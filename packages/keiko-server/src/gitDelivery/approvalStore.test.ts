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

  // #3386 (ADR-0138 D2) introduced an "authority-admission" claim operation as a coarse,
  // run-identity-bound claim meant to redeem `runBoundAuthority.authorizeGitDelivery`'s
  // "approval-required" disposition for a lower mode. Final-audit F2/#3390: no production HTTP
  // route ever minted a claim bound to it (there was no matching `/approve` endpoint), so it was
  // permanently unreachable and has been removed from `GitDeliveryApprovalOperation`.
  // `requestPreparation.ts`'s `gitDeliveryApprovalRedemption` now redeems "approval-required" by
  // reusing the SAME per-operation claim shape the route already mints/parses (here: the
  // "local-mutation" binding local-mutation routes already issue and consume), proven generically
  // below through the same issue/consume path every other operation kind already uses.
  it("mints and redeems a local-mutation claim bound to a run's identity and the attempted command", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const binding: GitDeliveryApprovalBinding = {
      projectId: "/workspace/repo",
      operation: "local-mutation",
      command: { kind: "branch-create", branchName: "feature/x" },
      runId: "run-a",
      envelopeDigest: "a".repeat(64),
    };
    const issued = store.issue({ binding, approvedByUserId: "u-1", nowMs: NOW, ttlMs: 60_000 });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");

    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding, nowMs: NOW + 1 }),
    ).toMatchObject({ required: true });

    // Bound to the specific command attempted: a claim minted for "branch-create" does not redeem
    // "stage".
    const other = createInMemoryGitDeliveryApprovalStore();
    const issuedForCreate = other.issue({
      binding,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsedForCreate = parseGitDeliveryApprovalRequest(issuedForCreate.approval);
    if (parsedForCreate?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsedForCreate, {
        store: other,
        binding: { ...binding, command: { kind: "stage", pathspecs: ["a.txt"] } },
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });
});

// #3399: negative coverage for the "pr-description-apply" operation — the description service's own
// `PrDescriptionApprovals` continuation mints and consumes through this SAME generic store, so a
// claim minted for the description apply must be exactly as cross-operation-safe and collision-safe
// as every other operation kind already proven above.
describe("git delivery approval store — pr-description-apply (#3399)", () => {
  const DESCRIPTION_BINDING: GitDeliveryApprovalBinding = {
    projectId: "repo_abc123",
    operation: "pr-description-apply",
    runId: "run-a",
    envelopeDigest: "a".repeat(64),
    proposalId: "proposal-1",
    command: {
      kind: "pr-description-apply",
      binding: {
        repositoryId: "repo_abc123",
        remoteDigest: "b".repeat(64),
        repository: "owner/repo",
        prNumber: 123,
        prExternalId: "123",
        baseRef: "main",
        baseSha: "c".repeat(40),
        headRepository: "owner/repo",
        headRef: "feature",
        headSha: "d".repeat(40),
        isDraft: true,
        snapshotDigest: "e".repeat(64),
        draftDigest: "f".repeat(64),
        renderingVersion: "1",
        expectedBodyDigest: "0".repeat(64),
        outsideRegionDigest: "1".repeat(64),
        finalBodyDigest: "2".repeat(64),
        providerUpdatedAt: "2026-09-05T00:00:00.000Z",
      },
    },
  };
  // GitDeliveryApprovalBinding.proposalId is `string?` (no explicit `| undefined`) under
  // exactOptionalPropertyTypes, so reading it back off DESCRIPTION_BINDING (typed as the interface)
  // widens to `string | undefined` even though the fixture above always sets it. Narrow once here
  // instead of writing an explicit `proposalId: undefined` into any binding built below.
  const DESCRIPTION_PROPOSAL_ID = DESCRIPTION_BINDING.proposalId;
  if (DESCRIPTION_PROPOSAL_ID === undefined) {
    throw new Error("expected DESCRIPTION_BINDING.proposalId to be set");
  }

  it("mints a claim redeemable exactly once for the exact bound proposal", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: DESCRIPTION_BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: DESCRIPTION_BINDING,
        nowMs: NOW + 1,
      }),
    ).toMatchObject({ required: true });
    // Redeemed: a second attempt against the identical binding no longer matches.
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: DESCRIPTION_BINDING,
        nowMs: NOW + 2,
      }),
    ).toBeUndefined();
  });

  it("cross-operation reuse: a claim minted for commit/push/pr never redeems a pr-description-apply binding with the identical proposalId/runId/envelopeDigest", () => {
    for (const operation of ["commit", "push", "pr", "merge"] as const) {
      const store = createInMemoryGitDeliveryApprovalStore();
      const foreignBinding: GitDeliveryApprovalBinding = {
        projectId: DESCRIPTION_BINDING.projectId,
        operation,
        runId: DESCRIPTION_BINDING.runId,
        envelopeDigest: DESCRIPTION_BINDING.envelopeDigest,
        proposalId: DESCRIPTION_PROPOSAL_ID,
        command: DESCRIPTION_BINDING.command,
      };
      const issued = store.issue({
        binding: foreignBinding,
        approvedByUserId: "u-1",
        nowMs: NOW,
        ttlMs: 60_000,
      });
      const parsed = parseGitDeliveryApprovalRequest(issued.approval);
      if (parsed?.kind !== "claim") throw new Error("expected claim");
      expect(
        resolveGitDeliveryApprovalRequirement(parsed, {
          store,
          binding: DESCRIPTION_BINDING,
          nowMs: NOW + 1,
        }),
      ).toBeUndefined();
    }
  });

  it("canonical-hash collision: two proposals whose commands differ only in property declaration order never collide, and an identically-shaped command for a different proposalId never redeems", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const reordered: GitDeliveryApprovalBinding = {
      command: DESCRIPTION_BINDING.command,
      envelopeDigest: DESCRIPTION_BINDING.envelopeDigest,
      operation: DESCRIPTION_BINDING.operation,
      projectId: DESCRIPTION_BINDING.projectId,
      proposalId: DESCRIPTION_PROPOSAL_ID,
      runId: DESCRIPTION_BINDING.runId,
    };
    // canonicalise() is key-order-independent: reordering the same fields must still match.
    const issued = store.issue({
      binding: DESCRIPTION_BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding: reordered, nowMs: NOW + 1 }),
    ).toMatchObject({ required: true });

    // A different proposalId for an otherwise byte-identical binding must never collide.
    const store2 = createInMemoryGitDeliveryApprovalStore();
    const issuedForOther = store2.issue({
      binding: { ...DESCRIPTION_BINDING, proposalId: "proposal-2" },
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsedForOther = parseGitDeliveryApprovalRequest(issuedForOther.approval);
    if (parsedForOther?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsedForOther, {
        store: store2,
        binding: DESCRIPTION_BINDING,
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });

  it("rejects a binding that smuggles an extra operation-specific field (mergeMethod, closeIssue) before any match can succeed", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: DESCRIPTION_BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    const smuggled: GitDeliveryApprovalBinding = {
      ...DESCRIPTION_BINDING,
      command: {
        ...(DESCRIPTION_BINDING.command as Record<string, unknown>),
        mergeMethod: "squash",
        closeIssue: true,
      },
    };
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding: smuggled, nowMs: NOW + 1 }),
    ).toBeUndefined();
  });
});

