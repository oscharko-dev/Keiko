// Issue #145 — model selection reliability across conversation entry points.
// Tests ACs #1-4 using pure helper functions and prop-injected session mocks.
// IMPORTANT: no module-level vi.mock("@/lib/api") — that pollutes capsule-actions tests.
// IMPORTANT: isConversationEligibleModel is a STATIC top-level import (dynamic import
//            does not resolve value-exports correctly in jsdom).

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    conversationReady: true,
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
    conversationReady: false,
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
    regeneratingMessageId: undefined,
    error: undefined,
    setDraft: vi.fn(),
    setSelectedModel: vi.fn(),
    openNewChat: vi.fn(),
    openProject: vi.fn(),
    openChat: vi.fn(),
    addProject: vi.fn(),
    sendMessage: vi.fn(),
    regenerateMessage: vi.fn(),
    cancelSend: vi.fn(),
    replaceChat: vi.fn(),
    latestGrounded: undefined,
    cancelGrounded: vi.fn(),
    // Issue #147 — attachment fields
    pendingAttachments: [],
    addPendingAttachment: vi.fn().mockResolvedValue({ ok: true }),
    removePendingAttachment: vi.fn(),
    clearPendingAttachments: vi.fn(),
    memoryEnabled: true,
    setMemoryEnabled: vi.fn(),
    memoryBudgetTokens: 1200,
    setMemoryBudgetTokens: vi.fn(),
    latestMemory: undefined,
    clearLatestMemory: vi.fn(),
    acceptMemoryCandidate: vi.fn(),
    rejectMemoryCandidate: vi.fn(),
    forgetMemoryAction: vi.fn(),
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
// Tri-state readiness + conversation-default rank (0.3.12 restart incident)
// ---------------------------------------------------------------------------
// `conversationReady` is tri-state on the wire: ABSENT means "this server process never probed
// the model" — after every restart the volatile observation store makes EVERY model unknown.
// Treating unknown as unusable emptied the picker until a manual probe plus reload (customer
// field incident, 0.3.11); the server verifies unknown models on demand at create/send. Among
// candidates the shared conversationDefaultRank keeps a mode-less OCR id from outranking a
// declared chat model.

function unprobedModel(id: string, chatModeDeclared?: boolean): ModelCapability {
  const { conversationReady: _ready, ...rest } = chatModel(id);
  return { ...rest, ...(chatModeDeclared === undefined ? {} : { chatModeDeclared }) };
}

function unreadyModel(id: string): ModelCapability {
  return { ...chatModel(id), conversationReady: false };
}

describe("pickChatModelId tri-state readiness", () => {
  it("keeps never-probed models usable — the picker survives a restart", () => {
    expect(pickChatModelId([unprobedModel("qwen-chat")])).toBe("qwen-chat");
  });

  it("blocks only an OBSERVED not-ready model", () => {
    expect(pickChatModelId([unreadyModel("cold-chat")])).toBeUndefined();
    expect(pickChatModelId([unreadyModel("cold-chat"), unprobedModel("qwen-chat")])).toBe(
      "qwen-chat",
    );
  });

  it("prefers a verified model over an unknown one", () => {
    expect(pickChatModelId([unprobedModel("unknown-first"), chatModel("verified-second")])).toBe(
      "verified-second",
    );
  });

  it("ranks a mode-less OCR id behind its siblings — unknown and verified alike", () => {
    // Unknown tier: the declared chat model wins over the first-listed OCR id.
    expect(pickChatModelId([unprobedModel("dotsocr"), unprobedModel("qwen-chat", true)])).toBe(
      "qwen-chat",
    );
    // Even without mode metadata the id heuristic keeps the OCR engine last.
    expect(pickChatModelId([unprobedModel("dotsocr"), unprobedModel("mistral-small")])).toBe(
      "mistral-small",
    );
    // Verified tier: a WARM OCR model that passed a probe still loses to a verified chat model.
    expect(
      pickChatModelId([
        chatModel("dotsocr"),
        { ...chatModel("qwen-chat"), chatModeDeclared: true },
      ]),
    ).toBe("qwen-chat");
    // Tier-first (review finding): a VERIFIED special-purpose model must not override an
    // UNPROBED declared chat model — verification breaks ties only within the best tier.
    expect(pickChatModelId([chatModel("dotsocr"), unprobedModel("qwen-chat", true)])).toBe(
      "qwen-chat",
    );
  });
});

