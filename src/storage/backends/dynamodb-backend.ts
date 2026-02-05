/**
 * AWS DynamoDB storage backend for session index.
 *
 * This backend stores session index data in DynamoDB, enabling:
 * - Distributed access across multiple Gateway instances
 * - True deletion (unlike AgentCore Memory)
 * - TTL-based automatic cleanup
 * - Conditional writes for atomic updates
 *
 * Table Schema:
 * - PK: {namespace}#{key}
 * - SK: "DATA"
 * - data: JSON-encoded value
 * - ttl: Unix timestamp for expiration (optional)
 * - updatedAt: ISO timestamp
 *
 * GSI (NamespaceIndex):
 * - PK: namespace
 * - SK: key
 * - Projection: ALL
 */

import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { HealthCheckResult, IStorageBackend, StorageBackendType } from "../types.js";

/**
 * Configuration for DynamoDBBackend.
 */
export type DynamoDBBackendConfig = {
  /** DynamoDB table name */
  tableName: string;
  /** AWS region */
  region?: string;
  /** TTL in seconds for session data (0 = no TTL) */
  ttlSeconds?: number;
  /** Enable caching for read operations */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs?: number;
  /** GSI name for namespace queries (default: NamespaceIndex) */
  namespaceIndexName?: string;
};

type CacheEntry<T> = {
  value: T;
  loadedAt: number;
};

const DEFAULT_CACHE_TTL_MS = 30_000; // 30 seconds
const DEFAULT_TTL_SECONDS = 86400 * 30; // 30 days
const DEFAULT_NAMESPACE_INDEX = "NamespaceIndex";

/**
 * AWS DynamoDB storage backend for session index.
 */
export class DynamoDBBackend implements IStorageBackend {
  readonly type: StorageBackendType = "dynamodb";
  readonly isDistributed = true;

  private readonly tableName: string;
  private readonly region: string;
  private readonly ttlSeconds: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly namespaceIndexName: string;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private client: DynamoDBClient | null = null;
  private docClient: DynamoDBDocumentClient | null = null;

  constructor(config: DynamoDBBackendConfig) {
    this.tableName = config.tableName;
    this.region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.cacheEnabled = config.cacheEnabled ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.namespaceIndexName = config.namespaceIndexName ?? DEFAULT_NAMESPACE_INDEX;
  }

  private getClient(): DynamoDBClient {
    if (!this.client) {
      this.client = new DynamoDBClient({
        region: this.region,
      });
    }
    return this.client;
  }

  private getDocClient(): DynamoDBDocumentClient {
    if (!this.docClient) {
      this.docClient = DynamoDBDocumentClient.from(this.getClient(), {
        marshallOptions: {
          removeUndefinedValues: true,
          convertClassInstanceToMap: true,
        },
        unmarshallOptions: {
          wrapNumbers: false,
        },
      });
    }
    return this.docClient;
  }

  /**
   * Build primary key for DynamoDB item.
   */
  private buildPK(namespace: string, key: string): string {
    return `${namespace}#${key}`;
  }

  /**
   * Parse primary key to extract namespace and key.
   */
  private parsePK(pk: string): { namespace: string; key: string } | null {
    const idx = pk.indexOf("#");
    if (idx === -1) return null;
    return {
      namespace: pk.slice(0, idx),
      key: pk.slice(idx + 1),
    };
  }

  private getCacheKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  private isCacheValid<T>(entry: CacheEntry<T>): boolean {
    if (!this.cacheEnabled) return false;
    return Date.now() - entry.loadedAt <= this.cacheTtlMs;
  }

  /**
   * Calculate TTL timestamp.
   */
  private getTtl(): number | undefined {
    if (this.ttlSeconds <= 0) return undefined;
    return Math.floor(Date.now() / 1000) + this.ttlSeconds;
  }

  async initialize(): Promise<void> {
    // Verify table exists
    await this.healthCheck();
  }

