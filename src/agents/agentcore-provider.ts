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
 * Extract the text value from a Python dict string like:
 *   {'role': 'assistant', 'content': [{'text': "Hello, I'm ..."}]}
 *
 * Handles both single- and double-quoted text values.
 * Returns null if the pattern doesn't match.
 */
function extractTextFromPythonDict(s: string): string | null {
  // Match 'text': "..." (double-quoted — Python uses this when the string contains apostrophes)
  const dq = s.match(/'text'\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (dq) {
    return dq[1];
  }
  // Match 'text': '...' (single-quoted)
  const sq = s.match(/'text'\s*:\s*'((?:[^'\\]|\\.)*)'/);
  if (sq) {
    return sq[1];
  }
  return null;
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
    // If response looks like a Python dict string, extract text via regex
    // (naive single→double quote replacement breaks on apostrophes like "I'm")
    if (responseVal.trim().startsWith("{")) {
      const extracted = extractTextFromPythonDict(responseVal);
      if (extracted) {
        return extracted;
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

      console.log(`[agentcore-debug][response-parse] raw body (first 500): ${body.slice(0, 500)}`);
      try {
        const result = JSON.parse(body) as Record<string, unknown>;
        console.log(
          `[agentcore-debug][response-parse] JSON parsed OK, keys=${Object.keys(result).join(",")}, response type=${typeof result.response}, content type=${typeof result.content}`,
        );
        responseText = extractResponseText(result);
        console.log(
          `[agentcore-debug][response-parse] extractResponseText result (first 200): ${responseText.slice(0, 200)}`,
        );
      } catch {
        // body might be a raw Python dict string (single quotes, not valid JSON).
        // Try to extract text content before falling back to the raw string.
        const extracted = extractTextFromPythonDict(body);
        console.log(
          `[agentcore-debug][response-parse] JSON parse failed, pythonDict extraction=${extracted ? "OK" : "null"}`,
        );
        responseText = extracted ?? body;
      }
    }

    const durationMs = Date.now() - started;
    log.info(`agentcore invoke complete: session=${sessionKey} duration=${durationMs}ms`);

    // Emit assistant text immediately so webchat/TUI clients see the response.
    if (params.runId && responseText) {
      log.info(
        `agentcore emitting assistant text: runId=${params.runId} textLen=${responseText.length}`,
      );
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: responseText },
      });
    }

    // Write transcript to storage BEFORE emitting lifecycle "end".
    // The webchat reloads chat.history on "end", so the data must be persisted first.
    // Use sessionId (unique per session, changes on /new) not sessionKey (stable per user/channel)
    const storageConfig = params.config?.storage;
    const isCloudStorage = storageConfig?.type === "hybrid" || storageConfig?.type === "agentcore";
    const transcriptSessionId = params.sessionId || rawSessionKey;
    if (isCloudStorage && responseText) {
      await writeTranscriptToStorage(
        params,
        storageConfig,
        transcriptSessionId,
        responseText,
        started,
      );
    }

    // Emit lifecycle "end" AFTER transcript is persisted so chat.history sees the data.
    if (params.runId) {
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
 * Persist user + assistant messages to cloud storage (background, best-effort).
 */
async function writeTranscriptToStorage(
  params: RunEmbeddedPiAgentParams,
  storageConfig: NonNullable<RunEmbeddedPiAgentParams["config"]>["storage"],
  transcriptSessionId: string,
  responseText: string,
  started: number,
): Promise<void> {
  try {
    const storageService = getStorageService(storageConfig);
    await storageService.initialize();
    const backend = storageService.getBackend(StorageNamespaces.TRANSCRIPTS);

    const supportsConversational = typeof backend.appendConversational === "function";
    console.log(
      `[agentcore-debug][provider.writeTranscript] transcriptSessionId=${transcriptSessionId} supportsConversational=${supportsConversational} backendType=${backend.type} promptLen=${params.prompt.length} responseLen=${responseText.length}`,
    );

    if (supportsConversational) {
      await backend.appendConversational!(
        StorageNamespaces.TRANSCRIPTS,
        transcriptSessionId,
        "user",
        params.prompt,
        { source: "webchat" },
      );
      await backend.appendConversational!(
        StorageNamespaces.TRANSCRIPTS,
        transcriptSessionId,
        "assistant",
        responseText,
        { source: "agentcore" },
      );
    } else {
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
    console.log(
      `[agentcore-debug][provider.writeTranscript] updating session entry: memoryArn=${memoryArn ?? "none"} sessionKey=${params.sessionKey ?? "none"}`,
    );
    if (memoryArn && params.sessionKey) {
      try {
        const sessionFileUri = buildAgentCoreTranscriptUri(memoryArn, transcriptSessionId);
        console.log(`[agentcore-debug][provider.writeTranscript] sessionFileUri=${sessionFileUri}`);
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

/**
 * Check if AgentCore is configured and should be used.
 */
export function shouldUseAgentCore(config?: {
  agents?: { defaults?: { runtime?: string } };
}): boolean {
  return config?.agents?.defaults?.runtime === "agentcore";
}
