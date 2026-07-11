// Behavioural unit tests for the CommitComposer (Issue #1575, Epic #1571).
// Covers the hard commit-policy gate, soft quality warnings, preview errors, mutation outcomes,
// the composed message (summary + body), and keyboard reachability. The composer is a presentational
// component driven entirely by props, so no seam mock is needed.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitDeliveryCommitPreviewResponse } from "@/lib/api";
import { CommitComposer, composeCommitMessage } from "./CommitComposer";

function makePreview(
  overrides: Partial<GitDeliveryCommitPreviewResponse> = {},
): GitDeliveryCommitPreviewResponse {
  return {
    schemaVersion: "1",
    summary: { stagedFileCount: 2, areaCount: 1, areas: ["src"], touchesTests: false },
    intent: { warnings: [], mixedScope: false, isWip: false },
    messageValidation: { ok: true },
    preflightFindingCodes: [],
    policyOutcome: "allowed",
    ...overrides,
  };
}

function renderComposer(props: Partial<Parameters<typeof CommitComposer>[0]> = {}) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  render(
    <CommitComposer
      projectId="/repos/alpha"
      stagedFileCount={2}
      busy={false}
      outcome={null}
      error={null}
      preview={null}
      previewDraft={null}
      previewError={null}
      onPreview={onPreview}
      onCommit={onCommit}
      {...props}
    />,
  );
  return { onPreview, onCommit };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("composeCommitMessage", () => {
  it("returns the trimmed subject when there is no body", () => {
    expect(composeCommitMessage("  feat: x  ", "   ")).toBe("feat: x");
  });

  it("joins subject and body with a blank line", () => {
    expect(composeCommitMessage("feat: x", "Why and how.")).toBe("feat: x\n\nWhy and how.");
  });
});

describe("CommitComposer — commit gate", () => {
  it("disables Commit until a summary is entered", async () => {
    const user = userEvent.setup();
    renderComposer({ preview: makePreview(), previewDraft: "feat: do the thing" });
    const button = screen.getByRole("button", { name: /^Commit/ });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("Summary"), "feat: do the thing");
    expect(button).toBeEnabled();
  });

  it("blocks Commit when message validation reports a violation", async () => {
    const user = userEvent.setup();
    renderComposer({
      previewDraft: "feat: a very long subject",
      preview: makePreview({
        messageValidation: { ok: false, violations: ["subject-too-long"] },
      }),
    });
    await user.type(screen.getByLabelText("Summary"), "feat: a very long subject");

    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
    expect(screen.getByTestId("git-commit-violations")).toHaveTextContent(
      "The subject line is too long",
    );
  });

  it("keeps Commit enabled for soft quality warnings", async () => {
    const user = userEvent.setup();
    renderComposer({
      previewDraft: "wip: still cooking",
      preview: makePreview({
        intent: { warnings: ["wip-marker"], mixedScope: false, isWip: true },
      }),
    });
    await user.type(screen.getByLabelText("Summary"), "wip: still cooking");

    expect(screen.getByRole("button", { name: /^Commit/ })).toBeEnabled();
    expect(screen.getByTestId("git-commit-warnings")).toHaveTextContent(
      "Work-in-progress marker in the subject",
    );
  });

  it("disables Commit and shows a hint when nothing is staged", () => {
    renderComposer({ stagedFileCount: 0 });
    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
    expect(screen.getByText(/Stage changes to commit/)).toBeInTheDocument();
  });

  it("disables Commit while a commit is in flight", () => {
    renderComposer({ busy: true, preview: makePreview(), previewDraft: "" });
    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
  });

  it("keeps Commit disabled until the policy preview matches the current draft", async () => {
    const user = userEvent.setup();
    renderComposer({ preview: makePreview(), previewDraft: "feat: old" });

    await user.type(screen.getByLabelText("Summary"), "feat: new");

    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
    expect(screen.getByText("Wait for commit policy preview.")).toBeInTheDocument();
  });
});

describe("CommitComposer — preview and outcomes", () => {
  it("does not request a commit preview for an empty draft", async () => {
    vi.useFakeTimers();
    const { onPreview } = renderComposer();

    await vi.advanceTimersByTimeAsync(500);

    expect(onPreview).not.toHaveBeenCalled();
  });

  it("debounces a policy preview for the composed draft when changes are staged", async () => {
    const user = userEvent.setup();
    const { onPreview } = renderComposer();
    await user.type(screen.getByLabelText("Summary"), "feat: x");

    await waitFor(() => expect(onPreview).toHaveBeenCalledWith("feat: x"));
  });

  it("renders a preview-error alert when the preview fails", () => {
    renderComposer({ previewError: "preview route unavailable" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Preview unavailable");
    expect(alert).toHaveTextContent("preview route unavailable");
  });

  it("renders the change summary in the policy preview", () => {
    renderComposer({
      previewDraft: "",
      preview: makePreview({
        summary: { stagedFileCount: 3, areaCount: 2, areas: ["src", "docs"], touchesTests: true },
      }),
    });
    const preview = screen.getByTestId("git-commit-preview");
    expect(preview).toHaveTextContent("3 staged files across 2 areas");
    expect(preview).toHaveTextContent("touches tests");
  });

  it("renders the commit mutation outcome", () => {
    renderComposer({
      outcome: { schemaVersion: "1", status: "succeeded", actionKind: "commit" },
    });
    expect(screen.getByTestId("git-commit-outcome")).toHaveTextContent("Succeeded");
  });

  it("renders a transport error", () => {
    renderComposer({ error: "network down" });
    expect(screen.getByTestId("git-commit-outcome")).toHaveTextContent("network down");
  });
});

describe("CommitComposer — commit action", () => {
  it("commits the composed summary and body", async () => {
    const user = userEvent.setup();
    const { onCommit } = renderComposer({
      preview: makePreview(),
      previewDraft: "feat: subject\n\nBody.",
    });
    await user.type(screen.getByLabelText("Summary"), "feat: subject");
    await user.type(screen.getByLabelText("Description"), "Body.");
    await user.click(screen.getByRole("button", { name: /^Commit/ }));

    expect(onCommit).toHaveBeenCalledWith("feat: subject\n\nBody.");
  });
});

describe("CommitComposer — keyboard", () => {
  it("reaches the summary, description, and Commit button by Tab", async () => {
    const user = userEvent.setup();
    renderComposer({ preview: makePreview(), previewDraft: "feat: x" });

    await user.click(screen.getByLabelText("Summary"));
    await user.keyboard("feat: x");
    expect(screen.getByLabelText("Summary")).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText("Description")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: /^Commit/ })).toHaveFocus();
  });
});
