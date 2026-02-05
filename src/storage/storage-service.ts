/**
 * Unified Storage Service
 *
 * Provides a high-level interface for storage operations that abstracts
 * the underlying backend (file, AgentCore Memory, DynamoDB, Secrets Manager).
 *
 * Features:
 * - Automatic backend selection based on configuration
 * - Hybrid storage: different backends for different data types
 * - Backward compatible: defaults to file storage
 *
 * Hybrid Architecture:
 * - Sessions: DynamoDB (supports true deletion, TTL)
 * - Transcripts: AgentCore Memory (append-only, semantic search)
 * - Auth: Secrets Manager or File (secure credential storage)
 * - Config: File (local configuration)
 */

import type { StorageConfig } from "../config/types.storage.js";
import type {
  IStorageBackend,
  IStorageService,
  HealthCheckResult,
  StorageNamespace,
  DataClassification,
} from "./types.js";
import { resolveStateDir } from "../config/paths.js";
import { AgentCoreMemoryBackend } from "./backends/agentcore-memory-backend.js";
import { DynamoDBBackend } from "./backends/dynamodb-backend.js";
import { FileBackend } from "./backends/file-backend.js";
import { SecretsManagerBackend } from "./backends/secrets-manager-backend.js";
import { StorageNamespaces } from "./types.js";

/**
 * Resolve data classification for a namespace.
 */
function resolveClassification(
  namespace: StorageNamespace,
  config: StorageConfig,
): DataClassification {
  const classification = config.dataClassification;

  // Check explicit configuration
  if (classification) {
    switch (namespace) {
      case StorageNamespaces.SESSIONS:
        if (classification.sessions) return classification.sessions;
        break;
      case StorageNamespaces.TRANSCRIPTS:
        if (classification.transcripts) return classification.transcripts;
        break;
      case StorageNamespaces.AUTH:
        if (classification.auth) return classification.auth;
        break;
      case StorageNamespaces.CONFIG:
        if (classification.config) return classification.config;
        break;
    }
  }

  // Defaults based on storage type
  if (config.type === "agentcore" || config.type === "hybrid") {
    switch (namespace) {
      case StorageNamespaces.SESSIONS:
      case StorageNamespaces.TRANSCRIPTS:
        return "cloud";
      case StorageNamespaces.AUTH:
      case StorageNamespaces.CONFIG:
        return "local"; // Auth and config stay local by default
    }
  }

  return "local";
}

/**
 * Storage service implementation.
 */
export class StorageService implements IStorageService {
  private readonly config: StorageConfig;
  private readonly baseDir: string;

  private fileBackend: FileBackend | null = null;
  private agentcoreBackend: AgentCoreMemoryBackend | null = null;
  private dynamodbBackend: DynamoDBBackend | null = null;
  private secretsManagerBackend: SecretsManagerBackend | null = null;

  private initialized = false;

  constructor(config: StorageConfig = { type: "file" }, baseDir?: string) {
    this.config = { ...config, type: config.type ?? "file" };
    this.baseDir = baseDir ?? resolveStateDir();
  }

  /**
   * Get the backend for a specific namespace based on configuration.
   *
   * Routing logic:
   * - hybrid mode:
   *   - sessions -> DynamoDB (supports true deletion)
   *   - transcripts -> AgentCore Memory (append-only, semantic search)
   *   - auth -> Secrets Manager (if configured) or File
   *   - config -> File
   * - agentcore mode:
   *   - sessions, transcripts -> AgentCore Memory
   *   - auth -> Secrets Manager (if configured) or File
   *   - config -> File
   * - file mode:
   *   - all -> File
   */
  getBackend(namespace: StorageNamespace): IStorageBackend {
    if (!this.initialized) {
      throw new Error("StorageService not initialized. Call initialize() first.");
    }

    const classification = resolveClassification(namespace, this.config);

    // Special handling for AUTH namespace with Secrets Manager
    if (namespace === StorageNamespaces.AUTH && this.config.secretsManager) {
      return this.getSecretsManagerBackend();
    }

    // Hybrid mode routing
    if (this.config.type === "hybrid" && classification === "cloud") {
      if (namespace === StorageNamespaces.SESSIONS) {
        // Sessions go to DynamoDB for true deletion support
        if (this.config.dynamodb?.tableName) {
          return this.getDynamoDBBackend();
        }
        // Fall back to AgentCore if DynamoDB not configured
        if (this.config.agentcore?.memoryArn) {
          return this.getAgentCoreBackend();
        }
      }
      if (namespace === StorageNamespaces.TRANSCRIPTS) {
        // Transcripts go to AgentCore Memory for append-only storage
        if (this.config.agentcore?.memoryArn) {
          return this.getAgentCoreBackend();
        }
      }
    }

    // AgentCore mode routing
    if (this.config.type === "agentcore" && classification === "cloud") {
      return this.getAgentCoreBackend();
    }

    // Default to file backend
    return this.getFileBackend();
  }

