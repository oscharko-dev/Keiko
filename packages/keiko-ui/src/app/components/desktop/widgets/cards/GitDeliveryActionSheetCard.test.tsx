// Component + interaction tests for the governed Git delivery action sheet (Issue #473). Renders
// each of the three distinct states (ready / waiting-for-approval / blocked) from a fixture
// GitDeliveryActionSheet and asserts readable, interaction-safe output plus the DI-seam fetch path.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitDeliveryActionSheet,
  GitDeliveryActionSheetState,
  GitDeliveryExpectedBlocker,
  GitDeliveryPreviewManifest,
} from "@oscharko-dev/keiko-contracts";
import { GitDeliveryActionSheetCard } from "./GitDeliveryActionSheetCard";

const blockingPreflight: GitDeliveryExpectedBlocker = {
  source: "preflight",
  severity: "blocking",
  remediation: "user-actionable",
  reasonCode: "uncommitted-changes",
};

function makePreview(
  overrides: Partial<GitDeliveryPreviewManifest> = {},
): GitDeliveryPreviewManifest {
  return {
    schemaVersion: "1",
    actionKind: "push",
    riskClass: "publish",
    riskSeverity: 2,
    affectedBranchName: "feature/x",
    baseBranchName: "main",
    remoteBranchName: "feature/x",
    estimatedFileCount: 4,
    estimatedBytesDelta: 2048,
    touchesRemote: true,
    wouldCreateRemoteBranch: true,
    wouldForcePublish: false,
    wouldTriggerChecks: true,
    mergeReadiness: {
      ready: false,
      blockingReason: "approvals-missing",
      requiredApprovalCount: 2,
      receivedApprovalCount: 1,
    },
    expectedBlockers: [],
    ...overrides,
  };
}

function makeSheet(
  state: GitDeliveryActionSheetState,
  overrides: Partial<GitDeliveryActionSheet> = {},
): GitDeliveryActionSheet {
  const base: GitDeliveryActionSheet = {
    schemaVersion: "1",
    actionId: "act-1",
    actionKind: "push",
    state,
    preview: makePreview(),
    approval: {
      necessity: state === "waiting-for-approval" ? "required" : "not-required",
      satisfied: false,
      riskClass: "publish",
      riskSeverity: 2,
      requiredApprovers: state === "waiting-for-approval" ? ["release-captain"] : [],
    },
    policyExplanation: {
      decision: state === "waiting-for-approval" ? "approval-gated" : "allowed",
      requiredApprovers: state === "waiting-for-approval" ? ["release-captain"] : [],
      constraints: [],
    },
    recovery: [
      { actionHint: "retry", remediation: "user-actionable" },
      {
        actionHint: "recover-via-strategy",
        remediation: "user-actionable",
        suggestedRecoveryStrategy: "stash-and-reset",
      },
    ],
    ...overrides,
  };
  return base;
}

function makeBlockedSheet(): GitDeliveryActionSheet {
  return makeSheet("blocked", {
    approval: {
      necessity: "impossible",
      satisfied: false,
      riskClass: "publish",
      riskSeverity: 2,
      requiredApprovers: [],
    },
    policyExplanation: {
      decision: "blocked",
      requiredApprovers: [],
      constraints: [],
      blockReason: "protected-branch",
    },
    preview: makePreview({ expectedBlockers: [blockingPreflight] }),
    blocked: { cause: "preflight", expectedBlockers: [blockingPreflight] },
  });
}

