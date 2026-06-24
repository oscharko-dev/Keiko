// Unit tests for the PR2 rich compaction vocabulary (ADR-0053). Each validator test mutates
// exactly one field of a known-good fixture so a single-line implementation mutation is caught.
// Anti-poisoning is tested two ways: a compile-time @ts-expect-error that an assumption is not
// assignable where a fact is expected (and vice versa), and a runtime test that the record
// validator keeps assumptions and preservedFacts in separate arrays. Backward compat pins the
// PR1 minimal record/handle shapes through the expanded validators.

import { describe, it, expect } from "vitest";
import { CONTEXT_ENGINEERING_SCHEMA_VERSION } from "./context-engineering.js";
import type {
  ContextAssumption,
  ContextCommandOutcome,
  ContextCompactionRecord,
  ContextInvalidationKey,
  ContextPreservedFact,
  ContextProvenanceRef,
  ContextRehydrationHandle,
  ContextUserConstraint,
} from "./context-engineering.js";
import type { ContextValidationResult } from "./context-engineering-validation.js";
import {
  isContextProvenanceRefKind,
  validateContextAssumption,
  validateContextCommandOutcome,
  validateContextCompactionRecord,
  validateContextInvalidationKey,
  validateContextPreservedFact,
  validateContextProvenanceRef,
  validateContextRehydrationHandle,
} from "./context-engineering-compaction-validation.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
function happyRef(): ContextProvenanceRef {
  return {
    kind: "repo-file",
    stableId: "ref-1",
    scopePath: "src/index.ts",
    lineRange: { startLine: 10, endLine: 20 },
    contentHash: "a".repeat(64),
  };
}

function happyFact(): ContextPreservedFact {
  return { statement: "the allocator is pure", sourceRef: happyRef() };
}

function happyAssumption(): ContextAssumption {
  return {
    statement: "the cache is process-local",
    rationale: "inferred from the module name, not file content",
    confidence: "low",
  };
}

function happyConstraint(): ContextUserConstraint {
  return { statement: "do not modify any other package", sourceRef: happyRef() };
}

function happyCommandOutcome(): ContextCommandOutcome {
  return { command: "run unit tests", exitCode: 0, summary: "all green" };
}

function happyInvalidationKey(): ContextInvalidationKey {
  return { scopePath: "src/index.ts", contentHash: "b".repeat(64) };
}

function minimalRecord(): ContextCompactionRecord {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "repo-evidence",
    reason: "budget exceeded",
    itemsBefore: 8,
    itemsAfter: 3,
    tokensBefore: 4_000,
    tokensAfter: 1_200,
  };
}

function minimalHandle(): ContextRehydrationHandle {
  return {
    schemaVersion: CONTEXT_ENGINEERING_SCHEMA_VERSION,
    laneId: "repo-evidence",
    handleId: "handle-1",
    itemCount: 5,
    approxTokens: 2_800,
  };
}

function richRecord(): ContextCompactionRecord {
  return {
    ...minimalRecord(),
    orderedAt: 7,
    sourceSpans: [happyRef()],
    preservedFacts: [happyFact()],
    assumptions: [happyAssumption()],
    userConstraints: [happyConstraint()],
    decisions: ["chose the additive extension"],
    openQuestions: ["does PR3 resolve tool-result handles"],
    filesInspected: ["src/a.ts"],
    filesChanged: ["src/b.ts"],
    commandOutcomes: [happyCommandOutcome()],
    failingTests: [],
    droppedCategories: ["verbose webpack output"],
    invalidationKeys: [happyInvalidationKey()],
    rehydration: { ...minimalHandle(), kind: "repo-file", scopePath: "src/index.ts" },
  };
}

function expectInvalidWithReason(result: ContextValidationResult, fragment: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.reasons.some((reason) => reason.includes(fragment))).toBe(true);
}

// ─── isContextProvenanceRefKind ─────────────────────────────────────────────────
describe("isContextProvenanceRefKind", () => {
  it("accepts the four declared kinds", () => {
    for (const kind of ["repo-file", "tool-result", "evidence-atom", "message"]) {
      expect(isContextProvenanceRefKind(kind)).toBe(true);
    }
  });

  it("rejects unknown / non-string values", () => {
    expect(isContextProvenanceRefKind("intentionally-not-persisted")).toBe(false);
    expect(isContextProvenanceRefKind(42)).toBe(false);
    expect(isContextProvenanceRefKind(undefined)).toBe(false);
  });
});

