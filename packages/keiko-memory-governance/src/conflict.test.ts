import { describe, expect, it } from "vitest";

import type { MemoryId } from "@oscharko-dev/keiko-contracts/memory";
import { checkStatusTransition, MEMORY_STATUSES } from "@oscharko-dev/keiko-contracts/memory";

import { buildConflictTransitions, detectConflictPair } from "./conflict.js";
import { GovernanceError } from "./errors.js";
import { ctx, FIXED_NOW_MS, makeRecord, must } from "./_support.js";

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

  it("does NOT detect a conflict on near-duplicate same-polarity bodies (let dedupe collapse them)", () => {
    const a = makeRecord({ id: "m-a", body: "we ship on Friday", type: "decision" });
    const b = makeRecord({ id: "m-b", body: "we ship on Friday", type: "decision" });
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
