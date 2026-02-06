import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const AgentCoreMemoryRecallSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
});

/**
 * Parse an AgentCore Memory ARN to extract memoryId and region.
 * ARN format: arn:aws:bedrock-agentcore:REGION:ACCOUNT:memory/MEMORY_ID
 */
function parseMemoryArn(arn: string): { memoryId: string; region: string } | null {
  const match = arn.match(/^arn:aws:bedrock-agentcore:([^:]+):([^:]+):memory\/(.+)$/);
  if (!match) {
    return null;
  }
  return { region: match[1], memoryId: match[3] };
}

/**
 * Resolve the AWS region for AgentCore Memory.
 * Priority: config.storage.agentcore.region > AWS_REGION env > ARN region
 */
function resolveRegion(configRegion: string | undefined, arnRegion: string): string {
  return configRegion ?? process.env.AWS_REGION ?? arnRegion;
}

/** Drop records with no text; keep score for transparency but don't filter by threshold. */
function formatRecallResults(
  records: Array<{ content?: { text?: string }; score?: number; recordId?: string }>,
  query: string,
): { results: Array<{ text: string; score?: number; id?: string }>; count: number; query: string } {
  const results = records
    .filter((r) => r.content?.text?.trim())
    .map((r) => ({
      text: r.content!.text!.trim(),
      ...(r.score != null ? { score: r.score } : {}),
      ...(r.recordId ? { id: r.recordId } : {}),
    }));
  return { results, count: results.length, query };
}

export function createAgentCoreMemoryRecallTool(options: {
  config?: OpenClawConfig;
}): AnyAgentTool | null {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const memoryArn = cfg.storage?.agentcore?.memoryArn;
  if (!memoryArn) {
    return null;
  }
  const parsed = parseMemoryArn(memoryArn);
  if (!parsed) {
    return null;
  }
  const region = resolveRegion(cfg.storage?.agentcore?.region, parsed.region);
  const namespace = cfg.storage?.agentcore?.namespacePrefix ?? "default";

  return {
    label: "AgentCore Memory Recall",
    name: "agentcore_memory_recall",
    description:
      "Recall facts and knowledge from long-term memory (AgentCore). Use when local memory_search lacks results or when recalling cross-session context, user preferences, or previously extracted facts.",
    parameters: AgentCoreMemoryRecallSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults") ?? 10;
      try {
        const { BedrockAgentCoreClient, RetrieveMemoryRecordsCommand } =
          await import("@aws-sdk/client-bedrock-agentcore");
        const client = new BedrockAgentCoreClient({ region });
        const command = new RetrieveMemoryRecordsCommand({
          memoryId: parsed.memoryId,
          namespace,
          query: { text: query },
          maxResults,
        });
        const response = await client.send(command);
        const records = response.memoryRecords ?? [];
        return jsonResult(formatRecallResults(records, query));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ results: [], error: message, query });
      }
    },
  };
}
