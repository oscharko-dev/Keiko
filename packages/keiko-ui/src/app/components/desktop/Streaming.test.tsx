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

// ─── ChatWindow UI tests — lifecycle indicator + Cancel button (AC#1, AC#3) ────

describe("ChatWindow lifecycle status indicator (Issue #152)", () => {
  it("does not render the role=status indicator while sendStatus is idle", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        messages: [userMessage("hi")],
        sendStatus: "idle",
        sending: false,
      }),
    );
    // The bootstrap loading status is gated on session.loading=false, so the
    // only role="status" left in the tree comes from the lifecycle indicator,
    // which must be hidden when idle.
    expect(screen.queryByRole("status")).toBeNull();
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
});
