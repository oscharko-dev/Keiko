// Issue #184 — unit tests for the Files → chat connector button.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ScopeConnectButton } from "./ScopeConnectButton";
import type { Chat, ChatConnectedScope, ChatResponse } from "@/lib/types";

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

describe("ScopeConnectButton", () => {
  it("is disabled and tooltipped when there is no candidate selection", () => {
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="files"
        currentScopeKind={undefined}
        candidateRelativePaths={[]}
        updateScope={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button");
    // PR #254 Copilot fix: empty-state uses aria-disabled rather than native disabled so the
    // button stays in the focus order and keyboard users can reach the tooltip hint.
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAccessibleDescription("Select a folder or file first.");
    expect(btn).toHaveAttribute("title", "Select a folder or file first");
  });

  it('labels "Connect to chat" when the chat has no existing binding', () => {
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="files"
        currentScopeKind={undefined}
        candidateRelativePaths={["src/a.ts"]}
        updateScope={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Connect to chat");
  });

  it('labels "Update connected scope" when a binding already exists', () => {
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="files"
        currentScopeKind="files"
        candidateRelativePaths={["src/new.ts"]}
        updateScope={vi.fn()}
      />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Update connected scope");
  });

  it("allows repository scope with an empty relativePaths array", async () => {
    const updated = makeChat({
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 100 },
    });
    const updateScope = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const user = userEvent.setup();
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="workspace-root"
        currentScopeKind={undefined}
        candidateRelativePaths={[]}
        updateScope={updateScope}
        now={() => 100}
      />,
    );
    const button = screen.getByRole("button", { name: "Connect repository" });
    expect(button).toHaveAttribute("aria-disabled", "false");
    await user.click(button);
    await waitFor(() => {
      expect(updateScope).toHaveBeenCalledWith("chat-1", [
        { kind: "workspace-root", relativePaths: [], connectedAtMs: 100 },
      ]);
    });
  });

  it("calls updateScope with the candidate paths and a clock value on click", async () => {
    const updated = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 100 },
    });
    const updateScope = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const onConnected = vi.fn();
    const user = userEvent.setup();
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="files"
        currentScopeKind={undefined}
        candidateRelativePaths={["src/a.ts"]}
        updateScope={updateScope}
        now={() => 100}
        onConnected={onConnected}
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(updateScope).toHaveBeenCalledWith("chat-1", [
        { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 100 },
      ]);
    });
    expect(onConnected).toHaveBeenCalledWith(updated);
  });

  it("includes the explicit Files root when provided", async () => {
    const updated = makeChat({
      connectedScope: {
        kind: "files",
        relativePaths: ["src/a.ts"],
        connectedAtMs: 100,
        root: "/outside/project",
      },
    });
    const updateScope = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const user = userEvent.setup();
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="files"
        scopeRoot="/outside/project"
        currentScopeKind={undefined}
        candidateRelativePaths={["src/a.ts"]}
        updateScope={updateScope}
        now={() => 100}
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(updateScope).toHaveBeenCalledWith("chat-1", [
        {
          kind: "files",
          relativePaths: ["src/a.ts"],
          connectedAtMs: 100,
          root: "/outside/project",
        },
      ]);
    });
  });

  it("does not clear localKnowledgeScopes when connecting a folder (connector-safe)", async () => {
    // Connecting a folder via this button must NOT send localKnowledgeScope: null — it
    // must only patch connectedScopes (additive). The chat already has a folder scope.
    const existingFolderScope: ChatConnectedScope = {
      kind: "workspace-root",
      relativePaths: [],
      connectedAtMs: 50,
    };
    const chatWithConnector = makeChat({
      connectedScopes: [existingFolderScope],
    });
    const updated = makeChat({
      connectedScopes: [
        existingFolderScope,
        { kind: "directory", relativePaths: ["src"], connectedAtMs: 200 },
      ],
    });
    const updateScope = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const user = userEvent.setup();
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="directory"
        currentScopeKind={undefined}
        candidateRelativePaths={["src"]}
        chat={chatWithConnector}
        updateScope={updateScope}
        now={() => 200}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Connect folder" }));
    await waitFor(() => {
      expect(updateScope).toHaveBeenCalledTimes(1);
    });
    // Must call the plural updateChatConnectedScopes — the call must NOT include a
    // localKnowledgeScope key at all (that is enforced by the type: updateScope only
    // accepts (chatId, scopes[]) and never sends localKnowledgeScope).
    const [calledId, calledScopes] = updateScope.mock.calls[0] as [
      string,
      readonly ChatConnectedScope[],
    ];
    expect(calledId).toBe("chat-1");
    // Both the original folder scope and the new directory scope are present.
    expect(calledScopes).toHaveLength(2);
    expect(calledScopes[0]).toEqual(existingFolderScope);
    expect(calledScopes[1]).toMatchObject({
      kind: "directory",
      relativePaths: ["src"],
      connectedAtMs: 200,
    });
    // The call signature is (chatId, scopes[]) — a 2-element tuple. There is no third
    // argument that could carry localKnowledgeScope: null.
    expect(updateScope.mock.calls[0]).toHaveLength(2);
  });

  it("keeps scopes from different roots distinct even when their relative paths match", async () => {
    const existingFolderScope: ChatConnectedScope = {
      kind: "directory",
      relativePaths: ["src"],
      root: "/workspace-a",
      connectedAtMs: 50,
    };
    const chatWithConnector = makeChat({
      connectedScopes: [existingFolderScope],
    });
    const updated = makeChat({
      connectedScopes: [
        existingFolderScope,
        { kind: "directory", relativePaths: ["src"], root: "/workspace-b", connectedAtMs: 200 },
      ],
    });
    const updateScope = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const user = userEvent.setup();
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="directory"
        scopeRoot="/workspace-b"
        currentScopeKind={undefined}
        candidateRelativePaths={["src"]}
        chat={chatWithConnector}
        updateScope={updateScope}
        now={() => 200}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Connect folder" }));
    await waitFor(() => {
      expect(updateScope).toHaveBeenCalledTimes(1);
    });
    const [, calledScopes] = updateScope.mock.calls[0] as [string, readonly ChatConnectedScope[]];
    expect(calledScopes).toEqual([
      existingFolderScope,
      { kind: "directory", relativePaths: ["src"], root: "/workspace-b", connectedAtMs: 200 },
    ]);
  });

  it("surfaces wire-error messages via role=alert", async () => {
    const updateScope = vi.fn().mockRejectedValue(new Error("network down"));
    const user = userEvent.setup();
    render(
      <ScopeConnectButton
        chatId="chat-1"
        scopeKind="files"
        currentScopeKind={undefined}
        candidateRelativePaths={["src/a.ts"]}
        updateScope={updateScope}
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("network down");
    });
  });
});
