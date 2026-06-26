// a11y smoke tests for the governed Git delivery action sheet (Issue #473, AC5). jest-axe scans the
// ready / waiting-for-approval / blocked states; asserts state and severity are conveyed by text
// (not colour alone); and asserts the polite live region exists for state-transition announcements.

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import type {
  GitDeliveryActionSheet,
  GitDeliveryActionSheetState,
} from "@oscharko-dev/keiko-contracts";
import { GitDeliveryActionSheetCard } from "./GitDeliveryActionSheetCard";

function makeSheet(state: GitDeliveryActionSheetState): GitDeliveryActionSheet {
  const base: GitDeliveryActionSheet = {
    schemaVersion: "1",
    actionId: "act-a11y",
    actionKind: "push",
    state,
    preview: {
      schemaVersion: "1",
      actionKind: "push",
      riskClass: "publish",
      riskSeverity: 2,
      affectedBranchName: "feature/y",
      baseBranchName: "main",
      touchesRemote: true,
      wouldCreateRemoteBranch: false,
      wouldForcePublish: false,
      wouldTriggerChecks: true,
      expectedBlockers: [],
    },
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
    recovery: [{ actionHint: "retry", remediation: "user-actionable" }],
  };
  if (state === "blocked") {
    const blocker = {
      source: "preflight" as const,
      severity: "blocking" as const,
      remediation: "user-actionable" as const,
      reasonCode: "uncommitted-changes",
    };
    return {
      ...base,
      policyExplanation: {
        decision: "blocked",
        requiredApprovers: [],
        constraints: [],
        blockReason: "protected-branch",
      },
      preview: { ...base.preview, expectedBlockers: [blocker] },
      blocked: { cause: "preflight", expectedBlockers: [blocker] },
    };
  }
  return base;
}

describe("GitDeliveryActionSheetCard — a11y (WCAG 2.2 AA)", () => {
  it("has no violations in the ready-to-execute state", async () => {
    const { container } = render(
      <GitDeliveryActionSheetCard
        actionSheet={makeSheet("ready-to-execute")}
        onConfirm={() => {}}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the waiting-for-approval state", async () => {
    const { container } = render(
      <GitDeliveryActionSheetCard
        actionSheet={makeSheet("waiting-for-approval")}
        onApprove={() => {}}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations in the blocked state", async () => {
    const { container } = render(
      <GitDeliveryActionSheetCard actionSheet={makeSheet("blocked")} onConfirm={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("conveys the state with a text label, not colour alone", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeSheet("blocked")} />);
    expect(screen.getByTestId("gdas-state")).toHaveTextContent("State: Blocked");
  });

  it("conveys blocker severity and source with an accessible name, not colour alone", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeSheet("blocked")} />);
    // The accessible name carries severity + source + reason + remediation; the visual badges are
    // aria-hidden so the status is never derived from colour alone.
    expect(
      screen.getByLabelText(
        /Blocking Preflight blocker: uncommitted-changes\. You can fix this\./i,
      ),
    ).toBeInTheDocument();
  });

  it("exposes a polite live region for state-transition announcements", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeSheet("waiting-for-approval")} />);
    const live = screen.getByTestId("gdas-live");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
    expect(live).toHaveTextContent("waiting for approval");
  });

  it("renders the alertdialog with an accessible name and description", () => {
    render(<GitDeliveryActionSheetCard actionSheet={makeSheet("ready-to-execute")} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).toHaveAttribute("aria-describedby");
  });
});