  private getFileBackend(): FileBackend {
    if (!this.fileBackend) {
      this.fileBackend = new FileBackend({
        baseDir: this.baseDir,
        cacheEnabled: this.config.cacheEnabled ?? true,
        cacheTtlMs: this.config.cacheTtlMs,
      });
    }
    return this.fileBackend;
  }

  private getAgentCoreBackend(): AgentCoreMemoryBackend {
    if (!this.agentcoreBackend) {
      if (!this.config.agentcore?.memoryArn) {
        throw new Error(
          "AgentCore storage configured but memoryArn not provided. " +
            "Set storage.agentcore.memoryArn in your configuration.",
        );
      }
      this.agentcoreBackend = new AgentCoreMemoryBackend({
        memoryArn: this.config.agentcore.memoryArn,
        region: this.config.agentcore.region,
        namespacePrefix: this.config.agentcore.namespacePrefix,
        cacheEnabled: this.config.cacheEnabled ?? true,
        cacheTtlMs: this.config.cacheTtlMs,
      });
    }
    return this.agentcoreBackend;
  }

  private getDynamoDBBackend(): DynamoDBBackend {
    if (!this.dynamodbBackend) {
      if (!this.config.dynamodb?.tableName) {
        throw new Error(
          "DynamoDB storage configured but tableName not provided. " +
            "Set storage.dynamodb.tableName in your configuration.",
        );
      }
      this.dynamodbBackend = new DynamoDBBackend({
        tableName: this.config.dynamodb.tableName,
        region: this.config.dynamodb.region,
        ttlSeconds: this.config.dynamodb.ttlSeconds,
        namespaceIndexName: this.config.dynamodb.namespaceIndexName,
        cacheEnabled: this.config.cacheEnabled ?? true,
        cacheTtlMs: this.config.cacheTtlMs,
      });
    }
    return this.dynamodbBackend;
  }

  private getSecretsManagerBackend(): SecretsManagerBackend {
    if (!this.secretsManagerBackend) {
      if (!this.config.secretsManager?.secretArn) {
        throw new Error(
          "Secrets Manager storage configured but secretArn not provided. " +
            "Set storage.secretsManager.secretArn in your configuration.",
        );
      }
      this.secretsManagerBackend = new SecretsManagerBackend({
        secretArn: this.config.secretsManager.secretArn,
        kmsKeyId: this.config.secretsManager.kmsKeyId,
        region: this.config.secretsManager.region,
        cacheEnabled: this.config.cacheEnabled ?? true,
        cacheTtlMs: this.config.cacheTtlMs,
      });
    }
    return this.secretsManagerBackend;
  }

