// Issue #152 — streaming-ready conversation lifecycle + cancellation tests.
//
// Two cohorts:
//   1. ChatWindow UI tests (prop-injected session) — pin the role="status"
//      lifecycle indicator and the Send→Cancel button label flip without
//      touching the network. The makeSession helper mirrors the shapes in
//      ChatWindow.test.tsx / ContextBudget.test.tsx so the surface stays
//      legible alongside the existing suite.
//   2. useChatSession hook tests — drive the real hook via renderHook and
//      mock @/lib/api at the module boundary so we can pin the discriminated
//      sendStatus union, idempotency under concurrent sendMessage calls,
//      cancelSend's effect on the live request, and the failed-error mapping
//      that preserves the user prompt but never persists a fake assistant.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow, sendStatusLabel } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { useChatSession, type ChatSessionApi } from "./hooks/useChatSession";
import * as api from "@/lib/api";
import type { Chat, ChatMessage, DesktopChatSendResponse, ModelCapability } from "@/lib/types";
import type { StreamHandlers } from "@/lib/api";

// ─── UI test helpers ──────────────────────────────────────────────────────────

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
    launchGroundedWorkflowHandoff: vi.fn().mockResolvedValue({ ok: true, runId: "test-run" }),
    lastSentDocuments: [],
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

function embeddingCapability(id: string): ModelCapability {
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
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "test fixture",
    preferredUseCases: ["Embeddings"],
    knownLimitations: ["test fixture"],
  };
}

function ocrVisionCapability(id: string): ModelCapability {
  return {
    id,
    kind: "ocr-vision",
    contextWindow: 0,
    maxOutputTokens: 0,
    toolCalling: false,
    structuredOutput: false,
    streaming: false,
    supportsImageInput: true,
    supportsDocumentInput: true,
    workflowEligible: false,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "test fixture",
    preferredUseCases: ["OCR"],
    knownLimitations: ["test fixture"],
  };
}

function userMessage(content: string): ChatMessage {
  return {
    id: "m1",
    chatId: "chat-1",
    role: "user",
    content,
    timestamp: 1,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

function assistantMessage(id: string, content: string): ChatMessage {
  return {
    id,
    chatId: "chat-1",
    role: "assistant",
    content,
    timestamp: 2,
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
}

// ─── ChatWindow UI tests — lifecycle indicator + Cancel button (AC#1, AC#3) ────

describe("ChatWindow lifecycle status indicator (Issue #152)", () => {
  it("keeps the lifecycle role=status region mounted but empty while sendStatus is idle", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [userMessage("hi")],
        sendStatus: "idle",
        sending: false,
      }),
    );
    // uiux-fix F041 (C170, WCAG 4.1.3) — the live region must stay permanently in
    // the DOM (regions inserted together with their first message are unreliably
    // announced by VoiceOver/Safari and NVDA); while idle it says nothing.
    // The bootstrap loading status is gated on session.loading=false, so the
    // only role="status" in the tree is the lifecycle indicator.
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
  });

  it("renders the role=status lifecycle indicator with assistive text during contacting (AC#1)", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [userMessage("hi")],
        sendStatus: "contacting",
        sending: true,
      }),
    );
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent("Contacting model…");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("renders the streaming label for non-streaming-style waits → AC#4 stable wait still maps to a polite announcement", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [userMessage("hi")],
        sendStatus: "streaming",
        sending: true,
      }),
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Receiving response…");
  });

  it("flips the send button to a Cancel response button while sending (AC#1, AC#3)", async () => {
    const cancelSend = vi.fn();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        models: [chatModelCapability("example-chat-model")],
        messages: [userMessage("hi")],
        draft: "next prompt",
        sendStatus: "contacting",
        sending: true,
        cancelSend,
      }),
    );
    // The primary send affordance is now the cancel button.
    const cancel = screen.getByRole("button", { name: "Cancel response" });
    expect(cancel).toBeInTheDocument();
    // The "Send message" button must NOT be in the tree while sending — both
    // labels appearing at once would let the user submit a duplicate request.
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    const user = userEvent.setup();
    await user.click(cancel);
    expect(cancelSend).toHaveBeenCalledOnce();
  });

  it("falls back to the Send button when sending=false", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        models: [chatModelCapability("example-chat-model")],
        messages: [userMessage("hi")],
        draft: "next prompt",
        sendStatus: "idle",
        sending: false,
      }),
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel response" })).toBeNull();
  });
});

