// Issue #184 / Epic #532 — unit tests for the chat-header connected-scope pills (1+N).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectedScopePill } from "./ConnectedScopePill";
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

describe("ConnectedScopePill", () => {
  it("renders nothing when the chat has no connected scope", () => {
    const { container } = render(<ConnectedScopePill chat={makeChat()} updateScopes={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders repository scope and trust/budget disclosure", () => {
    const chat = makeChat({
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Repository scope");
    expect(screen.getByText(/Keiko may inspect only the connected repository/i)).toHaveTextContent(
      /safe-read exclusions and context budget limits apply/i,
    );
  });

  it("renders the single-file basename when the scope has one file path", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/lib/api.ts"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("File: api.ts");
  });

  it("renders a folder label when the scope is a directory", () => {
    const chat = makeChat({
      connectedScope: { kind: "directory", relativePaths: ["src/lib"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Folder: lib");
  });

  it("labels an external connected folder by its root basename (#532)", () => {
    const chat = makeChat({
      connectedScope: {
        kind: "workspace-root",
        relativePaths: [],
        connectedAtMs: 1,
        root: "/Users/me/marketing",
      },
    });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Folder: marketing");
  });

  it("renders one pill per connected source for a 1+N binding (#532)", () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 1, root: "/data/alpha" },
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 2, root: "/data/beta" },
    ];
    const chat = makeChat({ connectedScopes: scopes, connectedScope: scopes[0] });
    render(<ConnectedScopePill chat={chat} updateScopes={vi.fn()} />);
    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("Folder: alpha");
    expect(statuses[1]).toHaveTextContent("Folder: beta");
  });

  it("removes only the clicked source from a multi-source binding (#532)", async () => {
    const scopes: ChatConnectedScope[] = [
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 1, root: "/data/alpha" },
      { kind: "workspace-root", relativePaths: [], connectedAtMs: 2, root: "/data/beta" },
    ];
    const chat = makeChat({ connectedScopes: scopes, connectedScope: scopes[0] });
    const updated: Chat = { ...chat, connectedScopes: [scopes[1]!], connectedScope: scopes[1] };
    const updateScopes = vi.fn().mockResolvedValue({ chat: updated } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectedScopePill chat={chat} updateScopes={updateScopes} onDisconnect={onDisconnect} />,
    );
    await user.click(screen.getByRole("button", { name: "Disconnect Folder: alpha from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", [scopes[1]]);
    });
    expect(onDisconnect).toHaveBeenCalledWith(updated);
  });

  it("clears the binding (null) when the last source is removed", async () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const cleared: Chat = { ...chat, connectedScope: undefined };
    const updateScopes = vi.fn().mockResolvedValue({ chat: cleared } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectedScopePill chat={chat} updateScopes={updateScopes} onDisconnect={onDisconnect} />,
    );
    await user.click(screen.getByRole("button", { name: "Disconnect File: a.ts from chat" }));
    await waitFor(() => {
      expect(updateScopes).toHaveBeenCalledWith("chat-1", null);
    });
    expect(onDisconnect).toHaveBeenCalledWith(cleared);
  });

  it("surfaces wire errors via role=alert", async () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const updateScopes = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ConnectedScopePill chat={chat} updateScopes={updateScopes} />);
    await user.click(screen.getByRole("button", { name: "Disconnect File: a.ts from chat" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("offline");
    });
  });
});