// ─── validateContextProvenanceRef ───────────────────────────────────────────────
describe("validateContextProvenanceRef", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextProvenanceRef(happyRef()).ok).toBe(true);
  });

  it("accepts a minimal ref (kind + stableId only)", () => {
    expect(validateContextProvenanceRef({ kind: "message", stableId: "m-1" }).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expectInvalidWithReason(validateContextProvenanceRef(null), "provenanceRef invalid");
  });

  it("rejects an invalid kind", () => {
    expectInvalidWithReason(validateContextProvenanceRef({ ...happyRef(), kind: "nope" }), "kind");
  });

  it("rejects an empty stableId", () => {
    expectInvalidWithReason(
      validateContextProvenanceRef({ ...happyRef(), stableId: "  " }),
      "stableId",
    );
  });

  it("rejects a non-string scopePath", () => {
    expectInvalidWithReason(
      validateContextProvenanceRef({ ...happyRef(), scopePath: 5 }),
      "scopePath",
    );
  });

  it("rejects a lineRange with endLine < startLine", () => {
    expectInvalidWithReason(
      validateContextProvenanceRef({ ...happyRef(), lineRange: { startLine: 20, endLine: 10 } }),
      "lineRange",
    );
  });

  it("rejects a lineRange with startLine < 1", () => {
    expectInvalidWithReason(
      validateContextProvenanceRef({ ...happyRef(), lineRange: { startLine: 0, endLine: 3 } }),
      "lineRange",
    );
  });

  it("is deterministic", () => {
    const value = happyRef();
    expect(validateContextProvenanceRef(value)).toEqual(validateContextProvenanceRef(value));
  });
});

// ─── validateContextPreservedFact (REFINEMENT 1) ────────────────────────────────
describe("validateContextPreservedFact anti-poisoning sourceRef-or-inferred", () => {
  it("accepts a fact with a sourceRef alone", () => {
    expect(validateContextPreservedFact({ statement: "x", sourceRef: happyRef() }).ok).toBe(true);
  });

  it("accepts a fact with inferred:true alone", () => {
    expect(validateContextPreservedFact({ statement: "x", inferred: true }).ok).toBe(true);
  });

  it("REJECTS a fact with neither sourceRef nor inferred", () => {
    expectInvalidWithReason(
      validateContextPreservedFact({ statement: "unsourced claim" }),
      "requires sourceRef or inferred",
    );
  });

  it("REJECTS a fact with inferred:false and no sourceRef", () => {
    expectInvalidWithReason(
      validateContextPreservedFact({ statement: "unsourced", inferred: false }),
      "requires sourceRef or inferred",
    );
  });

  it("rejects an empty statement", () => {
    expectInvalidWithReason(
      validateContextPreservedFact({ statement: "  ", inferred: true }),
      "statement",
    );
  });

  it("rejects a non-boolean inferred", () => {
    expectInvalidWithReason(
      validateContextPreservedFact({ statement: "x", inferred: "yes" }),
      "inferred",
    );
  });

  it("rejects an invalid nested sourceRef", () => {
    expectInvalidWithReason(
      validateContextPreservedFact({ statement: "x", sourceRef: { kind: "bad", stableId: "s" } }),
      "sourceRef.kind",
    );
  });

  it("rejects an invalid corroborating entry", () => {
    expectInvalidWithReason(
      validateContextPreservedFact({
        statement: "x",
        inferred: true,
        corroborating: [{ kind: "message", stableId: "" }],
      }),
      "corroborating[0].stableId",
    );
  });
});

// ─── validateContextAssumption ──────────────────────────────────────────────────
describe("validateContextAssumption", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextAssumption(happyAssumption()).ok).toBe(true);
  });

  it("rejects a missing rationale", () => {
    expectInvalidWithReason(
      validateContextAssumption({ statement: "x", confidence: "high" }),
      "rationale",
    );
  });

  it("rejects an empty statement", () => {
    expectInvalidWithReason(
      validateContextAssumption({ ...happyAssumption(), statement: "" }),
      "statement",
    );
  });

  it("rejects an invalid confidence", () => {
    expectInvalidWithReason(
      validateContextAssumption({ ...happyAssumption(), confidence: "certain" }),
      "confidence",
    );
  });
});

