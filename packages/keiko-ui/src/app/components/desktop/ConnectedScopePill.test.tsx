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

  it("renders the single-path basename when the scope has one path", () => {
    const chat = makeChat({
      connectedScope: { relativePaths: ["src/lib/api.ts"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScope={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("api.ts");
  });

  it("renders a count when the scope has multiple paths", () => {
    const chat = makeChat({
      connectedScope: { relativePaths: ["src/a.ts", "src/b.ts", "src/c.ts"], connectedAtMs: 1 },
    });
    render(<ConnectedScopePill chat={chat} updateScope={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Connected to 3 paths");
  });

  it("disconnects the scope when the × button is clicked", async () => {
    const chat = makeChat({
      connectedScope: { relativePaths: ["src/a.ts"], connectedAtMs: 1 },
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
      connectedScope: { relativePaths: ["src/a.ts"], connectedAtMs: 1 },
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