// ─── Streaming typing indicator + pending bubble (Issue #152) ──────────────────
// While the stream is contacting the model the pending assistant turn is shown as
// the TypingBubble. Once tokens flow (sendStatus "streaming") the growing assistant
// bubble IS the progress signal, so the redundant typing dots are suppressed and the
// empty pre-token assistant bubble is hidden — verified live against the Azure gateway.

describe("ChatWindow streaming typing indicator (Issue #152)", () => {
  it("shows the typing indicator while contacting (before the first token)", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [userMessage("hi")],
        sendStatus: "contacting",
        sending: true,
      }),
    );
    expect(screen.getByLabelText("Keiko is responding")).toBeInTheDocument();
  });

  it("suppresses the typing indicator once tokens are streaming (no dots over live text)", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [userMessage("hi"), assistantMessage("a-stream", "The TCP/IP stack")],
        sendStatus: "streaming",
        sending: true,
      }),
    );
    // Mutation guard: reverting the `sendStatus !== "streaming"` condition makes the
    // typing bubble reappear alongside the live assistant text, failing this.
    expect(screen.queryByLabelText("Keiko is responding")).toBeNull();
  });

  it("hides the empty pre-token assistant bubble, keeping only non-empty turns", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [
          userMessage("hi"),
          assistantMessage("a-empty", ""),
          assistantMessage("a-full", "Final answer."),
        ],
        sendStatus: "idle",
        sending: false,
      }),
    );
    // Mutation guard: dropping the `content.length > 0` filter renders the empty
    // assistant bubble too, making this length assertion fail.
    expect(document.querySelectorAll('article[data-role="assistant"]')).toHaveLength(1);
    expect(screen.getByText("Final answer.")).toBeInTheDocument();
  });
});

// ─── Pure label helper — the only progress signal per the engineering note ────

describe("sendStatusLabel (Issue #152 — no fake progress percentages)", () => {
  it("returns the empty string for terminal-success/idle states so the indicator self-hides", () => {
    expect(sendStatusLabel("idle")).toBe("");
    expect(sendStatusLabel("completed")).toBe("");
    expect(sendStatusLabel("failed")).toBe("");
  });

  it("returns a stable, human label for every in-flight lifecycle state", () => {
    expect(sendStatusLabel("queued")).toBe("Submitting your message…");
    expect(sendStatusLabel("contacting")).toBe("Contacting model…");
    expect(sendStatusLabel("streaming")).toBe("Receiving response…");
    expect(sendStatusLabel("cancelled")).toBe("Response cancelled.");
  });
});

// ─── useChatSession hook tests — discriminated lifecycle + idempotency ────────

interface DeferredSend {
  readonly promise: Promise<DesktopChatSendResponse>;
  resolve: (value: DesktopChatSendResponse) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | undefined;
}

function deferred(): DeferredSend {
  let resolveFn: ((value: DesktopChatSendResponse) => void) | undefined;
  let rejectFn: ((reason: unknown) => void) | undefined;
  const promise = new Promise<DesktopChatSendResponse>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  if (resolveFn === undefined || rejectFn === undefined) {
    throw new Error("Promise constructor invariant violated");
  }
  return { promise, resolve: resolveFn, reject: rejectFn, signal: undefined };
}

const PROJECT_PATH = "/proj";

