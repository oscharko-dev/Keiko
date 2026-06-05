// Issue #184 — unit tests for the chat-header connected-scope pill.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectedScopePill } from "./ConnectedScopePill";
import type { Chat, ChatResponse } from "@/lib/types";

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
  it("renders nothing when the chat has no connectedScope", () => {
    const { container } = render(<ConnectedScopePill chat={makeChat()} updateScope={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders repository scope and trust/budget disclosure", () => {
    const chat = makeChat({
      connectedScope: { kind: "workspace-root", relativePaths: [], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScope={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Repository scope");
    expect(screen.getByText(/Keiko may inspect only the connected repository/i)).toHaveTextContent(
      /safe-read exclusions and context budget limits apply/i,
    );
  });

  it("renders the single-file basename when the scope has one file path", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/lib/api.ts"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScope={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("File: api.ts");
  });

  it("renders a folder label when the scope is a directory", () => {
    const chat = makeChat({
      connectedScope: { kind: "directory", relativePaths: ["src/lib"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScope={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Folder: lib");
  });

  it("renders a count when the scope has multiple paths", () => {
    const chat = makeChat({
      connectedScope: {
        kind: "files",
        relativePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
        connectedAtMs: 1,
      },
    });
    render(<ConnectedScopePill chat={chat} updateScope={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("3 files connected");
  });

  it("disconnects the scope when the × button is clicked", async () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const cleared: Chat = { ...chat, connectedScope: undefined };
    const updateScope = vi.fn().mockResolvedValue({ chat: cleared } satisfies ChatResponse);
    const onDisconnect = vi.fn();
    const user = userEvent.setup();
    render(
      <ConnectedScopePill chat={chat} updateScope={updateScope} onDisconnect={onDisconnect} />,
    );
    await user.click(screen.getByRole("button", { name: "Disconnect scope from chat" }));
    await waitFor(() => {
      expect(updateScope).toHaveBeenCalledWith("chat-1", null);
    });
    expect(onDisconnect).toHaveBeenCalledWith(cleared);
  });

  it("surfaces wire errors via role=alert", async () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const updateScope = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<ConnectedScopePill chat={chat} updateScope={updateScope} />);
    await user.click(screen.getByRole("button", { name: "Disconnect scope from chat" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("offline");
    });
  });
});
