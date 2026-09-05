import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PrDescriptionArtifact } from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingWorkbenchDraftDelivery } from "./CodingWorkbenchDraftDelivery";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import { descriptionStatusSnapshot } from "./_workbenchDescriptionStatusTestSupport";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

function genericDescriptionArtifact(): PrDescriptionArtifact {
  const evidenceId = "e".repeat(64);
  return {
    schemaVersion: "1",
    renderingVersion: "1",
    binding: {
      repositoryId: "repository-1",
      baseRef: "dev",
      baseSha: "1".repeat(40),
      headRef: "feature",
      headSha: "2".repeat(40),
      mergeBaseSha: "1".repeat(40),
      snapshotDigest: "b".repeat(64),
    },
    language: "en",
    outcome: "complete",
    reason: "none",
    coverage: {
      snapshot: {
        totalFiles: 1,
        files: 1,
        hunks: 1,
        bytes: 10,
        omittedFiles: 0,
        omittedHunks: 0,
        truncatedFiles: 0,
        kinds: {
          add: 0,
          modify: 1,
          delete: 0,
          rename: 0,
          copy: 0,
          "mode-change": 0,
          binary: 0,
          submodule: 0,
        },
        omissions: [],
      },
      suppliedEvidenceCount: 1,
      processedEvidenceCount: 1,
      omittedEvidenceCount: 0,
    },
    candidate: {
      summary: [{ text: "Generic Workbench draft", evidenceIds: [evidenceId] }],
      keyChanges: [{ text: "One bounded change", evidenceIds: [evidenceId] }],
      risks: [],
      reviewerFocus: [],
    },
    markdown: "## Summary\n\nGeneric Workbench draft",
    artifactDigest: "c".repeat(64),
  };
}

