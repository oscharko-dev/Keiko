// a11y smoke tests for the governed merge command center (Issue #478, AC parity with #477). jest-axe
// scans the empty state, the default flow, the loaded readiness panel (with the high-risk approval gate),
// and an outcome banner; asserts the polite live region exists for async outcome announcements; and
// asserts readiness / outcome are conveyed by TEXT, not colour alone.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { GovernedMergeCard, type GovernedMergeClient } from "./GovernedMergeCard";
import type { GitDeliveryMergeExecuteResponse, GitDeliveryMergePreviewResponse } from "@/lib/api";

const PREVIEW: GitDeliveryMergePreviewResponse = {
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
  policyOutcome: "approval-gated",
  requiresApproval: true,
  readiness: {
    mergeable: true,
    blockers: [
      {
        code: "checks-failing",
        severity: "advisory",
        remediation: "user-actionable",
        actionHint: "wait-for-provider",
      },
    ],
  },
  recommendation: "merge-ready",
};

const OUTCOME: GitDeliveryMergeExecuteResponse = {
  schemaVersion: "1",
  status: "blocked",
  actionKind: "merge",
  blockReason: "policy-pack-blocked",
};

function makeClient(): GovernedMergeClient {
  return {
    mergePreview: vi.fn(async () => PREVIEW),
    mergeExecute: vi.fn(async () => OUTCOME),
  };
}

const PROJECT = "/home/me/repo";

function fillTarget(): void {
  fireEvent.change(screen.getByLabelText("Repository owner and name"), {
    target: { value: "oscharko-dev/Keiko" },
  });
  fireEvent.change(screen.getByLabelText("Pull request number"), { target: { value: "1500" } });
  fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "dev" } });
  fireEvent.change(screen.getByLabelText("Head branch"), {
    target: { value: "claude/issue-478-x" },
  });
}

describe("GovernedMergeCard — a11y (WCAG 2.2 AA)", () => {
  it("has no violations in the empty state", async () => {
    const { container } = render(<GovernedMergeCard client={makeClient()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the default flow state", async () => {
    const { container } = render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations once the readiness panel and approval gate are loaded", async () => {
    const { container } = render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    expect(screen.getByTestId("gm-approval")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with a rendered outcome banner", async () => {
    const { container } = render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText("I confirm this high-risk merge"));
    fireEvent.click(screen.getByTestId("gm-submit"));
    await waitFor(() => expect(screen.getByTestId("gm-outcome")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exposes a polite live region for async outcome announcements", () => {
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    const live = screen.getByTestId("gm-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
  });

  it("conveys readiness and outcome with text labels, not colour alone", async () => {
    render(<GovernedMergeCard projectId={PROJECT} client={makeClient()} />);
    fillTarget();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gm-readiness")).toBeInTheDocument());
    expect(screen.getByTestId("gm-readiness")).toHaveTextContent("Mergeable: yes");
    fireEvent.click(screen.getByLabelText("I confirm this high-risk merge"));
    fireEvent.click(screen.getByTestId("gm-submit"));
    await waitFor(() => expect(screen.getByTestId("gm-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gm-outcome")).toHaveTextContent("merge: blocked");
  });
});
