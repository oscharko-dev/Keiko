import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_PROFILE,
  type ContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";
import { conversationForGatewayWithCompaction } from "./conversation-compaction.js";
import type { ChatMessage } from "./store/index.js";

const NON_PATTERN_SECRET = "customer-secret-ABC-1234567890";
const CURRENT_INSTRUCTION = "latest question";

function msg(role: ChatMessage["role"], content: string, index: number): ChatMessage {
  return {
    id: `m${String(index)}`,
    chatId: "chat-1",
    role,
    content,
    timestamp: 1000 + index,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function structuredCompactionHistory(): ChatMessage[] {
  const huge = "x".repeat(420_000);
  return [
    msg(
      "user",
      `Fact: prompt assembly is deterministic
Assumption: \`buildSummaryContent\` still owns every history compaction path
Decision: replace raw snippets with structured continuity fields
Constraint: do not route summarization around the Model Gateway
Open question: should #1727 persist these records?
TypeError: failed at packages/keiko-server/src/conversation-compaction.ts:42
Call \`buildStructuredCompactionDigest\` before buildSummaryContent()
secret ${NON_PATTERN_SECRET}
${huge}`,
      0,
    ),
    msg("assistant", "acknowledged", 1),
    msg("user", CURRENT_INSTRUCTION, 2),
  ];
}

function compactStructuredHistory(): ReturnType<typeof conversationForGatewayWithCompaction> {
  return conversationForGatewayWithCompaction(structuredCompactionHistory(), {
    contextProfile: DEFAULT_CONTEXT_PROFILE,
    redactionSecrets: [NON_PATTERN_SECRET],
  });
}

function requiredCompaction(
  outcome: ReturnType<typeof conversationForGatewayWithCompaction>,
): ContextCompactionRecord {
  const record = outcome.compaction;
  if (record === undefined) {
    throw new Error("expected compaction record");
  }
  return record;
}

function requiredSystemContent(
  outcome: ReturnType<typeof conversationForGatewayWithCompaction>,
): string {
  const message = outcome.messages[0];
  if (message === undefined) {
    throw new Error("expected system-scoped compaction message");
  }
  expect(message.role).toBe("system");
  return message.content;
}

describe("conversationForGatewayWithCompaction — structured continuity summaries", () => {
  it("retains durable facts, decisions, constraints, questions, files, symbols, and references", () => {
    const outcome = compactStructuredHistory();
    const summary = requiredSystemContent(outcome);
    const record = requiredCompaction(outcome);
    const facts = (record.preservedFacts ?? []).map((fact) => fact.statement);
    expect(summary).toContain("Decisions:");
    expect(summary).toContain("Files:");
    expect(summary).not.toContain(NON_PATTERN_SECRET);
    expect(summary).not.toContain("x".repeat(200));
    expect(facts).toEqual(
      expect.arrayContaining([
        "prompt assembly is deterministic",
        "Referenced symbol: buildStructuredCompactionDigest",
        "Referenced symbol: buildSummaryContent",
      ]),
    );
    expect(record.decisions).toContain("replace raw snippets with structured continuity fields");
    expect(record.userConstraints?.[0]?.statement).toBe(
      "do not route summarization around the Model Gateway",
    );
    expect(record.openQuestions).toContain("should #1727 persist these records?");
    expect(record.filesInspected).toContain("packages/keiko-server/src/conversation-compaction.ts");
    expect(record.failingTests?.[0]).toContain("conversation-compaction.ts:42");
  });

  it("keeps assumptions out of preserved facts", () => {
    const record = requiredCompaction(compactStructuredHistory());
    const facts = (record.preservedFacts ?? []).map((fact) => fact.statement);
    expect(record.assumptions?.[0]?.statement).toContain("buildSummaryContent");
    expect(facts.some((statement) => statement.includes("still owns every"))).toBe(false);
  });
});
