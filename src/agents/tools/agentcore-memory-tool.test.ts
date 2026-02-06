import { describe, expect, it, vi } from "vitest";
import { createAgentCoreMemoryRecallTool } from "./agentcore-memory-tool.js";

describe("agentcore_memory_recall tool", () => {
  it("returns null when config is missing", () => {
    const tool = createAgentCoreMemoryRecallTool({});
    expect(tool).toBeNull();
  });

  it("returns null when storage.agentcore.memoryArn is missing", () => {
    const tool = createAgentCoreMemoryRecallTool({ config: {} });
    expect(tool).toBeNull();
  });

  it("returns null when memoryArn format is invalid", () => {
    const tool = createAgentCoreMemoryRecallTool({
      config: { storage: { agentcore: { memoryArn: "not-a-valid-arn" } } },
    });
    expect(tool).toBeNull();
  });

  it("creates tool when memoryArn is valid", () => {
    const tool = createAgentCoreMemoryRecallTool({
      config: {
        storage: {
          agentcore: {
            memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test-mem-id",
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("agentcore_memory_recall");
  });

  it("returns formatted results on successful API call", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      memoryRecords: [
        { content: { text: "User prefers dark mode" }, score: 0.92, recordId: "rec-1" },
        { content: { text: "Last project was a CLI tool" }, score: 0.78, recordId: "rec-2" },
        { content: { text: "" }, score: 0.1, recordId: "rec-3" },
        { content: undefined, score: 0.05, recordId: "rec-4" },
      ],
    });

    vi.doMock("@aws-sdk/client-bedrock-agentcore", () => {
      return {
        BedrockAgentCoreClient: class {
          send = mockSend;
        },
        RetrieveMemoryRecordsCommand: class {
          constructor(public input: unknown) {}
        },
      };
    });

    // Re-import to pick up the mock (force fresh module)
    const { createAgentCoreMemoryRecallTool: create } = await import("./agentcore-memory-tool.js");
    const tool = create({
      config: {
        storage: {
          agentcore: {
            memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test-mem-id",
          },
        },
      },
    });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call_1", { query: "user preferences" });
    const details = result.details as {
      results: Array<{ text: string; score?: number; id?: string }>;
      count: number;
      query: string;
    };
    // Empty text and undefined content records should be filtered out
    expect(details.count).toBe(2);
    expect(details.query).toBe("user preferences");
    expect(details.results[0]).toEqual({
      text: "User prefers dark mode",
      score: 0.92,
      id: "rec-1",
    });
    expect(details.results[1]).toEqual({
      text: "Last project was a CLI tool",
      score: 0.78,
      id: "rec-2",
    });

    vi.doUnmock("@aws-sdk/client-bedrock-agentcore");
  });

  it("returns error object instead of throwing on API failure", async () => {
    const mockFailSend = vi.fn().mockRejectedValue(new Error("AccessDeniedException"));
    vi.doMock("@aws-sdk/client-bedrock-agentcore", () => {
      return {
        BedrockAgentCoreClient: class {
          send = mockFailSend;
        },
        RetrieveMemoryRecordsCommand: class {
          constructor(public input: unknown) {}
        },
      };
    });

    const { createAgentCoreMemoryRecallTool: create } = await import("./agentcore-memory-tool.js");
    const tool = create({
      config: {
        storage: {
          agentcore: {
            memoryArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/test-mem-id",
          },
        },
      },
    });
    expect(tool).not.toBeNull();

    const result = await tool!.execute("call_2", { query: "anything" });
    const details = result.details as { results: unknown[]; error: string; query: string };
    expect(details.results).toEqual([]);
    expect(details.error).toBe("AccessDeniedException");
    expect(details.query).toBe("anything");

    vi.doUnmock("@aws-sdk/client-bedrock-agentcore");
  });
});
