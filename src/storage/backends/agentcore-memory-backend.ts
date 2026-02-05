/**
 * AWS Bedrock AgentCore Memory storage backend.
 *
 * This backend stores session data and transcripts in AgentCore Memory,
 * enabling distributed access across multiple Gateway instances.
 *
 * AgentCore Memory uses:
 * - Short-term memory (events): For session data and transcripts
 * - Long-term memory (memory records): For semantic search and insights
 *
 * Key-value storage is implemented using events with structured payloads.
 */

import type { DocumentType } from "@smithy/types";
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  type Event,
} from "@aws-sdk/client-bedrock-agentcore";
import type { HealthCheckResult, IStorageBackend, StorageBackendType } from "../types.js";

/**
 * Configuration for AgentCoreMemoryBackend.
 */
export type AgentCoreMemoryBackendConfig = {
  /** AgentCore Memory resource ARN */
  memoryArn: string;
  /** AWS region */
  region?: string;
  /** Optional namespace prefix for multi-tenant deployments */
  namespacePrefix?: string;
  /** Enable caching for read operations */
  cacheEnabled?: boolean;
  /** Cache TTL in milliseconds */
  cacheTtlMs?: number;
};

type CacheEntry<T> = {
  value: T;
  loadedAt: number;
};

const DEFAULT_CACHE_TTL_MS = 45_000;
const ACTOR_ID_PREFIX = "openclaw-storage";
const KV_SESSION_PREFIX = "kv-";
const TRANSCRIPT_SESSION_PREFIX = "tr-";

/**
 * Convert a Python dict format string to JSON.
 *
 * AWS SDK may serialize DocumentType as Python dict format:
 * - {key=value, nested={a=1, b=2}}
 *
 * This function converts it to valid JSON:
 * - {"key": "value", "nested": {"a": "1", "b": "2"}}
 *
 * Known limitations:
 * - String values containing '=' or ',' may not parse correctly
 * - Nested structures with complex string values may fail
 */
