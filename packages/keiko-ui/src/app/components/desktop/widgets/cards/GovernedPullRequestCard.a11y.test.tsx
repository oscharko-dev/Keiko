// a11y smoke tests for the governed GitHub pull request command center (Issue #477, AC parity with
// #475). jest-axe scans the empty state, the default flow, the loaded readiness panel, and an outcome
// banner; asserts the polite live region exists for async outcome announcements; and asserts readiness /
// outcome are conveyed by TEXT, not colour alone.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { GovernedPullRequestCard, type GovernedPullRequestClient } from "./GovernedPullRequestCard";
import type { GitDeliveryPrExecuteResponse, GitDeliveryPrPreviewResponse } from "@/lib/api";

const PREVIEW: GitDeliveryPrPreviewResponse = {
  schemaVersion: "1",
  actionKind: "pr-create",
  headBranchName: "claude/issue-477-x",
  baseBranchName: "dev",
  riskClass: "protected-or-merge",
  riskSeverity: 3,
  isDraft: false,
  policyOutcome: "allowed",
  composedTitle: "feat(keiko-server): github pr command center",
  composedBody: "## Summary\nfeat",
  riskNarrative: "This change is classified protected-or-merge (severity 3).",
  recommendation: "create-as-ready",
  readiness: { objectExists: false, reviewReady: false, blockerCodes: ["head-unpublished"] },
  suggestedLabels: ["enhancement"],
  suggestedIssueRefs: ["#477"],
  titleByteLength: 10,
  bodyByteLength: 20,
};

const OUTCOME: GitDeliveryPrExecuteResponse = {
  schemaVersion: "1",
  status: "blocked",
  actionKind: "pr-create",
  blockReason: "policy-pack-blocked",
};

function makeClient(): GovernedPullRequestClient {
  return {
    prPreview: vi.fn(async () => PREVIEW),
    prExecute: vi.fn(async () => OUTCOME),
  };
}

const PROJECT = "/home/me/repo";

function fillForm(): void {
  fireEvent.change(screen.getByLabelText("Repository (owner/repo)"), {
    target: { value: "oscharko-dev/Keiko" },
  });
  fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "dev" } });
  fireEvent.change(screen.getByLabelText("Head branch"), {
    target: { value: "claude/issue-477-x" },
  });
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "feat: x" } });
}

describe("GovernedPullRequestCard — a11y (WCAG 2.2 AA)", () => {
  it("has no violations in the empty state", async () => {
    const { container } = render(<GovernedPullRequestCard client={makeClient()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the default flow state", async () => {
    const { container } = render(
      <GovernedPullRequestCard projectId={PROJECT} client={makeClient()} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations once the readiness panel is loaded", async () => {
    const { container } = render(
      <GovernedPullRequestCard projectId={PROJECT} client={makeClient()} />,
    );
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gpr-readiness")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with a rendered outcome banner", async () => {
    const { container } = render(
      <GovernedPullRequestCard projectId={PROJECT} client={makeClient()} />,
    );
    fillForm();
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exposes a polite live region for async outcome announcements", () => {
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient()} />);
    const live = screen.getByTestId("gpr-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
  });

  it("conveys readiness and outcome with text labels, not colour alone", async () => {
    render(<GovernedPullRequestCard projectId={PROJECT} client={makeClient()} />);
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(screen.getByTestId("gpr-readiness")).toBeInTheDocument());
    expect(screen.getByTestId("gpr-readiness")).toHaveTextContent("Ready for review: no");
    fireEvent.click(screen.getByTestId("gpr-submit"));
    await waitFor(() => expect(screen.getByTestId("gpr-outcome")).toBeInTheDocument());
    expect(screen.getByTestId("gpr-outcome")).toHaveTextContent("pr-create: blocked");
  });
});
