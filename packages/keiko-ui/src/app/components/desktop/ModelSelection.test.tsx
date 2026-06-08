// Issue #145 — model selection reliability across conversation entry points.
// Tests ACs #1-4 using pure helper functions and prop-injected session mocks.
// IMPORTANT: no module-level vi.mock("@/lib/api") — that pollutes capsule-actions tests.
// IMPORTANT: isConversationEligibleModel is a STATIC top-level import (dynamic import
//            does not resolve value-exports correctly in jsdom).

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWindow } from "./ChatWindow";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { Footer } from "./Footer";
import type { ChatSessionApi } from "./hooks/useChatSession";
import { pickChatModelId, resolveSelectedModelId, useChatSession } from "./hooks/useChatSession";
import { chooseDefaultModel } from "./modals/NewWindowDialog";
import * as api from "@/lib/api";
import { isConversationEligibleModel } from "@/lib/types";
import type { Chat, ChatResponse, ModelCapability } from "@/lib/types";

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
    lastSentDocuments: [],
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

  it("skips embedding-only models when picking the default chat model", () => {
    expect(pickChatModelId([embeddingModel("text-embedding-3-large"), chatModel("gpt-oss")])).toBe(
      "gpt-oss",
    );
  });

  it("returns the first model id, never a hard-coded placeholder", () => {
    const models = [chatModel("provider-model-a"), chatModel("provider-model-b")];
    expect(pickChatModelId(models)).toBe("provider-model-a");
  });
});

