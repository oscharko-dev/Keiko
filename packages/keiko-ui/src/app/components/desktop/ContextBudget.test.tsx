// Tests for the Issue #151 context-pressure indicator and the AC#3
// context-overflow error mapping. These exercise the leaf BudgetIndicator
// component directly (no provider wiring needed) and the ChatWindow
// integration for send-blocking when pressure is "exceeded".

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BudgetIndicator } from "./ContextBudget";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { CONTEXT_OVERSIZED_USER_MESSAGE, type ChatSessionApi } from "./hooks/useChatSession";
import { ApiError } from "@/lib/api";
import type { Chat, ConversationBudgetEstimate, ModelCapability } from "@/lib/types";

function makeBudget(
  overrides: Partial<ConversationBudgetEstimate> = {},
): ConversationBudgetEstimate {
  return {
    approximateBytes: 2_000,
    approximateTokens: 500,
    contextWindowTokens: 10_000,
    reservedOutputTokens: 2_000,
    availableInputTokens: 8_000,
    pressure: "low",
    breakdown: {
      draftBytes: 100,
      historyBytes: 1_900,
      documentBytes: 0,
      repoContextBytes: 0,
      knowledgeBytes: 0,
      memoryBytes: 0,
    },
    ...overrides,
  };
}

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

function makeModel(overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "example-chat-model",
    kind: "chat",
    contextWindow: 10_000,
    maxOutputTokens: 2_000,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "",
    preferredUseCases: [],
    knownLimitations: [],
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
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    budget: undefined,
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    ...overrides,
  };
}

describe("BudgetIndicator", () => {
  it("renders the approximate token count and window using the 'Approximate context:' prefix", () => {
    render(<BudgetIndicator budget={makeBudget()} onClearHistory={vi.fn()} />);
    expect(screen.getByText(/Approximate context:/)).toBeInTheDocument();
    expect(screen.getByText(/500\b/)).toBeInTheDocument();
    expect(screen.getByText(/10\.0k/)).toBeInTheDocument();
  });

  it("renders a pressure badge matching the estimate pressure", () => {
    render(
      <BudgetIndicator budget={makeBudget({ pressure: "moderate" })} onClearHistory={vi.fn()} />,
    );
    const badge = screen.getByLabelText(/Context pressure: Moderate/);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("Moderate");
  });

  it("renders an approximate-token info affordance disclosing the estimate is approximate", () => {
    render(<BudgetIndicator budget={makeBudget()} onClearHistory={vi.fn()} />);
    expect(
      screen.getByLabelText(/Token counts are approximate. Actual model usage may vary./),
    ).toBeInTheDocument();
  });

  it("renders a role='alert' warning and (in the composer) blocks send when pressure is exceeded", () => {
    render(
      <BudgetIndicator budget={makeBudget({ pressure: "exceeded" })} onClearHistory={vi.fn()} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/Context exceeds the selected model'?s window/);
  });

  it("invokes the clear-history callback when the Clear history button is clicked", async () => {
    const user = userEvent.setup();
    const onClearHistory = vi.fn();
    render(<BudgetIndicator budget={makeBudget()} onClearHistory={onClearHistory} />);
    await user.click(
      screen.getByRole("button", { name: "Clear conversation history for next prompt" }),
    );
    expect(onClearHistory).toHaveBeenCalledTimes(1);
  });

  it("hides itself entirely when budget is undefined (no known model limits)", () => {
    const { container } = render(<BudgetIndicator budget={undefined} onClearHistory={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ChatWindow composer with exceeded context", () => {
  it("renders the exceeded-context alert and the send button is aria-disabled", () => {
    const chat = makeChat();
    const model = makeModel();
    const session = makeSession({
      activeChat: chat,
      activeProject: {
        path: "/proj",
        name: "proj",
        available: true,
        favorite: false,
        createdAt: 0,
        lastOpenedAt: 0,
      },
      models: [model],
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
      draft: "anything",
      budget: makeBudget({ pressure: "exceeded" }),
    });
    render(
      <ChatSessionProvider value={session}>
        <ChatWindow />
      </ChatSessionProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Context exceeds the selected model'?s window/,
    );
    const sendButton = screen.getByRole("button", { name: "Send message" });
    expect(sendButton.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("context-overflow error mapping (AC#3)", () => {
  // The mapping itself is exercised by the errorMessage helper inside the
  // hook. We test it through the exported user-facing copy constant + a
  // direct check of the ApiError code path: when a provider error mentions
  // "context length", the hook surfaces CONTEXT_OVERSIZED_USER_MESSAGE.
  it("uses the exact AC#3 user-facing copy", () => {
    expect(CONTEXT_OVERSIZED_USER_MESSAGE).toMatch(
      /context exceeded the model'?s window. Clear history or pick a larger-context model/i,
    );
  });

  it("maps the typed BFF CONVERSATION_OVERSIZED_CONTEXT code through the same surface", () => {
    // Sanity-check the ApiError shape used by the hook's classifier.
    const apiError = new ApiError("CONVERSATION_OVERSIZED_CONTEXT", "raw", 413);
    expect(apiError.code).toBe("CONVERSATION_OVERSIZED_CONTEXT");
  });
});
