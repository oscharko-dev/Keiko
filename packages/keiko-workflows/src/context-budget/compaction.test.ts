// Tests for the pure compaction builder (ADR-0053 D4/D7). Proves accounting, repo-file excerpt
// hash enrichment, invalidation keys from supplied file hashes, the no-eviction case, determinism,
// redaction of secrets in digest free-text, the unsourced-fact drop, fact/assumption separation,
// and that every produced record validates. No clock, no randomness — orderedAt is injected.

import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  validateContextCompactionRecord,
  type ContextAssumption,
  type ContextCompactionRecord,
  type ContextPreservedFact,
  type ContextProvenanceRef,
} from "@oscharko-dev/keiko-contracts";

import { allocateContext, type ContextLaneInput } from "./allocator.js";
import { DEFAULT_CONTEXT_BUDGET } from "./defaults.js";
import { buildCompactionRecords, type CompactionDigest } from "./compaction.js";
import {
  buildInvalidationKeys,
  buildRehydrationHandle,
  buildSourceSpans,
  itemsByIds,
  laneItems,
  projectDigest,
} from "./compaction-helpers.js";

function bulk(unit: string, repeats: number): string {
  return unit.repeat(repeats);
}

// A repo-evidence lane whose three items overflow the lane cap so the lowest-score item is evicted.
function overflowLanes(): readonly ContextLaneInput[] {
  const unit = bulk("z ", 200);
  return [
    {
      laneId: "repo-evidence",
      items: [
        { id: "keep-1", text: unit, score: 0.9 },
        { id: "keep-2", text: unit, score: 0.8 },
        { id: "drop-1", text: unit, score: 0.1 },
      ],
    },
  ];
}

function repoRef(
  stableId: string,
  scopePath: string,
  startLine: number,
  endLine: number,
): ContextProvenanceRef {
  return { kind: "repo-file", stableId, scopePath, lineRange: { startLine, endLine } };
}

// Builds an allocation in which exactly one repo-evidence item ("drop-1") is evicted by budget.
function evictOneInput(): {
  readonly lanes: readonly ContextLaneInput[];
  readonly provenance: ReadonlyMap<string, ContextProvenanceRef>;
  readonly fileHashes: ReadonlyMap<string, string>;
} {
  const lanes = overflowLanes();
  return {
    lanes,
    provenance: new Map<string, ContextProvenanceRef>([
      ["drop-1", repoRef("a-drop", "src/dropped.ts", 10, 20)],
      ["keep-2", repoRef("a-keep", "src/kept.ts", 1, 5)],
    ]),
    fileHashes: new Map<string, string>([["src/dropped.ts", "hash-dropped"]]),
  };
}

const tinyProfile = {
  ...DEFAULT_CONTEXT_BUDGET.profile,
  effectiveInputBudget: estimateTokens(bulk("z ", 200)) * 2,
};

// Narrows the first record to non-optional so a test body can assert without optional chains
// (each `?.` counts toward cyclomatic complexity). Throws if the builder emitted nothing.
function firstRecord(records: readonly ContextCompactionRecord[]): ContextCompactionRecord {
  const record = records[0];
  if (record === undefined) {
    throw new Error("expected at least one compaction record");
  }
  return record;
}

describe("buildCompactionRecords — accounting", () => {
  it("emits one record per evicted lane with correct counts and tokens", () => {
    const { lanes, provenance, fileHashes } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const records = buildCompactionRecords({
      result,
      lanes,
      provenance,
      orderedAt: 100,
      fileHashes,
    });
    expect(records).toHaveLength(1);
    const record = firstRecord(records);
    expect(record.laneId).toBe("repo-evidence");
    expect(record.itemsBefore).toBe(3);
    expect(record.itemsAfter).toBe(2);
    const unitTokens = estimateTokens(bulk("z ", 200));
    expect(record.tokensBefore).toBe(unitTokens * 3);
    expect(record.tokensAfter).toBe(unitTokens * 2);
    expect(record.orderedAt).toBe(100);
    expect(record.rehydration?.itemCount).toBe(1);
    expect(record.rehydration?.approxTokens).toBe(unitTokens);
  });

  it("enriches repo-file source spans with the per-excerpt content hash of the excluded text", () => {
    const { lanes, provenance, fileHashes } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const records = buildCompactionRecords({ result, lanes, provenance, orderedAt: 0, fileHashes });
    const span = records[0]?.sourceSpans?.find((s) => s.stableId === "a-drop");
    expect(span?.kind).toBe("repo-file");
    expect(span?.contentHash).toBeDefined();
    // The hash binds the exact excluded text — a single repo-file item also surfaces on the handle.
    expect(records[0]?.rehydration?.scopePath).toBe("src/dropped.ts");
    expect(records[0]?.rehydration?.contentHash).toBe(span?.contentHash);
  });

  it("derives invalidation keys only for excluded repo-file paths present in fileHashes", () => {
    const { lanes, provenance, fileHashes } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const records = buildCompactionRecords({ result, lanes, provenance, orderedAt: 0, fileHashes });
    expect(records[0]?.invalidationKeys).toEqual([
      { scopePath: "src/dropped.ts", contentHash: "hash-dropped" },
    ]);
  });

  it("omits invalidationKeys when no fileHashes are supplied", () => {
    const { lanes, provenance } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const records = buildCompactionRecords({ result, lanes, provenance, orderedAt: 0 });
    expect(records[0]?.invalidationKeys).toBeUndefined();
  });

  it("emits no record when no lane evicted and no digest is supplied", () => {
    const lanes: readonly ContextLaneInput[] = [
      { laneId: "repo-evidence", items: [{ id: "only", text: "tiny", score: 1 }] },
    ];
    const result = allocateContext({
      profile: DEFAULT_CONTEXT_BUDGET.profile,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes,
    });
    expect(buildCompactionRecords({ result, lanes, provenance: new Map(), orderedAt: 0 })).toEqual(
      [],
    );
  });
});

