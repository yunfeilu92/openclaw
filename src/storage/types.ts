/**
 * Storage Backend Abstraction Layer
 *
 * Provides a unified interface for storing session data, transcripts,
 * and configuration across different backends:
 * - FileBackend: Local filesystem (default, backward compatible)
 * - AgentCoreMemoryBackend: AWS Bedrock AgentCore Memory service
 * - SecretsManagerBackend: AWS Secrets Manager for auth credentials
 */

/**
 * Supported storage backend types.
 */
export type StorageBackendType = "file" | "agentcore" | "secrets-manager";

/**
 * Health check result for storage backends.
 */
export type HealthCheckResult = {
  ok: boolean;
  error?: string;
  latencyMs?: number;
};

/**
 * Core storage backend interface.
 *
 * All storage backends implement this interface to provide
 * consistent access patterns for key-value storage with
 * namespace separation.
 */
export interface IStorageBackend {
  /**
   * Backend type identifier.
   */
  readonly type: StorageBackendType;

  /**
   * Whether this backend supports distributed access.
   * File backend is local-only; AgentCore supports multi-instance.
   */
  readonly isDistributed: boolean;

  /**
   * Initialize the storage backend.
   * Called once before any other operations.
   */
  initialize(): Promise<void>;

  /**
   * Close the storage backend and release resources.
   */
  close(): Promise<void>;

  /**
   * Check if the backend is healthy and accessible.
   */
  healthCheck(): Promise<HealthCheckResult>;

  /**
   * Get a value by namespace and key.
   * Returns null if the key does not exist.
   */
  get<T>(namespace: string, key: string): Promise<T | null>;

  /**
   * Set a value by namespace and key.
   * Creates the key if it doesn't exist, updates otherwise.
   */
  set<T>(namespace: string, key: string, value: T): Promise<void>;

  /**
   * Delete a key from the namespace.
   * Returns true if the key existed and was deleted.
   */
  delete(namespace: string, key: string): Promise<boolean>;

  /**
   * List all keys in a namespace, optionally filtered by prefix.
   */
  list(namespace: string, prefix?: string): Promise<string[]>;

  /**
   * Atomically update a value using an updater function.
   * The updater receives the current value (or null) and returns the new value.
   * If the updater returns null, the key is deleted.
   *
   * This operation is atomic: the value is locked during the update
   * to prevent concurrent modifications.
   */
  update<T>(
    namespace: string,
    key: string,
    updater: (value: T | null) => T | null,
  ): Promise<T | null>;

  /**
   * Append a line to a transcript-style log.
   * Used for session transcripts (.jsonl files).
   */
  append(namespace: string, key: string, line: string): Promise<void>;

  /**
   * Read lines from a transcript-style log.
   * Returns an async iterable for memory-efficient streaming.
   */
  readLines(namespace: string, key: string): AsyncIterable<string>;
}

/**
 * Storage backend for authentication credentials.
 *
 * Extends the base interface with additional security features
 * like encryption key management.
 */
export interface IAuthStorageBackend extends IStorageBackend {
  /**
   * Backend type (always "secrets-manager" for auth backends).
   */
  readonly type: "secrets-manager";

  /**
   * Get the KMS key ID used for encryption (if configured).
   */
  getKmsKeyId(): string | undefined;

  /**
   * Get a secret value with automatic decryption.
   */
  getSecret(key: string): Promise<string | null>;

  /**
   * Set a secret value with automatic encryption.
   */
  setSecret(key: string, value: string): Promise<void>;

  /**
   * Delete a secret.
   */
  deleteSecret(key: string): Promise<boolean>;
}

/**
 * Storage namespaces used by OpenClaw.
 */
export const StorageNamespaces = {
  /** Session index (sessions.json equivalent) */
  SESSIONS: "sessions",
  /** Session transcripts (.jsonl files) */
  TRANSCRIPTS: "transcripts",
  /** Authentication profiles */
  AUTH: "auth",
  /** Configuration data */
  CONFIG: "config",
} as const;

export type StorageNamespace = (typeof StorageNamespaces)[keyof typeof StorageNamespaces];

/**
 * Data classification for hybrid storage scenarios.
 * Determines where each data type is stored.
 */
export type DataClassification = "local" | "cloud";

// Note: StorageConfig is defined in ../config/types.storage.ts
// and re-exported from ./index.ts for convenience

/**
 * Factory function type for creating storage backends.
 */
export type StorageBackendFactory = (
  config: import("../config/types.storage.js").StorageConfig,
) => Promise<IStorageBackend>;

/**
 * Storage service interface that combines multiple backends
 * based on data classification.
 */
export interface IStorageService {
  /**
   * Get the backend for a specific namespace.
   */
  getBackend(namespace: StorageNamespace): IStorageBackend;

  /**
   * Initialize all backends.
   */
  initialize(): Promise<void>;

  /**
   * Close all backends.
   */
  close(): Promise<void>;

  /**
   * Health check all backends.
   */
  healthCheck(): Promise<Record<StorageNamespace, HealthCheckResult>>;
}
