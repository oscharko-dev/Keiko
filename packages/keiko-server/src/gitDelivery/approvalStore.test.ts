import { describe, expect, it } from "vitest";
import {
  createInMemoryGitDeliveryApprovalStore,
  parseGitDeliveryApprovalRequest,
  resolveGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalBinding,
} from "./approvalStore.js";

const NOW = 1_700_000_000_000;

const BINDING: GitDeliveryApprovalBinding = {
  projectId: "/workspace/repo",
  operation: "merge",
  runId: "run-a",
  envelopeDigest: "a".repeat(64),
  command: {
    kind: "merge",
    ownerAndRepo: "oscharko-dev/Keiko",
    prExternalId: "42",
    baseBranchName: "main",
    headBranchName: "feat/x",
    mergeStrategy: "squash",
    deleteBranchAfterMerge: false,
  },
};

describe("git delivery approval store", () => {
  it("converts a matching server-issued claim into a trusted approval exactly once", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    expect(parsed?.kind).toBe("claim");
    if (parsed?.kind !== "claim") throw new Error("expected claim");

    const first = resolveGitDeliveryApprovalRequirement(parsed, {
      store,
      binding: BINDING,
      nowMs: NOW + 1,
    });
    expect(first).toMatchObject({
      required: true,
      approvalTokenHash: issued.approvalTokenHash,
      approvedByUserId: "u-1",
      approvedAtMs: NOW,
      expiresAtMs: NOW + 60_000,
    });

    const replay = resolveGitDeliveryApprovalRequirement(parsed, {
      store,
      binding: BINDING,
      nowMs: NOW + 2,
    });
    expect(replay).toBeUndefined();
  });

  it("rejects claims with the wrong operation binding", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: {
          ...BINDING,
          command: {
            kind: "merge",
            ownerAndRepo: "oscharko-dev/Keiko",
            prExternalId: "42",
            baseBranchName: "main",
            headBranchName: "feat/other",
            mergeStrategy: "squash",
            deleteBranchAfterMerge: false,
          },
        },
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });

  it("rejects a claim replayed under a different runtime Authority Envelope", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");

    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: { ...BINDING, runId: "run-b", envelopeDigest: "b".repeat(64) },
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });

  it("rejects expired claims", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 10,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding: BINDING, nowMs: NOW + 11 }),
    ).toBeUndefined();
  });

  it("KEIKO-0869: rejects a claim issued for a different projectId (projectId contributes to the binding hash)", () => {
    // Prove projectId is independently part of the binding hash, not just operation/command:
    // an issued claim for /workspace/repo must NOT resolve when replayed against a claim-request
    // for /workspace/other-repo with the exact same operation and command.
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: { ...BINDING, projectId: "/workspace/repo" },
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: { ...BINDING, projectId: "/workspace/other-repo" },
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });

  it("KEIKO-0869: rejects a request that reuses the real approvalId with a wrong approvalToken (constantTimeHexEqual path)", () => {
    // Exercise the constantTimeHexEqual rejection branch at approvalStore.ts:~133 that no other
    // test reaches. A forged claim carrying the real approvalId but a guessed token must not
    // be accepted, so a bad guess cannot flip a same-approvalId replay to success.
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    const forged: typeof parsed = {
      kind: "claim",
      claim: { ...parsed.claim, approvalToken: "0".repeat(64) },
    };
    expect(
      resolveGitDeliveryApprovalRequirement(forged, {
        store,
        binding: BINDING,
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
    // The real claim still works after the failed forgery attempt (no lockout on rejection).
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding: BINDING, nowMs: NOW + 2 }),
    ).toBeDefined();
  });

  it("does not parse legacy trusted approval objects as browser claims", () => {
    expect(
      parseGitDeliveryApprovalRequest({
        required: true,
        approvalTokenHash: "a".repeat(64),
        approvedByUserId: "u-1",
        approvedAtMs: NOW,
      }),
    ).toBeUndefined();
  });

  // #3386 (ADR-0138 D2): "authority-admission" is the coarse, run-identity-bound claim
  // `runBoundAuthority.authorizeGitDelivery`'s redemption hook consumes for a lower mode's
  // approval-required disposition (see requestPreparation.ts's `gitDeliveryApprovalRedemption`).
  // It carries no command shape of its own beyond the attempted operation — proven here through the
  // SAME generic issue/consume path every other operation kind already uses, so this is additive,
  // not a parallel mechanism.
  it("mints and redeems an authority-admission claim bound to a run's identity and the attempted operation", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const binding: GitDeliveryApprovalBinding = {
      projectId: "/workspace/repo",
      operation: "authority-admission",
      command: { operation: "push" },
      runId: "run-a",
      envelopeDigest: "a".repeat(64),
    };
    const issued = store.issue({ binding, approvedByUserId: "u-1", nowMs: NOW, ttlMs: 60_000 });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");

    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding, nowMs: NOW + 1 }),
    ).toMatchObject({ required: true });

    // Bound to the specific operation attempted: a claim minted for "push" does not redeem "pull".
    const other = createInMemoryGitDeliveryApprovalStore();
    const issuedForPush = other.issue({
      binding,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsedForPush = parseGitDeliveryApprovalRequest(issuedForPush.approval);
    if (parsedForPush?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsedForPush, {
        store: other,
        binding: { ...binding, command: { operation: "pull" } },
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });
});