describe("buildCompactionRecords — determinism + validity", () => {
  it("is deterministic — same input twice yields deeply-equal output", () => {
    const { lanes, provenance, fileHashes } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const input = { result, lanes, provenance, orderedAt: 7, fileHashes } as const;
    expect(buildCompactionRecords(input)).toEqual(buildCompactionRecords(input));
  });

  it("produces only records that pass validateContextCompactionRecord", () => {
    const { lanes, provenance, fileHashes } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const digest: CompactionDigest = {
      decisions: ["chose readExcerpt over a new reader"],
      openQuestions: ["which lane owns history compaction?"],
    };
    const records = buildCompactionRecords({
      result,
      lanes,
      provenance,
      orderedAt: 0,
      fileHashes,
      digest,
    });
    for (const record of records) {
      expect(validateContextCompactionRecord(record).ok).toBe(true);
    }
  });
});

describe("buildCompactionRecords — redaction + anti-poisoning", () => {
  const secret = "sk-livetest1234567890ABCDEF";

  function digestWithSecretFact(): CompactionDigest {
    const fact: ContextPreservedFact = {
      statement: `the api key is ${secret}`,
      inferred: true,
    };
    return { preservedFacts: [fact], decisions: [`token ${secret} appeared in output`] };
  }

  it("redacts a secret in a digest fact statement before inclusion", () => {
    const { lanes, provenance } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const records = buildCompactionRecords({
      result,
      lanes,
      provenance,
      orderedAt: 0,
      digest: digestWithSecretFact(),
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(secret);
    expect(records[0]?.preservedFacts?.[0]?.statement).toContain("[REDACTED]");
  });

  it("drops (does not include) a preserved fact lacking both sourceRef and inferred", () => {
    const { lanes, provenance } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const unsourced: ContextPreservedFact = { statement: "an unsourced claim" };
    const sourced: ContextPreservedFact = {
      statement: "a sourced claim",
      sourceRef: repoRef("a-1", "src/x.ts", 1, 2),
    };
    const records = buildCompactionRecords({
      result,
      lanes,
      provenance,
      orderedAt: 0,
      digest: { preservedFacts: [unsourced, sourced] },
    });
    const facts = records[0]?.preservedFacts ?? [];
    expect(facts).toHaveLength(1);
    expect(facts[0]?.statement).toBe("a sourced claim");
  });

  it("keeps assumptions strictly out of the preservedFacts array", () => {
    const { lanes, provenance } = evictOneInput();
    const result = allocateContext({ profile: tinyProfile, budget: DEFAULT_CONTEXT_BUDGET, lanes });
    const assumption: ContextAssumption = {
      statement: "the build probably uses esbuild",
      rationale: "inferred from a config filename, not file content",
      confidence: "low",
    };
    const records = buildCompactionRecords({
      result,
      lanes,
      provenance,
      orderedAt: 0,
      digest: { assumptions: [assumption], preservedFacts: [] },
    });
    expect(records[0]?.assumptions).toHaveLength(1);
    expect(records[0]?.preservedFacts ?? []).toHaveLength(0);
  });

  it("redacts optional digest structures while preserving path-list members verbatim", () => {
    const ref: ContextProvenanceRef = {
      kind: "tool-result",
      stableId: "tool-1",
      notPersistedReason: `captured ${secret}`,
    };
    const projection = projectDigest({
      preservedFacts: [
        {
          statement: `fact ${secret}`,
          sourceRef: ref,
          corroborating: [ref],
        },
      ],
      userConstraints: [{ statement: `constraint ${secret}`, sourceRef: ref }],
      commandOutcomes: [{ command: `echo ${secret}`, exitCode: 1, summary: `failed ${secret}` }],
      openQuestions: [`question ${secret}`],
      filesChanged: ["src/changed.ts"],
      failingTests: [`test ${secret}`],
      droppedCategories: ["verbose output"],
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(secret);
    expect(projection.filesChanged).toEqual(["src/changed.ts"]);
    expect(projection.droppedCategories).toEqual(["verbose output"]);
    expect(projection.preservedFacts?.[0]?.sourceRef?.notPersistedReason).toContain("[REDACTED]");
    expect(projection.commandOutcomes?.[0]?.summary).toContain("[REDACTED]");
  });
});

describe("compaction helper edge cases", () => {
  it("returns empty lane/items results for unknown ids", () => {
    const lanes: readonly ContextLaneInput[] = [
      { laneId: "repo-evidence", items: [{ id: "known", text: "a", score: 1 }] },
    ];
    expect(laneItems(lanes, "tool-observations")).toEqual([]);
    expect(itemsByIds(lanes[0]?.items ?? [], ["missing"])).toEqual([]);
  });

  it("skips missing provenance, non-file spans, duplicate paths, and missing file hashes", () => {
    const excluded = [
      { id: "missing", text: "missing", score: 1 },
      { id: "tool", text: "tool output", score: 1 },
      { id: "repo-a", text: "alpha", score: 1 },
      { id: "repo-dup", text: "beta", score: 1 },
      { id: "repo-no-hash", text: "gamma", score: 1 },
    ];
    const spans = buildSourceSpans(
      excluded,
      new Map<string, ContextProvenanceRef>([
        ["tool", { kind: "tool-result", stableId: "tool-1" }],
        ["repo-a", repoRef("repo-a", "src/a.ts", 1, 2)],
        ["repo-dup", repoRef("repo-dup", "src/a.ts", 3, 4)],
        ["repo-no-hash", repoRef("repo-no-hash", "src/no-hash.ts", 5, 6)],
      ]),
    );
    expect(spans).toHaveLength(4);
    expect(spans.find((span) => span.kind === "tool-result")?.contentHash).toBeUndefined();
    expect(spans.find((span) => span.stableId === "repo-a")?.contentHash).toBeDefined();
    expect(buildInvalidationKeys(spans, new Map([["src/a.ts", "file-hash"]]))).toEqual([
      { scopePath: "src/a.ts", contentHash: "file-hash" },
    ]);
  });

  it("omits direct repo-file fields from rehydration handles when multiple repo files were evicted", () => {
    const handle = buildRehydrationHandle({
      laneId: "repo-evidence",
      excludedIds: ["b", "a"],
      spans: [repoRef("repo-a", "src/a.ts", 1, 2), repoRef("repo-b", "src/b.ts", 3, 4)],
      approxTokens: 22,
    });
    const sameIdsDifferentOrder = buildRehydrationHandle({
      laneId: "repo-evidence",
      excludedIds: ["a", "b"],
      spans: [repoRef("repo-a", "src/a.ts", 1, 2), repoRef("repo-b", "src/b.ts", 3, 4)],
      approxTokens: 22,
    });
    expect(handle.handleId).toBe(sameIdsDifferentOrder.handleId);
    expect(handle.scopePath).toBeUndefined();
    expect(handle.lineRange).toBeUndefined();
    expect(handle.contentHash).toBeUndefined();
  });
});

describe("buildCompactionRecords — digest-only fallback", () => {
  it("emits a single digest-only history-summary record when no lane evicted", () => {
    const lanes: readonly ContextLaneInput[] = [
      { laneId: "repo-evidence", items: [{ id: "only", text: "tiny", score: 1 }] },
    ];
    const result = allocateContext({
      profile: DEFAULT_CONTEXT_BUDGET.profile,
      budget: DEFAULT_CONTEXT_BUDGET,
      lanes,
    });
    const records = buildCompactionRecords({
      result,
      lanes,
      provenance: new Map(),
      orderedAt: 42,
      digest: { decisions: ["nothing evicted but a turn-level digest exists"] },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.laneId).toBe("history-summary");
    expect(records[0]?.orderedAt).toBe(42);
    expect(records[0]?.decisions).toEqual(["nothing evicted but a turn-level digest exists"]);
    expect(validateContextCompactionRecord(records[0]).ok).toBe(true);
  });
});
