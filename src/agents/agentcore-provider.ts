/**
 * AgentCore Provider for OpenClaw.
 *
 * This provider enables OpenClaw to use AWS Bedrock AgentCore Runtime
 * as an alternative execution backend, providing enterprise features:
 * - Serverless scaling
 * - Managed memory
 * - Built-in observability
 * - Secure code execution
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { getStorageService } from "../storage/storage-service.js";
import { buildAgentCoreTranscriptUri } from "../storage/transcript-uri.js";
import { StorageNamespaces } from "../storage/types.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { log } from "./pi-embedded-runner/logger.js";

// AgentCore configuration from environment
const AGENTCORE_RUNTIME_ARN =
  process.env.AGENTCORE_RUNTIME_ARN ||
  "arn:aws:bedrock-agentcore:us-east-1:497892281794:runtime/openclaw_agentcore_demo-mgBuCB6xv5";
const AGENTCORE_REGION = process.env.AWS_REGION || "us-east-1";

// Minimum session key length required by AgentCore
const MIN_SESSION_KEY_LENGTH = 33;

let _client: BedrockAgentCoreClient | null = null;

function getClient(): BedrockAgentCoreClient {
  if (!_client) {
    _client = new BedrockAgentCoreClient({
      region: AGENTCORE_REGION,
    });
  }
  return _client;
}

/**
 * Ensure session key meets AgentCore's minimum length requirement.
 * Uses deterministic padding so the same input always produces the same output.
 */
function ensureSessionKeyLength(sessionKey: string): string {
  if (sessionKey.length >= MIN_SESSION_KEY_LENGTH) {
    return sessionKey;
  }
  // Pad with deterministic suffix (repeating the key hash)
  const needed = MIN_SESSION_KEY_LENGTH - sessionKey.length;
  const padding = "-openclaw-agentcore-session-pad".slice(0, needed);
  return sessionKey + padding;
}

/**
 * Extract response text from AgentCore's various response formats.
 *
 * AgentCore may return responses in different formats:
 * 1. {"response": "plain text"}
 * 2. {"response": "{'role': 'assistant', 'content': [{'text': '...'}]}"}
 * 3. {"content": [{"text": "..."}]}
 */
function extractResponseText(result: Record<string, unknown>): string {
  // Check for content array format (Claude response format)
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (typeof item === "object" && item !== null && "text" in item) {
        return String((item as { text: unknown }).text);
      }
    }
  }

  // Check response key
  const responseVal = result.response;
  if (responseVal && typeof responseVal === "string") {
    // If response looks like a Python dict string, try to parse it
    if (responseVal.trim().startsWith("{")) {
      try {
        // Convert Python dict syntax to JSON (single quotes to double quotes)
        const jsonStr = responseVal.replace(/'/g, '"');
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        return extractResponseText(parsed);
      } catch {
        // Not valid JSON, return as-is
      }
    }
    return responseVal;
  }

  // Fallback to text key or string representation
  if (typeof result.text === "string") {
    return result.text;
  }

  return JSON.stringify(result);
}

/**
 * Run an agent turn using AgentCore Runtime.
 *
 * This function provides the same interface as runEmbeddedPiAgent
 * but delegates execution to AWS Bedrock AgentCore.
 */
