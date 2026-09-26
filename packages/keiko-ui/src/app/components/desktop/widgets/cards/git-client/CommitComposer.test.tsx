// Behavioural unit tests for the CommitComposer (Issue #1575, Epic #1571).
// Covers the hard commit-policy gate, soft quality warnings, preview errors, mutation outcomes,
// the composed message (summary + body), and keyboard reachability. The composer is a presentational
// component driven entirely by props, so no seam mock is needed.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GitDeliveryCommitPreviewResponse } from "@/lib/api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
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
      previewRevision={0}
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
  resetClientDiagnosticWriter();
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
  it("loads the current staged summary without auto-generating a Keiko draft", async () => {
    vi.useFakeTimers();
    const onGenerateDraft = vi.fn(async () => "chore: generated\n\nBody.");
    const { onPreview } = renderComposer({ onGenerateDraft });

    await vi.advanceTimersByTimeAsync(0);

    expect(onPreview).toHaveBeenCalledWith("");
    expect(onGenerateDraft).not.toHaveBeenCalled();
  });

  it("debounces a policy preview for the composed draft when changes are staged", async () => {
    const user = userEvent.setup();
    const { onPreview } = renderComposer();
    await user.type(screen.getByLabelText("Summary"), "feat: x");

    await waitFor(() => expect(onPreview).toHaveBeenCalledWith("feat: x"));
  });

  it("refreshes the preview when the staged repository revision changes", async () => {
    vi.useFakeTimers();
    const onPreview = vi.fn();
    const props = {
      projectId: "/repos/alpha",
      stagedFileCount: 2,
      busy: false,
      outcome: null,
      error: null,
      preview: null,
      previewDraft: null,
      previewError: null,
      onPreview,
      onCommit: vi.fn(),
    } as const;
    const view = render(<CommitComposer {...props} previewRevision={1} />);
    await vi.advanceTimersByTimeAsync(0);
    onPreview.mockClear();

    view.rerender(<CommitComposer {...props} previewRevision={2} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith("");
  });

  it("renders a preview-error alert when the preview fails", () => {
    renderComposer({ previewError: "preview route unavailable" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Preview unavailable");
    expect(alert).toHaveTextContent("preview route unavailable");
  });

  // #3647: a transient preview failure previously left Commit disabled indefinitely — nothing
  // schedules another preview request merely because the error clears, so the user had to
  // discover a workaround such as editing the message and editing it back.
  it("does not render a Retry preview action when there is no preview error", () => {
    renderComposer();
    expect(screen.queryByRole("button", { name: "Retry preview" })).not.toBeInTheDocument();
  });

  it("retries with the currently composed message when Retry preview is clicked", async () => {
    const user = userEvent.setup();
    const { onPreview } = renderComposer({ previewError: "preview route unavailable" });
    await user.type(screen.getByLabelText("Summary"), "feat: x");
    onPreview.mockClear();

    await user.click(screen.getByRole("button", { name: "Retry preview" }));

    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith("feat: x");
  });

  it("hides stale draft, policy, and preview errors when the staged selection becomes empty", () => {
    const props = {
      projectId: "/repos/alpha",
      busy: false,
      outcome: null,
      error: null,
      preview: makePreview(),
      previewDraft: "",
      previewError: "stale preview error",
      previewRevision: 1,
      onPreview: vi.fn(),
      onCommit: vi.fn(),
    } as const;
    const view = render(<CommitComposer {...props} stagedFileCount={2} />);
    expect(screen.queryByTestId("git-commit-draft")).not.toBeInTheDocument();

    view.rerender(<CommitComposer {...props} stagedFileCount={0} previewRevision={2} />);

    expect(screen.queryByTestId("git-commit-draft")).not.toBeInTheDocument();
    expect(screen.queryByText("stale preview error")).not.toBeInTheDocument();
    expect(screen.getByText("Stage changes to prepare a commit draft.")).toBeInTheDocument();
  });

  it("does not render an unavailable draft card when the preview has no suggestion", () => {
    renderComposer({
      previewDraft: "",
      preview: makePreview({
        summary: { stagedFileCount: 3, areaCount: 2, areas: ["src", "docs"], touchesTests: true },
      }),
    });

    expect(screen.queryByTestId("git-commit-draft")).not.toBeInTheDocument();
  });

  it("fills an empty composer only after the explicit Keiko draft button is clicked", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
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
      preview: makePreview(),
      onGenerateDraft: vi.fn(async () => suggestedMessage),
    });

    try {
      expect(screen.getByLabelText("Summary")).toHaveValue("");
      await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));
      await waitFor(() =>
        expect(screen.getByLabelText("Summary")).toHaveValue("chore: update staged changes"),
      );
      expect(screen.getByLabelText("Description")).toHaveValue(
        "Update 2 staged files in src.\nKeep the commit limited to the staged selection.",
      );
      expect(diagnostics).toEqual(["git-client: model commit draft applied from explicit action"]);
      expect(screen.queryByTestId("git-commit-draft")).not.toBeInTheDocument();
      expect(screen.getByTestId("git-commit-message-preview")).toHaveTextContent("Commit draft");
      await user.click(screen.getByRole("button", { name: "Copy commit draft" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(suggestedMessage));
      expect(screen.getByText("Copied")).toBeInTheDocument();

      await waitFor(() => expect(onPreview).toHaveBeenCalledWith(suggestedMessage));
    } finally {
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });

  it("does not overwrite a manual draft when an empty-preview suggestion arrives", () => {
    renderComposer({
      summaryValue: "docs: keep my subject",
      bodyValue: "Manual body",
      previewDraft: "",
      preview: makePreview({
        suggestedMessage: "chore: update staged changes\n\nGenerated detail.",
      }),
    });

    expect(screen.getByLabelText("Summary")).toHaveValue("docs: keep my subject");
    expect(screen.getByLabelText("Description")).toHaveValue("Manual body");
    expect(screen.queryByRole("group", { name: "Commit draft" })).not.toBeInTheDocument();
  });

  it("does not apply a commit draft from an older staged selection revision", async () => {
    renderComposer({
      previewDraft: "",
      previewRevision: 2,
      previewRequestRevision: 1,
      preview: makePreview({
        suggestedMessage: "chore: update old staged changes\n\nGenerated stale detail.",
      }),
    });

    expect(screen.getByLabelText("Summary")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
    expect(screen.queryByTestId("git-commit-draft")).not.toBeInTheDocument();
  });

  it("clears an unchanged generated draft when the staged revision changes", async () => {
    const user = userEvent.setup();
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const suggestedMessage = "chore: update staged changes\n\nUpdate the staged selection.";
    const props = {
      projectId: "/repos/alpha",
      stagedFileCount: 2,
      busy: false,
      outcome: null,
      error: null,
      preview: makePreview({ suggestedMessage }),
      previewDraft: "",
      previewRequestRevision: 1,
      previewError: null,
      onPreview: vi.fn(),
      onGenerateDraft: vi.fn(async () => suggestedMessage),
      onCommit: vi.fn(),
    } as const;
    const view = render(<CommitComposer {...props} previewRevision={1} />);

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Summary")).toHaveValue("chore: update staged changes"),
    );

    view.rerender(<CommitComposer {...props} stagedFileCount={1} previewRevision={2} />);

    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveValue(""));
    expect(screen.getByLabelText("Description")).toHaveValue("");
    expect(diagnostics).toEqual([
      "git-client: model commit draft applied from explicit action",
      "git-client: stale generated commit draft cleared (repository-revision-changed)",
    ]);
  });

  it("preserves a manually edited draft when the staged revision changes", async () => {
    const user = userEvent.setup();
    const suggestedMessage = "chore: update staged changes\n\nGenerated detail.";
    const props = {
      projectId: "/repos/alpha",
      stagedFileCount: 2,
      busy: false,
      outcome: null,
      error: null,
      preview: makePreview({ suggestedMessage }),
      previewDraft: "",
      previewRequestRevision: 1,
      previewError: null,
      onPreview: vi.fn(),
      onGenerateDraft: vi.fn(async () => suggestedMessage),
      onCommit: vi.fn(),
    } as const;
    const view = render(<CommitComposer {...props} previewRevision={1} />);

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Summary")).toHaveValue("chore: update staged changes"),
    );
    await user.clear(screen.getByLabelText("Summary"));
    await user.type(screen.getByLabelText("Summary"), "docs: explain the selected change");

    view.rerender(<CommitComposer {...props} stagedFileCount={1} previewRevision={2} />);

    expect(screen.getByLabelText("Summary")).toHaveValue("docs: explain the selected change");
    expect(screen.getByLabelText("Description")).toHaveValue("Generated detail.");
  });

  // A late draft response must NOT overwrite fields the user edited after clicking Generate.
  // Fails before the token-snapshot guard is added.
  it("discards a late generated draft that resolves after the user typed a new summary", async () => {
    const user = userEvent.setup();
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    let releaseDraft = (_message: string): void => undefined;
    const onGenerateDraft = vi.fn(
      (): Promise<string> =>
        new Promise((resolve) => {
          releaseDraft = resolve;
        }),
    );
    renderComposer({
      preview: makePreview(),
      previewDraft: "",
      onGenerateDraft,
    });

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));
    await user.type(screen.getByLabelText("Summary"), "docs: user typed this");

    releaseDraft("chore: model draft\n\nGenerated body.");
    await waitFor(() =>
      expect(diagnostics).toContain(
        "git-client: generated commit draft discarded (composer edited before response)",
      ),
    );
    expect(screen.getByLabelText("Summary")).toHaveValue("docs: user typed this");
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });

  // The applied draft's stored representation must be canonical: a generated message with CRLF
  // or trailing whitespace, once split and applied, has to compare equal to
  // `composeCommitMessage(summary, body)` when the preview revision changes — otherwise
  // `clearStaleAppliedDraft` never fires and the stale draft lingers.
  it("clears a CRLF-normalized generated draft when the staged revision changes", async () => {
    const user = userEvent.setup();
    const diagnostics: string[] = [];
    setClientDiagnosticWriter((message) => diagnostics.push(message));
    const rawSuggested = "chore: crlf draft\r\n\r\nGenerated body.\r\n";
    const props = {
      projectId: "/repos/alpha",
      stagedFileCount: 2,
      busy: false,
      outcome: null,
      error: null,
      preview: makePreview(),
      previewDraft: "",
      previewRequestRevision: 1,
      previewError: null,
      onPreview: vi.fn(),
      onGenerateDraft: vi.fn(async () => rawSuggested),
      onCommit: vi.fn(),
    } as const;
    const view = render(<CommitComposer {...props} previewRevision={1} />);

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));
    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveValue("chore: crlf draft"));

    view.rerender(<CommitComposer {...props} stagedFileCount={1} previewRevision={2} />);

    await waitFor(() => expect(screen.getByLabelText("Summary")).toHaveValue(""));
    expect(screen.getByLabelText("Description")).toHaveValue("");
    expect(diagnostics).toContain(
      "git-client: stale generated commit draft cleared (repository-revision-changed)",
    );
  });

  it("surfaces a Keiko draft generation failure without fabricating a fallback message", async () => {
    const user = userEvent.setup();
    renderComposer({
      onGenerateDraft: vi.fn(async () => {
        throw new Error("No compatible model is available for commit draft generation.");
      }),
    });

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No compatible model is available for commit draft generation.",
    );
    expect(screen.getByLabelText("Summary")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });

  // #3591: a slow LiteLLM-fronted gateway is reported as a typed timeout, not the server's generic
  // safe message — the Git window gives the operator an actionable, localized next step instead.
  // The thrown ApiError deliberately carries a DIFFERENT message than the expected UI text: this
  // proves the displayed text comes from the CODE-based catalog lookup, not merely from relaying
  // whatever `error.message` says (which would make the assertion pass even without the mapping).
  it("gives the gateway-timeout draft failure an actionable, localized message", async () => {
    const user = userEvent.setup();
    renderComposer({
      onGenerateDraft: vi.fn(async () => {
        throw new ApiError(
          "GIT_DELIVERY_COMMIT_DRAFT_TIMED_OUT",
          "server-safe-message-placeholder",
          504,
        );
      }),
    });

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The gateway did not answer in time; the draft was not generated. Retry, or write the message yourself.",
    );
    expect(alert).not.toHaveTextContent("server-safe-message-placeholder");
  });

  // A reasoning model that spent its whole output budget on reasoning gets its own text distinct
  // from a plain "did not pass validation" — the operator otherwise has no idea raising a setting
  // (or retrying) would help. Same deliberate-mismatch technique as the timeout test above.
  it("gives the output-exhausted draft failure a distinct, localized message", async () => {
    const user = userEvent.setup();
    renderComposer({
      onGenerateDraft: vi.fn(async () => {
        throw new ApiError(
          "GIT_DELIVERY_COMMIT_DRAFT_OUTPUT_EXHAUSTED",
          "server-safe-message-placeholder",
          502,
        );
      }),
    });

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/output budget/);
    expect(alert).not.toHaveTextContent("server-safe-message-placeholder");
    expect(alert).not.toHaveTextContent("did not pass validation");
  });

  // GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT keeps surfacing the server's own safe message
  // unchanged — only the two new codes above get bespoke UI text.
  it("keeps relaying the server's own message for a code without bespoke UI text", async () => {
    const user = userEvent.setup();
    renderComposer({
      onGenerateDraft: vi.fn(async () => {
        throw new ApiError(
          "GIT_DELIVERY_COMMIT_DRAFT_INVALID_OUTPUT",
          "Keiko generated a commit draft that did not pass validation.",
          502,
        );
      }),
    });

    await user.click(screen.getByRole("button", { name: "Generate with Keiko" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Keiko generated a commit draft that did not pass validation.",
    );
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

  it("surfaces every preflight finding and a suggested subject prefix", async () => {
    const user = userEvent.setup();
    renderComposer({
      previewDraft: "feat: x",
      preview: makePreview({
        summary: { stagedFileCount: 2, areaCount: 2, areas: ["src", "docs"], touchesTests: false },
        intent: {
          warnings: [],
          mixedScope: false,
          isWip: false,
          suggestedSubjectPrefix: "feat",
        },
        preflightFindingCodes: [
          "branch-protection-unavailable",
          "signed-commits-required",
          "custom-policy-check",
        ],
      }),
    });

    await user.type(screen.getByLabelText("Summary"), "feat: x");

    expect(screen.getByText("Remote branch rules could not be read")).toBeInTheDocument();
    expect(screen.getByText("Signed commits may be required")).toBeInTheDocument();
    expect(screen.getByText("custom policy check")).toBeInTheDocument();
    expect(screen.getByText("feat")).toBeInTheDocument();
    expect(screen.getByTestId("git-commit-preview")).toHaveTextContent("2 areas");
  });

  it("reports a clipboard failure without losing the visible draft", async () => {
    const user = userEvent.setup();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    renderComposer({ preview: makePreview(), previewDraft: "feat: x" });

    try {
      await user.type(screen.getByLabelText("Summary"), "feat: x");
      await user.click(screen.getByRole("button", { name: "Copy commit draft" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Copy failed");
      expect(screen.getByLabelText("Summary")).toHaveValue("feat: x");
      expect(screen.getByTestId("git-commit-message-preview")).toBeInTheDocument();
    } finally {
      if (clipboardDescriptor === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
      } else {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
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

  it("hides the redundant remote-protection finding on a protected current branch", async () => {
    const user = userEvent.setup();
    renderComposer({
      onCreateBranch: vi.fn(),
      preview: makePreview({
        policyOutcome: "blocked",
        policyBlockReason: "protected-branch",
        preflightFindingCodes: ["branch-protection-unavailable"],
      }),
      previewDraft: "feat: x",
    });

    await user.type(screen.getByLabelText("Summary"), "feat: x");

    expect(screen.getByText(/Current branch is protected/)).toBeInTheDocument();
    expect(screen.queryByText("Remote branch rules could not be read")).not.toBeInTheDocument();
  });

  it("shows a generic policy block and keeps delivery actions available", async () => {
    const user = userEvent.setup();
    const onCreatePullRequest = vi.fn();
    const onMerge = vi.fn();
    renderComposer({
      onCreatePullRequest,
      onMerge,
      preview: makePreview({ policyOutcome: "blocked", policyBlockReason: "policy-denied" }),
      previewDraft: "feat: x",
    });

    await user.type(screen.getByLabelText("Summary"), "feat: x");
    expect(
      screen.getByText("Resolve the commit-policy issues below to commit."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This commit is blocked by the repository policy."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create pull request" }));
    await user.click(screen.getByRole("button", { name: "Merge…" }));
    expect(onCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it("disables delivery actions when no repository is selected", () => {
    renderComposer({
      projectId: null,
      onCreatePullRequest: vi.fn(),
      onMerge: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "Create pull request" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge…" })).toBeDisabled();
    expect(screen.getByText("Select a repository to commit.")).toBeInTheDocument();
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