function mockBootstrap(): void {
  const chat: Chat = {
    id: "chat-1",
    projectPath: PROJECT_PATH,
    title: "t",
    selectedModel: "example-chat-model",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
  };
  // The buffered-path lifecycle tests below exercise sendDesktopChat; pin the model to
  // non-streaming so they take the buffered branch (the streaming branch is covered by the
  // dedicated "Layer 3 SSE streaming" describe with its own sendDesktopChatStream spy).
  vi.spyOn(api, "fetchModels").mockResolvedValue({
    models: [{ ...chatModelCapability("example-chat-model"), streaming: false }],
  });
  vi.spyOn(api, "fetchProjects").mockResolvedValue({
    projects: [
      {
        path: PROJECT_PATH,
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

async function bootHook(): Promise<ReturnType<typeof renderHook<ChatSessionApi, unknown>>> {
  const view = renderHook(() => useChatSession());
  await waitFor(() => {
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.activeChat).toBeDefined();
  });
  return view;
}

describe("useChatSession sendStatus lifecycle (Issue #152)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    mockBootstrap();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts in idle and transitions to contacting then completed on a successful send", async () => {
    const send = deferred();
    vi.spyOn(api, "sendDesktopChat").mockImplementation((_input, signal) => {
      send.signal = signal;
      return send.promise;
    });

    const view = await bootHook();
    expect(view.result.current.sendStatus).toBe("idle");

    act(() => view.result.current.setDraft("hello"));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = view.result.current.sendMessage();
    });
    // Synchronously after sendMessage was called, we must be at least
    // queued — the ref-based idempotency guard relies on this.
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("contacting");
    });
    expect(view.result.current.sending).toBe(true);

    act(() => {
      send.resolve({
        chat: view.result.current.activeChat as Chat,
        messages: [
          {
            id: "assistant-1",
            chatId: "chat-1",
            role: "assistant",
            content: "world",
            timestamp: 2,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      });
    });
    await sendPromise;
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("completed");
    });
    expect(view.result.current.sending).toBe(false);
  });

  it("is idempotent — a second sendMessage while in-flight is a no-op (AC#2)", async () => {
    const send = deferred();
    const sendSpy = vi.spyOn(api, "sendDesktopChat").mockImplementation((_input, signal) => {
      send.signal = signal;
      return send.promise;
    });

    const view = await bootHook();
    act(() => view.result.current.setDraft("hello"));
    let firstPromise: Promise<void> | undefined;
    act(() => {
      firstPromise = view.result.current.sendMessage();
    });
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("contacting");
    });

    // Second call while in-flight must short-circuit BEFORE the network.
    await act(async () => {
      await view.result.current.sendMessage();
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Cleanup: resolve to terminate the first request so React doesn't warn.
    act(() => {
      send.resolve({
        chat: view.result.current.activeChat as Chat,
        messages: [],
      });
    });
    await firstPromise;
  });

  it("cancelSend aborts the in-flight request and transitions to cancelled (AC#3)", async () => {
    const send = deferred();
    vi.spyOn(api, "sendDesktopChat").mockImplementation((_input, signal) => {
      send.signal = signal;
      // Wire the abort to reject with a DOMException, matching real fetch.
      signal?.addEventListener("abort", () => {
        send.reject(new DOMException("aborted", "AbortError"));
      });
      return send.promise;
    });

    const view = await bootHook();
    act(() => view.result.current.setDraft("hello"));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = view.result.current.sendMessage();
    });
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("contacting");
    });

    act(() => view.result.current.cancelSend());
    await sendPromise;
    expect(view.result.current.sendStatus).toBe("cancelled");
    expect(view.result.current.sending).toBe(false);

    // AC#3 — the user's prompt must remain visible so they can retry without
    // retyping, but NO assistant message must have been appended.
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
    const users = view.result.current.messages.filter((m) => m.role === "user");
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it("maps a failed request to sendStatus=failed and a user-facing error string, preserving the user message", async () => {
    vi.spyOn(api, "sendDesktopChat").mockRejectedValue(new api.ApiError("INTERNAL", "boom", 500));

    const view = await bootHook();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      await view.result.current.sendMessage();
    });
    expect(view.result.current.sendStatus).toBe("failed");
    expect(view.result.current.error).toContain("boom");

    // No fake assistant content persisted — only the user's prompt should
    // remain (modulo whatever messages the bootstrap fetch returned, which
    // we set to empty above).
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  // ST-F2 — grounded cancel path at the hook level. A chat with a connectedScope
  // routes through sendGrounded (askGrounded); cancelSend must abort it, land in
  // sendStatus "cancelled", and persist NO partial answer as a completed turn.
  it("cancels an in-flight grounded request without persisting a partial answer (ST-F2)", async () => {
    // Re-bootstrap with a connected-scope chat so sendMessage routes to grounded.
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    const groundedChat = makeChat({
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [chatModelCapability("example-chat-model")],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: PROJECT_PATH,
          name: "proj",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [groundedChat] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });

    let rejectGrounded: ((reason: unknown) => void) | undefined;
    const groundedPromise = new Promise((_res, rej) => {
      rejectGrounded = rej;
    });
    const askSpy = vi.spyOn(api, "askGrounded").mockImplementation((_req, signal) => {
      signal?.addEventListener("abort", () => {
        rejectGrounded?.(new DOMException("aborted", "AbortError"));
      });
      return groundedPromise as ReturnType<typeof api.askGrounded>;
    });

    const view = await bootHook();
    expect(view.result.current.activeChat?.connectedScope).toBeDefined();

    act(() => view.result.current.setDraft("ground this"));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = view.result.current.sendMessage();
    });
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("contacting");
    });
    expect(askSpy).toHaveBeenCalledOnce();

    act(() => view.result.current.cancelSend());
    await sendPromise;

    expect(view.result.current.sendStatus).toBe("cancelled");
    expect(view.result.current.sending).toBe(false);
    // No grounded answer persisted, and no assistant message landed.
    expect(view.result.current.latestGrounded).toBeUndefined();
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
    // The user's prompt remains so they can retry without retyping (AC#3).
    const users = view.result.current.messages.filter((m) => m.role === "user");
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it("routes plural-only connectedScopes through grounded Q&A", async () => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    const groundedChat = makeChat({
      connectedScopes: [{ kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 }],
    });
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [chatModelCapability("example-chat-model")],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: PROJECT_PATH,
          name: "proj",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [groundedChat] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
    const askGroundedSpy = vi.spyOn(api, "askGrounded").mockResolvedValue({
      groundingKind: "connected-context",
      userMessageId: "u",
      assistantMessageId: "a",
      content: "grounded",
      citations: [],
      uncertainty: [],
      omittedCount: 0,
      elapsedMs: 1,
      contextPack: {
        schemaVersion: "1",
        scopeId: "cs-plural",
        scopeKind: "files",
        fileCount: 1,
        queryKind: "natural-language",
        usage: {
          searchCalls: 0,
          filesRead: 0,
          excerptBytes: 0,
          modelInputTokens: 0,
          modelOutputTokens: 0,
          elapsedMs: 0,
          rerankCalls: 0,
        },
        budget: {
          searchCallsMax: 16,
          filesReadMax: 32,
          excerptBytesMax: 131_072,
          modelInputTokensMax: 32_000,
          modelOutputTokensMax: 4_096,
          elapsedMsMax: 30_000,
          rerankCallsMax: 0,
        },
        citationCount: 0,
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
        elapsedMs: 1,
      },
    });
    const ungroundedSpy = vi.spyOn(api, "sendDesktopChat").mockResolvedValue({
      chat: groundedChat,
      messages: [],
    });

    const view = await bootHook();
    expect(view.result.current.activeChat?.connectedScope).toBeUndefined();
    expect(view.result.current.activeChat?.connectedScopes).toHaveLength(1);

    act(() => view.result.current.setDraft("ground plural scope"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(askGroundedSpy).toHaveBeenCalledWith(
      { chatId: groundedChat.id, content: "ground plural scope", modelId: "example-chat-model" },
      expect.any(AbortSignal),
    );
    expect(ungroundedSpy).not.toHaveBeenCalled();
    expect(view.result.current.sendStatus).toBe("completed");
  });

  it("refreshes a grounded turn from the chat's canonical projectPath after send", async () => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    const activeProjectPath = "/proj-active";
    const canonicalChatPath = "/proj-canonical";
    const groundedChat = makeChat({
      projectPath: canonicalChatPath,
      connectedScope: { kind: "files", relativePaths: ["src/a.ts"], connectedAtMs: 1 },
    });
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [chatModelCapability("example-chat-model")],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: activeProjectPath,
          name: "proj",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    const fetchChatsSpy = vi.spyOn(api, "fetchChats").mockImplementation(async (projectPath) => {
      if (projectPath === activeProjectPath) return { chats: [groundedChat] };
      if (projectPath === canonicalChatPath) return { chats: [{ ...groundedChat, updatedAt: 99 }] };
      throw new Error(`unexpected fetchChats path: ${projectPath}`);
    });
    const canonicalMessages: ChatMessage[] = [
      {
        id: "user-canonical",
        chatId: groundedChat.id,
        role: "user",
        content: "ground this",
        timestamp: 3,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
      {
        id: "assistant-canonical",
        chatId: groundedChat.id,
        role: "assistant",
        content: "answer",
        timestamp: 4,
        runId: undefined,
        workflowId: undefined,
        workflowStatus: undefined,
        shortResult: undefined,
        taskType: undefined,
      },
    ];
    const fetchChatMessagesSpy = vi
      .spyOn(api, "fetchChatMessages")
      .mockImplementation(async (chatId, projectPath) => {
        if (projectPath === activeProjectPath) return { messages: [] };
        if (chatId === groundedChat.id && projectPath === canonicalChatPath) {
          return { messages: canonicalMessages };
        }
        throw new Error(`unexpected fetchChatMessages args: ${chatId} ${projectPath}`);
      });
    const groundedResponse = {
      groundingKind: "connected-context",
      userMessageId: "user-canonical",
      assistantMessageId: "assistant-canonical",
      content: "answer",
      citations: [],
      uncertainty: [{ kind: "supported", claim: "grounded answer resolved from canonical path" }],
      omittedCount: 0,
      elapsedMs: 1,
      contextPack: {
        schemaVersion: "1",
        scopeId: "cs-canonical",
        scopeKind: "files",
        fileCount: 1,
        queryKind: "natural-language",
        usage: {
          searchCalls: 0,
          filesRead: 0,
          excerptBytes: 0,
          modelInputTokens: 0,
          modelOutputTokens: 0,
          elapsedMs: 0,
          rerankCalls: 0,
        },
        budget: {
          searchCallsMax: 16,
          filesReadMax: 32,
          excerptBytesMax: 131_072,
          modelInputTokensMax: 32_000,
          modelOutputTokensMax: 4_096,
          elapsedMsMax: 30_000,
          rerankCallsMax: 0,
        },
        citationCount: 0,
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
        uncertaintyCount: 1,
        elapsedMs: 1,
      },
    } satisfies Awaited<ReturnType<typeof api.askGrounded>>;
    vi.spyOn(api, "askGrounded").mockResolvedValue(groundedResponse);

    const view = await bootHook();
    act(() => view.result.current.setDraft("ground this"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.sendStatus).toBe("completed");
    expect(fetchChatMessagesSpy).toHaveBeenLastCalledWith(groundedChat.id, canonicalChatPath);
    expect(fetchChatsSpy).toHaveBeenLastCalledWith(canonicalChatPath);
    expect(view.result.current.messages).toEqual(canonicalMessages);
    expect(view.result.current.error).toBeUndefined();
  });
});