describe("resolveSelectedModelId tri-state readiness", () => {
  it("keeps the persisted model of a reopened chat when its readiness is merely unknown", () => {
    expect(
      resolveSelectedModelId("qwen-chat", [unprobedModel("dotsocr"), unprobedModel("qwen-chat")]),
    ).toBe("qwen-chat");
  });

  it("drops a persisted model only on an OBSERVED not-ready", () => {
    expect(
      resolveSelectedModelId("cold-chat", [unreadyModel("cold-chat"), unprobedModel("qwen-chat")]),
    ).toBe("qwen-chat");
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
  it("shows a pending catalog refresh as loading without a missing-model alert or send", () => {
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        models: [],
        selectedModel: undefined,
        modelCatalogStatus: "loading",
        noEligibleModels: false,
        draft: "Waiting draft",
      }),
    );
    expect(screen.getByRole("combobox", { name: "Models" })).toHaveTextContent("Loading models");
    expect(screen.queryByText(/No conversation model is currently available/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("announces unavailable models with Settings guidance and links disabled controls", () => {
    // activeChat required so the composer footer (containing the alert) renders (#146).
    renderWindow(
      makeSession({ noEligibleModels: true, selectedModel: undefined, activeChat: makeChat() }),
    );
    const alert = screen.getByText(/No conversation model is currently available/i, {
      selector: '[role="alert"]',
    });
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/Settings/i);
    expect(alert.id).not.toBe("");
    expect(screen.getByRole("combobox", { name: "Models" })).toHaveAttribute(
      "aria-describedby",
      alert.id,
    );
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "aria-describedby",
      alert.id,
    );
  });

  it("shows a failed catalog as unavailable and permits opening the picker to retry", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        models: [],
        selectedModel: undefined,
        modelCatalogStatus: "failed",
        noEligibleModels: false,
        draft: "Waiting draft",
        error: "Synthetic catalog transport failure",
      }),
    );
    const picker = screen.getByRole("combobox", { name: "Models" });
    expect(picker).toHaveTextContent("Model list unavailable");
    expect(picker).toBeEnabled();
    expect(screen.queryByText(/No conversation model is currently available/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(picker);
    expect(await screen.findByRole("option", { name: "Model list unavailable" })).toBeDisabled();
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
    expect(screen.queryByText(/No conversation model is currently available/i)).toBeNull();
  });

  it("does not render embedding-only models in the chat selector", async () => {
    const user = userEvent.setup();
    renderWindow(
      makeSession({
        activeChat: makeChat(),
        selectedModel: "gpt-oss",
        models: [embeddingModel("text-embedding-3-large"), chatModel("gpt-oss")],
      }),
    );
    await user.click(screen.getByRole("combobox", { name: "Models" }));
    expect(await screen.findByRole("option", { name: "gpt-oss" })).toBeInTheDocument();
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
// Footer intentionally hides model status; model state remains managed by the session.
// ---------------------------------------------------------------------------

describe("Footer selectedModel visibility", () => {
  it("does not show the selected model id when a model is configured", () => {
    render(
      <Footer
        backendHealth={{ state: "loaded", health: { status: "ok", version: "1.2.3" } }}
        winCount={1}
        windows={[]}
        windowPaletteOpen={false}
        onToggleWindowPalette={vi.fn()}
        onSelectWindow={vi.fn()}
        onCloseWindowPalette={vi.fn()}
      />,
    );
    expect(screen.queryByText(/gpt-4o/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 window/ })).toBeInTheDocument();
  });

  it("does not show 'No model selected' when selectedModel is undefined", () => {
    render(
      <Footer
        backendHealth={{ state: "loaded", health: { status: "ok", version: "1.2.3" } }}
        winCount={1}
        windows={[]}
        windowPaletteOpen={false}
        onToggleWindowPalette={vi.fn()}
        onSelectWindow={vi.fn()}
        onCloseWindowPalette={vi.fn()}
      />,
    );
    expect(screen.queryByText(/No model selected/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1 window/ })).toBeInTheDocument();
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
  it("renders the mini composer and inherits selectedModel from the session", () => {
    renderWindow(
      makeSession({
        activeChat: {
          id: "chat-1",
          projectPath: "/repo",
          title: "Chat 1",
          selectedModel: "inherited-model",
          branchLabel: undefined,
          status: undefined,
          connectedScope: undefined,
          localKnowledgeScope: undefined,
          createdAt: 1,
          updatedAt: 2,
        },
        selectedModel: "inherited-model",
        noEligibleModels: false,
        models: [chatModel("inherited-model")],
      }),
      true, // mini=true
    );
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Models" })).toHaveTextContent("inherited-model");
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
    api.resetModelRequestCache();
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

// Existing journeys start with the authoritative empty skill selection.
vi.mock("@/lib/markdown-skills-api", () => ({
  fetchMarkdownSkillSelection: vi
    .fn()
    .mockResolvedValue({ availability: "none", selection: { revision: 0, skill: null } }),
  changeMarkdownSkillSelection: vi.fn(),
}));

// ---------------------------------------------------------------------------
// #4351 — a model nobody checked is checked once, because a person picked it
// ---------------------------------------------------------------------------

describe("explicit model selection starts exactly one check (#4351)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.resetModelRequestCache();
    mockBootstrapModels(["model-a"]);
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [
        chatModel("model-a"),
        { ...chatModel("model-unchecked"), conversationReady: undefined },
        {
          ...chatModel("model-running"),
          conversationReady: undefined,
          conversationCheckPending: true,
        },
        { ...chatModel("model-failed"), conversationReady: false },
      ],
    });
    vi.spyOn(api, "updateChat").mockImplementation((_id, patch) =>
      Promise.resolve(
        chatResponse(makeHookChat({ selectedModel: patch.selectedModel ?? "model-a" })),
      ),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the server to check a picked model that has no observation, once", async () => {
    const start = vi
      .spyOn(api, "startChatModelSelectionCheck")
      .mockResolvedValue({ state: "checking" });
    const view = await bootChatHook();
    expect(start).not.toHaveBeenCalled();
    act(() => {
      view.result.current.setSelectedModel("model-unchecked");
    });
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    expect(start).toHaveBeenCalledWith("model-unchecked", expect.any(String));
    // The shared settlement read joins the running check and adopts its result.
    await waitFor(() => {
      expect(api.fetchModels).toHaveBeenCalledWith(
        expect.any(String),
        false,
        expect.objectContaining({ waitForStartup: true }),
      );
    });
  });

  it.each(["model-a", "model-running", "model-failed"])(
    "starts no check when the picked model %s is already answered or being checked",
    async (modelId) => {
      const start = vi
        .spyOn(api, "startChatModelSelectionCheck")
        .mockResolvedValue({ state: "checking" });
      const view = await bootChatHook();
      act(() => {
        view.result.current.setSelectedModel(modelId);
      });
      // Positive control: the pick took effect (it was persisted); only then is "no check" claimed.
      await waitFor(() => {
        expect(api.updateChat).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ selectedModel: modelId }),
        );
      });
      expect(start).not.toHaveBeenCalled();
    },
  );

  it("shows that a picked model is being checked, then a readable reason when it is not ready", () => {
    const checking = { ...chatModel("model-b"), conversationCheckPending: true as const };
    const { rerender } = render(
      <ChatSessionProvider
        value={makeSession({
          activeChat: makeChat(),
          selectedModel: "model-b",
          models: [chatModel("model-a"), checking],
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );
    expect(screen.getByText("Checking model-b…")).toBeInTheDocument();
    rerender(
      <ChatSessionProvider
        value={makeSession({
          activeChat: makeChat(),
          selectedModel: "model-b",
          models: [chatModel("model-a"), { ...chatModel("model-b"), conversationReady: false }],
        })}
      >
        <ChatWindow />
      </ChatSessionProvider>,
    );
    expect(screen.getByText(/model-b is not ready\./)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// #4351 — the first Send on a model nobody checked is the first use that checks it
// ---------------------------------------------------------------------------

describe("first use of an unchecked model on Send (#4351)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.resetModelRequestCache();
    mockBootstrapModels(["model-a"]);
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [
        chatModel("model-a"),
        { ...chatModel("model-unchecked"), conversationReady: undefined },
      ],
    });
    vi.spyOn(api, "fetchChats").mockResolvedValue({
      chats: [makeHookChat({ selectedModel: "model-unchecked" })],
    });
    vi.spyOn(api, "updateChat").mockResolvedValue(chatResponse(makeHookChat()));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sendSpies(): {
    readonly sent: () => number;
    readonly inputs: () => readonly unknown[];
  } {
    const stream = vi
      .spyOn(api, "sendDesktopChatStream")
      .mockReturnValue(new Promise(() => undefined));
    const buffered = vi.spyOn(api, "sendDesktopChat").mockReturnValue(new Promise(() => undefined));
    return {
      sent: (): number => stream.mock.calls.length + buffered.mock.calls.length,
      inputs: (): readonly unknown[] =>
        [...stream.mock.calls, ...buffered.mock.calls].map((call) => call[0]),
    };
  }

  it("checks nothing when a restored chat is opened, and sends after the check answers", async () => {
    const start = vi
      .spyOn(api, "startChatModelSelectionCheck")
      .mockResolvedValue({ state: "ready" });
    const spies = sendSpies();
    const view = await bootChatHook();
    expect(view.result.current.selectedModel).toBe("model-unchecked");
    // No check on page load, on restore or on opening a chat.
    expect(start).not.toHaveBeenCalled();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(spies.sent()).toBe(1);
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("model-unchecked", expect.any(String));
  });

  it("shows the reason and sends nothing when the model refuses its check", async () => {
    vi.spyOn(api, "startChatModelSelectionCheck").mockResolvedValue({ state: "not-ready" });
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    let outcome: unknown;
    await act(async () => {
      outcome = await view.result.current.sendMessage();
    });
    expect(outcome).toEqual({ status: "not-sent" });
    expect(spies.sent()).toBe(0);
    expect(view.result.current.error).toBe("MODEL_NOT_READY");
    // The draft is untouched: the person can pick another model and send it.
    expect(view.result.current.draft).toBe("hello");
  });

  it("shows an HTTP failure of the check instead of swallowing it", async () => {
    vi.spyOn(api, "startChatModelSelectionCheck").mockRejectedValue(
      new api.ApiError("INTERNAL", "gateway check failed", 500),
    );
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      await view.result.current.sendMessage();
    });
    expect(spies.sent()).toBe(0);
    expect(view.result.current.error).toMatch(/gateway check failed/);
  });

  function deferredCheck(): {
    readonly promise: Promise<{ state: "ready" | "not-ready"; outcome?: "cooldown" }>;
    readonly resolve: (value: { state: "ready" | "not-ready"; outcome?: "cooldown" }) => void;
  } {
    let resolve!: (value: { state: "ready" | "not-ready"; outcome?: "cooldown" }) => void;
    const promise = new Promise<{ state: "ready" | "not-ready"; outcome?: "cooldown" }>((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  it("sends nothing and clears nothing when the person typed during the check", async () => {
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    let outcome: unknown;
    const sending = act(async () => {
      outcome = await view.result.current.sendMessage();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    act(() => view.result.current.setDraft("hello, and more"));
    check.resolve({ state: "ready" });
    await sending;
    expect(outcome).toEqual({ status: "not-sent" });
    expect(spies.sent()).toBe(0);
    expect(view.result.current.draft).toBe("hello, and more");
  });

  it("sends nothing when the person switched the model during the check", async () => {
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    let outcome: unknown;
    const sending = act(async () => {
      outcome = await view.result.current.sendMessage();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    act(() => view.result.current.setSelectedModel("model-a"));
    check.resolve({ state: "ready" });
    await sending;
    expect(outcome).toEqual({ status: "not-sent" });
    expect(spies.sent()).toBe(0);
    expect(view.result.current.draft).toBe("hello");
  });

  it("sends nothing to the old chat when the person opened another chat during the check", async () => {
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const other = makeHookChat({ id: "hook-chat-2", selectedModel: "model-a", updatedAt: 1 });
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    let outcome: unknown;
    const sending = act(async () => {
      outcome = await view.result.current.sendMessage();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await view.result.current.openChat(other);
    });
    check.resolve({ state: "ready" });
    await sending;
    expect(outcome).toEqual({ status: "not-sent" });
    expect(spies.sent()).toBe(0);
  });

  it("tells a second Send why it waits, and starts one check only", async () => {
    const check = deferredCheck();
    const start = vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    const first = act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await first;
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await view.result.current.sendMessage();
    });
    expect(view.result.current.error).toBe("MODEL_CHECKING");
    expect(start).toHaveBeenCalledTimes(1);
    check.resolve({ state: "not-ready" });
  });

  it("shows the cooldown reason, and records a ready answer so the next Send costs no round trip", async () => {
    const start = vi
      .spyOn(api, "startChatModelSelectionCheck")
      .mockResolvedValueOnce({ state: "not-ready", outcome: "cooldown" })
      .mockResolvedValue({ state: "ready" });
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      await view.result.current.sendMessage();
    });
    expect(view.result.current.error).toBe("MODEL_CHECK_COOLDOWN");
    expect(spies.sent()).toBe(0);
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(spies.sent()).toBe(1);
    });
    expect(
      view.result.current.models.find((model) => model.id === "model-unchecked")?.conversationReady,
    ).toBe(true);
    // The answer is recorded: sending again asks the server nothing.
    const calls = start.mock.calls.length;
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    expect(start.mock.calls.length).toBe(calls);
  });

  it("starts no check for a model that already answered", async () => {
    vi.spyOn(api, "fetchChats").mockResolvedValue({
      chats: [makeHookChat({ selectedModel: "model-a" })],
    });
    const start = vi.spyOn(api, "startChatModelSelectionCheck");
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(spies.sent()).toBe(1);
    });
    expect(start).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------------------------
  // The entry points a person actually uses: the real composer (button and Enter) with the real
  // hook, not a call into an internal function.
  // -------------------------------------------------------------------------------------------

  interface SessionRef {
    current: ChatSessionApi | undefined;
  }

  function RealComposer({ sessionRef }: { readonly sessionRef?: SessionRef }): ReactNode {
    const session = useChatSession();
    if (sessionRef !== undefined) sessionRef.current = session;
    return (
      <ChatSessionProvider value={session}>
        <ChatWindow />
      </ChatSessionProvider>
    );
  }

  const UNCHECKED = "model-unchecked";

  function documentCapableCatalog(): void {
    vi.spyOn(api, "fetchModels").mockResolvedValue({
      models: [
        chatModel("model-a"),
        { ...chatModel(UNCHECKED), conversationReady: undefined, supportsDocumentInput: true },
      ],
    });
  }

  interface ComposerRig {
    readonly user: ReturnType<typeof userEvent.setup>;
    readonly sessionRef: SessionRef;
    readonly box: () => HTMLElement;
    readonly send: (how: "button" | "Enter") => Promise<void>;
    readonly stage: (name: string) => Promise<void>;
  }

  async function composerRig(): Promise<ComposerRig> {
    documentCapableCatalog();
    const user = userEvent.setup();
    const sessionRef: SessionRef = { current: undefined };
    render(<RealComposer sessionRef={sessionRef} />);
    const box = (): HTMLElement => screen.getByRole("textbox", { name: "Chat message" });
    await screen.findByRole("textbox", { name: "Chat message" });
    return {
      user,
      sessionRef,
      box,
      send: async (how): Promise<void> => {
        if (how === "button")
          await user.click(screen.getByRole("button", { name: "Send message" }));
        else await user.keyboard("{Enter}");
      },
      stage: async (name): Promise<void> => {
        await act(async () => {
          const added = await sessionRef.current?.addPendingAttachment(
            new File(["report"], name, { type: "text/plain" }),
          );
          expect(added?.ok).toBe(true);
        });
      },
    };
  }

  // Waits for the check's answer to land in the session (an observable event), then drains the
  // continuation that follows it: a bounded number of microtask turns, not a sleep.
  async function answerCheckReady(
    check: { readonly resolve: (value: { state: "ready" }) => void },
    sessionRef: SessionRef,
  ): Promise<void> {
    await act(async () => {
      check.resolve({ state: "ready" });
    });
    await waitFor(() => {
      expect(
        sessionRef.current?.models.find((model) => model.id === UNCHECKED)?.conversationReady,
      ).toBe(true);
    });
    await act(async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    });
  }

  it.each(["button", "Enter"] as const)(
    "erases nothing and sends nothing when the person typed during the check (%s)",
    async (how) => {
      const check = deferredCheck();
      const start = vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
      const spies = sendSpies();
      const rig = await composerRig();
      await rig.user.type(rig.box(), "hello");
      await rig.send(how);
      await waitFor(() => {
        expect(start).toHaveBeenCalledTimes(1);
      });
      await rig.user.type(rig.box(), " and more");
      await answerCheckReady(check, rig.sessionRef);
      // The text typed during the wait is neither erased nor lost, and the old text is not sent.
      expect(spies.sent()).toBe(0);
      expect(rig.box()).toHaveTextContent("hello");
      expect(rig.box()).toHaveTextContent("and more");
    },
  );

  it("does not send an attachment the person removed during the check", async () => {
    const check = deferredCheck();
    const start = vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const rig = await composerRig();
    await rig.user.type(rig.box(), "hello");
    await rig.stage("report.txt");
    await rig.send("button");
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    await rig.user.click(
      await screen.findByRole("button", { name: "Remove attachment report.txt" }),
    );
    await answerCheckReady(check, rig.sessionRef);
    expect(spies.sent()).toBe(0);
    expect(rig.box()).toHaveTextContent("hello");
  });

  it("sends nothing and clears nothing when an attachment was added during the check", async () => {
    const check = deferredCheck();
    const start = vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const rig = await composerRig();
    await rig.user.type(rig.box(), "hello");
    await rig.send("button");
    await waitFor(() => {
      expect(start).toHaveBeenCalledTimes(1);
    });
    await rig.stage("late.txt");
    await answerCheckReady(check, rig.sessionRef);
    expect(spies.sent()).toBe(0);
    expect(rig.box()).toHaveTextContent("hello");
    expect(screen.getByRole("button", { name: "Remove attachment late.txt" })).toBeInTheDocument();
  });

  it.each([
    ["fails", "failed"],
    ["is refused", "refused"],
  ] as const)(
    "keeps the draft and the staged attachment when the check %s, and sends nothing",
    async (_name, kind) => {
      const start = vi.spyOn(api, "startChatModelSelectionCheck");
      if (kind === "failed")
        start.mockRejectedValue(new api.ApiError("INTERNAL", "gateway check failed", 500));
      else start.mockResolvedValue({ state: "not-ready" });
      const spies = sendSpies();
      const rig = await composerRig();
      await rig.user.type(rig.box(), "hello");
      await rig.stage("report.txt");
      await rig.send("button");
      // Positive control: the reason reached the session; only then is "nothing sent" claimed.
      await waitFor(() => {
        expect(rig.sessionRef.current?.error).toMatch(
          kind === "failed" ? /gateway check failed/ : /^MODEL_NOT_READY$/,
        );
      });
      expect(spies.sent()).toBe(0);
      expect(rig.box()).toHaveTextContent("hello");
      expect(
        screen.getByRole("button", { name: "Remove attachment report.txt" }),
      ).toBeInTheDocument();
    },
  );

  it("sends exactly once to the picked model when the check succeeds, and clears the draft", async () => {
    const start = vi
      .spyOn(api, "startChatModelSelectionCheck")
      .mockResolvedValue({ state: "ready" });
    const spies = sendSpies();
    const rig = await composerRig();
    await rig.user.type(rig.box(), "hello");
    await rig.send("button");
    await waitFor(() => {
      expect(spies.sent()).toBe(1);
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(spies.inputs()[0]).toMatchObject({ modelId: UNCHECKED });
    await waitFor(() => {
      expect(rig.box()).not.toHaveTextContent("hello");
    });
  });

  function persistChatSelection(initial: string): void {
    vi.spyOn(api, "fetchChats").mockResolvedValue({
      chats: [makeHookChat({ selectedModel: initial })],
    });
    vi.spyOn(api, "updateChat").mockImplementation((_id, patch) =>
      Promise.resolve(
        chatResponse(makeHookChat({ selectedModel: patch.selectedModel ?? initial })),
      ),
    );
  }

  it("does not tell a Send after a model switch that the other model is still being checked", async () => {
    persistChatSelection("model-unchecked");
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    act(() => view.result.current.setSelectedModel("model-a"));
    // The send that goes out never settles in this double: it is started, not awaited.
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    expect(view.result.current.error).not.toBe("MODEL_CHECKING");
    await waitFor(() => {
      expect(spies.sent()).toBe(1);
    });
    check.resolve({ state: "ready" });
  });

  it("removes the 'still being checked' notice when the check it described has ended", async () => {
    persistChatSelection("model-unchecked");
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("hello"));
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await view.result.current.sendMessage();
    });
    expect(view.result.current.error).toBe("MODEL_CHECKING");
    // The person leaves for another model: the wait ends and the notice goes with it.
    act(() => view.result.current.setSelectedModel("model-a"));
    check.resolve({ state: "ready" });
    await waitFor(() => {
      expect(view.result.current.error).toBeUndefined();
    });
  });

  it.each([
    ["not-ready", "refused", "MODEL_NOT_READY"],
    ["not-ready", "cooldown", "MODEL_CHECK_COOLDOWN"],
    ["unchecked", "cooldown", "MODEL_CHECK_COOLDOWN"],
  ] as const)(
    "shows at once why a picked model that answered %s with outcome %s is not usable",
    async (state, outcome, expectedError) => {
      persistChatSelection("model-a");
      vi.spyOn(api, "startChatModelSelectionCheck").mockResolvedValue(
        outcome === "cooldown" ? { state, outcome } : { state },
      );
      const view = await bootChatHook();
      act(() => view.result.current.setSelectedModel("model-unchecked"));
      await waitFor(() => {
        expect(view.result.current.error).toBe(expectedError);
      });
      // A cooldown is read before the state, so an "unchecked" state never waits for a check that
      // was never started.
      expect(api.fetchModels).not.toHaveBeenCalledWith(
        expect.any(String),
        false,
        expect.objectContaining({ waitForStartup: true }),
      );
    },
  );

  it("holds a spoken final that arrives during the check as not sent, and keeps the typed draft", async () => {
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("typed draft"));
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    let outcome: unknown;
    await act(async () => {
      outcome = await view.result.current.sendMessage({
        text: "spoken final",
        reportOutcome: true,
        clientTurnId: "turn-1",
      });
    });
    // The Voice dialogue treats anything but "completed" as a failed delivery and keeps the
    // transcript for retry; nothing is dropped and the typed draft is untouched.
    expect(outcome).toEqual({ status: "not-sent" });
    expect(spies.sent()).toBe(0);
    expect(view.result.current.draft).toBe("typed draft");
    check.resolve({ state: "not-ready" });
  });

  it("does not hold a queued canonical Voice send behind the check; the queue owns its retry", async () => {
    const check = deferredCheck();
    vi.spyOn(api, "startChatModelSelectionCheck").mockReturnValue(check.promise);
    const spies = sendSpies();
    const view = await bootChatHook();
    act(() => view.result.current.setDraft("typed draft"));
    await act(async () => {
      void view.result.current.sendMessage();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.startChatModelSelectionCheck).toHaveBeenCalledTimes(1);
    });
    const chat = view.result.current.activeChat;
    expect(chat).toBeDefined();
    await act(async () => {
      void view.result.current.sendMessage({
        text: "queued spoken final",
        reportOutcome: true,
        clientTurnId: "turn-queued",
        canonicalVoiceTarget: {
          chat: chat as Chat,
          project: { path: "/repo" },
          modelId: "model-unchecked",
          attachments: [],
          memory: { context: { userId: "local-operator", conversationId: (chat as Chat).id } },
        },
      });
      await Promise.resolve();
    });
    // Not answered "checking": the queue's own bounded, non-terminal retry decides, so a refusal is
    // never a lost transcript.
    expect(view.result.current.error).not.toBe("MODEL_CHECKING");
    await waitFor(() => {
      expect(spies.sent()).toBe(1);
    });
    check.resolve({ state: "not-ready" });
  });
});
