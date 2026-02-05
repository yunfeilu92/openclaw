import { z } from "zod";

/**
 * Zod schema for data classification.
 */
export const DataClassificationSchema = z.union([z.literal("local"), z.literal("cloud")]);

/**
 * Zod schema for per-namespace data classification.
 */
export const DataClassificationConfigSchema = z
  .object({
    sessions: DataClassificationSchema.optional(),
    transcripts: DataClassificationSchema.optional(),
    auth: DataClassificationSchema.optional(),
    config: DataClassificationSchema.optional(),
  })
  .strict()
  .optional();

/**
 * Zod schema for AgentCore Memory configuration.
 */
export const AgentCoreStorageConfigSchema = z
  .object({
    memoryArn: z.string().min(1),
    region: z.string().optional(),
    namespacePrefix: z.string().optional(),
  })
  .strict()
  .optional();

/**
 * Zod schema for Secrets Manager configuration.
 */
export const SecretsManagerConfigSchema = z
  .object({
    secretArn: z.string().min(1),
    kmsKeyId: z.string().optional(),
    region: z.string().optional(),
  })
  .strict()
  .optional();

/**
 * Zod schema for storage configuration.
 */
export const StorageConfigSchema = z
  .object({
    type: z.union([z.literal("file"), z.literal("agentcore")]).optional(),
    dataClassification: DataClassificationConfigSchema,
    agentcore: AgentCoreStorageConfigSchema,
    secretsManager: SecretsManagerConfigSchema,
    cacheEnabled: z.boolean().optional(),
    cacheTtlMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();