// ─── useChatSession bootstrap eligibility filter (Issue #144 AC #1/#2) ─────────
// Why: the only call-site of isConversationEligibleModel that operates at the
// session boundary is useChatSession.ts:293. Removing that line would make
// embedding / ocr-vision models reachable from the conversation dropdown. Every
// other AC #1/#2 test either (a) passes pre-filtered data directly into context
// (ChatWindow.test.tsx) or (b) tests the helper in isolation (capabilities.test.ts /
// ModelSelection.test.tsx). This describe block is the SOLE mutation-robust guard
// on the bootstrap filter itself.

describe("useChatSession bootstrap eligibility filter (Issue #144 AC #1/#2)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("session.models contains only chat-eligible models after bootstrap", async () => {
    // fetchModels returns a deliberate mix: one chat-eligible model plus one
    // embedding and one ocr-vision model. bootstrapSession must filter the
    // list via isConversationEligibleModel (useChatSession.ts:293) so only
    // the chat model reaches session.models. Deleting that filter line causes
    // all three assertions below to fail, making this test mutation-robust.
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [
        chatModelCapability("test-chat-eligible"),
        embeddingCapability("test-embed-only"),
        ocrVisionCapability("test-ocr-only"),
      ],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: "/proj",
          name: "proj",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [makeChat()] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
    });

    const modelIds = view.result.current.models.map((m) => m.id);
    expect(modelIds).toContain("test-chat-eligible");
    expect(modelIds).not.toContain("test-embed-only");
    expect(modelIds).not.toContain("test-ocr-only");
    expect(view.result.current.models.every((m) => m.kind === "chat")).toBe(true);
  });

  it("prefers the most recently opened available project during bootstrap", async () => {
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [chatModelCapability("test-chat-eligible")],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: "/older-project",
          name: "older-project",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 10,
          available: true,
        },
        {
          path: "/current-project",
          name: "current-project",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 99,
          available: true,
        },
      ],
    });
    const fetchChatsSpy = vi.spyOn(api, "fetchChats").mockImplementation(async (projectPath) => {
      expect(projectPath).toBe("/current-project");
      return { chats: [makeChat({ projectPath, title: "current chat" })] };
    });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
    });

    expect(fetchChatsSpy).toHaveBeenCalledWith("/current-project");
    expect(view.result.current.activeProject?.path).toBe("/current-project");
    expect(view.result.current.projects.map((project) => project.path)).toEqual([
      "/current-project",
      "/older-project",
    ]);
  });
});

