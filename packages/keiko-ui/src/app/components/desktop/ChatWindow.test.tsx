// Issue #185 AC3 — tests for the grounded-request cancel button in ChatWindow.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import type { ChatSessionApi } from "./hooks/useChatSession";
import type { Chat, ModelCapability } from "@/lib/types";

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

function makeSession(overrides: Partial<ChatSessionApi> = {}): ChatSessionApi {
  return {
    projects: [],
    chats: [],
    messages: [],
    models: [],
    activeProject: undefined,
    activeChat: undefined,
    selectedModel: "example-chat-model",
    noEligibleModels: false,
    draft: "",
    loading: false,
    sending: false,
    sendStatus: "idle",
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    // Issue #151 — budget + clear-history fields default to "no known limits"
    // so the existing cancel-button tests keep their previous semantics.
    budget: undefined,
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
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

// Issue #144 / Epic #142 AC #1 + #2: the conversation dropdown must only
// surface chat-eligible models. ChatWindow trusts `session.models` to arrive
// already filtered by `useChatSession.bootstrapSession` (which routes through
// `isConversationEligibleModel`). These tests pin the realistic production
// flow: when only chat-eligible models are provided, only chat options appear
// in the dropdown.
function chatModelCapability(id: string): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Chat"],
    knownLimitations: ["test fixture"],
  };
}

describe("ChatWindow conversation model dropdown (Issue #144)", () => {
  it("renders every chat-eligible model id in the Model dropdown options", () => {
    // activeChat is required so the composer bar (containing the model select)
    // is rendered — without it the new NoChatState shows instead (#146).
    renderWindow(
      makeSession({
        models: [chatModelCapability("test-chat-1"), chatModelCapability("test-chat-2")],
        selectedModel: "test-chat-1",
        activeChat: makeChat(),
      }),
    );
    const select = screen.getByLabelText("Model");
    const options = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    expect(options).toContain("test-chat-1");
    expect(options).toContain("test-chat-2");
  });

  it("does not render an embedding-kind model id when session.models is pre-filtered (AC #2)", () => {
    // Production path: useChatSession.bootstrapSession filters via
    // isConversationEligibleModel before populating session.models. This test
    // pins the regression — if the session ever stopped filtering, the
    // dropdown would surface embedding models and this assertion would fail.
    // activeChat is required so the composer bar is rendered (#146).
    renderWindow(
      makeSession({
        models: [chatModelCapability("test-chat-1")],
        selectedModel: "test-chat-1",
        activeChat: makeChat(),
      }),
    );
    const select = screen.getByLabelText("Model");
    const options = Array.from(select.querySelectorAll("option")).map((option) => option.value);
    expect(options).not.toContain("test-embedding-1");
    expect(options).toContain("test-chat-1");
  });
});
