import { describe, expect, it } from "vitest";

import type { ContextCompactionRecord } from "@oscharko-dev/keiko-contracts";
import { validateContextCompactionRecord } from "@oscharko-dev/keiko-contracts/runtime/context-engineering-compaction-validation";

import {
  buildStructuredCompactionDigest,
  explicitClassification,
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

  it("removes open questions that are explicitly resolved later in the compacted thread", () => {
    const digest = buildStructuredCompactionDigest({
      entries: [
        entry("Open question: should persisted records rehydrate in #1727?"),
        entry(
          "Resolved question: should persisted records rehydrate in #1727? Use the recorded rehydration handle.",
        ),
      ],
    });

    expect(digest.openQuestions).toBeUndefined();
    expect(digest.decisions).toContain(
      "Resolved question: should persisted records rehydrate in #1727? Use the recorded rehydration handle.",
    );
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

// SonarCloud S8786: explicitClassification's regex had a redundant `\s*` immediately before the
// trailing `(.+)$` capture group, which overlaps with `.+` (both can consume whitespace) -- the
// "adjacent quantified atoms" shape the rule flags. Empirically this pattern was never actually
// superlinear (it is anchored at `^`, so only one start position is ever tried, and unlike the
// other findings in this batch there is nothing after `(.+)$` besides `$` for a shrunk `\s*` to
// fail against), but the quantifier is dropped anyway for lint compliance and because it was
// provably redundant: match[2] is `.trim()`-ed immediately after extraction, so the final `text`
// is identical whether the leading whitespace is consumed by `\s*` or captured and trimmed away.
describe("explicitClassification", () => {
  it.each([
    ["fact: hello", { kind: "fact", text: "hello" }],
    ["fact:hello", { kind: "fact", text: "hello" }],
    ["fact :   hello  ", { kind: "fact", text: "hello" }],
    ["fact=hello", { kind: "fact", text: "hello" }],
    ["fact-hello", { kind: "fact", text: "hello" }],
    ["FACT: Hello", { kind: "fact", text: "Hello" }],
    ["open question: still unresolved?", { kind: "question", text: "still unresolved?" }],
    ["resolved question: it is done", { kind: "resolved-question", text: "it is done" }],
    ["assume: cache is warm", { kind: "assumption", text: "cache is warm" }],
    ["not a classification line", undefined],
    ["fact:", undefined],
    ["fact:    ", undefined],
  ])("classifies %j as %j", (line, expected) => {
    expect(explicitClassification(line)).toEqual(expected);
  });

  it("completes within a tight budget for a long run of whitespace after the separator", () => {
    // Real callers never see more than MAX_TEXT_CHARS (260) characters here (cleanLine/boundText
    // truncate every line first), but this asserts the pattern itself has no hidden superlinear
    // cost at a scale ten thousand times that bound, guarding against a future rewrite quietly
    // reintroducing genuine ambiguity between the separator's surrounding quantifiers.
    const adversarial = `fact:${" ".repeat(20_000)}x`;
    const start = Date.now();
    const result = explicitClassification(adversarial);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
    expect(result).toEqual({ kind: "fact", text: "x" });
  });
});
