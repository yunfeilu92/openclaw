/**
 * Transcript URI utilities for hybrid storage.
 *
 * Transcript locations can be:
 * - Local file path: /Users/xxx/.openclaw/sessions/abc.jsonl
 * - AgentCore URI: agentcore://{memoryArn}/{sessionId}
 *
 * This module provides utilities for parsing and building these URIs.
 */

import type { StorageConfig } from "../config/types.storage.js";
import { createStorageService } from "./storage-service.js";
import { StorageNamespaces } from "./types.js";

const AGENTCORE_SCHEME = "agentcore://";

/**
 * Parsed transcript URI.
 */
export type ParsedTranscriptUri =
  | { type: "file"; path: string }
  | { type: "agentcore"; memoryArn: string; sessionId: string };

/**
 * Check if a string is an AgentCore URI.
 */
export function isAgentCoreUri(uri: string | undefined): boolean {
  return typeof uri === "string" && uri.startsWith(AGENTCORE_SCHEME);
}

/**
 * Parse a transcript URI into its components.
 *
 * @param uri - The URI string (file path or agentcore:// URI)
 * @returns Parsed URI components
 */
export function parseTranscriptUri(uri: string): ParsedTranscriptUri {
  if (isAgentCoreUri(uri)) {
    // Format: agentcore://{memoryArn}/{sessionId}
    // Example: agentcore://arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/mem-xxx/session-abc
    const withoutScheme = uri.slice(AGENTCORE_SCHEME.length);
    const lastSlash = withoutScheme.lastIndexOf("/");
    if (lastSlash === -1) {
      throw new Error(`Invalid AgentCore URI: missing sessionId in ${uri}`);
    }
    const memoryArn = withoutScheme.slice(0, lastSlash);
    const sessionId = withoutScheme.slice(lastSlash + 1);
    if (!memoryArn || !sessionId) {
      throw new Error(`Invalid AgentCore URI: ${uri}`);
    }
    return { type: "agentcore", memoryArn, sessionId };
  }
  return { type: "file", path: uri };
}

/**
 * Build an AgentCore transcript URI.
 *
 * @param memoryArn - The AgentCore Memory ARN
 * @param sessionId - The session ID
 * @returns The agentcore:// URI
 */
export function buildAgentCoreTranscriptUri(memoryArn: string, sessionId: string): string {
  return `${AGENTCORE_SCHEME}${memoryArn}/${sessionId}`;
}

/**
 * Read transcript messages from a URI (file or AgentCore).
 *
 * @param uri - The transcript URI
 * @param storageConfig - Storage configuration (for AgentCore backend)
 * @returns Array of parsed message objects
 */
export async function readTranscriptMessagesFromUri(
  uri: string,
  storageConfig?: StorageConfig,
): Promise<unknown[]> {
  const parsed = parseTranscriptUri(uri);

  if (parsed.type === "file") {
    // Local file - use synchronous file reading (existing behavior)
    const fs = await import("node:fs");
    if (!fs.existsSync(parsed.path)) {
      return [];
    }
    const lines = fs.readFileSync(parsed.path, "utf-8").split(/\r?\n/);
    const messages: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry?.message) {
          messages.push(entry.message);
        }
      } catch {
        // ignore bad lines
      }
    }
    return messages;
  }

  // AgentCore URI - use storage backend
  if (!storageConfig) {
    return [];
  }

  // Use createStorageService instead of getStorageService to ensure
  // we use the correct config (singleton may have been created with different config)
  const storageService = createStorageService(storageConfig);
  await storageService.initialize();
  const backend = storageService.getBackend(StorageNamespaces.TRANSCRIPTS);
  const messages: unknown[] = [];

  for await (const line of backend.readLines(StorageNamespaces.TRANSCRIPTS, parsed.sessionId)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry?.message) {
        messages.push(entry.message);
      }
    } catch {
      // ignore bad lines
    }
  }

  // AgentCore ListEvents returns newest-first; reverse to chronological order.
  messages.reverse();
  return messages;
}

/**
 * Check if transcript storage should use AgentCore based on configuration.
 */
export function shouldUseAgentCoreTranscripts(storageConfig?: StorageConfig): boolean {
  if (!storageConfig) {
    return false;
  }
  const storageType = storageConfig.type;
  if (storageType === "agentcore" || storageType === "hybrid") {
    // Check if transcripts are explicitly set to local
    const transcriptsClassification = storageConfig.dataClassification?.transcripts;
    if (transcriptsClassification === "local") {
      return false;
    }
    // Check if AgentCore is configured
    return !!storageConfig.agentcore?.memoryArn;
  }
  return false;
}
