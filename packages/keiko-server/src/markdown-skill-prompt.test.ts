import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_PROFILE } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { createInMemoryUiStore } from "./store/index.js";
import { selectGatewayPromptAssembly } from "./chat-prompt-budget.js";
import type { ChatMessage } from "./store/types.js";

function skill(
  body: string,
): ReturnType<ReturnType<typeof createInMemoryUiStore>["markdownSkills"]["import"]> {
  const store = createInMemoryUiStore();
  try {
    return store.markdownSkills.import({
      fileName: "synthetic.md",
      contentBase64: Buffer.from(body).toString("base64"),
    });
  } finally {
    store.close();
  }
}
function history(): ChatMessage[] {
  return Array.from({ length: 16 }, (_, index): ChatMessage => ({
    id: `history-${String(index)}`,
    chatId: "synthetic-chat",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Previous turn ${String(index)}. ${"Bounded synthetic history. ".repeat(150)}`,
    timestamp: index,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  }));
}
const input = {
  historyPrefix: [],
  historyTurnCount: 0,
  request: { content: "Review this boundary.", discussionMode: undefined },
  profile: {
    ...DEFAULT_CONTEXT_PROFILE,
    maxInputTokens: 8192,
    effectiveInputBudget: 6000,
    reservedOutputTokens: 1800,
    safetyMarginTokens: 392,
  },
  memoryEntries: [],
  documentContext: [],
  redactionSecrets: [],
  proactiveCompaction: true,
} as const;

describe("mandatory selected skill prompt budgeting (#4024)", () => {
  it("preserves the complete body exactly once before and after automatic compaction", () => {
    const selected = skill(
      "# Synthetic method\nCheck the exceptional boundary first.\nKeep this exact Unicode: ü.\n",
    );
    const plain = selectGatewayPromptAssembly({ ...input, protectedSkill: selected });
    expect(plain?.messages.at(-1)?.content).toContain(selected.body);
    const previous = history();
    const compacted = selectGatewayPromptAssembly({
      ...input,
      historyPrefix: previous,
      historyTurnCount: previous.length,
      protectedSkill: selected,
    });
    expect(compacted?.compaction).toBeDefined();
    const prompt = JSON.stringify(compacted?.messages);
    expect(prompt.split(JSON.stringify(selected.body).slice(1, -1))).toHaveLength(2);
    expect(compacted?.compaction).not.toHaveProperty("skillBody");
    expect(compacted?.diagnostics.totalEstimatedTokens).toBe(
      countGatewayPromptTokens(
        { messages: compacted?.messages ?? [] },
        input.profile.tokenAccounting,
        { contextWindow: input.profile.maxInputTokens },
      ),
    );
  });

  it("refuses an oversized skill instead of truncating it or spending the output reserve", () => {
    const selected = skill("Required instruction. ".repeat(1800));
    expect(selectGatewayPromptAssembly({ ...input, protectedSkill: selected })).toBeUndefined();
    expect(selectGatewayPromptAssembly(input)).toBeDefined();
  });
});
