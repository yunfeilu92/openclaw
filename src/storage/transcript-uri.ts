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
 * Sanitize a message that may contain a raw Python dict string as its text content.
 * AgentCore sometimes returns responses like:
 *   {'role': 'assistant', 'content': [{'text': "Hello, I'm ..."}]}
 * If this was stored verbatim, extract the actual text on read.
 */
function sanitizePythonDictContent(message: Record<string, unknown>): void {
  if (!Array.isArray(message.content)) {
    return;
  }
  for (const part of message.content as Array<Record<string, unknown>>) {
    if (typeof part?.text !== "string") {
      continue;
    }
    const text = (part.text as string).trim();
    if (!text.startsWith("{") || !text.includes("'text'")) {
      continue;
    }
    // Try double-quoted value first (Python uses this when text contains apostrophes)
    const dq = text.match(/'text'\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (dq) {
      part.text = dq[1];
      continue;
    }
    // Try single-quoted value
    const sq = text.match(/'text'\s*:\s*'((?:[^'\\]|\\.)*)'/);
    if (sq) {
      part.text = sq[1];
    }
  }
}

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
  console.log(
    `[agentcore-debug][transcript-uri] readTranscriptMessagesFromUri: type=${parsed.type} uri=${uri}`,
  );

  if (parsed.type === "file") {
    // Local file - use synchronous file reading (existing behavior)
    const fs = await import("node:fs");
    if (!fs.existsSync(parsed.path)) {
      console.log(`[agentcore-debug][transcript-uri] file not found: ${parsed.path}`);
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
          sanitizePythonDictContent(entry.message as Record<string, unknown>);
          messages.push(entry.message);
        }
      } catch {
        // ignore bad lines
      }
    }
    console.log(
      `[agentcore-debug][transcript-uri] file read: ${messages.length} messages from ${parsed.path}`,
    );
    return messages;
  }

  // AgentCore URI - use storage backend
  if (!storageConfig) {
    console.log(`[agentcore-debug][transcript-uri] no storageConfig, returning empty`);
    return [];
  }

  console.log(
    `[agentcore-debug][transcript-uri] reading from AgentCore: memoryArn=${parsed.memoryArn} sessionId=${parsed.sessionId}`,
  );
  // Use createStorageService instead of getStorageService to ensure
  // we use the correct config (singleton may have been created with different config)
  const storageService = createStorageService(storageConfig);
  await storageService.initialize();
  const backend = storageService.getBackend(StorageNamespaces.TRANSCRIPTS);
  const messages: unknown[] = [];
  let lineCount = 0;

  for await (const line of backend.readLines(StorageNamespaces.TRANSCRIPTS, parsed.sessionId)) {
    lineCount++;
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry?.message) {
        sanitizePythonDictContent(entry.message as Record<string, unknown>);
        const msg = entry.message as { role?: string };
        console.log(
          `[agentcore-debug][transcript-uri] line#${lineCount}: role=${msg.role ?? "unknown"} contentLen=${JSON.stringify(entry.message).length}`,
        );
        messages.push(entry.message);
      } else {
        console.log(
          `[agentcore-debug][transcript-uri] line#${lineCount}: no .message field, keys=${Object.keys(entry).join(",")}`,
        );
      }
    } catch {
      console.log(
        `[agentcore-debug][transcript-uri] line#${lineCount}: JSON parse failed, line=${line.slice(0, 120)}`,
      );
    }
  }

  console.log(
    `[agentcore-debug][transcript-uri] AgentCore read done: ${messages.length} messages from ${lineCount} lines (pre-reverse)`,
  );
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
