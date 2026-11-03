import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { UseCodingWorkbenchApprovalReviewResult } from "@/lib/useCodingWorkbenchApprovalReview";
import { CodingWorkbenchDeliveryReview } from "./CodingWorkbenchDeliveryReview";
import { CodingWorkbenchDraftDelivery } from "./CodingWorkbenchDraftDelivery";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import { matchesJourneySnapshot } from "./_journeyPresentation";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

// ADR-0086 D13: a run on a verified github.com origin opens a draft pull request without an accepted
// issue. Its record names the repository and no issue, and the Code task must show the pull request
// journey for it exactly as for an issue-bound run, minus the issue.
const digest = "a".repeat(64);
const repository = "owner/repository";

function repositorySnapshot(
  phase: DraftDeliveryRecord["phase"] = "draft-created",
  reason: DraftDeliveryRecord["reason"] = "completed",
): CodingWorkbenchRuntimeSnapshot {
  const { issueBinding: _issue, draftDelivery: _draft, ...base } = draftDeliverySnapshot();
  const delivered = phase === "draft-created";
  return {
    ...base,
    draftDelivery: {
      schemaVersion: "1",
      revision: 5,
      phase,
      reason,
      proposalId: "delivery-1",
      proposalDigest: digest,
      recordedAt: "2026-09-05T00:00:00.000Z",
      binding: {
        kind: "github-repository",
        runId: "run-1",
        workspaceDigest: digest,
        runtimeAuthorityDigest: digest,
        envelopeDigest: digest,
        remoteDigest: digest,
        repository,
        remoteAlias: "origin",
        baseRef: "main",
        baseSha: "1".repeat(40),
        headRef: "claude/task-1",
        headSha: "3".repeat(40),
        verifiedCommitProposalId: "commit-1",
        recoveryId: "delivery-1",
      },
      ...(delivered
        ? {
            pullRequest: {
              number: 9,
              externalId: "PR_fixture9",
              url: `https://github.com/${repository}/pull/9`,
              repository,
              headRepository: repository,
              headRef: "claude/task-1",
              headSha: "3".repeat(40),
              baseRef: "main",
              baseSha: "1".repeat(40),
              state: "open",
              isDraft: true,
            },
          }
        : {}),
    },
  };
}

describe("repository delivery of an issue-free run on a github.com origin", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the delivered draft pull request with its repository and no issue", async () => {
    render(<CodingWorkbenchDraftDelivery snapshot={repositorySnapshot()} />);
    const delivery = screen.getByRole("region", { name: "Repository delivery" });
    const state = screen.getByTestId("cwb-draft-delivery-state");
    expect(state).toHaveAttribute("data-state", "draft-created");
    expect(delivery).toHaveTextContent("Draft pull request created");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      `https://github.com/${repository}/pull/9`,
    );

    const fact = (id: string): string | undefined =>
      delivery.querySelector(`[data-fact="${id}"] dd`)?.textContent ?? undefined;
    expect(fact("repository")).toBe(repository);
    expect(fact("headRef")).toBe("claude/task-1");
    expect(fact("baseRef")).toBe("main");
    expect(fact("remote")).toBeUndefined();
    expect(fact("issueNumber")).toBeUndefined();
    expect(delivery).not.toHaveTextContent("#42");
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("shows a pull request awaiting approval without a link", () => {
    render(
      <CodingWorkbenchDraftDelivery
        snapshot={repositorySnapshot("pr-proposed", "approval-required")}
      />,
    );
    expect(screen.getByText("Draft pull request awaits approval")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the exact title and body the human approves, with the repository and no issue", () => {
    const record = repositorySnapshot("pr-proposed", "approval-required").draftDelivery;
    if (record === undefined) throw new Error("missing record");
    const state: UseCodingWorkbenchApprovalReviewResult = {
      status: "ready",
      retry: vi.fn(),
      review: {
        requestId: record.proposalId,
        paths: [],
        pathsTruncated: false,
        fileCount: 0,
        addedLines: 0,
        deletedLines: 0,
        draftDelivery: { record, title: "feat: bounded change", body: "Trusted region only" },
      },
    };
    render(
      <CodingWorkbenchDeliveryReview
        state={state}
        t={(key, values) => translateCodingWorkbench("en", key, values)}
      />,
    );
    const target = screen.getByRole("region", { name: "Reviewed delivery target" });
    expect(target.querySelector('[data-fact="repository"] dd')).toHaveTextContent(repository);
    expect(target.querySelector('[data-fact="issueNumber"]')).toBeNull();
    expect(screen.getByText("feat: bounded change")).toBeInTheDocument();
    expect(screen.getByText("Trusted region only")).toBeInTheDocument();
  });

  it("never lets a repository-bound delivery stand for an issue-keyed journey", () => {
    const journey = {
      schemaVersion: "1",
      state: "awaiting-ready-approval",
      binding: { runId: "run-1" },
    };
    expect(matchesJourneySnapshot(journey, repositorySnapshot())).toBe(false);
  });
});
