import { describe, expect, it } from "vitest";

import {
  MEMORY_NEGATION_TIERS,
  MEMORY_NEGATION_VOCABULARY,
  memoryNegationTokens,
} from "@oscharko-dev/keiko-contracts/memory";

import { FIXED_NOW_MS, makeIdFactory, makeRecord, must } from "./_support.js";
import {
  CONFLICT_OVERLAP_THRESHOLD,
  detectConflicts,
  findConflictPairs,
  hasNegation,
  type ConflictsOptions,
} from "./conflicts.js";
import type { DuplicateCluster } from "./dedupe.js";

function options(): ConflictsOptions {
  return {
    nowMs: FIXED_NOW_MS,
    newReviewItemId: makeIdFactory("rv"),
  };
}

function cluster(canonicalId: string, members: ReturnType<typeof makeRecord>[]): DuplicateCluster {
  return { canonicalId, members };
}

describe("detectConflicts - multi-way duplicate (cluster size > 2)", () => {
  it("emits exactly one merge review item per 3+ member cluster", () => {
    const a = makeRecord({ id: "m-a", body: "same body", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "same body", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "same body", createdAt: 300 });
    const items = detectConflicts([cluster("m-a", [a, b, c])], options());
    expect(items).toHaveLength(1);
    const item = must(items[0]);
    expect(item.reason).toBe("multi-way-duplicate");
    expect(item.relatedMemoryIds).toEqual(["m-a", "m-b", "m-c"]);
    // Winner is the newest (c, createdAt 300); losers are the older ones.
    expect(item.proposedAction).toEqual({ kind: "merge", winner: "m-c", losers: ["m-a", "m-b"] });
  });

  it("does NOT emit a multi-way review item for a 2-member cluster (handled as edge)", () => {
    const a = makeRecord({ id: "m-a", body: "x", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "x", createdAt: 200 });
    const items = detectConflicts([cluster("m-a", [a, b])], options());
    expect(items.filter((i) => i.reason === "multi-way-duplicate")).toEqual([]);
  });
});

