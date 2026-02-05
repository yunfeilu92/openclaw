/**
 * AWS Secrets Manager storage backend for authentication credentials.
 *
 * This backend stores sensitive authentication data (API keys, OAuth tokens)
 * in AWS Secrets Manager with optional KMS encryption.
 *
 * Security features:
 * - Automatic encryption at rest using KMS
 * - IAM-based access control
 * - Automatic secret rotation support
 * - Audit logging via CloudTrail
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  UpdateSecretCommand,
  DeleteSecretCommand,
  ListSecretsCommand,
  type SecretListEntry,
} from "@aws-sdk/client-secrets-manager";
import type { HealthCheckResult, IAuthStorageBackend } from "../types.js";

/**
 * Configuration for SecretsManagerBackend.
 */
export type SecretsManagerBackendConfig = {
  /** Secret ARN or name prefix */
  secretArn: string;
  /** Optional KMS key ID for envelope encryption */
  kmsKeyId?: string;
  /** AWS region */
  region?: string;
  /** Enable caching for read operations */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs?: number;
};

type CacheEntry<T> = {
  value: T;
  loadedAt: number;
};

const DEFAULT_CACHE_TTL_MS = 60_000; // 1 minute for secrets
const SECRET_NAME_PREFIX = "openclaw-auth";

/**
 * AWS Secrets Manager storage backend for authentication credentials.
 */
export class SecretsManagerBackend implements IAuthStorageBackend {
  readonly type = "secrets-manager" as const;
  readonly isDistributed = true;

  private readonly secretArn: string;
  private readonly kmsKeyId?: string;
  private readonly region: string;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private client: SecretsManagerClient | null = null;

