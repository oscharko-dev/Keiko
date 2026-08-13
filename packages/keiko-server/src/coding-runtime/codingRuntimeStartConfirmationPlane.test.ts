import { describe, expect, it } from "vitest";

import { codingRuntimeStartConfirmationClaim } from "./codingRuntimeStartConfirmation.js";
import { createAuthenticatedSessionStartConfirmationPlane } from "./codingRuntimeStartConfirmationPlane.js";

const FACTS = {
  requestId: "req-1",
  taskIntent: "trace one governed edit",
  requestedMode: "supervised-coding",
  operatorId: "operator-1",
  taskId: "task-1",
  projectId: "project-1",
  projectDigest: "d".repeat(64),
  workspaceId: "workspace-1",
  workspaceRoot: "/workspaces/task-1",
  branchRef: "refs/heads/task-1",
  branchHeadDigest: "e".repeat(40),
  deploymentCeiling: "supervised-coding",
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
  modelProfileId: "profile-1",
} as const;

function claimAt(
  nowMs: number,
  requestId: string = FACTS.requestId,
): ReturnType<typeof codingRuntimeStartConfirmationClaim> {
  return codingRuntimeStartConfirmationClaim({ ...FACTS, requestId }, nowMs);
}

describe("authenticated session start-confirmation plane", () => {
  it("consumes a fresh claim exactly once and binds a server-private digest", () => {
    const plane = createAuthenticatedSessionStartConfirmationPlane({ now: () => 1_000 });
    const consumed = plane.consume(claimAt(1_000));
    expect(consumed?.approvalDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(plane.consume(claimAt(1_000))).toBeUndefined();
  });

  it("issues distinct digests for distinct requests and plane instances", () => {
    const plane = createAuthenticatedSessionStartConfirmationPlane({ now: () => 1_000 });
    const other = createAuthenticatedSessionStartConfirmationPlane({ now: () => 1_000 });
    const first = plane.consume(claimAt(1_000, "req-a"));
    const second = plane.consume(claimAt(1_000, "req-b"));
    const foreign = other.consume(claimAt(1_000, "req-a"));
    expect(first?.approvalDigest).not.toBe(second?.approvalDigest);
    expect(first?.approvalDigest).not.toBe(foreign?.approvalDigest);
  });

  it("rejects stale and future claims outside the freshness window", () => {
    const plane = createAuthenticatedSessionStartConfirmationPlane({
      now: () => 100_000,
      claimFreshnessMs: 5_000,
    });
    expect(plane.consume(claimAt(94_000, "req-old"))).toBeUndefined();
    expect(plane.consume(claimAt(106_000, "req-future"))).toBeUndefined();
    expect(plane.consume(claimAt(96_000, "req-fresh"))).toBeDefined();
  });

  it("rejects malformed binding digests and request ids without consuming them", () => {
    const plane = createAuthenticatedSessionStartConfirmationPlane({ now: () => 1_000 });
    expect(
      plane.consume({ requestId: "", bindingDigest: "a".repeat(64), nowMs: 1_000 }),
    ).toBeUndefined();
    expect(
      plane.consume({ requestId: "req-bad", bindingDigest: "not-a-digest", nowMs: 1_000 }),
    ).toBeUndefined();
    expect(plane.consume(claimAt(1_000, "req-bad"))).toBeDefined();
  });

  it("fails closed once the replay-tracking budget is exhausted", () => {
    const plane = createAuthenticatedSessionStartConfirmationPlane({ now: () => 1_000 });
    for (let index = 0; index < 4_096; index += 1) {
      expect(plane.consume(claimAt(1_000, `req-${String(index)}`))).toBeDefined();
    }
    expect(plane.consume(claimAt(1_000, "req-overflow"))).toBeUndefined();
  });

  // Regression: KEIKO-0396. Once ~4k requests filled the anti-replay set, every subsequent claim
  // was permanently denied — even after the freshness window on all the tracked entries had
  // elapsed and none of them could ever be replayed. The set must prune expired ids so a
  // long-lived process can keep starting runtimes.
  it("prunes replay-tracked ids whose freshness window has elapsed so the cap does not become permanent", () => {
    let currentNow = 1_000;
    const plane = createAuthenticatedSessionStartConfirmationPlane({
      now: () => currentNow,
      claimFreshnessMs: 5_000,
    });
    for (let index = 0; index < 4_096; index += 1) {
      expect(plane.consume(claimAt(currentNow, `req-${String(index)}`))).toBeDefined();
    }
    // At the cap; the next id is denied under this wall clock.
    expect(plane.consume(claimAt(currentNow, "req-still-full"))).toBeUndefined();
    // Advance past the freshness window — every tracked entry is now unreplayable and can be
    // pruned. A brand-new fresh claim must succeed.
    currentNow += 10_000;
    expect(plane.consume(claimAt(currentNow, "req-after-drain"))).toBeDefined();
  });
});