describe("detectConflicts - potential conflict (2-member negation pair)", () => {
  it("emits one supersede review item when older affirms and newer negates the same subject", () => {
    const older = makeRecord({ id: "m-old", body: "the build uses tabs", createdAt: 100 });
    const newer = makeRecord({
      id: "m-new",
      body: "the build does not use tabs",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, newer])], options());
    const conflicts = items.filter((i) => i.reason === "potential-conflict");
    expect(conflicts).toHaveLength(1);
    expect(must(conflicts[0]).proposedAction).toEqual({
      kind: "supersede",
      newer: "m-new",
      older: "m-old",
    });
  });

  it("detects contraction negation (n't)", () => {
    const older = makeRecord({ id: "m-old", body: "we deploy on Friday", createdAt: 100 });
    const newer = makeRecord({
      id: "m-new",
      body: "we don't deploy on Friday",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, newer])], options());
    expect(items.map((i) => i.reason)).toContain("potential-conflict");
  });

  it("detects German negation tokens", () => {
    const older = makeRecord({ id: "m-old", body: "wir deployen am Freitag", createdAt: 100 });
    const newer = makeRecord({
      id: "m-new",
      body: "wir deployen nicht am Freitag",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, newer])], options());
    expect(items.map((i) => i.reason)).toContain("potential-conflict");
  });

  it("does not treat words ending in nt as contractions", () => {
    expect(hasNegation("we want tabs")).toBe(false);
  });

  // Cross-layer pin (#208 <-> #209): the word list is owned by keiko-contracts and this layer reads
  // ALL of its tiers — that is what makes its vocabulary a superset of the governance layer's, which
  // reads only the "english-particle" tier. Derived from the production table, never restated.
  it("recognizes every token of every shared tier (this layer reads the full vocabulary)", () => {
    for (const tier of MEMORY_NEGATION_TIERS) {
      for (const token of MEMORY_NEGATION_VOCABULARY[tier]) {
        expect(hasNegation(`we ship the release ${token} today`)).toBe(true);
      }
    }
  });

  it("recognizes a negation token regardless of case and surrounding punctuation", () => {
    for (const token of memoryNegationTokens(MEMORY_NEGATION_TIERS)) {
      expect(hasNegation(`We ship, ${token.toUpperCase()}!`)).toBe(true);
    }
  });

  it("does not fire on a body whose tokens merely CONTAIN a negation token", () => {
    expect(hasNegation("important notation cannotate nowhere keinerlei")).toBe(false);
  });

  // Negative control for the same drift: these read as negations to a human but are deliberately
  // absent from MEMORY_NEGATION_VOCABULARY. Re-growing a PRIVATE word list in this package — the
  // exact regression the shared table was introduced to end — is what this catches; widening the
  // vocabulary is legitimate, but it has to happen in the one owning table, which flips this
  // assertion and forces the governance side to be considered at the same time.
  it("does not fire on negation-flavoured words that the shared table does not list", () => {
    const shared = memoryNegationTokens(MEMORY_NEGATION_TIERS);
    for (const control of ["nope", "nah", "nein", "negative", "nix"]) {
      expect(shared.has(control)).toBe(false);
      expect(hasNegation(`we ship the release ${control} today`)).toBe(false);
    }
  });

  it("does not fire on an empty or whitespace-only body", () => {
    expect(hasNegation("")).toBe(false);
    expect(hasNegation("   \n\t ")).toBe(false);
  });

  it("does NOT emit a conflict review item for a 2-member non-negating cluster", () => {
    const a = makeRecord({ id: "m-a", body: "user likes tabs", createdAt: 100 });
    const b = makeRecord({
      id: "m-b",
      body: "user likes tabs in the build",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-a", [a, b])], options());
    expect(items.filter((i) => i.reason === "potential-conflict")).toEqual([]);
  });

  it("does NOT emit a conflict for a multi-way cluster (multi-way takes precedence)", () => {
    const older = makeRecord({ id: "m-old", body: "we use tabs", createdAt: 100 });
    const middle = makeRecord({ id: "m-mid", body: "we use tabs", createdAt: 150 });
    const newer = makeRecord({
      id: "m-new",
      body: "we do not use tabs",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-old", [older, middle, newer])], options());
    expect(items.map((i) => i.reason)).toEqual(["multi-way-duplicate"]);
  });

  it("does NOT emit a conflict when both members carry the same negation polarity", () => {
    const a = makeRecord({ id: "m-a", body: "we do not deploy on Friday", createdAt: 100 });
    const b = makeRecord({
      id: "m-b",
      body: "we do not deploy on Friday at all",
      createdAt: 200,
    });
    const items = detectConflicts([cluster("m-a", [a, b])], options());
    expect(items.filter((i) => i.reason === "potential-conflict")).toEqual([]);
  });
});

describe("findConflictPairs - value replacement conflicts", () => {
  it("detects same-key region changes even without a duplicate cluster", () => {
    const older = makeRecord({
      id: "m-old",
      body: "Deployment region is eu-central-1",
      createdAt: 100,
    });
    const newer = makeRecord({
      id: "m-new",
      body: "Deployment region is us-east-1",
      createdAt: 200,
    });
    const items = findConflictPairs([older, newer], [], CONFLICT_OVERLAP_THRESHOLD, options());
    expect(items).toHaveLength(1);
    expect(must(items[0]).evidence?.map((item) => item.kind)).toContain("value-replacement");
  });

  it("does not flag normalised equivalent values as replacements", () => {
    const older = makeRecord({ id: "m-old", body: "database is Postgres", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "database is PostgreSQL", createdAt: 200 });
    const items = findConflictPairs([older, newer], [], CONFLICT_OVERLAP_THRESHOLD, options());
    expect(items).toEqual([]);
  });

  // Regression for a Gitar review finding on this exact PR: KEY_VALUE_VALUE_RE's split into a
  // connector regex plus an atom regex must still fall back to treating the connector word itself
  // as the value when nothing else follows it (the original combined regex's optional connector
  // group could backtrack out entirely in that case) rather than silently dropping the fact. "is"
  // is both a connector token and a syntactically valid atom shape.
  it("extracts a value fact even when the value itself is a connector word", () => {
    const older = makeRecord({ id: "m-old", body: "database is", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "database is postgres", createdAt: 200 });
    const items = findConflictPairs([older, newer], [], CONFLICT_OVERLAP_THRESHOLD, options());
    expect(items).toHaveLength(1);
    expect(must(items[0]).evidence?.map((item) => item.kind)).toContain("value-replacement");
    expect(must(items[0]).evidence?.[0]?.detail).toContain("is -> postgres");
  });

  // REGION_PATTERN and KEY_VALUE_PATTERN used to sandwich their optional connector token between
  // two independent `\s*`s (`\s*(?:connector)?\s*`). Once the trailing capture never matches — the
  // common case for a keyword mention with no real fact attached — the engine re-tries every split
  // of a shared whitespace run between both quantifiers, which is quadratic in the run length
  // (S8786; empirically ~940ms/~1.3s at a 40k-char gap for the region/key-value patterns
  // respectively, before this fix). A body with one such gap plus a genuine, separate fact
  // regression-tests both the fix's speed and that the real fact still gets extracted.
  //
  // The gap's tail deliberately is NOT `zzzzzz`: an all-lowercase-letters tail is a *valid* match
  // for KEY_VALUE_PATTERN's value charset (`[a-z][a-z0-9+#._-]{1,40}`), so the whole match
  // succeeds on the engine's very first (maximal `\s*`) attempt — no backtracking ever happens,
  // and the case exercises nothing about KEY_VALUE_PATTERN's fix (it only genuinely stresses
  // REGION_PATTERN, whose stricter `[a-z]{2}-[a-z]+-\d` value shape does reject "zzzzzz"). `)))`
  // fails the mandatory value capture of BOTH patterns (neither starts with `[a-z]`), so the
  // engine is forced to backtrack across the entire whitespace run for both, which is exactly the
  // shape this test needs to catch a regression in either pattern.
  it("extracts a value fact from a body with a large non-matching gap in linear time", () => {
    const gap = " ".repeat(50_000);
    const older = makeRecord({
      id: "m-old",
      body: `Deployment region is eu-central-1. region${gap})))  tool${gap}))) `,
      createdAt: 100,
    });
    const newer = makeRecord({
      id: "m-new",
      body: "Deployment region is us-east-1",
      createdAt: 200,
    });
    const start = Date.now();
    const items = findConflictPairs([older, newer], [], CONFLICT_OVERLAP_THRESHOLD, options());
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
    expect(items).toHaveLength(1);
    expect(must(items[0]).evidence?.map((item) => item.kind)).toContain("value-replacement");
    expect(must(items[0]).evidence?.[0]?.detail).toContain("eu-central-1 -> us-east-1");
  });
});

describe("detectConflicts - deterministic output", () => {
  it("emits ids drawn from the newReviewItemId factory in order", () => {
    const a = makeRecord({ id: "m-a", body: "x", createdAt: 100 });
    const b = makeRecord({ id: "m-b", body: "x", createdAt: 200 });
    const c = makeRecord({ id: "m-c", body: "x", createdAt: 300 });
    const d = makeRecord({ id: "m-d", body: "y", createdAt: 100 });
    const e = makeRecord({ id: "m-e", body: "y", createdAt: 200 });
    const f = makeRecord({ id: "m-f", body: "y", createdAt: 300 });
    const items = detectConflicts(
      [cluster("m-a", [a, b, c]), cluster("m-d", [d, e, f])],
      options(),
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id).sort()).toEqual(["rv-1", "rv-2"]);
  });

  it("returns the same items for the same input twice", () => {
    const older = makeRecord({ id: "m-old", body: "uses tabs", createdAt: 100 });
    const newer = makeRecord({ id: "m-new", body: "does not use tabs", createdAt: 200 });
    const input = [cluster("m-old", [older, newer])];
    expect(detectConflicts(input, options())).toEqual(detectConflicts(input, options()));
  });
});