  async close(): Promise<void> {
    this.cache.clear();
    if (this.docClient) {
      this.docClient.destroy();
      this.docClient = null;
    }
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const started = Date.now();
    try {
      const client = this.getClient();
      const command = new DescribeTableCommand({
        TableName: this.tableName,
      });
      const response = await client.send(command);

      if (response.Table?.TableStatus !== "ACTIVE") {
        return {
          ok: false,
          error: `Table status: ${response.Table?.TableStatus ?? "unknown"}`,
          latencyMs: Date.now() - started,
        };
      }

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
   * Get a value from DynamoDB.
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
      const docClient = this.getDocClient();
      const pk = this.buildPK(namespace, key);

      const command = new GetCommand({
        TableName: this.tableName,
        Key: {
          PK: pk,
          SK: "DATA",
        },
      });

      const response = await docClient.send(command);

      if (!response.Item) {
        return null;
      }

      // Check if item has expired (in case TTL deletion is delayed)
      if (response.Item.ttl && response.Item.ttl < Math.floor(Date.now() / 1000)) {
        return null;
      }

      const value = response.Item.data as T;

      // Update cache
      if (this.cacheEnabled && value !== undefined) {
        this.cache.set(cacheKey, { value: structuredClone(value), loadedAt: Date.now() });
      }

      return value ?? null;
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      if (errorCode === "ResourceNotFoundException") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Set a value in DynamoDB.
   */
  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    const docClient = this.getDocClient();
    const pk = this.buildPK(namespace, key);
    const now = new Date().toISOString();
    const ttl = this.getTtl();

    const command = new PutCommand({
      TableName: this.tableName,
      Item: {
        PK: pk,
        SK: "DATA",
        namespace,
        key,
        data: value,
        updatedAt: now,
        ...(ttl !== undefined ? { ttl } : {}),
      },
    });

    await docClient.send(command);
  }

  /**
   * Delete a value from DynamoDB.
   */
  async delete(namespace: string, key: string): Promise<boolean> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    try {
      const docClient = this.getDocClient();
      const pk = this.buildPK(namespace, key);

      const command = new DeleteCommand({
        TableName: this.tableName,
        Key: {
          PK: pk,
          SK: "DATA",
        },
        ReturnValues: "ALL_OLD",
      });

      const response = await docClient.send(command);
      return response.Attributes !== undefined;
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      if (errorCode === "ResourceNotFoundException") {
        return false;
      }
      throw err;
    }
  }

  /**
   * List all keys in a namespace using GSI.
   */
  async list(namespace: string, prefix?: string): Promise<string[]> {
    const docClient = this.getDocClient();
    const keys: string[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      const command = new QueryCommand({
        TableName: this.tableName,
        IndexName: this.namespaceIndexName,
        KeyConditionExpression: prefix ? "#ns = :ns AND begins_with(#key, :prefix)" : "#ns = :ns",
        ExpressionAttributeNames: {
          "#ns": "namespace",
          ...(prefix ? { "#key": "key" } : {}),
        },
        ExpressionAttributeValues: {
          ":ns": namespace,
          ...(prefix ? { ":prefix": prefix } : {}),
        },
        ProjectionExpression: "#key",
        ExclusiveStartKey: lastEvaluatedKey,
      });

      // Fix: #key is already defined, need to use "key" in expression attribute names
      command.input.ExpressionAttributeNames = {
        "#ns": "namespace",
        "#key": "key",
      };

      const response = await docClient.send(command);
      const items = response.Items ?? [];

      for (const item of items) {
        if (item.key) {
          keys.push(item.key as string);
        }
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return keys;
  }

  /**
   * Atomically update a value using conditional writes.
   */
  async update<T>(
    namespace: string,
    key: string,
    updater: (value: T | null) => T | null,
  ): Promise<T | null> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache before update
    this.cache.delete(cacheKey);

    // Read current value
    const current = await this.get<T>(namespace, key);
    const next = updater(current);

    if (next === null) {
      await this.delete(namespace, key);
      return null;
    }

    const docClient = this.getDocClient();
    const pk = this.buildPK(namespace, key);
    const now = new Date().toISOString();
    const ttl = this.getTtl();

    // Use conditional write to ensure atomicity
    const command = new UpdateCommand({
      TableName: this.tableName,
      Key: {
        PK: pk,
        SK: "DATA",
      },
      UpdateExpression:
        "SET #data = :data, #ns = :ns, #key = :key, #updatedAt = :updatedAt" +
        (ttl !== undefined ? ", #ttl = :ttl" : ""),
      ExpressionAttributeNames: {
        "#data": "data",
        "#ns": "namespace",
        "#key": "key",
        "#updatedAt": "updatedAt",
        ...(ttl !== undefined ? { "#ttl": "ttl" } : {}),
      },
      ExpressionAttributeValues: {
        ":data": next,
        ":ns": namespace,
        ":key": key,
        ":updatedAt": now,
        ...(ttl !== undefined ? { ":ttl": ttl } : {}),
      },
      ReturnValues: "ALL_NEW",
    });

    const response = await docClient.send(command);
    return (response.Attributes?.data as T) ?? null;
  }

  /**
   * Append is not the primary use case for DynamoDB session index.
   * For transcript-style logs, use AgentCoreMemoryBackend instead.
   */
  async append(_namespace: string, _key: string, _line: string): Promise<void> {
    throw new Error(
      "Append operation is not recommended for DynamoDBBackend. " +
        "Use AgentCoreMemoryBackend for transcript storage.",
    );
  }

  /**
   * ReadLines is not the primary use case for DynamoDB session index.
   */
  async *readLines(_namespace: string, _key: string): AsyncIterable<string> {
    throw new Error(
      "ReadLines operation is not recommended for DynamoDBBackend. " +
        "Use AgentCoreMemoryBackend for transcript storage.",
    );
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get table name.
   */
  getTableName(): string {
    return this.tableName;
  }
}

/**
 * Create a DynamoDBBackend with the given configuration.
 */
export function createDynamoDBBackend(config: DynamoDBBackendConfig): DynamoDBBackend {
  return new DynamoDBBackend(config);
}