// ─── Layer 3 SSE streaming — sendDesktopChatStream integration ───────────────
//
// These tests drive the real useChatSession hook. sendDesktopChatStream is
// spied on at the module boundary so we can control when tokens and done/error/
// cancel events fire. Each test is mutation-robust: a single-line deletion in
// the production accumulation or replacement logic causes the assertion to fail.

describe("useChatSession Layer 3 SSE streaming (Issue #152)", () => {
  const PROJECT_PATH_STREAM = "/proj-stream";

  function streamingChat(): Chat {
    return {
      id: "chat-stream",
      projectPath: PROJECT_PATH_STREAM,
      title: "t",
      selectedModel: "streaming-model",
      branchLabel: undefined,
      status: undefined,
      connectedScope: undefined,
      localKnowledgeScope: undefined,
      createdAt: 1,
      updatedAt: 2,
    };
  }

  function mockBootstrapStreaming(): void {
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [chatModelCapability("streaming-model")],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: PROJECT_PATH_STREAM,
          name: "proj-stream",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [streamingChat()] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });
  }

  function nonStreamingModelCapability(id: string): ModelCapability {
    return { ...chatModelCapability(id), streaming: false };
  }

  async function bootStreamingHook(): Promise<
    ReturnType<typeof renderHook<ChatSessionApi, unknown>>
  > {
    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });
    return view;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    mockBootstrapStreaming();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ST-L3-1 — happy path: two tokens then done.
  // Mutation: removing the onToken accumulation would leave the bubble with
  // only the second token (or empty). Removing the onDone replacement would
  // leave the temp row in the message list.
  it("accumulates token deltas into the temp bubble and replaces it with canonical messages on done", async () => {
    let capturedHandlers: StreamHandlers | undefined;
    vi.spyOn(api, "sendDesktopChatStream").mockImplementation(
      (_input, _signal, handlers): Promise<void> => {
        capturedHandlers = handlers;
        return new Promise<void>(() => undefined);
      },
    );

    const canonicalAssistant: ChatMessage = {
      id: "assistant-canonical",
      chatId: "chat-stream",
      role: "assistant",
      content: "Hello world",
      timestamp: 10,
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    };

    const view = await bootStreamingHook();
    act(() => view.result.current.setDraft("hi"));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = view.result.current.sendMessage();
    });

    // Wait until sendDesktopChatStream is called (contacting state).
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("contacting");
      expect(capturedHandlers).toBeDefined();
    });

    // Fire two tokens — status must flip to streaming and content accumulates.
    act(() => {
      capturedHandlers?.onToken("Hello ");
    });
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("streaming");
    });
    const afterFirstToken = view.result.current.messages.find((m) => m.role === "assistant");
    expect(afterFirstToken?.content).toBe("Hello ");

    act(() => {
      capturedHandlers?.onToken("world");
    });
    await waitFor(() => {
      const bubble = view.result.current.messages.find((m) => m.role === "assistant");
      expect(bubble?.content).toBe("Hello world");
    });

    // Fire done — canonical messages replace the temp rows.
    act(() => {
      capturedHandlers?.onDone({
        chat: { ...streamingChat(), updatedAt: 99 },
        messages: [
          {
            id: "user-canonical",
            chatId: "chat-stream",
            role: "user",
            content: "hi",
            timestamp: 5,
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
          canonicalAssistant,
        ],
      });
    });
    await sendPromise;

    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("completed");
    });
    // The canonical assistant message must be present by its server-assigned id.
    const canonical = view.result.current.messages.find((m) => m.id === "assistant-canonical");
    expect(canonical).toBeDefined();
    expect(canonical?.content).toBe("Hello world");
    // No temp rows remain (id starts with "stream-").
    const tempRows = view.result.current.messages.filter((m) => m.id.startsWith("stream-"));
    expect(tempRows).toHaveLength(0);
  });

  // ST-L3-2 — cancel mid-stream: no partial assistant message kept (AC#3).
  it("removes the temp assistant bubble on cancel, leaving only the user prompt (AC#3)", async () => {
    let capturedHandlers: StreamHandlers | undefined;
    vi.spyOn(api, "sendDesktopChatStream").mockImplementation(
      (_input, _signal, handlers): Promise<void> => {
        capturedHandlers = handlers;
        return new Promise<void>(() => undefined);
      },
    );

    const view = await bootStreamingHook();
    act(() => view.result.current.setDraft("tell me a story"));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = view.result.current.sendMessage();
    });

    await waitFor(() => {
      expect(capturedHandlers).toBeDefined();
    });

    // Fire a token to get into streaming state.
    act(() => {
      capturedHandlers?.onToken("Once ");
    });
    await waitFor(() => {
      expect(view.result.current.sendStatus).toBe("streaming");
    });

    // Cancel — onCancelled fires.
    act(() => {
      capturedHandlers?.onCancelled();
    });
    await sendPromise;

    expect(view.result.current.sendStatus).toBe("cancelled");
    // AC#3: no partial assistant content.
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
    // The user's prompt stays visible.
    const users = view.result.current.messages.filter((m) => m.role === "user");
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  // ST-L3-3 — non-streaming model: sendDesktopChatStream must NOT be called.
  it("uses sendDesktopChat (not sendDesktopChatStream) for a non-streaming model", async () => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    const nonStreamChat: Chat = {
      ...streamingChat(),
      selectedModel: "non-stream-model",
    };
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [nonStreamingModelCapability("non-stream-model")],
    });
    vi.spyOn(api, "fetchProjects").mockResolvedValue({
      projects: [
        {
          path: PROJECT_PATH_STREAM,
          name: "proj-stream",
          favorite: false,
          createdAt: 0,
          lastOpenedAt: 0,
          available: true,
        },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({ chats: [nonStreamChat] });
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });

    const bufferedSpy = vi.spyOn(api, "sendDesktopChat").mockResolvedValue({
      chat: nonStreamChat,
      messages: [
        {
          id: "a1",
          chatId: nonStreamChat.id,
          role: "assistant",
          content: "buffered answer",
          timestamp: 5,
          runId: undefined,
          workflowId: undefined,
          workflowStatus: undefined,
          shortResult: undefined,
          taskType: undefined,
        },
      ],
    });
    const streamSpy = vi.spyOn(api, "sendDesktopChatStream");

    const view = renderHook(() => useChatSession());
    await waitFor(() => {
      expect(view.result.current.loading).toBe(false);
      expect(view.result.current.activeChat).toBeDefined();
    });

    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.sendStatus).toBe("completed");
    expect(bufferedSpy).toHaveBeenCalledOnce();
    expect(streamSpy).not.toHaveBeenCalled();
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.content).toBe("buffered answer");
  });

  // ST-L3-4 — StreamingUnavailableError before stream: falls back to sendDesktopChat.
  it("falls back to sendDesktopChat when sendDesktopChatStream throws StreamingUnavailableError", async () => {
    const streamSpy = vi
      .spyOn(api, "sendDesktopChatStream")
      .mockRejectedValue(new api.StreamingUnavailableError("STREAMING_UNSUPPORTED", "no stream"));

    const bufferedSpy = vi.spyOn(api, "sendDesktopChat").mockResolvedValue({
      chat: streamingChat(),
      messages: [
        {
          id: "a-fallback",
          chatId: "chat-stream",
          role: "assistant",
          content: "fallback answer",
          timestamp: 9,
          runId: undefined,
          workflowId: undefined,
          workflowStatus: undefined,
          shortResult: undefined,
          taskType: undefined,
        },
      ],
    });

    const view = await bootStreamingHook();
    act(() => view.result.current.setDraft("use fallback"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.sendStatus).toBe("completed");
    // The streaming path was attempted.
    expect(streamSpy).toHaveBeenCalledOnce();
    // The buffered fallback was used and produced the answer.
    expect(bufferedSpy).toHaveBeenCalledOnce();
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]?.content).toBe("fallback answer");
  });

  // ST-L3-5 — mid-stream client error (e.g. network drop / reader TypeError):
  // error must be surfaced in state AND the optimistic user-message removed.
  // Mutation: removing setError in the catch branch leaves error null (first assertion fails).
  // Mutation: removing the optimisticId filter leaves the orphaned user row (second assertion fails).
  it("sets state.error and removes the optimistic user message on a mid-stream generic rejection", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.spyOn(api, "sendDesktopChatStream").mockRejectedValue(networkError);

    const view = await bootStreamingHook();
    act(() => view.result.current.setDraft("trigger network error"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.sendStatus).toBe("failed");
    expect(view.result.current.error).toBeTruthy();
    // No orphaned user message — the optimistic row must have been removed.
    const users = view.result.current.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(0);
    // No partial assistant content persisted.
    const assistants = view.result.current.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(0);
  });

  // ST-L3-6 — AbortError mid-stream: must NOT set state.error (cancel is not an error).
  // Mutation: treating AbortError as a generic error would set error here (assertion fails).
  it("does not set state.error when the stream is aborted (AbortError)", async () => {
    vi.spyOn(api, "sendDesktopChatStream").mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    const view = await bootStreamingHook();
    act(() => view.result.current.setDraft("cancel me"));
    await act(async () => {
      await view.result.current.sendMessage();
    });

    expect(view.result.current.sendStatus).toBe("cancelled");
    expect(view.result.current.error).toBeUndefined();
  });
});
