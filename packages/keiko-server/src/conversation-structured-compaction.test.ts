import { describe, expect, it } from "vitest";
import type { ContextCompactionRecord } from "@oscharko-dev/keiko-contracts";
import {
  CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
  DEFAULT_CONTEXT_PROFILE,
} from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { countGatewayPromptTokens } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import { validateContextCompactionRecord } from "@oscharko-dev/keiko-contracts/runtime/context-engineering-compaction-validation";
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

function oversizedDigestHistory(): ChatMessage[] {
  const fields = Array.from({ length: 16 }, (_, index) =>
    ["Fact", "Decision", "Constraint"]
      .map((kind) => `${kind}: Requirement ${String(index)} ${"durable information ".repeat(10)}`)
      .join("\n"),
  ).join("\n");
  return [
    msg(
      "user",
      `${fields}\nConstraint: Latest budget is 60000 EUR.\n${"Historical discussion. ".repeat(1500)}`,
      0,
    ),
    msg("assistant", "Understood.", 1),
    msg("user", "What budget applies now?", 2),
  ];
}

describe("conversationForGatewayWithCompaction — structured continuity summaries", () => {
  it("retains the complete canonical checkpoint across a squeezed turn and a roomy follow-up", () => {
    const prior = requiredCompaction(
      conversationForGatewayWithCompaction(oversizedDigestHistory(), {
        effectiveInputBudget: 6000,
      }),
    );
    const earlier: ContextCompactionRecord = {
      ...prior,
      modelSummary: {
        promptVersion: CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
        modelId: "fixture",
        content: "Earlier valid generated continuity. ".repeat(30).trim(),
        status: "valid",
        validationState: "accepted",
      },
    };
    const squeezed = conversationForGatewayWithCompaction([], {
      earlierCompaction: earlier,
      effectiveInputBudget: 900,
    });
    expect(countGatewayPromptTokens({ messages: squeezed.messages })).toBeLessThanOrEqual(900);
    expect(requiredCompaction(squeezed).modelSummary).toEqual(earlier.modelSummary);
    expect(requiredCompaction(squeezed).decisions).toEqual(earlier.decisions);
    expect(requiredCompaction(squeezed).preservedFacts).toEqual(earlier.preservedFacts);
    const roomy = conversationForGatewayWithCompaction([], {
      earlierCompaction: requiredCompaction(squeezed),
      effectiveInputBudget: 8000,
    });
    expect(requiredSystemContent(roomy)).toContain(
      requiredCompaction(squeezed).modelSummary?.content,
    );
    for (const decision of earlier.decisions ?? [])
      expect(requiredSystemContent(roomy)).toContain(decision);
  });

  it("folds additional old messages before omitting valid model-written continuity", () => {
    const earlier: ContextCompactionRecord = {
      ...requiredCompaction(compactStructuredHistory()),
      modelSummary: {
        promptVersion: CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
        modelId: "fixture",
        content: "Retain this valid model-written continuity. ".repeat(20).trim(),
        status: "valid",
        validationState: "accepted",
      },
    };
    const tail = Array.from({ length: 12 }, (_, index) =>
      msg(
        index % 2 === 0 ? "user" : "assistant",
        "Ordinary earlier discussion. ".repeat(100),
        index + 10,
      ),
    );
    tail.push(msg("user", "Current question stays verbatim.", 30));
    const full = conversationForGatewayWithCompaction(tail, { earlierCompaction: earlier });
    const budget = countGatewayPromptTokens({ messages: full.messages }) - 400;
    const result = conversationForGatewayWithCompaction(tail, {
      earlierCompaction: earlier,
      effectiveInputBudget: budget,
    });
    expect(countGatewayPromptTokens({ messages: result.messages })).toBeLessThanOrEqual(budget);
    expect(requiredSystemContent(result)).toContain(earlier.modelSummary?.content);
    expect(requiredCompaction(result).itemsBefore).toBeGreaterThan(earlier.itemsBefore);
    expect(result.messages.at(-1)?.content).toBe("Current question stays verbatim.");
  });

  it("fits an oversized digest honestly while retaining the newest constraints", () => {
    const outcome = conversationForGatewayWithCompaction(oversizedDigestHistory(), {
      effectiveInputBudget: 900,
    });
    const record = requiredCompaction(outcome);
    expect(countGatewayPromptTokens({ messages: outcome.messages })).toBeLessThanOrEqual(900);
    expect(requiredSystemContent(outcome)).toContain("60000 EUR");
    expect(record.droppedCategories?.length).toBeGreaterThan(0);
    expect(validateContextCompactionRecord(record).ok).toBe(true);
    expect(outcome.omittedSummaryCategories).toContain("preservedFacts-requires-rehydration");
    const roomy = conversationForGatewayWithCompaction([], {
      earlierCompaction: record,
      effectiveInputBudget: 8000,
    });
    for (const fact of record.preservedFacts ?? [])
      expect(requiredSystemContent(roomy)).toContain(fact.statement);
    for (const constraint of record.userConstraints ?? [])
      expect(requiredSystemContent(roomy)).toContain(constraint.statement);
    expect(record.sourceSpans).toContainEqual({ kind: "message", stableId: "m0" });
  });

  it("refits an earlier checkpoint even when no new historical turns exist", () => {
    const record = requiredCompaction(
      conversationForGatewayWithCompaction(oversizedDigestHistory(), {
        effectiveInputBudget: 6000,
      }),
    );
    const earlier = {
      ...record,
      modelSummary: {
        promptVersion: CONTEXT_COMPACTION_MODEL_SUMMARY_PROMPT_VERSION,
        modelId: "fixture",
        content: "Older generated continuity. ".repeat(30).trim(),
      },
    };
    const outcome = conversationForGatewayWithCompaction([], {
      earlierCompaction: earlier,
      effectiveInputBudget: 900,
    });
    expect(countGatewayPromptTokens({ messages: outcome.messages })).toBeLessThanOrEqual(900);
    expect(requiredSystemContent(outcome)).toContain("60000 EUR");
    expect(requiredCompaction(outcome).itemsBefore).toBe(record.itemsBefore);
    expect(requiredCompaction(outcome).conversationCoverage).toEqual(record.conversationCoverage);
    expect(requiredCompaction(outcome).modelSummary).toEqual(earlier.modelSummary);
    expect(requiredSystemContent(outcome)).not.toContain(earlier.modelSummary.content);
    expect(outcome.omittedSummaryCategories).toContain(
      "model-written-continuity-requires-rehydration",
    );
    expect(validateContextCompactionRecord(requiredCompaction(outcome)).ok).toBe(true);
  });
  it("preserves unlabelled German requirements with durable message provenance", () => {
    const history = [
      msg(
        "user",
        "Das Budget darf 75000 EUR nicht überschreiten.\nWir speichern Kundendokumente ausschließlich lokal.\n" +
          "Older general discussion. ".repeat(2000),
        0,
      ),
      msg("assistant", "Die Planung geht weiter.", 1),
      msg("user", "Welche Budgetgrenze gilt?", 2),
    ];
    const outcome = conversationForGatewayWithCompaction(history, { effectiveInputBudget: 2_000 });
    expect(requiredSystemContent(outcome)).toContain("75000 EUR");
    expect(requiredSystemContent(outcome)).toContain("ausschließlich lokal");
    expect(requiredCompaction(outcome).sourceSpans).toContainEqual({
      kind: "message",
      stableId: "m0",
    });
  });

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
