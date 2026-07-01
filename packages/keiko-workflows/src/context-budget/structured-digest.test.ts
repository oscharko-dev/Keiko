import { describe, expect, it } from "vitest";

import {
  validateContextCompactionRecord,
  type ContextCompactionRecord,
} from "@oscharko-dev/keiko-contracts";

import {
  buildStructuredCompactionDigest,
  type StructuredCompactionEntry,
} from "./structured-digest.js";
import { buildCompactionRecords } from "./compaction.js";
import { allocateContext, type ContextLaneInput } from "./allocator.js";
import { DEFAULT_CONTEXT_BUDGET } from "./defaults.js";

const SECRET = "customer-secret-1726";

function entry(content: string): StructuredCompactionEntry {
  return { stableId: "message-1", role: "user" as const, content };
}

function compactedRecordFor(content: string): ContextCompactionRecord | undefined {
  const lanes: readonly ContextLaneInput[] = [
    {
      laneId: "history-summary",
      items: [
        { id: "kept", text: "current turn", score: 1 },
        { id: "dropped", text: content, score: 0 },
      ],
    },
  ];
  const result = allocateContext({
    profile: { ...DEFAULT_CONTEXT_BUDGET.profile, effectiveInputBudget: 10 },
    budget: DEFAULT_CONTEXT_BUDGET,
    lanes,
  });
  return buildCompactionRecords({
    result,
    lanes,
    provenance: new Map([["dropped", { kind: "message", stableId: "message-1" }]]),
    orderedAt: 1,
    digest: buildStructuredCompactionDigest({
      entries: [entry(content)],
      redactionSecrets: [SECRET],
    }),
  })[0];
}

describe("buildStructuredCompactionDigest", () => {
  it("extracts durable continuity fields from compacted conversation text", () => {
    const digest = buildStructuredCompactionDigest({
      entries: [
        entry(`Fact: allocator records are deterministic
Decision: use structured summaries instead of raw snippets
Constraint: do not route summarization around the Model Gateway
Open question: should persisted records rehydrate in #1727?
Touch packages/keiko-server/src/conversation-compaction.ts:42 and call buildSummaryContent()
`),
      ],
    });

    expect(digest.preservedFacts?.map((fact) => fact.statement)).toEqual(
      expect.arrayContaining([
        "allocator records are deterministic",
        "Referenced symbol: buildSummaryContent",
      ]),
    );
    expect(digest.decisions).toContain("use structured summaries instead of raw snippets");
    expect(digest.userConstraints?.[0]?.statement).toBe(
      "do not route summarization around the Model Gateway",
    );
    expect(digest.openQuestions).toContain("should persisted records rehydrate in #1727?");
    expect(digest.filesInspected).toContain("packages/keiko-server/src/conversation-compaction.ts");
    expect(digest.failingTests?.[0]).toContain("conversation-compaction.ts:42");
  });

  it("keeps explicit assumptions separate from preserved facts", () => {
    const digest = buildStructuredCompactionDigest({
      entries: [entry("Assumption: `buildSummaryContent` is still the active slow-path renderer")],
    });

    expect(digest.assumptions?.[0]?.statement).toBe(
      "`buildSummaryContent` is still the active slow-path renderer",
    );
    expect(digest.preservedFacts).toBeUndefined();
  });

  it("redacts secrets and records omitted unsafe categories", () => {
    const digest = buildStructuredCompactionDigest({
      entries: [
        entry(`Fact: token ${SECRET} appeared
See /Users/example/private/repo/src/secret.ts
\`\`\`
throw new Error("${SECRET}")
\`\`\``),
      ],
      redactionSecrets: [SECRET],
    });

    const serialized = JSON.stringify(digest);
    expect(serialized).not.toContain(SECRET);
    expect(digest.droppedCategories).toEqual(
      expect.arrayContaining([
        "absolute-path-references-omitted",
        "code-block-content-omitted-structured-references-retained",
      ]),
    );
  });

  it("builds records that pass the rich compaction validator", () => {
    const record = compactedRecordFor("Fact: summary builder validates records");

    expect(record).toBeDefined();
    expect(validateContextCompactionRecord(record).ok).toBe(true);
    expect(record?.preservedFacts?.[0]?.statement).toBe("summary builder validates records");
  });
});
