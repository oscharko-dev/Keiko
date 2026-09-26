import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingWorkbenchDraftDelivery } from "./CodingWorkbenchDraftDelivery";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import {
  descriptionStatusSnapshot,
  genericDescriptionArtifact,
} from "./_workbenchDescriptionStatusTestSupport";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

/** A delivered pull request whose automatically generated draft is no longer retained. */
function expiredDescriptionSnapshot(): ReturnType<typeof draftDeliverySnapshot> {
  const snapshot = draftDeliverySnapshot();
  const described = descriptionStatusSnapshot({ state: "stale", reason: "expired" });
  const status = described.descriptionStatus;
  if (status === undefined) throw new Error("description status fixture absent");
  const { proposalId: _dropped, ...retained } = status;
  return { ...snapshot, descriptionStatus: retained };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("durable repository delivery in the Code task", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #3390: a lapsed retention used to leave the operator with a false sentence ("the change moved")
  // and NO control at all -- the automatic draft simply vanished about a minute after the run
  // ended, with no way back. The card must now say what actually happened and still open the
  // governed description surface for the pull request it already delivered.
  it("offers the description surface when the retained draft has expired", async () => {
    const onReviewDescription = vi.fn();
    render(
      <CodingWorkbenchDraftDelivery
        snapshot={expiredDescriptionSnapshot()}
        onReviewDescription={onReviewDescription}
      />,
    );

    expect(screen.getByTestId("cwb-description-status")).toHaveAttribute("data-reason", "expired");
    expect(
      screen.getByRole("region", { name: "Pull request description draft" }),
    ).toHaveTextContent("The change itself has not moved.");

    fireEvent.click(screen.getByRole("button", { name: "Write the description" }));
    expect(onReviewDescription).toHaveBeenCalledWith({
      ownerAndRepo: "owner/repository",
      prNumber: 7,
    });
  });

  // #3390: the Code task's four status cards render one state each. Two of them (CI readiness,
  // journey outcome) already carry that state as a `data-state` attribute alongside the translated
  // sentence; these two carried the sentence alone, so the state was readable only by translating
  // the prose back. That is not a test hook: a status a machine cannot read is one that support
  // tooling, the qualification lane, and any future automation must guess at, in whichever locale
  // the operator happens to be running. This brings the two stragglers onto the sibling pattern,
  // and adds the reason code the sentence is derived from.
  it("exposes the delivery phase and reason as machine-readable state", () => {
    render(<CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />);
    const state = screen.getByTestId("cwb-draft-delivery-state");
    expect(state).toHaveAttribute("data-state", "draft-created");
    expect(state).toHaveAttribute("data-reason", "completed");
    expect(state).toHaveTextContent("Draft pull request created");
  });

  // Same reason as the two states above: every delivery fact was addressable only through its
  // TRANSLATED label, so nothing could read "the head SHA" without first knowing the operator's
  // locale. Each fact now carries its own stable id.
  it("identifies every delivery fact by a stable key, not by its translated label", () => {
    render(<CodingWorkbenchDraftDelivery snapshot={draftDeliverySnapshot()} />);
    const delivery = screen.getByRole("region", { name: "Repository delivery" });
    const factValue = (id: string): string =>
      delivery.querySelector(`[data-fact="${id}"] dd`)?.textContent ?? "";
    expect(factValue("remoteState")).toBe("Open · Draft");
    expect(factValue("remoteHead")).toBe("3".repeat(40));
    expect(factValue("repository")).toBe("owner/repository");
    expect(factValue("headRef")).toBe("feature/issue-42");
    expect(factValue("headSha")).toBe("3".repeat(40));
    expect(factValue("baseRef")).toBe("main");
  });

  it("exposes the description state and reason as machine-readable state", () => {
    render(<CodingWorkbenchDraftDelivery snapshot={descriptionStatusSnapshot()} />);
    const state = screen.getByTestId("cwb-description-status");
    expect(state).toHaveAttribute("data-state", "current");
    expect(state).toHaveAttribute("data-reason", "generated");
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
    // F56: a refused model answer is a fallback too, but it names the refusal, not an absent model.
    ["fallback", "fallback-output-refused", "Draft generated without the model"],
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
      "c".repeat(64),
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("discards an older draft read after the immutable proposal target changes", async () => {
    const older = deferred<{
      readonly outcome: "draft";
      readonly draft: {
        readonly schemaVersion: "1";
        readonly proposalId: string;
        readonly expiresAt: string;
        readonly artifact: ReturnType<typeof genericDescriptionArtifact>;
      };
    }>();
    const newerArtifact = {
      ...genericDescriptionArtifact(),
      binding: {
        ...genericDescriptionArtifact().binding,
        snapshotDigest: "d".repeat(64),
      },
      markdown: "## New head draft",
    };
    const reviewDraft = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({
        outcome: "draft",
        draft: {
          schemaVersion: "1",
          proposalId: "proposal-new",
          expiresAt: "2026-09-05T18:00:00.000Z",
          artifact: newerArtifact,
        },
      });
    const { rerender } = render(
      <CodingWorkbenchDraftDelivery
        snapshot={descriptionStatusSnapshot({ proposalId: "proposal-old" })}
        reviewDraft={reviewDraft}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review exact draft" }));
    rerender(
      <CodingWorkbenchDraftDelivery
        snapshot={descriptionStatusSnapshot({
          proposalId: "proposal-new",
          snapshotDigest: "d".repeat(64),
        })}
        reviewDraft={reviewDraft}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review exact draft" }));
    await waitFor(() =>
      expect(screen.getByTestId("cwb-description-draft").textContent).toBe(newerArtifact.markdown),
    );
    await act(() => {
      older.resolve({
        outcome: "draft",
        draft: {
          schemaVersion: "1",
          proposalId: "proposal-old",
          expiresAt: "2026-09-05T18:00:00.000Z",
          artifact: genericDescriptionArtifact(),
        },
      });
      return older.promise;
    });
    expect(screen.getByTestId("cwb-description-draft").textContent).toBe(newerArtifact.markdown);
  });

  // Review comment 3941638345 (#3394): the T44 artifact-digest binding rejects a resolved draft
  // whose proposal/snapshot match but whose artifact digest does not. Before this fix, that
  // mismatch was dropped with no diagnostic and no operator-visible state — indistinguishable from
  // a request that never completed. This proves both the closed, body-free diagnostic and the
  // calm, localized "unavailable" state now surface instead.
  it("reports and surfaces a digest-mismatch instead of silently dropping the response", async () => {
    const reviewDraft = vi.fn(async () => ({
      outcome: "draft" as const,
      draft: {
        schemaVersion: "1" as const,
        proposalId: "generic-description-1",
        expiresAt: "2026-09-05T18:00:00.000Z",
        artifact: { ...genericDescriptionArtifact(), artifactDigest: "d".repeat(64) },
      },
    }));
    render(
      <CodingWorkbenchDraftDelivery
        snapshot={descriptionStatusSnapshot({ proposalId: "generic-description-1" })}
        reviewDraft={reviewDraft}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review exact draft" }));
    await waitFor(() => expect(reviewDraft).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("cwb-description-draft")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        "[keiko] workbench description draft rejected: digest-mismatch proposal generic-description-1 expected cccccccccccc actual dddddddddddd",
      ),
    );
    expect(
      screen.getByText(
        translateCodingWorkbench("en", "codingWorkbench.descriptionStatus.unavailable"),
      ),
    ).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();
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
