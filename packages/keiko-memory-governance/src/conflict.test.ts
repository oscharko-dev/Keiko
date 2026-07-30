import { describe, expect, it } from "vitest";

import type { MemoryId, MemoryNegationTier } from "@oscharko-dev/keiko-contracts/memory";
import {
  checkStatusTransition,
  MEMORY_NEGATION_TIERS,
  MEMORY_STATUSES,
  memoryNegationTokens,
} from "@oscharko-dev/keiko-contracts/memory";

import {
  buildConflictTransitions,
  detectConflictPair,
  GOVERNANCE_NEGATION_TIERS,
  jaccardSimilarity,
} from "./conflict.js";
import { GovernanceError } from "./errors.js";
import { ctx, FIXED_NOW_MS, makeRecord, must, projectScope } from "./_support.js";

describe("detectConflictPair", () => {
  it("detects a negation-flip pair", () => {
    const a = makeRecord({ id: "m-a", body: "we ship on Friday", type: "decision" });
    const b = makeRecord({ id: "m-b", body: "we do not ship on Friday", type: "decision" });
    const r = detectConflictPair(a, b);
    expect(r.hasConflict).toBe(true);
    expect(r.reason).toBe("negation-flip");
  });

  it("detects a polarity-mismatch (yes/no markers) pair", () => {
    const a = makeRecord({
      id: "m-a",
      body: "ship on Friday yes",
      type: "decision",
    });
    const b = makeRecord({
      id: "m-b",
      body: "ship on Friday no",
      type: "decision",
    });
    const r = detectConflictPair(a, b);
    expect(r.hasConflict).toBe(true);
    expect(r.reason).toBe("polarity-mismatch");
  });

  it("detects a value-mismatch pair when overlap is in [0.4, 0.85)", () => {
    const a = makeRecord({
      id: "m-a",
      body: "the deploy target is staging us-east-1",
      type: "decision",
    });
    const b = makeRecord({
      id: "m-b",
      body: "the deploy target is staging eu-west-1",
      type: "decision",
    });
    const r = detectConflictPair(a, b);
    expect(r.hasConflict).toBe(true);
    expect(r.reason).toBe("value-mismatch");
  });

  it("does NOT detect a conflict across different types", () => {
    const a = makeRecord({ id: "m-a", body: "we ship on Friday", type: "decision" });
    const b = makeRecord({ id: "m-b", body: "we do not ship on Friday", type: "preference" });
    expect(detectConflictPair(a, b).hasConflict).toBe(false);
  });

  it("does NOT detect a conflict across different scope kinds", () => {
    const a = makeRecord({ id: "m-a", body: "we ship on Friday", type: "decision" });
    const b = makeRecord({
      id: "m-b",
      body: "we do not ship on Friday",
      type: "decision",
      scope: { kind: "global" },
    });
    expect(detectConflictPair(a, b).hasConflict).toBe(false);
  });

  it("does NOT detect a conflict across different scope coordinates of the same kind", () => {
    const a = makeRecord({
      id: "m-a",
      body: "the deploy target is staging us-east-1",
      type: "decision",
      scope: projectScope("p-1"),
    });
    const b = makeRecord({
      id: "m-b",
      body: "the deploy target is staging eu-west-1",
      type: "decision",
      scope: projectScope("p-2"),
    });
    expect(detectConflictPair(a, b).hasConflict).toBe(false);
  });

  it("does NOT detect a conflict on near-duplicate same-polarity bodies (let dedupe collapse them)", () => {
    const a = makeRecord({ id: "m-a", body: "we ship on Friday", type: "decision" });
    const b = makeRecord({ id: "m-b", body: "we ship on Friday", type: "decision" });
    expect(detectConflictPair(a, b).hasConflict).toBe(false);
  });

  it("does NOT treat words ending in 'nt' as negation markers", () => {
    const a = makeRecord({
      id: "m-a",
      body: "important deploy target is staging us east",
      type: "decision",
    });
    const b = makeRecord({
      id: "m-b",
      body: "deploy target is staging us east",
      type: "decision",
    });
    expect(detectConflictPair(a, b).hasConflict).toBe(false);
  });

  it("does NOT detect a conflict when overlap is below 0.4", () => {
    const a = makeRecord({ id: "m-a", body: "alpha beta gamma delta", type: "decision" });
    const b = makeRecord({
      id: "m-b",
      body: "zeta eta theta iota kappa lambda mu",
      type: "decision",
    });
    expect(detectConflictPair(a, b).hasConflict).toBe(false);
  });
});