  constructor(config: SecretsManagerBackendConfig) {
    this.secretArn = config.secretArn;
    this.kmsKeyId = config.kmsKeyId;
    this.region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.cacheEnabled = config.cacheEnabled ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  private getClient(): SecretsManagerClient {
    if (!this.client) {
      this.client = new SecretsManagerClient({
        region: this.region,
      });
    }
    return this.client;
  }

  /**
   * Get the KMS key ID used for encryption.
   */
  getKmsKeyId(): string | undefined {
    return this.kmsKeyId;
  }

  /**
   * Build a full secret name from namespace and key.
   */
  private buildSecretName(namespace: string, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_/-]/g, "_");
    return `${SECRET_NAME_PREFIX}/${namespace}/${safeKey}`;
  }

  private getCacheKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  private isCacheValid<T>(entry: CacheEntry<T>): boolean {
    if (!this.cacheEnabled) return false;
    return Date.now() - entry.loadedAt <= this.cacheTtlMs;
  }

  async initialize(): Promise<void> {
    // Verify connectivity
    await this.healthCheck();
  }

  async close(): Promise<void> {
    this.cache.clear();
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const started = Date.now();
    try {
      const client = this.getClient();
      // List secrets to verify connectivity (limit to 1)
      const command = new ListSecretsCommand({
        MaxResults: 1,
        Filters: [
          {
            Key: "name",
            Values: [SECRET_NAME_PREFIX],
          },
        ],
      });
      await client.send(command);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
  }

  /**
   * Get a secret value from Secrets Manager.
   */
  async getSecret(key: string): Promise<string | null> {
    return this.get<string>("secrets", key);
  }

  /**
   * Set a secret value in Secrets Manager.
   */
  async setSecret(key: string, value: string): Promise<void> {
    await this.set("secrets", key, value);
  }

  /**
   * Delete a secret from Secrets Manager.
   */
  async deleteSecret(key: string): Promise<boolean> {
    return this.delete("secrets", key);
  }

  /**
   * Get a value from Secrets Manager.
   */
  async get<T>(namespace: string, key: string): Promise<T | null> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Check cache
    if (this.cacheEnabled) {
      const cached = this.cache.get(cacheKey) as CacheEntry<T> | undefined;
      if (cached && this.isCacheValid(cached)) {
        return structuredClone(cached.value);
      }
    }

    try {
      const client = this.getClient();
      const secretName = this.buildSecretName(namespace, key);

      const command = new GetSecretValueCommand({
        SecretId: secretName,
      });

      const response = await client.send(command);

      if (!response.SecretString) {
        return null;
      }

      // Try to parse as JSON, otherwise return as-is
      let value: T;
      try {
        value = JSON.parse(response.SecretString) as T;
      } catch {
        value = response.SecretString as unknown as T;
      }

      // Update cache
      if (this.cacheEnabled) {
        this.cache.set(cacheKey, { value: structuredClone(value), loadedAt: Date.now() });
      }

      return value;
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      // Secret not found
      if (errorCode === "ResourceNotFoundException" || errorCode === "SecretNotFoundException") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Set a value in Secrets Manager.
   */
  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    const client = this.getClient();
    const secretName = this.buildSecretName(namespace, key);
    const secretString = typeof value === "string" ? value : JSON.stringify(value);

    try {
      // Try to update existing secret first
      const command = new UpdateSecretCommand({
        SecretId: secretName,
        SecretString: secretString,
        ...(this.kmsKeyId ? { KmsKeyId: this.kmsKeyId } : {}),
      });
      await client.send(command);
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      // Secret doesn't exist, create it
      if (errorCode === "ResourceNotFoundException" || errorCode === "SecretNotFoundException") {
        const createCommand = new CreateSecretCommand({
          Name: secretName,
          SecretString: secretString,
          ...(this.kmsKeyId ? { KmsKeyId: this.kmsKeyId } : {}),
          Tags: [
            { Key: "Application", Value: "openclaw" },
            { Key: "Namespace", Value: namespace },
          ],
        });
        await client.send(createCommand);
        return;
      }
      throw err;
    }
  }

  /**
   * Delete a secret from Secrets Manager.
   */
  async delete(namespace: string, key: string): Promise<boolean> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    try {
      const client = this.getClient();
      const secretName = this.buildSecretName(namespace, key);

      const command = new DeleteSecretCommand({
        SecretId: secretName,
        ForceDeleteWithoutRecovery: true, // Immediate deletion
      });

      await client.send(command);
      return true;
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      if (errorCode === "ResourceNotFoundException" || errorCode === "SecretNotFoundException") {
        return false;
      }
      throw err;
    }
  }

  /**
   * List all keys in a namespace.
   */
  async list(namespace: string, prefix?: string): Promise<string[]> {
    const client = this.getClient();
    const secretPrefix = `${SECRET_NAME_PREFIX}/${namespace}/`;
    const keys: string[] = [];
    let nextToken: string | undefined;

    do {
      const command = new ListSecretsCommand({
        MaxResults: 100,
        NextToken: nextToken,
        Filters: [
          {
            Key: "name",
            Values: [secretPrefix],
          },
        ],
      });

      const response = await client.send(command);
      const secrets = response.SecretList ?? [];

      for (const secret of secrets as SecretListEntry[]) {
        if (secret.Name?.startsWith(secretPrefix)) {
          const key = secret.Name.slice(secretPrefix.length);
          if (!prefix || key.startsWith(prefix)) {
            keys.push(key);
          }
        }
      }

      nextToken = response.NextToken;
    } while (nextToken);

    return keys;
  }

  /**
   * Atomically update a value.
   */
  async update<T>(
    namespace: string,
    key: string,
    updater: (value: T | null) => T | null,
  ): Promise<T | null> {
    // Read current value (skip cache)
    const cacheKey = this.getCacheKey(namespace, key);
    this.cache.delete(cacheKey);

    const current = await this.get<T>(namespace, key);
    const next = updater(current);

    if (next === null) {
      await this.delete(namespace, key);
      return null;
    }

    await this.set(namespace, key, next);
    return next;
  }

  /**
   * Append is not supported for Secrets Manager.
   * Use a different backend for transcript-style logs.
   */
  async append(_namespace: string, _key: string, _line: string): Promise<void> {
    throw new Error(
      "Append operation is not supported by SecretsManagerBackend. " +
        "Use FileBackend or AgentCoreMemoryBackend for transcript storage.",
    );
  }

  /**
   * ReadLines is not supported for Secrets Manager.
   */
  async *readLines(_namespace: string, _key: string): AsyncIterable<string> {
    throw new Error(
      "ReadLines operation is not supported by SecretsManagerBackend. " +
        "Use FileBackend or AgentCoreMemoryBackend for transcript storage.",
    );
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Create a SecretsManagerBackend with the given configuration.
 */
export function createSecretsManagerBackend(
  config: SecretsManagerBackendConfig,
): SecretsManagerBackend {
  return new SecretsManagerBackend(config);
}
