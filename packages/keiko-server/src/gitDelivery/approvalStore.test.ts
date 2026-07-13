import { describe, expect, it } from "vitest";
import {
  createInMemoryGitDeliveryApprovalStore,
  parseGitDeliveryApprovalRequest,
  parseRequiredGitDeliveryApprovalClaim,
  resolveGitDeliveryApprovalRequirement,
  type GitDeliveryApprovalBinding,
} from "./approvalStore.js";

const NOW = 1_700_000_000_000;

const BINDING: GitDeliveryApprovalBinding = {
  projectId: "/workspace/repo",
  operation: "merge",
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

  it.each([
    ["project", { ...BINDING, projectId: "/workspace/other" }],
    ["action", { ...BINDING, operation: "push" as const }],
    ["message or delivery operands", { ...BINDING, command: { changed: true } }],
    ["live head or staged content", { ...BINDING, contextDigest: "b".repeat(64) }],
  ])("rejects a claim with a changed %s binding", (_name, changedBinding) => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const binding = { ...BINDING, contextDigest: "a".repeat(64) };
    const issued = store.issue({ binding, approvedByUserId: "u-1", nowMs: NOW });
    const parsed = parseRequiredGitDeliveryApprovalClaim(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, {
        store,
        binding: changedBinding,
        nowMs: NOW + 1,
      }),
    ).toBeUndefined();
  });

  it("does not accept a claim through a process-global fallback store", () => {
    const store = createInMemoryGitDeliveryApprovalStore();
    const issued = store.issue({ binding: BINDING, approvedByUserId: "u-1", nowMs: NOW });
    const parsed = parseRequiredGitDeliveryApprovalClaim(issued.approval);
    if (parsed?.kind !== "claim") throw new Error("expected claim");
    expect(
      resolveGitDeliveryApprovalRequirement(parsed, { binding: BINDING, nowMs: NOW + 1 }),
    ).toBeUndefined();
  });

  it("requires a server claim where separate delivery approval is mandatory", () => {
    expect(parseRequiredGitDeliveryApprovalClaim(undefined)).toBeUndefined();
    expect(parseRequiredGitDeliveryApprovalClaim({ required: false })).toBeUndefined();
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
});