describe("GitDeliveryActionSheetCard", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ready-to-execute: confirm is enabled and fires onConfirm", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <GitDeliveryActionSheetCard
        actionSheet={makeSheet("ready-to-execute")}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByTestId("gdas-state")).toHaveTextContent("Ready to execute");
    const confirm = screen.getByTestId("gdas-confirm");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Approval necessity + policy decision are visible (AC1).
    expect(screen.getByTestId("gdas-necessity")).toHaveTextContent("Optional");
    expect(screen.getByTestId("gdas-policy-decision")).toHaveTextContent("Allowed");
  });

  it("waiting-for-approval: confirm is absent/disabled, Approve fires onApprove, approvers shown", async () => {
    const onApprove = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <GitDeliveryActionSheetCard
        actionSheet={makeSheet("waiting-for-approval")}
        onApprove={onApprove}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByTestId("gdas-state")).toHaveTextContent("Waiting for approval");
    // The execute affordance must NOT be confirmable in this state (AC1): the Approve action
    // replaces Confirm, so no enabled Confirm exists.
    expect(screen.queryByTestId("gdas-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("gdas-necessity")).toHaveTextContent("Mandatory");
    expect(screen.getByTestId("gdas-required-approvers")).toHaveTextContent("release-captain");

    await user.click(screen.getByTestId("gdas-approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocked: cause + expected blockers shown, confirm disabled", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeBlockedSheet()} onConfirm={vi.fn()} />);

    expect(screen.getByTestId("gdas-state")).toHaveTextContent("Blocked");
    expect(screen.getByTestId("gdas-blocked-cause")).toHaveTextContent(
      "Blocked by a preflight check",
    );
    expect(screen.getByTestId("gdas-block-reason")).toHaveTextContent(
      "Target is a protected branch",
    );
    // The expected blocker is rendered with its typed code (AC3).
    expect(screen.getByText("uncommitted-changes")).toBeInTheDocument();
    // Confirm is present but disabled — it cannot be executed while blocked (AC1/AC3).
    const confirm = screen.getByTestId("gdas-confirm");
    expect(confirm).toBeDisabled();
  });

  it("renders recovery hints inline in all states, including the suggested strategy", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeSheet("ready-to-execute")} />);
    const items = screen.getAllByTestId("gdas-recovery-item");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Retry the action")).toBeInTheDocument();
    expect(screen.getByTestId("gdas-recovery-strategy")).toHaveTextContent("stash and reset");
  });

  it("renders the preview manifest: branch, risk, remote impact, and merge readiness (AC2)", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeSheet("ready-to-execute")} />);
    // feature/x is the affected branch AND (for a push) the remote branch — both are rendered.
    expect(screen.getAllByText("feature/x").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText(/Publish \(severity 2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Touches the remote/)).toBeInTheDocument();
    expect(screen.getByTestId("gdas-preview-merge")).toHaveTextContent("Not ready to merge");
    expect(screen.getByTestId("gdas-preview-merge")).toHaveTextContent("1 of 2 approvals");
  });

  it("wires Reject and Escape to onReject", async () => {
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(
      <GitDeliveryActionSheetCard
        actionSheet={makeSheet("ready-to-execute")}
        onReject={onReject}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onReject).toHaveBeenCalledTimes(2);
  });

  it("renders directly from actionSheet without calling fetchImpl", () => {
    const fetchImpl = vi.fn();
    render(
      <GitDeliveryActionSheetCard
        actionSheet={makeSheet("ready-to-execute")}
        fetchImpl={fetchImpl as never}
      />,
    );
    expect(screen.getByTestId("gdas-state")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("DI seam: fetches on mount via fetchImpl when request is provided, then renders the sheet", async () => {
    const sheet = makeSheet("ready-to-execute");
    const fetchImpl = vi.fn().mockResolvedValue(sheet);
    const request = {
      schemaVersion: "1" as const,
      resolvedInputs: {
        kind: "push" as const,
        sourceBranchName: "feature/x",
        remoteAlias: "origin",
        remoteBranchName: "feature/x",
        forcePush: false,
        setUpstreamTracking: true,
      },
      worktreeSnapshot: {
        headDetached: false,
        currentBranchName: "feature/x",
        stagedFileCount: 1,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        hasUpstream: true,
        aheadCount: 1,
        behindCount: 0,
        existingLocalBranchNames: ["feature/x", "main"],
        remoteAliases: ["origin"],
      },
    };
    render(<GitDeliveryActionSheetCard request={request} fetchImpl={fetchImpl as never} />);
    await waitFor(() => {
      expect(screen.getByTestId("gdas-state")).toHaveTextContent("Ready to execute");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(request);
  });

  it("DI seam: surfaces a retryable error when the fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const request = {
      schemaVersion: "1" as const,
      resolvedInputs: {
        kind: "push" as const,
        sourceBranchName: "feature/x",
        remoteAlias: "origin",
        remoteBranchName: "feature/x",
        forcePush: false,
        setUpstreamTracking: true,
      },
      worktreeSnapshot: {
        headDetached: false,
        currentBranchName: "feature/x",
        stagedFileCount: 1,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        hasUpstream: true,
        aheadCount: 1,
        behindCount: 0,
        existingLocalBranchNames: ["feature/x", "main"],
        remoteAliases: ["origin"],
      },
    };
    render(<GitDeliveryActionSheetCard request={request} fetchImpl={fetchImpl as never} />);
    expect(await screen.findByTestId("gdas-error")).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders an empty state when neither actionSheet nor request is provided", () => {
    render(<GitDeliveryActionSheetCard />);
    expect(screen.getByTestId("gdas-empty")).toBeInTheDocument();
  });
});
