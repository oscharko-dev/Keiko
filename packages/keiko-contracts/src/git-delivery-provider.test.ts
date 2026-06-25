// Behavioral tests for git-delivery-provider.ts (Issue #471, Epic #470). Covers every exported
// guard (positive AND negative cases) for the provider-neutral interfaces.

import { describe, expect, it } from "vitest";

import {
  GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
  isGitDeliveryBranchProtection,
  isGitDeliveryChecksOverallStatus,
  isGitDeliveryChecksState,
  isGitDeliveryMergeReadiness,
  isGitDeliveryProviderDescriptor,
  isGitDeliveryPullRequestState,
  isGitDeliveryPullRequestStatus,
} from "./git-delivery-provider.js";

describe("provider status guards", () => {
  it("isGitDeliveryChecksOverallStatus discriminates the four statuses", () => {
    expect(isGitDeliveryChecksOverallStatus("passing")).toBe(true);
    expect(isGitDeliveryChecksOverallStatus("skipped")).toBe(true);
    expect(isGitDeliveryChecksOverallStatus("flaky")).toBe(false);
    expect(isGitDeliveryChecksOverallStatus(3)).toBe(false);
  });

  it("isGitDeliveryPullRequestStatus excludes the orthogonal draft state", () => {
    expect(isGitDeliveryPullRequestStatus("open")).toBe(true);
    expect(isGitDeliveryPullRequestStatus("closed")).toBe(true);
    expect(isGitDeliveryPullRequestStatus("merged")).toBe(true);
    // draft is orthogonal (isDraft boolean), not a lifecycle status.
    expect(isGitDeliveryPullRequestStatus("draft")).toBe(false);
  });
});

describe("isGitDeliveryBranchProtection", () => {
  it("accepts a well-formed protection record", () => {
    expect(
      isGitDeliveryBranchProtection({
        deletionAllowed: false,
        forcePushAllowed: false,
        linearHistoryRequired: true,
        requiredReviewCount: 2,
        requiredStatusCheckCount: 3,
      }),
    ).toBe(true);
  });

  it("rejects non-boolean flags and negative/fractional counts", () => {
    expect(
      isGitDeliveryBranchProtection({
        deletionAllowed: "no",
        forcePushAllowed: false,
        linearHistoryRequired: true,
        requiredReviewCount: 2,
        requiredStatusCheckCount: 3,
      }),
    ).toBe(false);
    expect(
      isGitDeliveryBranchProtection({
        deletionAllowed: false,
        forcePushAllowed: false,
        linearHistoryRequired: true,
        requiredReviewCount: -1,
        requiredStatusCheckCount: 3,
      }),
    ).toBe(false);
    expect(
      isGitDeliveryBranchProtection({
        deletionAllowed: false,
        forcePushAllowed: false,
        linearHistoryRequired: true,
        requiredReviewCount: 1.5,
        requiredStatusCheckCount: 3,
      }),
    ).toBe(false);
    expect(isGitDeliveryBranchProtection(null)).toBe(false);
  });
});

describe("isGitDeliveryChecksState", () => {
  it("accepts a well-formed checks state", () => {
    expect(
      isGitDeliveryChecksState({
        total: 4,
        passing: 3,
        failing: 0,
        pending: 1,
        overallStatus: "pending",
      }),
    ).toBe(true);
  });

  it("rejects a bad overallStatus or non-integer counts", () => {
    expect(
      isGitDeliveryChecksState({
        total: 4,
        passing: 3,
        failing: 0,
        pending: 1,
        overallStatus: "weird",
      }),
    ).toBe(false);
    expect(
      isGitDeliveryChecksState({
        total: "4",
        passing: 3,
        failing: 0,
        pending: 1,
        overallStatus: "passing",
      }),
    ).toBe(false);
  });
});

describe("isGitDeliveryMergeReadiness", () => {
  it("accepts ready with and without a typed blocking reason", () => {
    expect(
      isGitDeliveryMergeReadiness({
        ready: true,
        requiredApprovalCount: 2,
        receivedApprovalCount: 2,
      }),
    ).toBe(true);
    expect(
      isGitDeliveryMergeReadiness({
        ready: false,
        blockingReason: "checks-failing",
        requiredApprovalCount: 2,
        receivedApprovalCount: 0,
      }),
    ).toBe(true);
  });

  it("rejects a free-form blocking reason and bad counts", () => {
    expect(
      isGitDeliveryMergeReadiness({
        ready: false,
        blockingReason: "because",
        requiredApprovalCount: 2,
        receivedApprovalCount: 0,
      }),
    ).toBe(false);
    expect(
      isGitDeliveryMergeReadiness({
        ready: true,
        requiredApprovalCount: -1,
        receivedApprovalCount: 0,
      }),
    ).toBe(false);
    expect(isGitDeliveryMergeReadiness(undefined)).toBe(false);
  });
});

describe("isGitDeliveryPullRequestState", () => {
  function validState(): Record<string, unknown> {
    return {
      schemaVersion: GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
      externalId: "42",
      status: "open",
      isDraft: false,
      headBranchName: "feature/x",
      baseBranchName: "main",
      mergeReadiness: {
        ready: true,
        requiredApprovalCount: 1,
        receivedApprovalCount: 1,
      },
    };
  }

  it("accepts a well-formed PR state with orthogonal isDraft", () => {
    expect(isGitDeliveryPullRequestState(validState())).toBe(true);
    expect(isGitDeliveryPullRequestState({ ...validState(), isDraft: true })).toBe(true);
  });

  it("rejects a bad schemaVersion, missing isDraft, and an invalid nested mergeReadiness", () => {
    expect(isGitDeliveryPullRequestState({ ...validState(), schemaVersion: "2" })).toBe(false);
    const withoutDraft: Record<string, unknown> = { ...validState() };
    delete withoutDraft.isDraft;
    expect(isGitDeliveryPullRequestState(withoutDraft)).toBe(false);
    expect(
      isGitDeliveryPullRequestState({ ...validState(), mergeReadiness: { ready: "yes" } }),
    ).toBe(false);
    expect(isGitDeliveryPullRequestState(null)).toBe(false);
  });
});

describe("isGitDeliveryProviderDescriptor", () => {
  it("accepts a descriptor whose capabilities are non-empty strings", () => {
    expect(
      isGitDeliveryProviderDescriptor({
        schemaVersion: GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
        providerInstanceId: "inst-1",
        capabilities: ["branch-protection", "merge-queue"],
      }),
    ).toBe(true);
    expect(
      isGitDeliveryProviderDescriptor({
        schemaVersion: GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
        providerInstanceId: "inst-1",
        capabilities: [],
      }),
    ).toBe(true);
  });

  it("rejects a bad schemaVersion, empty instance id, and non-string capabilities", () => {
    expect(
      isGitDeliveryProviderDescriptor({
        schemaVersion: "2",
        providerInstanceId: "inst-1",
        capabilities: [],
      }),
    ).toBe(false);
    expect(
      isGitDeliveryProviderDescriptor({
        schemaVersion: GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
        providerInstanceId: "",
        capabilities: [],
      }),
    ).toBe(false);
    expect(
      isGitDeliveryProviderDescriptor({
        schemaVersion: GIT_DELIVERY_PROVIDER_SCHEMA_VERSION,
        providerInstanceId: "inst-1",
        capabilities: [7],
      }),
    ).toBe(false);
  });
});