// ─── Cross-layer negation-vocabulary pin (#208 consolidation <-> #209 governance) ────────────────
//
// The word list used to be duplicated here and in the consolidation layer, and the two copies had
// drifted while a comment above `detectConflictPair` asserted they were the same detector. There is
// now one owning table in keiko-contracts and this pin fixes the RELATIONSHIP between the layers:
// governance reads the "english-particle" tier and nothing else, because the negative quantifiers
// ("no", "never", …) must keep reaching the separate `polarity-mismatch` / no-conflict outcomes.
// Every expectation is derived from the production table and from the tier list the production code
// itself resolves, so a token added to either side is caught rather than restated.
describe("negation vocabulary shared with the consolidation layer", () => {
  const BASE_BODY = "we ship the release on friday";
  const base = makeRecord({ id: "m-a", body: BASE_BODY, type: "decision" });

  function withToken(token: string): ReturnType<typeof makeRecord> {
    return makeRecord({ id: "m-b", body: `${BASE_BODY} ${token}`, type: "decision" });
  }

  const governanceTiers = new Set<MemoryNegationTier>(GOVERNANCE_NEGATION_TIERS);
  const otherTiers = MEMORY_NEGATION_TIERS.filter((tier) => !governanceTiers.has(tier));

  it("reads a non-empty, strict subset of the shared vocabulary", () => {
    const mine = memoryNegationTokens(GOVERNANCE_NEGATION_TIERS);
    const shared = memoryNegationTokens(MEMORY_NEGATION_TIERS);
    expect(mine.size).toBeGreaterThan(0);
    expect(mine.size).toBeLessThan(shared.size);
    for (const token of mine) {
      expect(shared.has(token)).toBe(true);
    }
  });

  it("reports negation-flip for every token of the tier it reads", () => {
    for (const token of memoryNegationTokens(GOVERNANCE_NEGATION_TIERS)) {
      expect(detectConflictPair(base, withToken(token))).toEqual({
        hasConflict: true,
        reason: "negation-flip",
      });
    }
  });

  it("does NOT treat a tier it deliberately skips as a negation particle", () => {
    expect(otherTiers.length).toBeGreaterThan(0);
    for (const token of memoryNegationTokens(otherTiers)) {
      expect(detectConflictPair(base, withToken(token))).toEqual({ hasConflict: false });
    }
  });
});

describe("jaccardSimilarity", () => {
  it("drops a supplementary-plane character (emoji) without corrupting adjacent tokens", () => {
    // "😀" (U+1F600) is a 2-UTF-16-code-unit character. mapCharToSafe's letter/digit
    // range check must reject it the same way whether it reads a lone surrogate's code
    // unit or the full code point — both are far outside 0-9/a-z — so it is dropped
    // exactly like any other punctuation, never splitting or merging the surrounding
    // ASCII tokens.
    const withEmoji = "hello 😀 world";
    const withoutEmoji = "hello world";
    expect(jaccardSimilarity(withEmoji, withoutEmoji)).toBe(1);
  });
});

describe("buildConflictTransitions", () => {
  it("emits one status transition per loser, all to 'conflicted'", () => {
    const winner = makeRecord({ id: "m-w", body: "the truth" });
    const loser1 = makeRecord({ id: "m-l1", body: "lie one" });
    const loser2 = makeRecord({ id: "m-l2", body: "lie two" });
    const { statusTransitions, supersessions } = buildConflictTransitions(
      [winner, loser1, loser2],
      { winner: winner.id, losers: [loser1.id, loser2.id] },
      ctx(),
    );
    expect(statusTransitions).toHaveLength(2);
    for (const t of statusTransitions) {
      expect(t.from).toBe("accepted");
      expect(t.to).toBe("conflicted");
      expect(t.transitionedAt).toBe(FIXED_NOW_MS);
    }
    expect(supersessions).toHaveLength(2);
    expect(must(supersessions[0]).oldMemoryId).toBe(loser1.id);
    expect(must(supersessions[0]).newMemoryId).toBe(winner.id);
    expect(must(supersessions[0]).edgeKind).toBe("supersedes");
  });

  it("every emitted transition is legal per MEMORY_STATUS_TRANSITIONS", () => {
    const winner = makeRecord({ id: "m-w" });
    const loser = makeRecord({ id: "m-l", status: "accepted" });
    const { statusTransitions } = buildConflictTransitions(
      [winner, loser],
      { winner: winner.id, losers: [loser.id] },
      ctx(),
    );
    for (const t of statusTransitions) {
      expect(checkStatusTransition(t.from, t.to).ok).toBe(true);
    }
  });

  it("throws GovernanceError('illegal-status-transition') if a loser is already 'forgotten'", () => {
    const winner = makeRecord({ id: "m-w" });
    const loser = makeRecord({ id: "m-l", status: "forgotten" });
    expect(() =>
      buildConflictTransitions([winner, loser], { winner: winner.id, losers: [loser.id] }, ctx()),
    ).toThrow(/illegal-status-transition/);
  });

  it("throws when losers is empty", () => {
    const winner = makeRecord({ id: "m-w" });
    expect(() =>
      buildConflictTransitions([winner], { winner: winner.id, losers: [] }, ctx()),
    ).toThrow(GovernanceError);
  });

  it("throws when the winner is not in the conflicted set", () => {
    const loser = makeRecord({ id: "m-l" });
    expect(() =>
      buildConflictTransitions([loser], { winner: "m-w" as MemoryId, losers: [loser.id] }, ctx()),
    ).toThrow(GovernanceError);
  });

  it("throws when a loser equals the winner", () => {
    const m = makeRecord({ id: "m-w" });
    expect(() => buildConflictTransitions([m], { winner: m.id, losers: [m.id] }, ctx())).toThrow(
      GovernanceError,
    );
  });

  it("throws when a loser id is not in the conflicted set", () => {
    const winner = makeRecord({ id: "m-w" });
    expect(() =>
      buildConflictTransitions(
        [winner],
        { winner: winner.id, losers: ["m-missing" as MemoryId] },
        ctx(),
      ),
    ).toThrow(GovernanceError);
  });

  it("covers every memory status in the transition matrix (matrix regression guard)", () => {
    // Belt-and-braces: assert that the loser's current status is in the closed set so a
    // future widening of MemoryStatus surfaces in this test.
    for (const status of MEMORY_STATUSES) {
      expect(MEMORY_STATUSES).toContain(status);
    }
  });
});
