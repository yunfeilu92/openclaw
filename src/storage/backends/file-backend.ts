/**
 * File-based storage backend.
 *
 * This is the default backend that maintains backward compatibility
 * with the existing local filesystem storage. All existing OpenClaw
 * installations will use this backend without any configuration changes.
 */

import JSON5 from "json5";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HealthCheckResult, IStorageBackend, StorageBackendType } from "../types.js";

/**
 * Configuration options for FileBackend.
 */
export type FileBackendConfig = {
  /** Base directory for storage (defaults to ~/.openclaw) */
  baseDir: string;
  /** Enable caching for read operations */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs?: number;
};

type CacheEntry<T> = {
  value: T;
  loadedAt: number;
  mtimeMs?: number;
};

const DEFAULT_CACHE_TTL_MS = 45_000; // 45 seconds

/**
 * Lock management for atomic updates.
 */
async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; pollIntervalMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 25;
  const staleMs = opts.staleMs ?? 30_000;
  const startedAt = Date.now();

  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
          "utf-8",
        );
      } catch {
        // best-effort
      }
      await handle.close();
      break;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;

      if (code === "ENOENT") {
        await fs.promises.mkdir(path.dirname(lockPath), { recursive: true }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }

      if (code !== "EEXIST") {
        throw err;
      }

      const now = Date.now();
      if (now - startedAt > timeoutMs) {
        throw new Error(`timeout acquiring file lock: ${lockPath}`, { cause: err });
      }

      // Stale lock eviction
      try {
        const st = await fs.promises.stat(lockPath);
        const ageMs = now - st.mtimeMs;
        if (ageMs > staleMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * File-based storage backend implementation.
 */
export class FileBackend implements IStorageBackend {
  readonly type: StorageBackendType = "file";
  readonly isDistributed = false;

  private readonly baseDir: string;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(config: FileBackendConfig) {
    this.baseDir = config.baseDir;
    this.cacheEnabled = config.cacheEnabled ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async initialize(): Promise<void> {
    await fs.promises.mkdir(this.baseDir, { recursive: true });
  }

  async close(): Promise<void> {
    this.cache.clear();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const started = Date.now();
    try {
      // Test write and read
      const testPath = path.join(this.baseDir, ".health-check");
      await fs.promises.writeFile(testPath, "ok", "utf-8");
      await fs.promises.unlink(testPath);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  private resolvePath(namespace: string, key: string): string {
    // Sanitize key to prevent path traversal
    const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.baseDir, namespace, `${safeKey}.json`);
  }

  private resolveTranscriptPath(namespace: string, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return path.join(this.baseDir, namespace, `${safeKey}.jsonl`);
  }

  private resolveLockPath(filePath: string): string {
    return `${filePath}.lock`;
  }

  private getCacheKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  private getFileMtimeMs(filePath: string): number | undefined {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private isCacheValid<T>(entry: CacheEntry<T>, filePath: string): boolean {
    if (!this.cacheEnabled) return false;
    const now = Date.now();
    if (now - entry.loadedAt > this.cacheTtlMs) return false;
    const currentMtime = this.getFileMtimeMs(filePath);
    return currentMtime === entry.mtimeMs;
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    const filePath = this.resolvePath(namespace, key);
    const cacheKey = this.getCacheKey(namespace, key);

    // Check cache
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey) as CacheEntry<T> | undefined;
      if (cached && this.isCacheValid(cached, filePath)) {
        return structuredClone(cached.value);
      }
    }

    // Read from disk
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const value = JSON5.parse(raw) as T;
      const mtimeMs = this.getFileMtimeMs(filePath);

      // Update cache
      if (this.cacheEnabled) {
        this.cache.set(cacheKey, { value: structuredClone(value), loadedAt: Date.now(), mtimeMs });
      }

      return value;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const filePath = this.resolvePath(namespace, key);
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    // Write atomically
    const json = JSON.stringify(value, null, 2);

    if (process.platform === "win32") {
      await fs.promises.writeFile(filePath, json, "utf-8");
      return;
    }

    const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
      await fs.promises.rename(tmp, filePath);
      await fs.promises.chmod(filePath, 0o600);
    } finally {
      await fs.promises.rm(tmp, { force: true });
    }
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    const filePath = this.resolvePath(namespace, key);
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return false;
      }
      throw err;
    }
  }

  async list(namespace: string, prefix?: string): Promise<string[]> {
    const dirPath = path.join(this.baseDir, namespace);

    try {
      const files = await fs.promises.readdir(dirPath);
      const keys = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); // Remove .json extension

      if (prefix) {
        return keys.filter((k) => k.startsWith(prefix));
      }
      return keys;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async update<T>(
    namespace: string,
    key: string,
    updater: (value: T | null) => T | null,
  ): Promise<T | null> {
    const filePath = this.resolvePath(namespace, key);
    const lockPath = this.resolveLockPath(filePath);

    return await withFileLock(lockPath, async () => {
      // Always re-read inside the lock
      const current = await this.get<T>(namespace, key);
      const next = updater(current);

      if (next === null) {
        await this.delete(namespace, key);
        return null;
      }

      await this.set(namespace, key, next);
      return next;
    });
  }

  async append(namespace: string, key: string, line: string): Promise<void> {
    const filePath = this.resolveTranscriptPath(namespace, key);

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    // Append line with newline
    const content = line.endsWith("\n") ? line : `${line}\n`;
    await fs.promises.appendFile(filePath, content, "utf-8");
  }

  async *readLines(namespace: string, key: string): AsyncIterable<string> {
    const filePath = this.resolveTranscriptPath(namespace, key);

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code)
          : null;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        yield line;
      }
    }
  }

  /**
   * Get the base directory for this backend.
   */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Create a FileBackend with default configuration.
 */
export function createFileBackend(baseDir: string): FileBackend {
  return new FileBackend({ baseDir });
}