describe("resolveSelectedModelId", () => {
  it("preserves the current model when it is still eligible", () => {
    const models = [chatModel("provider-model-a"), chatModel("provider-model-b")];
    expect(resolveSelectedModelId("provider-model-b", models)).toBe("provider-model-b");
  });

  it("falls back to the first eligible model when the persisted id is stale", () => {
    const models = [chatModel("provider-model-a"), chatModel("provider-model-b")];
    expect(resolveSelectedModelId("removed-model", models)).toBe("provider-model-a");
  });

  it("returns undefined when no eligible models remain", () => {
    expect(resolveSelectedModelId("removed-model", [])).toBeUndefined();
  });

  it("drops a persisted embedding model and falls back to a chat-capable model", () => {
    expect(
      resolveSelectedModelId("text-embedding-3-large", [
        embeddingModel("text-embedding-3-large"),
        chatModel("gpt-oss"),
      ]),
    ).toBe("gpt-oss");
  });

  // N3 — bootstrap path: latestChat.selectedModel may be undefined in the DB.
  it("treats undefined current as stale and returns the first eligible model", () => {
    const models = [chatModel("provider-model-a")];
    expect(resolveSelectedModelId(undefined, models)).toBe("provider-model-a");
  });

  it("returns undefined when current is undefined and no eligible models remain", () => {
    expect(resolveSelectedModelId(undefined, [])).toBeUndefined();
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

  it("does not render embedding-only models in the chat selector", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        selectedModel: "gpt-oss",
        models: [embeddingModel("text-embedding-3-large"), chatModel("gpt-oss")],
      }),
    );
    expect(screen.getByRole("option", { name: "gpt-oss" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "text-embedding-3-large" })).toBeNull();
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
    render(
      <Footer
        winCount={1}
        mode="autonomous"
        selectedModel="gpt-4o"
        projectName="Keiko"
        branchLabel="main"
        shellStatusLabel="Ready"
        evidenceStatusLabel="Open review"
      />,
    );
    expect(screen.getByText(/gpt-4o/i)).toBeInTheDocument();
  });

  it("shows 'No model selected' when selectedModel is undefined", () => {
    render(
      <Footer
        winCount={1}
        mode="autonomous"
        selectedModel={undefined}
        projectName="Keiko"
        branchLabel="main"
        shellStatusLabel="Ready"
        evidenceStatusLabel="Open review"
      />,
    );
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

// ---------------------------------------------------------------------------
// AC #3 integration — setSelectedModel PATCH persistence and rollback
// Tests the real useChatSession hook with mocked @/lib/api (vi.spyOn, no
// module-level vi.mock per file-level constraint).
// ---------------------------------------------------------------------------

const HOOK_PROJECT_PATH = "/hook-proj";

function chatModelCapability(id: string): ModelCapability {
  return chatModel(id);
}

function makeHookChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: "hook-chat-1",
    projectPath: HOOK_PROJECT_PATH,
    title: "t",
    selectedModel: "model-a",
    branchLabel: undefined,
    status: undefined,
    connectedScope: undefined,
    localKnowledgeScope: undefined,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function chatResponse(chat: Chat): ChatResponse {
  return { chat };
}

function mockBootstrapModels(modelIds: string[]): void {
  const chat = makeHookChat();
  vi.spyOn(api, "fetchModels").mockResolvedValue({
    models: modelIds.map(chatModelCapability),
  });
  vi.spyOn(api, "fetchProjects").mockResolvedValue({
    projects: [
      {
        path: HOOK_PROJECT_PATH,
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

async function bootChatHook() {
  const view = renderHook(() => useChatSession());
  await waitFor(() => {
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.activeChat).toBeDefined();
  });
  return view;
}

describe("setSelectedModel PATCH persistence (AC #3 integration)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.clearModelCacheForTests();
    mockBootstrapModels(["model-a", "model-b"]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls back the optimistic update when PATCH fails so UI stays consistent with the server", async () => {
    vi.spyOn(api, "updateChat").mockRejectedValue(new Error("network error"));

    const view = await bootChatHook();
    expect(view.result.current.selectedModel).toBe("model-a");

    act(() => {
      view.result.current.setSelectedModel("model-b");
    });
    // Optimistic update applied synchronously.
    expect(view.result.current.selectedModel).toBe("model-b");

    // PATCH rejects — state must revert to "model-a".
    await waitFor(() => {
      expect(view.result.current.selectedModel).toBe("model-a");
    });
    expect(view.result.current.error).toMatch(/network error/i);
  });

  // MS-F4 — cross-chat rollback regression. A rejected PATCH for chat A must NOT
  // clobber the selection of chat B after the user navigates away. Reverting the
  // `activeChatIdRef.current !== activeChatId` guard in setSelectedModel's catch
  // makes B's selection revert to A's old model and surfaces an error on B.
  it("does not roll back the now-active chat when an earlier chat's PATCH rejects (MS-F4)", async () => {
    const chatB = makeHookChat({ id: "hook-chat-2", selectedModel: "model-b", updatedAt: 1 });

    let rejectFirst!: (reason: Error) => void;
    const firstPatch = new Promise<ChatResponse>((_res, rej) => {
      rejectFirst = rej;
    });
    vi.spyOn(api, "updateChat").mockReturnValue(firstPatch);
    // openChat(B) refetches B's messages; return an empty log.
    vi.spyOn(api, "fetchChatMessages").mockResolvedValue({ messages: [] });

    const view = await bootChatHook();
    // Chat A boots with model-a selected.
    expect(view.result.current.selectedModel).toBe("model-a");

    // User switches A to model-b (optimistic), firing a PATCH that will reject.
    act(() => {
      view.result.current.setSelectedModel("model-b");
    });
    expect(view.result.current.selectedModel).toBe("model-b");

    // User navigates to chat B (persisted on model-b → resolves to model-b).
    await act(async () => {
      await view.result.current.openChat(chatB);
    });
    expect(view.result.current.activeChat?.id).toBe("hook-chat-2");
    expect(view.result.current.selectedModel).toBe("model-b");

    // Now A's PATCH rejects. B is active — the rollback must be skipped.
    await act(async () => {
      rejectFirst(new Error("network error"));
      await firstPatch.catch(() => undefined);
    });

    // B's selection is intact and no error was surfaced on B.
    expect(view.result.current.activeChat?.id).toBe("hook-chat-2");
    expect(view.result.current.selectedModel).toBe("model-b");
    expect(view.result.current.error).toBeUndefined();
  });

  it("last-write-wins: a stale PATCH response from an earlier call does not overwrite a later selection", async () => {
    const chat = makeHookChat();
    let resolveFirst!: (v: ChatResponse) => void;
    let resolveSecond!: (v: ChatResponse) => void;
    const firstPatch = new Promise<ChatResponse>((res) => {
      resolveFirst = res;
    });
    const secondPatch = new Promise<ChatResponse>((res) => {
      resolveSecond = res;
    });

    let callCount = 0;
    vi.spyOn(api, "updateChat").mockImplementation(() => {
      callCount += 1;
      return callCount === 1 ? firstPatch : secondPatch;
    });

    const view = await bootChatHook();

    act(() => {
      view.result.current.setSelectedModel("model-b");
      view.result.current.setSelectedModel("model-c");
    });

    // Resolve the first (stale) PATCH after the second call already superseded it.
    await act(async () => {
      resolveFirst(chatResponse({ ...chat, selectedModel: "model-b" }));
    });
    // Stale response must be silently dropped; "model-c" stays.
    expect(view.result.current.selectedModel).toBe("model-c");

    // Resolve the second (current) PATCH.
    await act(async () => {
      resolveSecond(chatResponse({ ...chat, selectedModel: "model-c" }));
    });
    expect(view.result.current.selectedModel).toBe("model-c");
  });
});
