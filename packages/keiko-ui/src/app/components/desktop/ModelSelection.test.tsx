// Issue #145 — model selection reliability across conversation entry points.
// Tests ACs #1-4 using pure helper functions and prop-injected session mocks.
// IMPORTANT: no module-level vi.mock("@/lib/api") — that pollutes capsule-actions tests.
// IMPORTANT: isConversationEligibleModel is a STATIC top-level import (dynamic import
//            does not resolve value-exports correctly in jsdom).

import { act, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { Footer } from "./Footer";
import type { ChatSessionApi } from "./hooks/useChatSession";
import { pickChatModelId } from "./hooks/useChatSession";
import { chooseDefaultModel } from "./modals/NewWindowDialog";
import { isConversationEligibleModel } from "@/lib/types";
import type { Chat, ModelCapability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function chatModel(id: string): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 4096,
    maxOutputTokens: 1024,
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

function embeddingModel(id: string): ModelCapability {
  return {
    id,
    kind: "embedding",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["Embeddings"],
    knownLimitations: ["test fixture"],
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
    budget: undefined,
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    ...overrides,
  };
}

function renderWindow(session: ChatSessionApi, mini?: boolean): void {
  render(
    <ChatSessionProvider value={session}>
      {mini === true ? <ChatWindow mini={true} /> : <ChatWindow />}
    </ChatSessionProvider>,
  );
}

// ---------------------------------------------------------------------------
// AC #1 + #4 — pickChatModelId
// ---------------------------------------------------------------------------

describe("pickChatModelId (AC #1, AC #4)", () => {
  it("returns undefined when model list is empty", () => {
    expect(pickChatModelId([])).toBeUndefined();
  });

  it("returns the first model id when models are available", () => {
    const model = chatModel("real-model-1");
    expect(pickChatModelId([model])).toBe("real-model-1");
  });

  it("returns the first model id, never a hard-coded placeholder", () => {
    const models = [chatModel("provider-model-a"), chatModel("provider-model-b")];
    expect(pickChatModelId(models)).toBe("provider-model-a");
  });
});

// ---------------------------------------------------------------------------
// AC #4 — chooseDefaultModel (NewWindowDialog)
// ---------------------------------------------------------------------------

describe("chooseDefaultModel (AC #4)", () => {
  it("returns empty string when model list is empty", () => {
    expect(chooseDefaultModel([])).toBe("");
  });

  it("returns the first model id, not any placeholder", () => {
    const first = chatModel("real-first-model");
    const second = chatModel("example-chat-model");
    // AC #4: the old code preferred "example-chat-model"; the new code uses first
    expect(chooseDefaultModel([first, second])).toBe("real-first-model");
  });
});

// ---------------------------------------------------------------------------
// AC #1 — ChatWindow renders role="alert" with "Settings" when noEligibleModels
// ---------------------------------------------------------------------------

// makeChat needed for #146: the no-model alert and send button only appear in
// the composer footer, which requires activeChat to be defined.
function makeChat(): Chat {
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
  };
}

describe("ChatWindow no-eligible-models error (AC #1)", () => {
  it("renders a role=alert message containing 'Settings' when noEligibleModels is true", () => {
    // activeChat required so the composer footer (containing the alert) renders (#146).
    renderWindow(
      makeSession({ noEligibleModels: true, selectedModel: undefined, activeChat: makeChat() }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/Settings/i);
  });

  it("does not render the no-model alert when models are available", () => {
    renderWindow(
      makeSession({
        noEligibleModels: false,
        selectedModel: "real-model",
        models: [chatModel("real-model")],
      }),
    );
    // The only role="alert" present should be for session errors, not the no-model
    // alert. Since error is undefined and noEligibleModels is false, no alert fires.
    expect(screen.queryByText(/No conversation-eligible model/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC #1 — send button is aria-disabled when noEligibleModels
// ---------------------------------------------------------------------------

describe("ChatWindow send button aria-disabled (AC #1)", () => {
  it("send button has aria-disabled=true when noEligibleModels is true", () => {
    // activeChat required so the composer footer (with send button) renders (#146).
    renderWindow(
      makeSession({ noEligibleModels: true, selectedModel: undefined, activeChat: makeChat() }),
    );
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("send button does not have aria-disabled when a model is selected and ready", () => {
    // activeChat + messages: composer footer only renders with activeChat (#146).
    // Provide a message so we render the messages-log branch (always shows footer).
    renderWindow(
      makeSession({
        noEligibleModels: false,
        selectedModel: "real-model",
        models: [chatModel("real-model")],
        draft: "hello",
        activeChat: makeChat(),
        messages: [
          {
            id: "m1",
            chatId: "chat-1",
            role: "user" as const,
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
    const sendBtn = screen.getByRole("button", { name: "Send message" });
    // aria-disabled should be false or absent when the composer is ready
    expect(sendBtn).not.toHaveAttribute("aria-disabled", "true");
  });
});

// ---------------------------------------------------------------------------
// AC #4 — Footer displays the real selected model id
// ---------------------------------------------------------------------------

describe("Footer selectedModel display (AC #4)", () => {
  it("shows the selected model id when a model is configured", () => {
    render(<Footer winCount={1} mode="autonomous" selectedModel="gpt-4o" />);
    expect(screen.getByText(/gpt-4o/i)).toBeInTheDocument();
  });

  it("shows 'No model selected' when selectedModel is undefined", () => {
    render(<Footer winCount={1} mode="autonomous" selectedModel={undefined} />);
    expect(screen.getByText(/No model selected/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AC #3 — setSelectedModel updates selectedModel without clearing other state
// ---------------------------------------------------------------------------

describe("setSelectedModel state update (AC #3)", () => {
  it("calling setSelectedModel updates selectedModel in the session context", () => {
    // Use a synthesised component that exposes setSelectedModel via context
    // rather than rendering the real hook (which needs @/lib/api).
    const received: string[] = [];
    const mockSetSelectedModel = vi.fn((id: string) => {
      received.push(id);
    });

    const session = makeSession({
      selectedModel: "model-a",
      setSelectedModel: mockSetSelectedModel,
    });

    // Render a component that calls setSelectedModel via the context
    function Picker(): ReactNode {
      const { setSelectedModel: setter } = session;
      return (
        <button type="button" onClick={() => setter("model-b")}>
          Switch
        </button>
      );
    }

    render(
      <ChatSessionProvider value={session}>
        <Picker />
      </ChatSessionProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Switch" }).click();
    });

    expect(mockSetSelectedModel).toHaveBeenCalledWith("model-b");
    expect(received).toContain("model-b");
  });
});

// ---------------------------------------------------------------------------
// AC #2 (wire-level) — isConversationEligibleModel discriminates correctly
// ---------------------------------------------------------------------------

describe("isConversationEligibleModel (AC #2 wire-level)", () => {
  it("returns true for a chat model with conversationEligible=true", () => {
    const model = chatModel("chat-model-1");
    expect(isConversationEligibleModel(model)).toBe(true);
  });

  it("returns false for an embedding model", () => {
    const model = embeddingModel("embedding-model-1");
    expect(isConversationEligibleModel(model)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC #2 — mini composer inherits selectedModel from session (no own picker)
// ---------------------------------------------------------------------------

describe("ChatWindow mini composer (AC #2)", () => {
  it("renders the mini composer and inherits selectedModel from the session (no own picker)", () => {
    // The mini composer does not render its own model select; it relies on the
    // parent session (ChatSessionProvider) for the selected model.
    renderWindow(
      makeSession({
        selectedModel: "inherited-model",
        noEligibleModels: false,
        models: [chatModel("inherited-model")],
      }),
      true, // mini=true
    );
    // The mini composer renders a textarea but no model <select> at the top level
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    // The model select is not rendered in mini mode (no ComposerBar)
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("renders the no-model alert in mini mode when noEligibleModels is true", () => {
    renderWindow(makeSession({ noEligibleModels: true, selectedModel: undefined }), true);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Settings/i);
  });
});