function pythonDictToJson(str: string): string | null {
  // First check if it's already valid JSON
  try {
    JSON.parse(str);
    return str;
  } catch {
    // Not JSON, try to convert from Python dict
  }

  // Simple heuristic: if it doesn't look like Python dict, return null
  if (!str.startsWith("{") || !str.endsWith("}")) {
    return null;
  }

  // State machine to convert Python dict to JSON
  let result = "";
  let i = 0;
  let depth = 0;
  let inKey = false;
  let keyStart = -1;

  while (i < str.length) {
    const ch = str[i];

    if (ch === "{") {
      result += "{";
      depth++;
      inKey = true;
      keyStart = i + 1;
      i++;
    } else if (ch === "}") {
      depth--;
      result += "}";
      inKey = false;
      i++;
    } else if (ch === "[") {
      result += "[";
      depth++;
      i++;
    } else if (ch === "]") {
      depth--;
      result += "]";
      i++;
    } else if (ch === "=" && inKey) {
      // End of key, extract and quote it
      const key = str.slice(keyStart, i).trim();
      // Replace the unquoted key we might have added with quoted version
      const lastBraceOrComma = Math.max(result.lastIndexOf("{"), result.lastIndexOf(","));
      result = result.slice(0, lastBraceOrComma + 1);
      result += `"${key}":`;
      inKey = false;

      // Now read the value
      i++; // skip '='
      // Skip whitespace
      while (i < str.length && str[i] === " ") i++;

      // Determine value type
      if (str[i] === "{" || str[i] === "[") {
        // Nested structure - will be handled by the main loop
        continue;
      }

      // Find end of value (next ',' or '}' or ']' at current depth)
      const valueStart = i;
      let valueDepth = 0;
      while (i < str.length) {
        const vc = str[i];
        if (vc === "{" || vc === "[") valueDepth++;
        else if (vc === "}" || vc === "]") {
          if (valueDepth === 0) break;
          valueDepth--;
        } else if (vc === "," && valueDepth === 0) {
          break;
        }
        i++;
      }
      const value = str.slice(valueStart, i).trim();

      // Quote the value if it's not a number, boolean, null, or already a structure
      if (
        value === "null" ||
        value === "true" ||
        value === "false" ||
        /^-?\d+(\.\d+)?$/.test(value)
      ) {
        result += value;
      } else {
        // Escape quotes in value and wrap in quotes
        result += `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      }
    } else if (ch === ",") {
      result += ",";
      inKey = true;
      keyStart = i + 1;
      i++;
    } else if (inKey) {
      // Part of key - skip, we'll extract it at '='
      i++;
    } else {
      // Should not reach here normally
      result += ch;
      i++;
    }
  }

  // Validate the result is valid JSON
  try {
    JSON.parse(result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Extract the JSON content from AWS SDK's Python dict format response.
 *
 * AWS SDK may return blob as a Python dict format string like:
 * - {_type=line, text={"type":"message",...}}  (new format with embedded JSON)
 * - {_type=line, data={...}}  (old format with Python dict)
 *
 * This function extracts the embedded JSON from the text= field,
 * or converts the old format Python dict to JSON.
 */
function extractJsonFromPythonDict(str: string): string | null {
  // First try standard JSON parse
  try {
    JSON.parse(str);
    return str; // Already valid JSON
  } catch {
    // Not valid JSON, continue
  }

  // Try to extract text= value which should be valid JSON (new format)
  // Pattern: {_type=line, text={...JSON...}}
  const textMatch = str.match(/\{_type=line,\s*text=(\{[\s\S]*\})\s*\}$/);
  if (textMatch?.[1]) {
    try {
      JSON.parse(textMatch[1]);
      return textMatch[1]; // Valid JSON extracted
    } catch {
      // Not valid JSON in text field
    }
  }

  // Try to convert old format Python dict to JSON
  // Pattern: {_type=line, data={...}}
  const dataMatch = str.match(/\{_type=line,\s*data=(\{[\s\S]*\})\s*\}$/);
  if (dataMatch?.[1]) {
    const converted = pythonDictToJson(dataMatch[1]);
    if (converted) {
      // The converted object should have a 'message' field that we need
      // Return the converted JSON directly
      return converted;
    }
  }

  return null;
}

/**
 * AWS Bedrock AgentCore Memory storage backend.
 */
export class AgentCoreMemoryBackend implements IStorageBackend {
  readonly type: StorageBackendType = "agentcore";
  readonly isDistributed = true;

  private readonly memoryArn: string;
  private readonly region: string;
  private readonly namespacePrefix: string;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private client: BedrockAgentCoreClient | null = null;

  constructor(config: AgentCoreMemoryBackendConfig) {
    this.memoryArn = config.memoryArn;
    this.region = config.region ?? process.env.AWS_REGION ?? "us-east-1";
    this.namespacePrefix = config.namespacePrefix ?? "";
    this.cacheEnabled = config.cacheEnabled ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  private getClient(): BedrockAgentCoreClient {
    if (!this.client) {
      this.client = new BedrockAgentCoreClient({
        region: this.region,
      });
    }
    return this.client;
  }

  /**
   * Extract memory ID from ARN.
   * Format: arn:aws:bedrock-agentcore:region:account:memory/memory-id
   */
  private getMemoryId(): string {
    const match = this.memoryArn.match(/memory\/([^/]+)$/);
    if (!match) {
      throw new Error(`Invalid memory ARN format: ${this.memoryArn}`);
    }
    return match[1];
  }

  /**
   * Build actor ID with optional namespace prefix.
   */
  private buildActorId(namespace: string): string {
    const prefix = this.namespacePrefix ? `${this.namespacePrefix}/` : "";
    return `${ACTOR_ID_PREFIX}/${prefix}${namespace}`;
  }

  /**
   * Build session ID for key-value storage.
   */
  private buildKvSessionId(key: string): string {
    return `${KV_SESSION_PREFIX}${this.sanitizeKey(key)}`;
  }

  /**
   * Build session ID for transcript storage.
   */
  private buildTranscriptSessionId(key: string): string {
    return `${TRANSCRIPT_SESSION_PREFIX}${this.sanitizeKey(key)}`;
  }

  /**
   * Sanitize key for use in session IDs.
   */
  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_.-]/g, "_");
  }

  private getCacheKey(namespace: string, key: string): string {
    return `${namespace}:${key}`;
  }

  private isCacheValid<T>(entry: CacheEntry<T>): boolean {
    if (!this.cacheEnabled) return false;
    return Date.now() - entry.loadedAt <= this.cacheTtlMs;
  }

  async initialize(): Promise<void> {
    // Verify connectivity by making a lightweight API call
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
      const command = new ListSessionsCommand({
        memoryId: this.getMemoryId(),
        actorId: `${ACTOR_ID_PREFIX}/health-check`,
        maxResults: 1,
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
   * Get a value by retrieving the latest event from a session.
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
      const actorId = this.buildActorId(namespace);
      const sessionId = this.buildKvSessionId(key);

      // List events for this session (most recent first)
      const command = new ListEventsCommand({
        memoryId: this.getMemoryId(),
        actorId,
        sessionId,
        maxResults: 1,
        includePayloads: true,
      });

      const response = await client.send(command);
      const events = response.events ?? [];

      if (events.length === 0) {
        return null;
      }

      const event = events[0] as Event;
      const payload = event.payload?.[0];

      if (!payload?.blob) {
        return null;
      }

      // Check for tombstone (soft delete)
      const blob = payload.blob as Record<string, unknown>;
      if (blob._type === "tombstone") {
        return null;
      }

      // Extract value from blob payload
      // blob is now a JSON document (DocumentType) with our wrapper format
      let value: T;
      if (blob._type === "kv" && blob.value !== undefined) {
        // KV storage format: { _type: "kv", value: ... }
        value = blob.value as T;
      } else {
        // Treat entire blob as the value (legacy or direct format)
        value = blob as T;
      }

      // Update cache
      if (this.cacheEnabled) {
        this.cache.set(cacheKey, { value: structuredClone(value), loadedAt: Date.now() });
      }

      return value;
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      // Session not found means key doesn't exist
      if (errorCode === "ResourceNotFoundException") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Set a value by creating a new event in the session.
   */
  async set<T>(namespace: string, key: string, value: T): Promise<void> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Invalidate cache
    this.cache.delete(cacheKey);

    const client = this.getClient();
    const actorId = this.buildActorId(namespace);
    const sessionId = this.buildKvSessionId(key);

    // AgentCore Memory expects blob as a JSON document (DOCUMENT_VALUE)
    // Wrap the value in a container to preserve type information
    // Use JSON.parse(JSON.stringify()) to ensure value is JSON-serializable
    const jsonValue = JSON.parse(JSON.stringify(value)) as DocumentType;
    const blobData: DocumentType = {
      _type: "kv",
      value: jsonValue,
    };
    const command = new CreateEventCommand({
      memoryId: this.getMemoryId(),
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload: [
        {
          blob: blobData,
        },
      ],
    });

    await client.send(command);
  }

  /**
   * Delete a key.
   *
   * Note: AgentCore Memory API doesn't have a DeleteSession command.
   * We implement soft delete by storing a tombstone marker.
   * For proper deletion, consider using DynamoDB for session index
   * (hybrid architecture).
   */
  async delete(namespace: string, key: string): Promise<boolean> {
    const cacheKey = this.getCacheKey(namespace, key);

    // Check if key exists first
    const exists = await this.get(namespace, key);
    if (exists === null) {
      return false;
    }

    // Invalidate cache
    this.cache.delete(cacheKey);

    // Store a tombstone marker (soft delete)
    const client = this.getClient();
    const actorId = this.buildActorId(namespace);
    const sessionId = this.buildKvSessionId(key);

    const blobData: DocumentType = {
      _type: "tombstone",
      deletedAt: new Date().toISOString(),
    };
    const command = new CreateEventCommand({
      memoryId: this.getMemoryId(),
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload: [
        {
          blob: blobData,
        },
      ],
    });

    await client.send(command);
    return true;
  }

  /**
   * List all keys in a namespace by listing sessions.
   */
  async list(namespace: string, prefix?: string): Promise<string[]> {
    const client = this.getClient();
    const actorId = this.buildActorId(namespace);
    const keys: string[] = [];
    let nextToken: string | undefined;

    do {
      const command = new ListSessionsCommand({
        memoryId: this.getMemoryId(),
        actorId,
        maxResults: 100,
        nextToken,
      });

      const response = await client.send(command);
      const sessions = response.sessionSummaries ?? [];

      for (const session of sessions) {
        if (session.sessionId?.startsWith(KV_SESSION_PREFIX)) {
          const key = session.sessionId.slice(KV_SESSION_PREFIX.length);
          if (!prefix || key.startsWith(prefix)) {
            keys.push(key);
          }
        }
      }

      nextToken = response.nextToken;
    } while (nextToken);

    return keys;
  }

  /**
   * Atomically update a value.
   *
   * Note: AgentCore Memory doesn't support true atomic updates,
   * so we use a read-modify-write pattern. For distributed scenarios,
   * consider using DynamoDB with conditional writes instead.
   */
  async update<T>(
    namespace: string,
    key: string,
    updater: (value: T | null) => T | null,
  ): Promise<T | null> {
    // Read current value (skip cache to get latest)
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
   * Append a line to a transcript session.
   */
  async append(namespace: string, key: string, line: string): Promise<void> {
    const client = this.getClient();
    const actorId = this.buildActorId(namespace);
    const sessionId = this.buildTranscriptSessionId(key);

    // Store the line as a text string to avoid AWS SDK DocumentType serialization issues
    // AWS SDK may serialize nested objects as Python dict format instead of JSON
    const blobData: DocumentType = { _type: "line", text: line };

    const command = new CreateEventCommand({
      memoryId: this.getMemoryId(),
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload: [
        {
          blob: blobData,
        },
      ],
    });

    await client.send(command);
  }

  /**
   * Append a conversational message to enable Long-term Memory extraction.
   *
   * Uses AgentCore's conversational payload format which enables:
   * - Semantic understanding of conversation flow
   * - Automatic extraction of facts, summaries, and insights
   * - Long-term Memory record generation
   *
   * Also stores the line in blob format for transcript recovery.
   */
  async appendConversational(
    namespace: string,
    key: string,
    role: "user" | "assistant",
    content: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const client = this.getClient();
    const actorId = this.buildActorId(namespace);
    const sessionId = this.buildTranscriptSessionId(key);

    // Map role to AgentCore format (uppercase)
    const agentCoreRole = role === "user" ? "USER" : "ASSISTANT";

    // Build metadata with timestamp if not provided
    const eventMetadata: Record<string, { value: string }> = {};
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        eventMetadata[k] = { value: v };
      }
    }
    if (!eventMetadata.timestamp) {
      eventMetadata.timestamp = { value: new Date().toISOString() };
    }

    // Build transcript entry for recovery (same format as append)
    const transcriptEntry = {
      type: "message",
      id: `${role}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: {
        role,
        content: [{ type: "text", text: content }],
        timestamp: Date.now(),
      },
    };

    const command = new CreateEventCommand({
      memoryId: this.getMemoryId(),
      actorId,
      sessionId,
      eventTimestamp: new Date(),
      // Use both conversational (for Long-term Memory) and blob (for transcript recovery)
      payload: [
        {
          conversational: {
            role: agentCoreRole,
            content: { text: content },
          },
        },
        {
          blob: { _type: "line", text: JSON.stringify(transcriptEntry) },
        },
      ],
      metadata: Object.keys(eventMetadata).length > 0 ? eventMetadata : undefined,
    });

    await client.send(command);
  }

  /**
   * Read all lines from a transcript session.
   */
  async *readLines(namespace: string, key: string): AsyncIterable<string> {
    const client = this.getClient();
    const actorId = this.buildActorId(namespace);
    const sessionId = this.buildTranscriptSessionId(key);
    let nextToken: string | undefined;

    try {
      do {
        const command = new ListEventsCommand({
          memoryId: this.getMemoryId(),
          actorId,
          sessionId,
          maxResults: 100,
          includePayloads: true,
          nextToken,
        });

        const response = await client.send(command);
        const events = response.events ?? [];

        for (const event of events as Event[]) {
          const payload = event.payload?.[0];
          if (!payload?.blob) {
            continue;
          }

          // blob may be a string (from SDK) or a parsed object
          if (typeof payload.blob === "string") {
            // AWS SDK returns blob as Python dict format string
            // Try to extract embedded JSON from text= field
            const extracted = extractJsonFromPythonDict(payload.blob);
            if (extracted) {
              yield extracted;
              continue;
            }
            // Could not extract, yield as-is (might be plain text or old format)
            yield payload.blob;
            continue;
          }

          // blob is already an object (parsed by SDK)
          const blob = payload.blob as Record<string, unknown>;

          // Convert blob back to JSON line
          let line: string;
          if (blob._type === "line") {
            if (blob.text !== undefined && typeof blob.text === "string") {
              // Text wrapper format (preferred)
              line = blob.text;
            } else if (blob.data !== undefined) {
              // JSON data format (legacy)
              line = typeof blob.data === "string" ? blob.data : JSON.stringify(blob.data);
            } else {
              continue;
            }
          } else {
            // Legacy or direct format
            line = JSON.stringify(blob);
          }

          if (line.trim()) {
            yield line.trim();
          }
        }

        nextToken = response.nextToken;
      } while (nextToken);
    } catch (err) {
      const errorCode = err && typeof err === "object" && "name" in err ? String(err.name) : null;

      // Session not found means no lines exist
      if (errorCode === "ResourceNotFoundException") {
        return;
      }
      throw err;
    }
  }

  /**
   * Get the memory ARN.
   */
  getMemoryArn(): string {
    return this.memoryArn;
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Create an AgentCoreMemoryBackend with the given configuration.
 */
export function createAgentCoreMemoryBackend(
  config: AgentCoreMemoryBackendConfig,
): AgentCoreMemoryBackend {
  return new AgentCoreMemoryBackend(config);
}
