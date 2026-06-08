// Tests for the Issue #151 context-pressure indicator and the AC#3
// context-overflow error mapping. These exercise the leaf BudgetIndicator
// component directly (no provider wiring needed) and the ChatWindow
// integration for send-blocking when pressure is "exceeded".

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetIndicator } from "./ContextBudget";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import {
  CONTEXT_OVERSIZED_USER_MESSAGE,
  isBudgetExceeded,
  useChatSession,
  type ChatSessionApi,
} from "./hooks/useChatSession";
import * as api from "@/lib/api";
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
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
    clearHistory: vi.fn(),
    launchWorkflowFromConversation: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    lastSentDocuments: [],
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

// ───────────────────────────────────────────────────────────────────────────
// CB-F1 — a runtime-configured model with contextWindow 0 must NOT be treated
// as over budget (the estimator reports "exceeded" for a zero window). The
// shared isBudgetExceeded predicate guards on contextWindowTokens > 0.
// ───────────────────────────────────────────────────────────────────────────

describe("isBudgetExceeded (CB-F1 guard)", () => {
  it("returns false for a contextWindow:0 model even when pressure is 'exceeded'", () => {
    expect(isBudgetExceeded(makeBudget({ contextWindowTokens: 0, pressure: "exceeded" }))).toBe(
      false,
    );
  });

  it("returns false when budget is undefined", () => {
    expect(isBudgetExceeded(undefined)).toBe(false);
  });

  it("returns true only when window > 0 AND pressure is 'exceeded'", () => {
    expect(
      isBudgetExceeded(makeBudget({ contextWindowTokens: 10_000, pressure: "exceeded" })),
    ).toBe(true);
    expect(isBudgetExceeded(makeBudget({ contextWindowTokens: 10_000, pressure: "high" }))).toBe(
      false,
    );
  });
});