  /**
   * Initialize all configured backends.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Always initialize file backend (default fallback)
    await this.getFileBackend().initialize();

    // Initialize cloud backends if configured
    const isCloudMode = this.config.type === "agentcore" || this.config.type === "hybrid";

    if (isCloudMode && this.config.agentcore?.memoryArn) {
      try {
        await this.getAgentCoreBackend().initialize();
      } catch (err) {
        // Log warning but don't fail - we can fall back to file backend
        console.warn(
          `AgentCore Memory initialization failed, falling back to file storage: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (this.config.type === "hybrid" && this.config.dynamodb?.tableName) {
      try {
        await this.getDynamoDBBackend().initialize();
      } catch (err) {
        console.warn(
          `DynamoDB initialization failed, falling back to file storage: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (this.config.secretsManager?.secretArn) {
      try {
        await this.getSecretsManagerBackend().initialize();
      } catch (err) {
        console.warn(
          `Secrets Manager initialization failed, falling back to file storage: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.initialized = true;
  }

  /**
   * Close all backends and release resources.
   */
  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    if (this.fileBackend) {
      closePromises.push(this.fileBackend.close());
    }
    if (this.agentcoreBackend) {
      closePromises.push(this.agentcoreBackend.close());
    }
    if (this.dynamodbBackend) {
      closePromises.push(this.dynamodbBackend.close());
    }
    if (this.secretsManagerBackend) {
      closePromises.push(this.secretsManagerBackend.close());
    }

    await Promise.all(closePromises);

    this.fileBackend = null;
    this.agentcoreBackend = null;
    this.dynamodbBackend = null;
    this.secretsManagerBackend = null;
    this.initialized = false;
  }

  /**
   * Health check all configured backends.
   */
  async healthCheck(): Promise<Record<StorageNamespace, HealthCheckResult>> {
    const results: Record<StorageNamespace, HealthCheckResult> = {
      [StorageNamespaces.SESSIONS]: { ok: false, error: "not checked" },
      [StorageNamespaces.TRANSCRIPTS]: { ok: false, error: "not checked" },
      [StorageNamespaces.AUTH]: { ok: false, error: "not checked" },
      [StorageNamespaces.CONFIG]: { ok: false, error: "not checked" },
    };

    // Check each namespace's backend
    for (const namespace of Object.values(StorageNamespaces)) {
      try {
        const backend = this.getBackend(namespace);
        results[namespace] = await backend.healthCheck();
      } catch (err) {
        results[namespace] = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    return results;
  }

  /**
   * Get storage configuration summary.
   */
  getConfigSummary(): {
    type: string;
    backends: Record<StorageNamespace, { type: string; classification: DataClassification }>;
  } {
    const backends: Record<StorageNamespace, { type: string; classification: DataClassification }> =
      {} as Record<StorageNamespace, { type: string; classification: DataClassification }>;

    for (const namespace of Object.values(StorageNamespaces)) {
      const classification = resolveClassification(namespace, this.config);
      let backendType = "file";

      if (namespace === StorageNamespaces.AUTH && this.config.secretsManager) {
        backendType = "secrets-manager";
      } else if (this.config.type === "hybrid" && classification === "cloud") {
        // Hybrid mode backend selection
        if (namespace === StorageNamespaces.SESSIONS && this.config.dynamodb?.tableName) {
          backendType = "dynamodb";
        } else if (
          namespace === StorageNamespaces.TRANSCRIPTS &&
          this.config.agentcore?.memoryArn
        ) {
          backendType = "agentcore";
        } else if (this.config.agentcore?.memoryArn) {
          backendType = "agentcore";
        }
      } else if (this.config.type === "agentcore" && classification === "cloud") {
        backendType = "agentcore";
      }

      backends[namespace] = { type: backendType, classification };
    }

    return {
      type: this.config.type ?? "file",
      backends,
    };
  }
}

// Singleton instance
let _storageService: StorageService | null = null;

/**
 * Get or create the global storage service instance.
 */
export function getStorageService(config?: StorageConfig, baseDir?: string): StorageService {
  if (!_storageService) {
    _storageService = new StorageService(config, baseDir);
  }
  return _storageService;
}

/**
 * Reset the global storage service (for testing).
 */
export function resetStorageService(): void {
  if (_storageService) {
    _storageService.close().catch(() => {});
    _storageService = null;
  }
}

/**
 * Create a new storage service instance (non-singleton).
 */
export function createStorageService(config?: StorageConfig, baseDir?: string): StorageService {
  return new StorageService(config, baseDir);
}