describe("durable repository delivery in the Code task", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the confirmed draft and exact immutable target with a safe PR link", async () => {
    render(<CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />);
    expect(screen.getByRole("region", { name: "Repository delivery" })).toHaveTextContent(
      "Draft pull request created",
    );
    const link = screen.getByRole("link", { name: "Pull request #7" });
    expect(link).toHaveAttribute("href", "https://github.com/owner/repository/pull/7");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByText("3".repeat(40))).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith(
      "[keiko] draft delivery displayed: draft-created reason completed head 333333333333",
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it.each([
    ["push-proposed", "approval-required", "Push awaits approval"],
    ["pushing", "in-flight", "Push in progress"],
    ["pushed", "completed", "Commit pushed"],
    ["pr-proposed", "approval-required", "Draft pull request awaits approval"],
    ["creating-pr", "in-flight", "Creating draft pull request"],
    ["recovery-required", "remote-drift", "Delivery needs reconciliation"],
  ] as const)(
    "shows saved %s progress without inventing a grant or mutation",
    (phase, reason, label) => {
      const snapshot = draftDeliverySnapshot({ phase, reason });
      if (snapshot.draftDelivery !== undefined)
        Reflect.deleteProperty(snapshot.draftDelivery, "pullRequest");
      render(<CodingWorkbenchDraftDelivery snapshot={snapshot} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  // #3386/#3387: before this hint existed, a "push-proposed"/"pr-proposed" proposal showed only its
  // reason text (which already says a matching approval is required) with no pointer to WHERE that
  // approval happens — a viewer had no way to discover the pending permission request from this
  // card. Every other phase must stay silent: the hint targets exactly the two "approval-required"
  // phases, never a phase whose own reason is unrelated (in-flight/completed/remote-drift).
  it.each([
    ["push-proposed", "approval-required", true],
    ["pr-proposed", "approval-required", true],
    ["pushing", "in-flight", false],
    ["pushed", "completed", false],
    ["creating-pr", "in-flight", false],
    ["recovery-required", "remote-drift", false],
  ] as const)("shows the pending-approval hint only for phase %s", (phase, reason, expectHint) => {
    const snapshot = draftDeliverySnapshot({ phase, reason });
    if (snapshot.draftDelivery !== undefined)
      Reflect.deleteProperty(snapshot.draftDelivery, "pullRequest");
    render(<CodingWorkbenchDraftDelivery snapshot={snapshot} />);
    const hint = screen.queryByTestId("cwb-draft-delivery-approval-hint");
    if (expectHint) {
      expect(hint).toHaveTextContent("Respond to the pending permission request");
    } else {
      expect(hint).not.toBeInTheDocument();
    }
    // The hint is informational text only — it must never add a second approve control.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("distinguishes last observed remote facts from the approved target during recovery", () => {
    const snapshot = draftDeliverySnapshot({ phase: "recovery-required", reason: "remote-drift" });
    const pr = snapshot.draftDelivery?.pullRequest;
    if (pr === undefined) throw new Error("Fixture requires a PR");
    Reflect.set(pr, "state", "closed");
    Reflect.set(pr, "isDraft", false);
    Reflect.set(pr, "headSha", "4".repeat(40));
    render(<CodingWorkbenchDraftDelivery snapshot={snapshot} />);
    expect(screen.getByText("Last observed PR state")).toBeInTheDocument();
    expect(screen.getByText("Closed · Not a draft")).toBeInTheDocument();
    expect(screen.getByText("4".repeat(40))).toBeInTheDocument();
    expect(screen.queryByText("Draft pull request created")).not.toBeInTheDocument();
  });

  it.each([
    "foreign-run",
    "foreign-issue",
    "foreign-repository",
    "missing-issue",
    "unknown-field",
    "unsafe-url",
  ])("refuses %s without displaying or logging it", (shape) => {
    const snapshot = draftDeliverySnapshot();
    if (shape === "foreign-run") Reflect.set(snapshot, "runId", "run-2");
    if (shape === "missing-issue") Reflect.deleteProperty(snapshot, "issueBinding");
    if (shape === "foreign-issue")
      Reflect.set(snapshot, "issueBinding", { ...snapshot.issueBinding, issueNumber: 99 });
    if (shape === "foreign-repository")
      Reflect.set(snapshot, "issueBinding", {
        ...snapshot.issueBinding,
        remoteDigest: "b".repeat(64),
      });
    if (shape === "unknown-field" && snapshot.draftDelivery !== undefined)
      Reflect.set(snapshot.draftDelivery, "body", "private customer text");
    if (shape === "unsafe-url" && snapshot.draftDelivery?.pullRequest !== undefined)
      Reflect.set(snapshot.draftDelivery.pullRequest, "url", "javascript:alert(1)");
    const { container } = render(<CodingWorkbenchDraftDelivery snapshot={snapshot} />);
    expect(container).toBeEmptyDOMElement();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("removes a stale result on run switch and avoids duplicate display diagnostics", () => {
    const { rerender } = render(
      <CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />,
    );
    rerender(<CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />);
    expect(console.warn).toHaveBeenCalledOnce();
    rerender(
      <CodingWorkbenchDraftDelivery snapshot={{ ...draftDeliverySnapshot(), runId: "run-2" }} />,
    );
    expect(screen.queryByRole("region", { name: "Repository delivery" })).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it.each([
    ["current", "generated", "Draft ready"],
    ["stale", "stale-snapshot", "Draft is stale"],
    ["partial", "partial-generated", "Draft partially generated"],
    ["fallback", "fallback-generated", "Draft generated without the model"],
    ["blocked", "authority-expired", "Draft blocked"],
    ["failed", "provider-failed", "Draft generation failed"],
  ] as const)(
    "shows the automatic description status %s without blocking unrelated Workbench controls",
    async (state, reason, label) => {
      const artifactBearing = state === "current" || state === "partial" || state === "fallback";
      const snapshot = descriptionStatusSnapshot({
        state,
        reason,
        snapshotDigest: artifactBearing ? "b".repeat(64) : null,
        draftDigest: artifactBearing ? "c".repeat(64) : null,
        artifactOutcome: artifactBearing ? "complete" : null,
      });
      render(<CodingWorkbenchDraftDelivery snapshot={snapshot} />);
      expect(
        screen.getByRole("region", { name: "Pull request description draft" }),
      ).toHaveTextContent(label);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(await axe(document.body)).toHaveNoViolations();
    },
  );

  it("shows the description draft alongside repository delivery when both are present", () => {
    const delivery = draftDeliverySnapshot();
    const snapshot = {
      ...delivery,
      descriptionStatus: descriptionStatusSnapshot().descriptionStatus,
    };
    render(<CodingWorkbenchDraftDelivery snapshot={snapshot} />);
    expect(screen.getByRole("region", { name: "Repository delivery" })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Pull request description draft" }),
    ).toBeInTheDocument();
  });

  it("opens the exact retained proposal only when a live PR target is available", () => {
    const onReviewDescription = vi.fn();
    const delivery = draftDeliverySnapshot();
    const snapshot = {
      ...delivery,
      descriptionStatus: descriptionStatusSnapshot({
        proposalId: "pr-description-1",
      }).descriptionStatus,
    };
    render(
      <CodingWorkbenchDraftDelivery
        snapshot={snapshot}
        onReviewDescription={onReviewDescription}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review exact draft" }));
    expect(onReviewDescription).toHaveBeenCalledExactlyOnceWith({
      ownerAndRepo: "owner/repository",
      prNumber: 7,
      proposalId: "pr-description-1",
      snapshotDigest: "b".repeat(64),
    });
  });

  it("reviews the exact retained generic draft without inventing a pull-request target", async () => {
    const artifact = genericDescriptionArtifact();
    const reviewDraft = vi.fn(async () => ({
      outcome: "draft" as const,
      draft: {
        schemaVersion: "1" as const,
        proposalId: "generic-description-1",
        expiresAt: "2026-09-05T18:00:00.000Z",
        artifact,
      },
    }));
    const snapshot = descriptionStatusSnapshot({ proposalId: "generic-description-1" });
    render(<CodingWorkbenchDraftDelivery snapshot={snapshot} reviewDraft={reviewDraft} />);
    fireEvent.click(screen.getByRole("button", { name: "Review exact draft" }));
    await waitFor(() =>
      expect(screen.getByTestId("cwb-description-draft").textContent).toBe(artifact.markdown),
    );
    expect(reviewDraft).toHaveBeenCalledExactlyOnceWith(
      snapshot.runId,
      "generic-description-1",
      "b".repeat(64),
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders nothing for the description status when it is absent, without a diagnostic", () => {
    const { container } = render(
      <CodingWorkbenchDraftDelivery
        snapshot={{ ...draftDeliverySnapshot(), descriptionStatus: undefined }}
      />,
    );
    expect(container).not.toBeEmptyDOMElement();
    expect(
      screen.queryByRole("region", { name: "Pull request description draft" }),
    ).not.toBeInTheDocument();
  });

  it("provides the same durable status and link labels in German", () => {
    expect(translateCodingWorkbench("de", "codingWorkbench.draftDelivery.title")).toBe(
      "Repository-Übermittlung",
    );
    expect(
      translateCodingWorkbench("de", "codingWorkbench.draftDelivery.phase.draft-created"),
    ).toBe("Pull-Request-Entwurf erstellt");
    expect(
      translateCodingWorkbench("de", "codingWorkbench.draftDelivery.pullRequest", { number: 7 }),
    ).toBe("Pull Request #7");
    expect(translateCodingWorkbench("de", "codingWorkbench.descriptionStatus.title")).toBe(
      "Entwurf der Pull-Request-Beschreibung",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.descriptionStatus.state.blocked")).toBe(
      "Entwurf blockiert",
    );
    expect(translateCodingWorkbench("de", "codingWorkbench.descriptionStatus.review")).toBe(
      "Exakten Entwurf prüfen",
    );
    expect(
      translateCodingWorkbench("de", "codingWorkbench.draftDelivery.pendingApprovalHint"),
    ).toContain("Berechtigungsanfrage");
  });
});
