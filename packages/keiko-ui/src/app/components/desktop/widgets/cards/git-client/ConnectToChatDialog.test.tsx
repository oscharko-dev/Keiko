// Issue #3400 (epic #3384) — unit tests for the Git window's "Connect to Chat" dialog.
//
// Frozen Decision 5: the Git window only CONNECTS a comparison to a Chat; it never composes or
// refines a description itself. These tests pin that boundary as well as the happy/blocked/error
// paths of the connect flow.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { ConnectGitChangeInput, GitChangeConnectResponse } from "@/lib/api";
import type { Chat, ChatsResponse } from "@/lib/types";
import { ConnectToChatDialog, type ConnectToChatDialogProps } from "./ConnectToChatDialog";

function makeChat(id: string, title: string): Chat {
  return {
    id,
    projectPath: "/repos/alpha",
    title,
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
  };
}

function oneChat(): ChatsResponse {
  return { chats: [makeChat("chat-1", "Release notes")] };
}

function baseProps(): Omit<ConnectToChatDialogProps, "listChats" | "connect"> {
  return {
    projectId: "/repos/alpha",
    currentBranch: "feature/x",
    baseBranchName: "main",
    baseBranchChoices: ["main", "dev"],
    onClose: vi.fn(),
  };
}

async function selectFirstChat(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: "Chat" }));
  await user.click(await screen.findByRole("option", { name: "Release notes" }));
}

describe("ConnectToChatDialog", () => {
  it("loads chats for the repository and lists them in the picker", async () => {
    const listChats = vi.fn(async (): Promise<ChatsResponse> => ({
      chats: [makeChat("chat-1", "Release notes"), makeChat("chat-2", "Bug triage")],
    }));
    const user = userEvent.setup();
    render(<ConnectToChatDialog {...baseProps()} listChats={listChats} connect={vi.fn()} />);
    await waitFor(() => expect(listChats).toHaveBeenCalledWith("/repos/alpha"));
    await user.click(await screen.findByRole("combobox", { name: "Chat" }));
    expect(await screen.findByRole("option", { name: "Release notes" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Bug triage" })).toBeInTheDocument();
  });

  it("shows an empty-chats hint and keeps Connect disabled when the repository has no chats", async () => {
    const listChats = vi.fn(async (): Promise<ChatsResponse> => ({ chats: [] }));
    render(<ConnectToChatDialog {...baseProps()} listChats={listChats} connect={vi.fn()} />);
    expect(
      await screen.findByText("No chats are open for this repository yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("keeps Connect disabled while there is no current branch to compare from", async () => {
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    const user = userEvent.setup();
    render(
      <ConnectToChatDialog
        {...baseProps()}
        currentBranch={undefined}
        listChats={listChats}
        connect={vi.fn()}
      />,
    );
    await selectFirstChat(user);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("connects an exact comparison using the default base branch", async () => {
    const onConnected = vi.fn();
    const scope = {
      kind: "git-change",
      relationshipId: "relationship-1",
      remoteDigest: "d".repeat(64),
      comparisonLabel: "main...feature/x",
      baseRef: "main",
      headRef: "feature/x",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      mergeBaseSha: "a".repeat(40),
      snapshotDigest: "c".repeat(64),
      fileCount: 1,
      totalFiles: 1,
      omittedFiles: 0,
      truncatedFiles: 0,
      descriptionStatus: "current",
      connectedAtMs: 3,
    } as const;
    const connect = vi.fn(async (): Promise<GitChangeConnectResponse> => ({
      status: "connected",
      scope,
    }));
    const onClose = vi.fn();
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    const user = userEvent.setup();
    render(
      <ConnectToChatDialog
        {...baseProps()}
        onClose={onClose}
        onConnected={onConnected}
        listChats={listChats}
        connect={connect}
      />,
    );
    await selectFirstChat(user);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({
        chatId: "chat-1",
        mode: "comparison",
        headRef: "feature/x",
        baseRef: "main",
      } satisfies ConnectGitChangeInput);
    });
    expect(onConnected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "chat-1", gitChangeScopes: [scope] }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("connects to the one open pull request for the branch when Open pull request is selected", async () => {
    const connect = vi.fn(async (): Promise<GitChangeConnectResponse> => ({
      status: "connected",
      scope: {} as never,
    }));
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    const user = userEvent.setup();
    render(<ConnectToChatDialog {...baseProps()} listChats={listChats} connect={connect} />);
    await selectFirstChat(user);
    await user.click(screen.getByRole("button", { name: "Open pull request for this branch" }));
    expect(screen.queryByRole("combobox", { name: "Base branch" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith({
        chatId: "chat-1",
        mode: "pull-request",
        headRef: "feature/x",
      } satisfies ConnectGitChangeInput);
    });
  });

  it("renders a blocked reason as a body-free localized message and keeps the dialog open", async () => {
    const connect = vi.fn(async (): Promise<GitChangeConnectResponse> => ({
      status: "blocked",
      reason: "detached-head",
    }));
    const onClose = vi.fn();
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    const user = userEvent.setup();
    render(
      <ConnectToChatDialog
        {...baseProps()}
        onClose={onClose}
        listChats={listChats}
        connect={connect}
      />,
    );
    await selectFirstChat(user);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Blocked: the repository HEAD is detached.",
    );
    expect(screen.queryByText(/detached-head/)).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a transport failure via role=alert without closing the dialog", async () => {
    const connect = vi.fn().mockRejectedValue(new Error("offline"));
    const onClose = vi.fn();
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    const user = userEvent.setup();
    render(
      <ConnectToChatDialog
        {...baseProps()}
        onClose={onClose}
        listChats={listChats}
        connect={connect}
      />,
    );
    await selectFirstChat(user);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    render(
      <ConnectToChatDialog
        {...baseProps()}
        onClose={onClose}
        listChats={listChats}
        connect={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(dialog, "{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Frozen Decision 5 / AC "no second composer... no generic Git UI is introduced": the Git
  // window's only Chat-reachable surface is this connect dialog, and it must expose nothing a
  // branch, push, PR-create, or merge control would — those stay on the window's existing
  // Changes/Sync/Pull-Request/Merge surfaces, untouched by this dialog.
  it("exposes no branch, push, PR-create, or merge control", async () => {
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    render(<ConnectToChatDialog {...baseProps()} listChats={listChats} connect={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    const forbidden = [
      /create branch/i,
      /switch branch/i,
      /push/i,
      /create pull request/i,
      /merge/i,
      /publish/i,
      /commit/i,
    ];
    for (const pattern of forbidden) {
      expect(dialog.textContent ?? "").not.toMatch(pattern);
    }
  });

  it("jest-axe: no violations with chats loaded", async () => {
    const listChats = vi.fn(async (): Promise<ChatsResponse> => oneChat());
    const { container } = render(
      <ConnectToChatDialog {...baseProps()} listChats={listChats} connect={vi.fn()} />,
    );
    await waitFor(() => expect(listChats).toHaveBeenCalled());
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
