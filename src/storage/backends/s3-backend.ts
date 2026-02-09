/**
 * AWS S3 storage backend for workspace files.
 *
 * Stores workspace files (SOUL.md, AGENTS.md, etc.) in a private S3 bucket.
 * Only supports key-value operations needed for workspace; transcript
 * operations (append/readLines) are not supported.
 *
 * S3 key layout:
 *   s3://{bucket}/{prefix}/{namespace}/{key}
 *
 * Security: bucket MUST be private (no public access).
 * Access is via IAM credentials (SDK default credential chain).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { HealthCheckResult, IStorageBackend, StorageBackendType } from "../types.js";

export type S3BackendConfig = {
  /** S3 bucket name (must be private) */
  bucket: string;
  /** Optional key prefix, e.g. "openclaw/workspace" */
  prefix?: string;
  /** AWS region */
  region?: string;
};

export class S3Backend implements IStorageBackend {
  readonly type: StorageBackendType = "s3";
  readonly isDistributed = true;

  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;

  constructor(config: S3BackendConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "";
    this.client = new S3Client({ region: config.region });
  }

  /** Build full S3 key from namespace + key. */
  private key(namespace: string, key: string): string {
    const parts = [this.prefix, namespace, key].filter(Boolean);
    return parts.join("/");
  }

  async initialize(): Promise<void> {
    // No initialization needed — S3 client is stateless.
  }

  async close(): Promise<void> {
    this.client.destroy();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // List with max 1 to verify bucket access
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  async get<T>(namespace: string, key: string): Promise<T | null> {
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(namespace, key) }),
      );
      const body = await resp.Body?.transformToString("utf-8");
      if (body == null) return null;
      try {
        return JSON.parse(body) as T;
      } catch {
        // Stored as plain string (workspace files)
        return body as unknown as T;
      }
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      // Also handle the generic "NoSuchKey" error name from older SDK versions
      if (err instanceof Error && err.name === "NoSuchKey") return null;
      throw err;
    }
  }

  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(namespace, key),
        Body: body,
        ContentType: typeof value === "string" ? "text/plain; charset=utf-8" : "application/json",
      }),
    );
  }

  async delete(namespace: string, key: string): Promise<boolean> {
    // S3 DeleteObject is idempotent (no error if key missing)
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(namespace, key) }),
    );
    return true;
  }

  async list(namespace: string, prefix?: string): Promise<string[]> {
    const s3Prefix = [this.prefix, namespace, prefix].filter(Boolean).join("/") + "/";
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: s3Prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (obj.Key) {
          // Strip the namespace prefix to return just the key name
          const relative = obj.Key.slice(s3Prefix.length);
          if (relative) keys.push(relative);
        }
      }
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  async update<T>(
    namespace: string,
    key: string,
    updater: (value: T | null) => T | null,
  ): Promise<T | null> {
    // S3 has no native atomic update; read-modify-write (acceptable for workspace files)
    const current = await this.get<T>(namespace, key);
    const updated = updater(current);
    if (updated === null) {
      await this.delete(namespace, key);
    } else {
      await this.set(namespace, key, updated);
    }
    return updated;
  }

  async append(_namespace: string, _key: string, _line: string): Promise<void> {
    throw new Error("S3Backend does not support append (use AgentCore Memory for transcripts)");
  }

  async *readLines(_namespace: string, _key: string): AsyncIterable<string> {
    throw new Error("S3Backend does not support readLines (use AgentCore Memory for transcripts)");
  }
}

export function createS3Backend(config: S3BackendConfig): S3Backend {
  return new S3Backend(config);
}
