// Issue #185 AC3 — tests for the grounded-request cancel button in ChatWindow.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat } from "@/lib/types";

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

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: undefined,
    selectedModel: "example-chat-model",
    draft: "",
    loading: false,
    sending: false,
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    ...overrides,
  };
}

function renderWindow(session: ChatSessionApi): void {
  render(
    <ChatSessionProvider value={session}>
      <ChatWindow />
    </ChatSessionProvider>,
  );
}

describe("ChatWindow cancel button", () => {
  it("does not render the cancel button when not sending", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    renderWindow(makeSession({ activeChat: chat, sending: false }));
    expect(screen.queryByRole("button", { name: "Cancel grounded request" })).toBeNull();
  });

  it("does not render the cancel button when sending but no connectedScope", () => {
    const chat = makeChat({ connectedScope: undefined });
    renderWindow(makeSession({ activeChat: chat, sending: true }));
    expect(screen.queryByRole("button", { name: "Cancel grounded request" })).toBeNull();
  });

  it("renders the cancel button while sending with a connectedScope", () => {
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    // Provide at least one visible message so the chatw-log branch is rendered
    renderWindow(
      makeSession({
        activeChat: chat,
        sending: true,
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );
    expect(screen.getByRole("button", { name: "Cancel grounded request" })).toBeInTheDocument();
  });

  it("calls cancelGrounded when the cancel button is clicked", async () => {
    const cancelGrounded = vi.fn();
    const chat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: chat,
        sending: true,
        cancelGrounded,
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user",
            content: "hello",
            timestamp: 1,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel grounded request" }));
    expect(cancelGrounded).toHaveBeenCalledOnce();
  });
});
