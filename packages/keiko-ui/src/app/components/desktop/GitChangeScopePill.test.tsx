// Issue #3400 (epic #3384) — unit tests for the git-change scope pill.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import { GitChangeScopePill } from "./GitChangeScopePill";
import type {
  Chat,
  ChatGitChangeDescriptionStatus,
  ChatGitChangeScope,
  ChatResponse,
} from "@/lib/types";
import type { GitChangeRefreshResponse } from "@/lib/api";

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/proj",
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeGitChangeScope(overrides: Partial<ChatGitChangeScope> = {}): ChatGitChangeScope {
  return {
    kind: "git-change",
    relationshipId: "rel-1",
    remoteDigest: "d".repeat(64),
    comparisonLabel: "main...feature/x",
    baseRef: "main",
    headRef: "feature/x",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergeBaseSha: "c".repeat(40),
    snapshotDigest: "e".repeat(64),
    fileCount: 3,
    totalFiles: 3,
    omittedFiles: 0,
    truncatedFiles: 0,
    descriptionStatus: "current",
    connectedAtMs: 10,
    ...overrides,
  };
}

describe("GitChangeScopePill", () => {
  it("renders nothing when the chat has no connected git-change scope", () => {
    const { container } = render(
      <GitChangeScopePill chat={makeChat()} updateScopes={vi.fn()} refreshScope={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the comparison label, status and counts", () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    render(<GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />);
    expect(screen.getByText("main...feature/x")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("3 files changed")).toBeInTheDocument();
  });

  // Review residual: the file-count message had no plural handling, so a single changed file
  // rendered the grammatically wrong "1 files changed" (and the German catalog said "1 geänderte
  // Dateien" instead of "1 geänderte Datei"). Failing-before: with the old unconditional
  // "gitChangeScope.counts.files" key, `getByText("1 file changed")` below never matches.
  it("uses the singular count message for exactly one changed file", () => {
    const chat = makeChat({
      gitChangeScopes: [makeGitChangeScope({ fileCount: 1, totalFiles: 1 })],
    });
    render(<GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />);
    expect(screen.getByText("1 file changed")).toBeInTheDocument();
    expect(screen.queryByText("1 files changed")).not.toBeInTheDocument();
  });

  it("shows a shown/total counts label when files were omitted", () => {
    const chat = makeChat({
      gitChangeScopes: [makeGitChangeScope({ fileCount: 3, totalFiles: 5, omittedFiles: 2 })],
    });
    render(<GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />);
    expect(screen.getByText("3 of 5 files shown")).toBeInTheDocument();
  });

  it.each<ChatGitChangeDescriptionStatus>([
    "current",
    "stale",
    "partial",
    "fallback",
    "blocked",
    "failed",
  ])("renders a distinct badge for descriptionStatus=%s", (status) => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope({ descriptionStatus: status })] });
    render(<GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />);
    // Badge text is the localized status label; each status renders exactly once.
    expect(screen.getAllByText(/^(Current|Stale|Partial|Fallback|Blocked|Failed)$/)).toHaveLength(
      1,
    );
  });

  it("renders one pill per connected scope with stable, distinct keys", () => {
    const scopes: ChatGitChangeScope[] = [
      makeGitChangeScope({ relationshipId: "rel-1", comparisonLabel: "main...feature/a" }),
      makeGitChangeScope({ relationshipId: "rel-2", comparisonLabel: "main...feature/b" }),
    ];
    render(
      <GitChangeScopePill
        chat={makeChat({ gitChangeScopes: scopes })}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
      />,
    );
    expect(screen.getByText("main...feature/a")).toBeInTheDocument();
    expect(screen.getByText("main...feature/b")).toBeInTheDocument();
    // Two pills × (refresh + disconnect) = 4 buttons.
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  it("disconnects and PATCHes with the remaining scopes", async () => {
    const scopes: ChatGitChangeScope[] = [
      makeGitChangeScope({ relationshipId: "rel-1" }),
      makeGitChangeScope({ relationshipId: "rel-2", comparisonLabel: "main...feature/b" }),
    ];
    const chat = makeChat({ gitChangeScopes: scopes });
    const updated: Chat = { ...chat, gitChangeScopes: [scopes[1]!] };
    const updateScopes = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={updateScopes}
        refreshScope={vi.fn()}
        onDisconnect={onDisconnect}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Disconnect main...feature/x from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", [scopes[1]]);
    });
    expect(onDisconnect).toHaveBeenCalledWith(updated);
  });

  it("PATCHes null when the last git-change scope is disconnected", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const cleared: Chat = makeChat();
    const updateScopes = vi.fn().mockResolvedValue({ chat: cleared } satisfies ChatResponse);
    const user = userEvent.setup();
    render(<GitChangeScopePill chat={chat} updateScopes={updateScopes} refreshScope={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Disconnect main...feature/x from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", null);
    });
  });

  it("surfaces a disconnect wire error via role=alert", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const updateScopes = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<GitChangeScopePill chat={chat} updateScopes={updateScopes} refreshScope={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Disconnect main...feature/x from chat" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("offline");
    });
  });

  it("refreshes and replaces the scope with the returned current projection", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const refreshed: GitChangeRefreshResponse = {
      status: "current",
      scope: makeGitChangeScope(),
    };
    const refreshScope = vi.fn().mockResolvedValue(refreshed);
    const onRefreshed = vi.fn();
    const user = userEvent.setup();
    render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={refreshScope}
        onRefreshed={onRefreshed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Refresh main...feature/x" }));
    await waitFor(() => {
      expect(refreshScope).toHaveBeenCalledWith("chat-1", "rel-1");
    });
    expect(onRefreshed).toHaveBeenCalledWith({
      ...chat,
      gitChangeScopes: [refreshed.scope],
    });
  });

  // Owner audit b1-6 — before the fix, `runRefresh` merged the *chat prop captured at click time*
  // instead of the latest one, so a title rename (or any other chat field change) that landed
  // while the refresh round trip was in flight got silently reverted by the merge. Failing-before:
  // `onRefreshed` was called with `title: "t"` (the stale click-time value) instead of the renamed
  // title that committed before the response resolved.
  it("merges a refresh response onto the latest chat, not the one captured at click time", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    let resolveRefresh: ((value: GitChangeRefreshResponse) => void) | undefined;
    const refreshScope = vi.fn(
      () =>
        new Promise<GitChangeRefreshResponse>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const onRefreshed = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={refreshScope}
        onRefreshed={onRefreshed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Refresh main...feature/x" }));
    await waitFor(() => {
      expect(refreshScope).toHaveBeenCalledWith("chat-1", "rel-1");
    });
    // A title rename lands (via the normal chat-list prop update) while the refresh is in flight.
    const renamedChat = { ...chat, title: "renamed while refresh was in flight" };
    rerender(
      <GitChangeScopePill
        chat={renamedChat}
        updateScopes={vi.fn()}
        refreshScope={refreshScope}
        onRefreshed={onRefreshed}
      />,
    );
    const refreshed: GitChangeRefreshResponse = { status: "current", scope: makeGitChangeScope() };
    resolveRefresh?.(refreshed);
    await waitFor(() => {
      expect(onRefreshed).toHaveBeenCalledWith({
        ...renamedChat,
        gitChangeScopes: [refreshed.scope],
      });
    });
  });

  it("shows a stale scope after a refresh detects a moved head", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const staleScope = makeGitChangeScope({
      relationshipId: "rel-2",
      snapshotDigest: "f".repeat(64),
      descriptionStatus: "stale",
    });
    const refreshScope = vi
      .fn()
      .mockResolvedValue({ status: "stale", scope: staleScope } satisfies GitChangeRefreshResponse);
    const onRefreshed = vi.fn();
    const user = userEvent.setup();
    render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={refreshScope}
        onRefreshed={onRefreshed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Refresh main...feature/x" }));
    await waitFor(() => {
      expect(onRefreshed).toHaveBeenCalledWith({ ...chat, gitChangeScopes: [staleScope] });
    });
  });

  it("surfaces a blocked refresh reason as a body-free localized message, never a raw code", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const refreshScope = vi.fn().mockResolvedValue({
      status: "blocked",
      reason: "detached-head",
    } satisfies GitChangeRefreshResponse);
    const user = userEvent.setup();
    render(<GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={refreshScope} />);
    await user.click(screen.getByRole("button", { name: "Refresh main...feature/x" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Blocked: the repository HEAD is detached.",
      );
    });
    expect(screen.queryByText(/detached-head/)).not.toBeInTheDocument();
  });

  it("announces removal once the last scope is disconnected via a prop change", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const { rerender } = render(
      <GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />,
    );
    rerender(
      <GitChangeScopePill
        chat={makeChat({ gitChangeScopes: [] })}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("git-change-scope-announcer")).toHaveTextContent(
        "Connected Git change removed.",
      );
    });
  });

  it("announces a stale transition distinctly from a routine connect", async () => {
    const chat = makeChat({ gitChangeScopes: [] });
    const { rerender } = render(
      <GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />,
    );
    rerender(
      <GitChangeScopePill
        chat={makeChat({ gitChangeScopes: [makeGitChangeScope()] })}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("git-change-scope-announcer")).toHaveTextContent(
        "Git change connected.",
      );
    });
    rerender(
      <GitChangeScopePill
        chat={makeChat({
          gitChangeScopes: [makeGitChangeScope({ descriptionStatus: "stale" })],
        })}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("git-change-scope-announcer")).toHaveTextContent(
        "Connected Git change is stale; refresh to continue.",
      );
    });
  });

  it("jest-axe: no violations with one connected git-change scope", async () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    const { container } = render(
      <GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: no violations with a blocked-status scope", async () => {
    const chat = makeChat({
      gitChangeScopes: [makeGitChangeScope({ descriptionStatus: "blocked" })],
    });
    const { container } = render(
      <GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// #3400 final-audit F5: before the apply action and its Preview -> Approve -> Apply affordance
// existed, a PR-connected scope rendered no `git-change-description-*` controls at all — every
// `getByTestId`/`getByRole` lookup below failed with "Unable to find an element" before this UI
// was added. Renders nothing for a comparison-only scope (no `pullRequestNumber`), covered above.
describe("GitChangeScopePill — description apply affordance (#3400 final-audit F5)", () => {
  function applicationStatusFixture(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schemaVersion: "1",
      state: "current",
      reason: "applied",
      binding: {
        repositoryId: "repo-1",
        remoteDigest: "a".repeat(64),
        repository: "oscharko-dev/Keiko",
        prNumber: 1499,
        prExternalId: "1499",
        baseRef: "dev",
        baseSha: "b".repeat(40),
        headRepository: "oscharko-dev/Keiko",
        headRef: "feature/x",
        headSha: "c".repeat(40),
        isDraft: false,
        snapshotDigest: "d".repeat(64),
        draftDigest: "e".repeat(64),
        renderingVersion: "1",
        expectedBodyDigest: "f".repeat(64),
        outsideRegionDigest: "0".repeat(64),
        finalBodyDigest: "1".repeat(64),
        providerUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      observedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:00:30.000Z",
      completeness: "complete",
      effect: "confirmed",
      concurrency: "read-check-write-verify",
      ...overrides,
    };
  }

  function prScope(overrides: Partial<ChatGitChangeScope> = {}): ChatGitChangeScope {
    return makeGitChangeScope({ pullRequestNumber: 1499, ...overrides });
  }

  it("renders no description controls for a comparison-only scope (no pull request)", () => {
    const chat = makeChat({ gitChangeScopes: [makeGitChangeScope()] });
    render(<GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />);
    expect(screen.queryByTestId("git-change-description-panel")).not.toBeInTheDocument();
  });

  it("runs preview -> approve -> apply and renders the final applied status", async () => {
    const chat = makeChat({ gitChangeScopes: [prScope()] });
    const previewDescription = vi.fn().mockResolvedValue({
      outcome: "preview",
      preview: {
        proposalId: "prop-1",
        expiresAt: "2026-01-01T00:00:30.000Z",
        status: applicationStatusFixture(),
        finalBody: "generated body",
        managedRegion: "generated body",
        concurrencyLimitation: "x",
      },
    });
    const approveDescription = vi
      .fn()
      .mockResolvedValue({ schemaVersion: "1", proposalId: "prop-1", expiresAt: "x" });
    const applyDescription = vi
      .fn()
      .mockResolvedValue({ outcome: "observed", status: applicationStatusFixture() });
    const user = userEvent.setup();
    render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
        approveDescription={approveDescription}
        applyDescription={applyDescription}
      />,
    );

    await user.click(screen.getByTestId("git-change-description-preview"));
    await waitFor(() => expect(previewDescription).toHaveBeenCalledWith(chat, prScope(), "en"));
    await waitFor(() =>
      expect(screen.getByTestId("git-change-description-state")).toHaveTextContent("Current"),
    );

    await user.click(screen.getByTestId("git-change-description-approve"));
    await waitFor(() => expect(approveDescription).toHaveBeenCalledWith(chat, prScope(), "prop-1"));

    await user.click(screen.getByTestId("git-change-description-apply"));
    await waitFor(() => expect(applyDescription).toHaveBeenCalledWith(chat, "rel-1", "prop-1"));

    // One-use: applying clears the approved proposal, so a second Apply click never re-fires.
    await user.click(screen.getByTestId("git-change-description-apply"));
    expect(applyDescription).toHaveBeenCalledTimes(1);
  });

  it("disables approve for a stale connected scope, even if a proposal was already previewed", async () => {
    // The scope starts current (so preview succeeds and yields a real proposalId), then a refresh
    // flips it stale — Approve must refuse even though a fresh, un-consumed proposal exists.
    const chat = makeChat({ gitChangeScopes: [prScope({ descriptionStatus: "current" })] });
    const previewDescription = vi.fn().mockResolvedValue({
      outcome: "preview",
      preview: {
        proposalId: "prop-1",
        expiresAt: "x",
        status: applicationStatusFixture(),
        finalBody: "x",
        managedRegion: "x",
        concurrencyLimitation: "x",
      },
    });
    const approveDescription = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
        approveDescription={approveDescription}
      />,
    );
    await user.click(screen.getByTestId("git-change-description-preview"));
    await waitFor(() => expect(previewDescription).toHaveBeenCalled());
    expect(screen.getByTestId("git-change-description-approve")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );

    rerender(
      <GitChangeScopePill
        chat={makeChat({ gitChangeScopes: [prScope({ descriptionStatus: "stale" })] })}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
        approveDescription={approveDescription}
      />,
    );
    expect(screen.getByTestId("git-change-description-approve")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByTestId("git-change-description-approve"));
    expect(approveDescription).not.toHaveBeenCalled();
  });

  it("disables apply for a stale connected scope, even after the proposal was approved", async () => {
    // Preview + approve succeed while current, then a refresh flips the scope stale before Apply
    // is clicked — Apply must refuse the already-approved proposal rather than reaching the
    // one-use apply action for a description that may no longer match the live PR.
    const chat = makeChat({ gitChangeScopes: [prScope({ descriptionStatus: "current" })] });
    const previewDescription = vi.fn().mockResolvedValue({
      outcome: "preview",
      preview: {
        proposalId: "prop-1",
        expiresAt: "x",
        status: applicationStatusFixture(),
        finalBody: "x",
        managedRegion: "x",
        concurrencyLimitation: "x",
      },
    });
    const approveDescription = vi
      .fn()
      .mockResolvedValue({ schemaVersion: "1", proposalId: "prop-1", expiresAt: "x" });
    const applyDescription = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
        approveDescription={approveDescription}
        applyDescription={applyDescription}
      />,
    );
    await user.click(screen.getByTestId("git-change-description-preview"));
    await waitFor(() => expect(previewDescription).toHaveBeenCalled());
    await user.click(screen.getByTestId("git-change-description-approve"));
    await waitFor(() => expect(approveDescription).toHaveBeenCalled());
    expect(screen.getByTestId("git-change-description-apply")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );

    rerender(
      <GitChangeScopePill
        chat={makeChat({ gitChangeScopes: [prScope({ descriptionStatus: "stale" })] })}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
        approveDescription={approveDescription}
        applyDescription={applyDescription}
      />,
    );
    expect(screen.getByTestId("git-change-description-apply")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByTestId("git-change-description-apply"));
    expect(applyDescription).not.toHaveBeenCalled();
  });

  it("renders a blocked outcome's state and reason code body-free, never a raw error body", async () => {
    const chat = makeChat({ gitChangeScopes: [prScope()] });
    const previewDescription = vi
      .fn()
      .mockResolvedValue({ outcome: "blocked", reason: "authority-denied" });
    const user = userEvent.setup();
    render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
      />,
    );

    await user.click(screen.getByTestId("git-change-description-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("git-change-description-state")).toHaveTextContent(
        "Blocked (authority-denied)",
      ),
    );
  });

  it("surfaces a preview wire error via role=alert, body-free", async () => {
    const chat = makeChat({ gitChangeScopes: [prScope()] });
    const previewDescription = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(
      <GitChangeScopePill
        chat={chat}
        updateScopes={vi.fn()}
        refreshScope={vi.fn()}
        previewDescription={previewDescription}
      />,
    );

    await user.click(screen.getByTestId("git-change-description-preview"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("offline"));
  });

  it("jest-axe: no violations with the description apply affordance rendered", async () => {
    const chat = makeChat({ gitChangeScopes: [prScope()] });
    const { container } = render(
      <GitChangeScopePill chat={chat} updateScopes={vi.fn()} refreshScope={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