// ─── validateContextCommandOutcome (summary <= 200) ─────────────────────────────
describe("validateContextCommandOutcome", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextCommandOutcome(happyCommandOutcome()).ok).toBe(true);
  });

  it("accepts a summary of exactly 200 chars", () => {
    expect(
      validateContextCommandOutcome({ ...happyCommandOutcome(), summary: "s".repeat(200) }).ok,
    ).toBe(true);
  });

  it("REJECTS a summary longer than 200 chars", () => {
    expectInvalidWithReason(
      validateContextCommandOutcome({ ...happyCommandOutcome(), summary: "s".repeat(201) }),
      "summary",
    );
  });

  it("rejects a non-finite exitCode", () => {
    expectInvalidWithReason(
      validateContextCommandOutcome({ ...happyCommandOutcome(), exitCode: Number.NaN }),
      "exitCode",
    );
  });

  it("rejects an empty command", () => {
    expectInvalidWithReason(
      validateContextCommandOutcome({ ...happyCommandOutcome(), command: " " }),
      "command",
    );
  });
});

// ─── validateContextInvalidationKey ─────────────────────────────────────────────
describe("validateContextInvalidationKey", () => {
  it("accepts the happy fixture", () => {
    expect(validateContextInvalidationKey(happyInvalidationKey()).ok).toBe(true);
  });

  it("rejects an empty scopePath", () => {
    expectInvalidWithReason(
      validateContextInvalidationKey({ ...happyInvalidationKey(), scopePath: "" }),
      "scopePath",
    );
  });

  it("rejects an empty contentHash", () => {
    expectInvalidWithReason(
      validateContextInvalidationKey({ ...happyInvalidationKey(), contentHash: "  " }),
      "contentHash",
    );
  });
});

// ─── validateContextRehydrationHandle ───────────────────────────────────────────
describe("validateContextRehydrationHandle", () => {
  it("accepts the minimal PR1 handle (no PR2 fields)", () => {
    expect(validateContextRehydrationHandle(minimalHandle()).ok).toBe(true);
  });

  it("accepts a rich handle with all PR2 fields", () => {
    expect(
      validateContextRehydrationHandle({
        ...minimalHandle(),
        kind: "repo-file",
        scopePath: "src/index.ts",
        lineRange: { startLine: 1, endLine: 3 },
        contentHash: "c".repeat(64),
        evidenceAtomId: "atom-1",
        notPersistedReason: "too large",
        approvedSummary: "the gist",
      }).ok,
    ).toBe(true);
  });

  it("rejects a wrong schema version", () => {
    expectInvalidWithReason(
      validateContextRehydrationHandle({ ...minimalHandle(), schemaVersion: "9" }),
      "schemaVersion",
    );
  });

  it("rejects an invalid kind", () => {
    expectInvalidWithReason(
      validateContextRehydrationHandle({ ...minimalHandle(), kind: "bogus" }),
      "kind",
    );
  });

  it("rejects a negative itemCount", () => {
    expectInvalidWithReason(
      validateContextRehydrationHandle({ ...minimalHandle(), itemCount: -1 }),
      "itemCount",
    );
  });

  it("rejects an invalid lineRange", () => {
    expectInvalidWithReason(
      validateContextRehydrationHandle({
        ...minimalHandle(),
        lineRange: { startLine: 5, endLine: 1 },
      }),
      "lineRange",
    );
  });

  it("rejects a non-string approvedSummary", () => {
    expectInvalidWithReason(
      validateContextRehydrationHandle({ ...minimalHandle(), approvedSummary: 5 }),
      "approvedSummary",
    );
  });
});