// #3389: negative coverage for the "pr-mark-ready" operation, deliberately separate from "pr" so the
// generic pr-update admission can never redeem a mark-ready claim (epic #3384 correction 1/7).
describe("git delivery approval store — pr-mark-ready (#3389)", () => {
  const MARK_READY_BINDING: GitDeliveryApprovalBinding = {
    projectId: "repo_abc123",
    operation: "pr-mark-ready",
    runId: "run-a",
    envelopeDigest: "a".repeat(64),
    command: {
      kind: "pr-mark-ready",
      ownerAndRepo: "owner/repo",
      remoteDigest: "b".repeat(64),
      prExternalId: "123",
      headSha: "c".repeat(40),
      baseSha: "d".repeat(40),
      readinessDigest: "e".repeat(64),
      currentDraftState: true,
      transitionPayloadDigest: "f".repeat(64),
    },
  };

  it("mints a claim redeemable exactly once for the exact bound transition", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: MARK_READY_BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: MARK_READY_BINDING,
        nowMs: NOW + 1,
      }),
    ).toMatchObject({ required: true });
    // Redeemed: a second attempt against the identical binding no longer matches.
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: MARK_READY_BINDING,
        nowMs: NOW + 2,
      }),
    ).toBeUndefined();
  });

  it("a claim minted for the generic pr-update operation never redeems a pr-mark-ready binding, and vice versa (closes the approval-less convertFromDraft path)", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const genericPrBinding: GitDeliveryApprovalBinding = {
      projectId: MARK_READY_BINDING.projectId,
      operation: "pr",
      runId: MARK_READY_BINDING.runId,
      envelopeDigest: MARK_READY_BINDING.envelopeDigest,
      command: MARK_READY_BINDING.command,
    };
    const issued = store.issue({
      binding: genericPrBinding,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: MARK_READY_BINDING,
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });

  it("drift: a binding whose baseSha/headSha differ from the minted claim never redeems", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: MARK_READY_BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    const drifted: GitDeliveryApprovalBinding = {
      ...MARK_READY_BINDING,
      command: {
        ...(MARK_READY_BINDING.command as Record<string, unknown>),
        headSha: "0".repeat(40),
      },
    };
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding: drifted, nowMs: NOW + 1 }),
    ).toBeUndefined();
  });

  it("rejects a binding that smuggles a merge or issue-close field before any match can succeed", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({
      binding: MARK_READY_BINDING,
      approvedByUserId: "u-1",
      nowMs: NOW,
      ttlMs: 60_000,
    });
    const parsed = parseGitDeliveryApprovalRequest(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    const smuggled: GitDeliveryApprovalBinding = {
      ...MARK_READY_BINDING,
      command: {
        ...(MARK_READY_BINDING.command as Record<string, unknown>),
        mergeMethod: "squash",
        closeIssue: true,
      },
    };
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { store, binding: smuggled, nowMs: NOW + 1 }),
    ).toBeUndefined();
  });
});
