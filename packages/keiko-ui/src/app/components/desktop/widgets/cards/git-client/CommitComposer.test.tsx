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
    signatureRequirement: "not-required",
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
  it("exposes a visible Commit heading", () => {
    renderComposer();
    expect(screen.getByRole("heading", { name: "Commit" })).toBeInTheDocument();
  });

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
        intent: { warnings: ["wip-marker", "empty-body"], mixedScope: false, isWip: true },
      }),
    });
    await user.type(screen.getByLabelText("Summary"), "wip: still cooking");

    expect(screen.getByRole("button", { name: /^Commit/ })).toBeEnabled();
    expect(screen.getByTestId("git-commit-warnings")).toHaveTextContent(
      "Work-in-progress marker in the subject",
    );
    expect(screen.queryByText("No commit body")).not.toBeInTheDocument();
  });

  it("disables Commit and shows a hint when nothing is staged", () => {
    renderComposer({ stagedFileCount: 0 });
    expect(screen.getByRole("button", { name: /^Commit/ })).toBeDisabled();
    expect(screen.getByText(/Stage changes to prepare a commit draft/)).toBeInTheDocument();
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
  it("loads the current staged summary and eligible draft for an empty composer", async () => {
    vi.useFakeTimers();
    const { onPreview } = renderComposer();

    await vi.advanceTimersByTimeAsync(0);

    expect(onPreview).toHaveBeenCalledWith("");
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

  it("renders the change summary before a commit draft is entered", () => {
    renderComposer({
      previewDraft: "",
      preview: makePreview({
        summary: { stagedFileCount: 3, areaCount: 2, areas: ["src", "docs"], touchesTests: true },
      }),
    });
    const preview = screen.getByTestId("git-commit-draft");
    expect(preview).toHaveTextContent("3 staged files across 2 areas");
    expect(preview).toHaveTextContent("touches tests");
  });

  it("shows the live staged summary and applies an eligible commit draft on request", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const suggestedMessage = [
      "chore: update staged changes",
      "",
      "Update 2 staged files in src.",
      "Keep the commit limited to the staged selection.",
    ].join("\n");
    const { onPreview } = renderComposer({
      previewDraft: "",
      preview: makePreview({ suggestedMessage }),
    });

    try {
      expect(screen.getByTestId("git-commit-draft")).toHaveTextContent(
        "2 staged files across 1 area",
      );
      await user.click(screen.getByRole("button", { name: "Review commit draft" }));

      expect(screen.getByLabelText("Summary")).toHaveValue("chore: update staged changes");
      expect(screen.getByLabelText("Description")).toHaveValue(
        "Update 2 staged files in src.\nKeep the commit limited to the staged selection.",
      );
      expect(screen.getByTestId("git-commit-message-preview")).toHaveTextContent("Commit draft");
      await user.click(screen.getByRole("button", { name: "Copy commit draft" }));

      await waitFor(() => expect(onPreview).toHaveBeenCalledWith(suggestedMessage));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(suggestedMessage));
      expect(screen.getByText("Copied")).toBeInTheDocument();
    } finally {
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
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

  it("routes protected-branch commits to branch creation instead of execute", async () => {
    const user = userEvent.setup();
    const onCreateBranch = vi.fn();
    const { onCommit } = renderComposer({
      branchName: "dev",
      onCreateBranch,
      preview: makePreview({
        policyOutcome: "blocked",
        policyBlockReason: "protected-branch",
      }),
      previewDraft: "feat: x",
    });

    await user.type(screen.getByLabelText("Summary"), "feat: x");
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.includes("Current branch is protected") === true,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create branch first" }));

    expect(onCreateBranch).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("CommitComposer — keyboard", () => {
  it("reaches the summary, description, Commit button, and draft copy by Tab", async () => {
    const user = userEvent.setup();
    renderComposer({ preview: makePreview(), previewDraft: "feat: x" });

    await user.click(screen.getByLabelText("Summary"));
    await user.keyboard("feat: x");
    expect(screen.getByLabelText("Summary")).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText("Description")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: /^Commit/ })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Copy commit draft" })).toHaveFocus();
  });
});
