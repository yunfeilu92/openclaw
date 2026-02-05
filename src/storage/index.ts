/**
 * OpenClaw Storage Module
 *
 * Provides pluggable storage backends for session data, transcripts,
 * and authentication credentials.
 *
 * Default: File-based storage (~/.openclaw)
 * Optional: AWS Bedrock AgentCore Memory, AWS Secrets Manager
 *
 * @example
 * ```typescript
 * import { getStorageService, StorageNamespaces } from "./storage";
 *
 * const storage = getStorageService(config.storage);
 * await storage.initialize();
 *
 * const backend = storage.getBackend(StorageNamespaces.SESSIONS);
 * await backend.set("sessions", "session-123", sessionData);
 * ```
 */

// Types
export type {
  IStorageBackend,
  IAuthStorageBackend,
  IStorageService,
  HealthCheckResult,
  StorageBackendType,
  StorageNamespace,
  DataClassification,
  StorageBackendFactory,
} from "./types.js";

export { StorageNamespaces } from "./types.js";

// Re-export StorageConfig from config types for convenience
export type { StorageConfig } from "../config/types.storage.js";

// Backends
export { FileBackend, createFileBackend, type FileBackendConfig } from "./backends/file-backend.js";

export {
  AgentCoreMemoryBackend,
  createAgentCoreMemoryBackend,
  type AgentCoreMemoryBackendConfig,
} from "./backends/agentcore-memory-backend.js";

export {
  SecretsManagerBackend,
  createSecretsManagerBackend,
  type SecretsManagerBackendConfig,
} from "./backends/secrets-manager-backend.js";

export {
  DynamoDBBackend,
  createDynamoDBBackend,
  type DynamoDBBackendConfig,
} from "./backends/dynamodb-backend.js";

// Services
export {
  StorageService,
  getStorageService,
  resetStorageService,
  createStorageService,
} from "./storage-service.js";