export async function runAgentCoreAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  const started = Date.now();
  const client = getClient();

  // Build session key (must be at least 33 characters)
  const rawSessionKey = params.sessionKey || params.sessionId;
  const sessionKey = ensureSessionKeyLength(rawSessionKey);

  // Build AgentCore payload
  const payload = {
    prompt: params.prompt,
    session_id: sessionKey,
    context: {
      channel: params.messageChannel || params.messageProvider || "api",
      agent_id: params.agentAccountId || "main",
      sender_id: params.senderId || undefined,
      is_group: !!params.groupId,
      group_id: params.groupId || undefined,
    },
  };

  log.info(
    `agentcore invoke start: session=${sessionKey} channel=${payload.context.channel} runId=${params.runId || "none"}`,
  );

  // Emit lifecycle start event
  if (params.runId) {
    log.info(`agentcore emitting lifecycle start: runId=${params.runId}`);
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: started },
    });
  } else {
    log.warn(`agentcore: no runId provided, events will not be emitted`);
  }

  try {
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENTCORE_RUNTIME_ARN,
      runtimeSessionId: sessionKey,
      payload: Buffer.from(JSON.stringify(payload)),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await client.send(command);

    // Parse response from StreamingBody
    let responseText = "";
    if (response.response) {
      // response is a Readable stream or has transformToString
      let body: string;
      if (
        typeof (response.response as { transformToString?: unknown }).transformToString ===
        "function"
      ) {
        body = await (
          response.response as { transformToString: () => Promise<string> }
        ).transformToString();
      } else if (typeof (response.response as { read?: unknown }).read === "function") {
        // Node.js stream
        const chunks: Buffer[] = [];
        for await (const chunk of response.response as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks).toString("utf-8");
      } else {
        body = String(response.response);
      }

      try {
        const result = JSON.parse(body) as Record<string, unknown>;
        responseText = extractResponseText(result);
      } catch {
        responseText = body;
      }
    }

    const durationMs = Date.now() - started;
    log.info(`agentcore invoke complete: session=${sessionKey} duration=${durationMs}ms`);

    // Write transcript to storage service if cloud storage is configured
    const storageConfig = params.config?.storage;
    const isCloudStorage = storageConfig?.type === "hybrid" || storageConfig?.type === "agentcore";
    if (isCloudStorage && responseText) {
      try {
        const storageService = getStorageService(storageConfig);
        await storageService.initialize();
        const backend = storageService.getBackend(StorageNamespaces.TRANSCRIPTS);
        const transcriptSessionId = rawSessionKey;

        // Use appendConversational if available (enables Long-term Memory extraction)
        const supportsConversational = typeof backend.appendConversational === "function";

        if (supportsConversational) {
          // Write user message with conversational format for Long-term Memory
          await backend.appendConversational!(
            StorageNamespaces.TRANSCRIPTS,
            transcriptSessionId,
            "user",
            params.prompt,
            { source: "webchat" },
          );

          // Write assistant response with conversational format
          await backend.appendConversational!(
            StorageNamespaces.TRANSCRIPTS,
            transcriptSessionId,
            "assistant",
            responseText,
            { source: "agentcore" },
          );
        } else {
          // Fallback to blob format for backends that don't support conversational
          const userEntry = {
            type: "message",
            id: `user-${Date.now()}`,
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: params.prompt }],
              timestamp: started,
            },
          };
          await backend.append(
            StorageNamespaces.TRANSCRIPTS,
            transcriptSessionId,
            JSON.stringify(userEntry),
          );

          const assistantEntry = {
            type: "message",
            id: `assistant-${Date.now()}`,
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              content: [{ type: "text", text: responseText }],
              timestamp: Date.now(),
              stopReason: "stop",
              usage: { input: 0, output: 0, totalTokens: 0 },
            },
          };
          await backend.append(
            StorageNamespaces.TRANSCRIPTS,
            transcriptSessionId,
            JSON.stringify(assistantEntry),
          );
        }
        log.info(`agentcore transcript written to storage: session=${transcriptSessionId}`);

        // Update session entry with AgentCore URI so chat.history can read from it
        const memoryArn = storageConfig?.agentcore?.memoryArn || process.env.AGENTCORE_MEMORY_ARN;
        if (memoryArn && params.sessionKey) {
          try {
            const sessionFileUri = buildAgentCoreTranscriptUri(memoryArn, transcriptSessionId);
            const agentId = resolveSessionAgentId({
              sessionKey: params.sessionKey,
              config: params.config,
            });
            const storePath = resolveStorePath(params.config?.session?.store, { agentId });
            await updateSessionStore(storePath, (store) => {
              const entry = store[params.sessionKey!];
              if (entry) {
                entry.sessionFile = sessionFileUri;
                entry.updatedAt = Date.now();
              }
            });
            log.info(
              `agentcore session entry updated with URI: sessionKey=${params.sessionKey} sessionFile=${sessionFileUri}`,
            );
          } catch (updateErr) {
            log.warn(
              `agentcore session entry update failed: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
            );
          }
        }
      } catch (err) {
        log.warn(
          `agentcore transcript write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Emit agent events so webchat/TUI clients receive the response
    // (AgentCore doesn't emit streaming events like Pi, so we emit final events)
    if (params.runId) {
      // Emit assistant text
      if (responseText) {
        log.info(
          `agentcore emitting assistant text: runId=${params.runId} textLen=${responseText.length}`,
        );
        emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: responseText },
        });
      }
      // Emit lifecycle end
      log.info(`agentcore emitting lifecycle end: runId=${params.runId}`);
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "end", startedAt: started, endedAt: Date.now() },
      });
    }

    // Call streaming callbacks if provided
    if (params.onPartialReply) {
      await params.onPartialReply({ text: responseText });
    }
    if (params.onBlockReply) {
      await params.onBlockReply({ text: responseText });
    }

    return {
      payloads: [{ text: responseText }],
      meta: {
        durationMs,
        agentMeta: {
          sessionId: sessionKey,
          provider: "agentcore",
          model: "claude-3-5-sonnet",
        },
      },
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const errorMessage = error instanceof Error ? error.message : String(error);

    log.error(`agentcore invoke error: session=${sessionKey} error=${errorMessage}`);

    // Emit lifecycle error event
    if (params.runId) {
      emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: { phase: "error", startedAt: started, endedAt: Date.now(), error: errorMessage },
      });
    }

    return {
      payloads: [
        {
          text: `AgentCore Error: ${errorMessage}`,
          isError: true,
        },
      ],
      meta: {
        durationMs,
        agentMeta: {
          sessionId: sessionKey,
          provider: "agentcore",
          model: "unknown",
        },
        error: {
          kind: "agentcore_error",
          message: errorMessage,
        },
      },
    };
  }
}

/**
 * Check if AgentCore is configured and should be used.
 */
export function shouldUseAgentCore(config?: {
  agents?: { defaults?: { runtime?: string } };
}): boolean {
  return config?.agents?.defaults?.runtime === "agentcore";
}
