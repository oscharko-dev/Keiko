// Behavioural tests for the governed merge command center (Issue #478, Epic #470). Exercises the merge
// target editor + eligible-strategy selector + readiness/recommendation panel + governed merge dispatch
// with a fully mocked api client: empty state, strategy-selector population from the preview (AC2),
// execute gated on mergeable + high-risk confirmation, the readable outcome banner (merged / blocked /
// normalized provider rejection), and the disabled-deployment notice.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GovernedMergeCard, type GovernedMergeClient } from "./GovernedMergeCard";
import {
  ApiError,
  type GitDeliveryMergeExecuteResponse,
  type GitDeliveryMergePreviewResponse,
} from "@/lib/api";

function makePreview(
  overrides: Partial<GitDeliveryMergePreviewResponse> = {},
): GitDeliveryMergePreviewResponse {
  return {
    schemaVersion: "1",
    actionKind: "merge",
    baseBranchName: "dev",
    headBranchName: "claude/issue-478-x",
    prExternalId: "1500",
    riskClass: "protected-or-merge",
    riskSeverity: 3,
    requestedStrategy: "provider-default",
    eligibleStrategies: ["squash", "rebase"],
    selectedDefaultStrategy: "squash",
    requestedStrategyEligible: true,
    policyOutcome: "allowed",
    requiresApproval: false,
    readiness: { mergeable: true, blockers: [] },
    recommendation: "merge-ready",
    ...overrides,
  };
}

function makeExecute(
  overrides: Partial<GitDeliveryMergeExecuteResponse> = {},
): GitDeliveryMergeExecuteResponse {
  return {
    schemaVersion: "1",
    status: "succeeded",
    actionKind: "merge",
    ...overrides,
  };
}

function makeClient(overrides: Partial<GovernedMergeClient> = {}): GovernedMergeClient {
  return {
    mergePreview: vi.fn(async () => makePreview()),
    mergeExecute: vi.fn(async () => makeExecute({ merged: true, branchDeleted: false })),
    ...overrides,
  };
}

const PROJECT = "/home/me/repo";

function fillTarget(): void {
  fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), {
    target: { value: "oscharko-dev/Keiko" },
  });
  fireEvent.change(screen.getByLabelText("Pull request number"), { target: { value: "1500" } });
  fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "dev" } });
  fireEvent.change(screen.getByLabelText("Head branch"), {
    target: { value: "claude/issue-478-x" },
  });
}

describe("GovernedMergeCard", () => {
  it("renders an empty state when no project root is provided", () => {
    render(<GovernedMergeCard client={makeClient()} />);
    expect(screen.getByTestId("gm-empty")).toBeInTheDocument();
  });

  it("leaves the strategy selector empty/disabled until a preview is loaded", () => {
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    const select = screen.getByTestId("gm-strategy") as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.value).toBe("");
  });

  it("populates the strategy selector from the preview and defaults to the selected default (AC2)", async () => {
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    const select = screen.getByTestId("gm-strategy") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(["squash", "rebase"]);
    expect(select.value).toBe("squash");
  });

  it("flags an ineligible requested strategy", async () => {
    const mergePreview = vi.fn(async () =>
      makePreview({
        requestedStrategy: "rebase",
        requestedStrategyEligible: false,
        eligibleStrategies: ["squash"],
        selectedDefaultStrategy: "squash",
      }),
    );
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergePreview })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    expect(screen.getByText(/is not eligible/i)).toBeInTheDocument();
  });

  it("dispatches a governed merge with the right payload and surfaces merged + branch flags", async () => {
    const mergeExecute = vi.fn(async () => makeExecute({ merged: true, branchDeleted: true }));
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergeExecute })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("gm-submit"));
    await waitFor(() => expect(screen.getByTestId("gm-outcome")).toBeInTheDocument());
    expect(mergeExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        ownerAndRepo: "oscharko-dev/Keiko",
        prExternalId: "1500",
        baseBranchName: "dev",
        headBranchName: "claude/issue-478-x",
        mergeStrategy: "squash",
      }),
    );
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("merged: yes");
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("branch deleted: yes");
  });

  it("keeps execute disabled until the PR is mergeable", async () => {
    const mergePreview = vi.fn(async () =>
      makePreview({
        readiness: {
          mergeable: false,
          blockers: [
            {
              code: "conflicts",
              severity: "blocking",
              remediation: "user-actionable",
              actionHint: "resolve-conflicts",
            },
          ],
        },
      }),
    );
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergePreview })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    expect(screen.getByTestId("gm-readiness")).toHaveTextContent("Mergeable: no");
    expect(screen.getByTestId("gm-readiness")).toHaveTextContent("blocker: conflicts");
    // AC3: recovery action hint is rendered for the readiness blocker.
    expect(screen.getByTestId("gm-readiness")).toHaveTextContent("resolve-conflicts");
    expect(screen.getByTestId("gm-submit")).toBeDisabled();
  });

  it("gates execute on the high-risk confirmation when approval is required", async () => {
    const mergePreview = vi.fn(async () => makePreview({ requiresApproval: true }));
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergePreview })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    // Mergeable but unconfirmed → still disabled.
    expect(screen.getByTestId("gm-submit")).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I confirm this high-risk merge"));
    expect(screen.getByTestId("gm-submit")).not.toBeDisabled();
  });

  it("re-gates the merge when a target field changes after a preview (AC1 — no stale gate)", async () => {
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    // Mergeable, no approval required → enabled for the previewed target.
    expect(screen.getByTestId("gm-submit")).not.toBeDisabled();
    // Editing the target invalidates the stale preview gate until a fresh preview is run.
    fireEvent.change(screen.getByLabelText("Pull request number"), { target: { value: "2001" } });
    expect(screen.getByTestId("gm-submit")).toBeDisabled();
  });

  it("surfaces a policy-blocked outcome with its reason", async () => {
    const mergeExecute = vi.fn(async () =>
      makeExecute({
        status: "blocked",
        blockReason: "policy-pack-blocked",
        mergeable: false,
        readinessBlockers: [
          { code: "base-protected", severity: "blocking", remediation: "internal" },
        ],
      }),
    );
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergeExecute })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("gm-submit"));
    await waitFor(() => expect(screen.getByTestId("gm-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("merge: blocked");
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("reason: policy-pack-blocked");
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("blocker: base-protected");
  });

  it("normalizes a provider rejection into a typed reason + recovery disposition + hint", async () => {
    const mergeExecute = vi.fn(async () =>
      makeExecute({
        status: "failed",
        executionErrorCode: "provider-rejected",
        mergeRejectionReason: "not-mergeable",
        recoveryDisposition: "user-fixable",
        recoveryActionHint: "resolve-conflicts",
      }),
    );
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergeExecute })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("gm-submit"));
    await waitFor(() => expect(screen.getByTestId("gm-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("rejected: not-mergeable");
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("recover: user-fixable");
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("hint: resolve-conflicts");
  });

  it("renders the disabled notice when the deployment has governed delivery off", async () => {
    const mergePreview = vi.fn(() =>
      Promise.reject(new ApiError("GIT_DELIVERY_MERGE_DISABLED", "not enabled", 404)),
    );
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient({ mergePreview })} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-disabled")).toBeInTheDocument());
  });
});