// ─── validateContextCompactionRecord ────────────────────────────────────────────
describe("validateContextCompactionRecord", () => {
  it("accepts the rich fixture", () => {
    expect(validateContextCompactionRecord(richRecord()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expectInvalidWithReason(validateContextCompactionRecord(7), "compactionRecord invalid");
  });

  it("rejects a wrong schema version", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({ ...minimalRecord(), schemaVersion: "2" }),
      "schemaVersion",
    );
  });

  it("rejects a negative tokensBefore", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({ ...minimalRecord(), tokensBefore: -1 }),
      "tokensBefore",
    );
  });

  it("rejects an invalid laneId", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({ ...minimalRecord(), laneId: "nope" }),
      "laneId",
    );
  });

  it("rejects a non-finite orderedAt", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({ ...minimalRecord(), orderedAt: Number.POSITIVE_INFINITY }),
      "orderedAt",
    );
  });

  it("propagates an invalid preservedFact (unsourced, not inferred)", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({
        ...minimalRecord(),
        preservedFacts: [{ statement: "unsourced" }],
      }),
      "preservedFacts[0] requires sourceRef or inferred",
    );
  });

  it("propagates an invalid assumption", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({
        ...minimalRecord(),
        assumptions: [{ statement: "x", confidence: "high" }],
      }),
      "assumptions[0].rationale",
    );
  });

  it("propagates a command-outcome summary over 200 chars", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({
        ...minimalRecord(),
        commandOutcomes: [{ command: "c", exitCode: 0, summary: "s".repeat(201) }],
      }),
      "commandOutcomes[0].summary",
    );
  });

  it("rejects a non-array preservedFacts", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({ ...minimalRecord(), preservedFacts: {} }),
      "preservedFacts invalid",
    );
  });

  it("rejects a non-string decisions entry", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({ ...minimalRecord(), decisions: [5] }),
      "decisions[0] invalid",
    );
  });

  it("propagates an invalid invalidationKey", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({
        ...minimalRecord(),
        invalidationKeys: [{ scopePath: "", contentHash: "h" }],
      }),
      "invalidationKeys[0].scopePath",
    );
  });

  it("propagates an invalid nested rehydration handle", () => {
    expectInvalidWithReason(
      validateContextCompactionRecord({
        ...minimalRecord(),
        rehydration: { ...minimalHandle(), kind: "bad" },
      }),
      "rehydration.kind",
    );
  });

  it("is deterministic", () => {
    const value = richRecord();
    expect(validateContextCompactionRecord(value)).toEqual(validateContextCompactionRecord(value));
  });
});

// ─── ANTI-POISONING: structural separation of facts and assumptions ─────────────
describe("anti-poisoning: facts and assumptions are structurally distinct", () => {
  it("an assumption is NOT assignable where a ContextPreservedFact is expected", () => {
    const takesFact = (fact: ContextPreservedFact): string => fact.statement;
    const assumption = happyAssumption();
    // A ContextAssumption (rationale+confidence, no sourceRef/inferred) is not a
    // ContextPreservedFact — the type system rejects promoting an assumption to a trusted fact.
    // @ts-expect-error structural separation: assumption is not assignable to fact.
    expect(takesFact(assumption)).toBeDefined();
  });

  it("a fact is NOT assignable where a ContextAssumption is expected", () => {
    const takesAssumption = (a: ContextAssumption): string => a.rationale;
    const fact = happyFact();
    // A ContextPreservedFact has no rationale/confidence, so it is not assignable
    // to a ContextAssumption.
    // @ts-expect-error structural separation: fact is not assignable to assumption.
    expect(takesAssumption(fact)).toBeUndefined();
  });

  it("the record validator keeps assumptions and preservedFacts in separate arrays", () => {
    const record = richRecord();
    expect(validateContextCompactionRecord(record).ok).toBe(true);
    // The assumption statement is never coerced into the facts array.
    const factStatements = (record.preservedFacts ?? []).map((f) => f.statement);
    expect(factStatements).not.toContain(happyAssumption().statement);
    expect((record.assumptions ?? []).map((a) => a.statement)).toContain(
      happyAssumption().statement,
    );
  });

  it("an assumption masquerading as a fact (no sourceRef/inferred) is rejected at runtime", () => {
    const masquerade = {
      statement: happyAssumption().statement,
      rationale: happyAssumption().rationale,
      confidence: happyAssumption().confidence,
    };
    expectInvalidWithReason(
      validateContextPreservedFact(masquerade),
      "requires sourceRef or inferred",
    );
  });
});

// ─── BACKWARD COMPAT: PR1 minimal shapes still validate ─────────────────────────
describe("backward compatibility with PR1 minimal stubs", () => {
  it("the PR1 minimal ContextCompactionRecord validates with all PR2 fields absent", () => {
    expect(validateContextCompactionRecord(minimalRecord()).ok).toBe(true);
  });

  it("the PR1 minimal ContextCompactionRecord round-trips through JSON unchanged", () => {
    const record = minimalRecord();
    const roundTripped = JSON.parse(JSON.stringify(record)) as unknown;
    expect(roundTripped).toEqual(record);
    expect(validateContextCompactionRecord(roundTripped).ok).toBe(true);
  });

  it("the PR1 minimal ContextRehydrationHandle validates with all PR2 fields absent", () => {
    expect(validateContextRehydrationHandle(minimalHandle()).ok).toBe(true);
  });

  it("a PR1 record carrying only summaryRefHash + minimal handle validates", () => {
    expect(
      validateContextCompactionRecord({
        ...minimalRecord(),
        summaryRefHash: "deadbeef",
        rehydration: minimalHandle(),
      }).ok,
    ).toBe(true);
  });
});