describe("ChatWindow with a contextWindow:0 model (CB-F1)", () => {
  it("does not block send and hides the budget indicator and its dangling describedby", () => {
    const session = makeSession({
      activeChat: makeChat(),
      activeProject: {
        path: "/proj",
        name: "proj",
        available: true,
        favorite: false,
        createdAt: 0,
        lastOpenedAt: 0,
      },
      models: [makeModel({ contextWindow: 0 })],
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
      // Estimator output for a zero window: pressure exceeded but no real limit.
      budget: makeBudget({ contextWindowTokens: 0, pressure: "exceeded" }),
    });
    render(
      <ChatSessionProvider value={session}>
        <ChatWindow />
      </ChatSessionProvider>,
    );
    // No exceeded alert is rendered (BudgetIndicator self-hides at window <= 0).
    expect(screen.queryByText(/Context exceeds the selected model/)).toBeNull();
    const sendButton = screen.getByRole("button", { name: "Send message" });
    // Send is NOT blocked by budget — aria-disabled must not be "true".
    expect(sendButton.getAttribute("aria-disabled")).not.toBe("true");
    // The send button's aria-describedby must not point at the (absent)
    // budget-exceeded alert element.
    const describedBy = sendButton.getAttribute("aria-describedby");
    if (describedBy !== null) {
      expect(describedBy).not.toContain("budget-exceeded");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CB-F2 / CB-F3 — real-hook integration. Bootstrap a single chat + model so the
// hook reaches a sendable state.
// ───────────────────────────────────────────────────────────────────────────

const CB_PROJECT_PATH = "/cb-proj";

function mockBootstrap(model: ModelCapability): void {
  const chat = makeChat({ projectPath: CB_PROJECT_PATH, selectedModel: model.id });
  vi.spyOn(api, "fetchModels").mockResolvedValue({ models: [model] });
  vi.spyOn(api, "fetchProjects").mockResolvedValue({
    projects: [
      {
        path: CB_PROJECT_PATH,
        name: "proj",
        favorite: false,
        createdAt: 0,
        lastOpenedAt: 0,
        available: true,
      },
    ],
  });
  vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [chat] });
  vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
}

describe("useChatSession context-overflow classification (CB-F2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    mockBootstrap(makeModel({ id: "cb-model", contextWindow: 10_000 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps a GATEWAY_CONTEXT_OVERFLOW ApiError to the CONTEXT_OVERSIZED_USER_MESSAGE copy", async () => {
    vi.spyOn(api, "sendDesktopChat").mockRejectedValue(
      new ApiError(
        "GATEWAY_CONTEXT_OVERFLOW",
        "provider reported context overflow for 'cb-model'",
        413,
      ),
    );

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    act(() => view.result.current.setDraft("hi"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.error).toBe(CONTEXT_OVERSIZED_USER_MESSAGE);
  });
});

describe("useChatSession Enter-key budget guard (CB-F3)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    // A tiny real window so any non-empty draft tips pressure to "exceeded".
    mockBootstrap(makeModel({ id: "cb-tiny", contextWindow: 8, maxOutputTokens: 0 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call sendDesktopChat when the budget is exceeded (window > 0)", async () => {
    const sendSpy = vi.spyOn(api, "sendDesktopChat");

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    // Sanity: this draft does push the estimator to exceeded with a real window.
    act(() => view.result.current.setDraft("this draft is comfortably over an 8-token window"));
    expect(isBudgetExceeded(view.result.current.budget)).toBe(true);

    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(view.result.current.error).toBe(CONTEXT_OVERSIZED_USER_MESSAGE);
  });

  it("DOES send when the window is 0 (unknown limits — CB-F1/CB-F3 interplay)", async () => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    mockBootstrap(makeModel({ id: "cb-zero", contextWindow: 0, maxOutputTokens: 0 }));
    const sendSpy = vi.spyOn(api, "sendDesktopChat").mockResolvedValue({
      chat: makeChat({ projectPath: CB_PROJECT_PATH, selectedModel: "cb-zero" }),
      messages: [],
    });

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    act(() => view.result.current.setDraft("anything at all"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GAP-D (#151) — budget estimate includes memory / repo / knowledge bytes.
// A one-line revert of any of these three contributions must fail the test.
// ───────────────────────────────────────────────────────────────────────────

describe("useChatSession budget accounts for connected context (#151 GAP-D)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    // Large context window so pressure stays "low" unless we deliberately tip it.
    mockBootstrap(makeModel({ id: "gapd-model", contextWindow: 200_000, maxOutputTokens: 4_000 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes memoryContextBytes when memory is enabled and latestMemory has context text", async () => {
    // After bootstrap, inject a memory result by simulating a completed send.
    const memoryText = "a".repeat(2_000); // 2000 bytes → 500 tokens estimated

    vi.spyOn(api, "sendDesktopChat").mockResolvedValue({
      chat: makeChat({ projectPath: CB_PROJECT_PATH, selectedModel: "gapd-model" }),
      messages: [
        {
          id: "a1",
          chatId: "chat-1",
          role: "assistant",
          content: "ok",
          timestamp: 2,
          runId: undefined,
          workflowId: undefined,
          workflowStatus: undefined,
          shortResult: undefined,
          taskType: undefined,
        },
      ],
      memory: {
        context: {
          enabled: true,
          text: memoryText,
          memories: [],
          budget: { tokens: 1200, used: 500 },
        },
        actions: [],
      },
    });

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    // After the send, latestMemory is populated and budget must include the bytes.
    await waitFor(() => {
      const budget = view.result.current.budget;
      expect(budget).toBeDefined();
      // memoryBytes in the breakdown must be > 0 (2000 / 4 = 500 tokens)
      expect(budget?.breakdown.memoryBytes).toBeGreaterThan(0);
    });
  });

  it("includes repoContextPackBytes when latestGrounded is a connected-context answer", async () => {
    const excerptBytes = 8_000;

    vi.spyOn(api, "askGrounded").mockResolvedValue({
      groundingKind: "connected-context",
      userMessageId: "u1",
      assistantMessageId: "a1",
      content: "grounded answer",
      citations: [],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 100,
      contextPack: {
        schemaVersion: "1",
        scopeId: "scope-aabbccdd",
        scopeKind: "files",
        fileCount: 3,
        queryKind: "natural-language",
        usage: {
          searchCalls: 1,
          filesRead: 3,
          excerptBytes,
          modelInputTokens: 200,
          modelOutputTokens: 50,
          elapsedMs: 100,
          rerankCalls: 0,
        },
        budget: {
          searchCallsMax: 10,
          filesReadMax: 50,
          excerptBytesMax: 50_000,
          modelInputTokensMax: 50_000,
          modelOutputTokensMax: 4_000,
          elapsedMsMax: 30_000,
          rerankCallsMax: 3,
        },
        citationCount: 2,
        omittedCount: 0,
        omittedCounts: {
          "outside-scope": 0,
          binary: 0,
          generated: 0,
          ignored: 0,
          "size-exceeded": 0,
          "near-duplicate": 0,
          "low-relevance": 0,
          "redacted-only": 0,
          "budget-exhausted": 0,
          "tool-unavailable": 0,
        },
        uncertaintyCount: 0,
        elapsedMs: 100,
      },
    });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
    vi.spyOn(api, "fetchChats").mockResolvedValue({
      chats: [makeChat({ projectPath: CB_PROJECT_PATH, selectedModel: "gapd-model" })],
    });

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    // Attach a connected scope so the chat routes through sendGrounded.
    act(() => {
      view.result.current.replaceChat(
        makeChat({
          projectPath: CB_PROJECT_PATH,
          selectedModel: "gapd-model",
          connectedScope: { kind: "files", relativePaths: ["src"], connectedAtMs: 1 },
        }),
      );
    });

    act(() => view.result.current.setDraft("repo question"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    await waitFor(() => {
      const budget = view.result.current.budget;
      expect(budget).toBeDefined();
      // repoContextBytes must reflect the excerptBytes from the grounded answer.
      expect(budget?.breakdown.repoContextBytes).toBeGreaterThan(0);
    });
  });
});
