import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import { CodingWorkbenchDraftDelivery } from "./CodingWorkbenchDraftDelivery";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import { matchesJourneySnapshot } from "./_journeyPresentation";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

// ADR-0085 D1b: an issue-free run delivers by pushing its own task branch. Its record carries no
// repository, issue or pull request, and the Code task must say so instead of showing an issue number.
const digest = "a".repeat(64);

function branchPushSnapshot(
  phase: DraftDeliveryRecord["phase"] = "pushed",
  reason: DraftDeliveryRecord["reason"] = "completed",
): CodingWorkbenchRuntimeSnapshot {
  const { issueBinding: _issue, draftDelivery: _draft, ...base } = draftDeliverySnapshot();
  return {
    ...base,
    draftDelivery: {
      schemaVersion: "1",
      revision: 2,
      phase,
      reason,
      proposalId: "delivery-1",
      proposalDigest: digest,
      recordedAt: "2026-09-05T00:00:00.000Z",
      binding: {
        kind: "branch-push",
        runId: "run-1",
        workspaceDigest: digest,
        runtimeAuthorityDigest: digest,
        envelopeDigest: digest,
        remoteDigest: digest,
        remoteAlias: "origin",
        baseRef: "main",
        baseSha: "1".repeat(40),
        headRef: "claude/task-1",
        headSha: "3".repeat(40),
        verifiedCommitProposalId: "commit-1",
        recoveryId: "delivery-1",
      },
    },
  };
}

describe("repository delivery of an issue-free branch push", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the pushed branch with its remote and no issue, repository or pull request", async () => {
    render(<CodingWorkbenchDraftDelivery snapshot={branchPushSnapshot()} />);
    const delivery = screen.getByRole("region", { name: "Repository delivery" });
    const state = screen.getByTestId("cwb-draft-delivery-state");
    expect(state).toHaveAttribute("data-state", "pushed");
    expect(state).toHaveAttribute("data-reason", "completed");
    expect(delivery).toHaveTextContent("Commit pushed");

    const fact = (id: string): string | undefined =>
      delivery.querySelector(`[data-fact="${id}"] dd`)?.textContent ?? undefined;
    expect(fact("remote")).toBe("origin");
    expect(fact("headRef")).toBe("claude/task-1");
    expect(fact("headSha")).toBe("3".repeat(40));
    expect(fact("baseRef")).toBe("main");
    expect(fact("repository")).toBeUndefined();
    expect(fact("issueNumber")).toBeUndefined();
    expect(delivery).not.toHaveTextContent("#42");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it.each([
    ["push-proposed", "approval-required", "Push awaits approval"],
    ["pushing", "in-flight", "Push in progress"],
    ["recovery-required", "provider-failed", "Delivery needs reconciliation"],
  ] as const)("shows the %s phase of a branch push", (phase, reason, label) => {
    render(<CodingWorkbenchDraftDelivery snapshot={branchPushSnapshot(phase, reason)} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("names the remote in both locales", () => {
    expect(translateCodingWorkbench("en", "codingWorkbench.draftDelivery.remoteName")).toBe(
      "Remote",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.draftDelivery.remoteName")).toBe(
      "Remote-Ziel",
    );
  });

  it("never lets a branch push stand for a pull request journey", () => {
    const journey = {
      schemaVersion: "1",
      state: "awaiting-ready-approval",
      binding: { runId: "run-1" },
    };
    expect(matchesJourneySnapshot(journey, branchPushSnapshot())).toBe(false);
  });
});
