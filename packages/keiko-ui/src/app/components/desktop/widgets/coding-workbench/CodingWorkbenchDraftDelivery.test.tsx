import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingWorkbenchDraftDelivery } from "./CodingWorkbenchDraftDelivery";
import { draftDeliverySnapshot } from "./_draftDeliveryTestSupport";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

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
  });
});
