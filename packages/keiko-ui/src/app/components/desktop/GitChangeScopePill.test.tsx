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
