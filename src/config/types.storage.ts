/**
 * Storage configuration types for cloud-native storage backends.
 */

/**
 * Data classification determines where each data type is stored.
 * - "local": Local filesystem (default, backward compatible)
 * - "cloud": Cloud storage (AgentCore Memory, S3, etc.)
 */
export type DataClassification = "local" | "cloud";

/**
 * Per-namespace data classification overrides.
 */
export type DataClassificationConfig = {
  /** Session index storage (default: "cloud" when storage type is agentcore) */
  sessions?: DataClassification;
  /** Session transcript storage (default: "cloud" when storage type is agentcore) */
  transcripts?: DataClassification;
  /** Authentication credentials (default: "local" for security) */
  auth?: DataClassification;
  /** Configuration data (default: "local") */
  config?: DataClassification;
};

/**
 * AWS Bedrock AgentCore Memory configuration.
 */
export type AgentCoreStorageConfig = {
  /** AgentCore Memory resource ARN */
  memoryArn: string;
  /** AWS region (defaults to AWS_REGION env var) */
  region?: string;
  /** Optional namespace prefix for multi-tenant deployments */
  namespacePrefix?: string;
};

/**
 * AWS Secrets Manager configuration for auth credential storage.
 */
export type SecretsManagerConfig = {
  /** Secret ARN or name prefix */
  secretArn: string;
  /** Optional KMS key ID for envelope encryption */
  kmsKeyId?: string;
  /** AWS region (defaults to AWS_REGION env var) */
  region?: string;
};

/**
 * AWS DynamoDB configuration for session index storage.
 */
export type DynamoDBStorageConfig = {
  /** DynamoDB table name */
  tableName: string;
  /** AWS region (defaults to AWS_REGION env var) */
  region?: string;
  /** TTL in seconds for session data (0 = no TTL, default: 30 days) */
  ttlSeconds?: number;
  /** GSI name for namespace queries (default: NamespaceIndex) */
  namespaceIndexName?: string;
};

/**
 * Storage backend configuration.
 */
export type StorageConfig = {
  /**
   * Primary storage backend type.
   * - "file": Local filesystem (default, backward compatible)
   * - "agentcore": AWS Bedrock AgentCore Memory (for transcripts)
   * - "hybrid": Use DynamoDB for sessions + AgentCore for transcripts
   */
  type?: "file" | "agentcore" | "hybrid";

  /**
   * Per-namespace data classification overrides.
   * Allows hybrid local/cloud storage strategies.
   */
  dataClassification?: DataClassificationConfig;

  /**
   * AgentCore Memory configuration (for transcripts storage).
   */
  agentcore?: AgentCoreStorageConfig;

  /**
   * DynamoDB configuration (for session index storage in hybrid mode).
   */
  dynamodb?: DynamoDBStorageConfig;

  /**
   * AWS Secrets Manager configuration (optional, for cloud auth storage).
   */
  secretsManager?: SecretsManagerConfig;

  /**
   * Enable caching for cloud storage operations.
   * Default: true
   */
  cacheEnabled?: boolean;

  /**
   * Cache TTL in milliseconds.
   * Default: 45000 (45 seconds, matching session store cache)
   */
  cacheTtlMs?: number;
};
