import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, ModelCapability, ProjectWithAvailability } from "@/lib/types";
import {
  ApiError,
  askGrounded,
  appendDesktopChatVoiceTurn,
  createDesktopChat,
  fetchChatMessages,
  fetchChats,
  fetchModels,
  fetchProjects,
  sendDesktopChat,
} from "@/lib/api";
import {
  CONTEXT_OVERSIZED_USER_MESSAGE,
  GROUNDED_ATTACHMENT_NOTICE,
  MAX_ATTACHMENT_BYTES,
  clearChatSessionBootstrapCacheForTests,
  isInFlight,
  notifyChatDeleted,
  notifyChatUpsert,
  pickChatModelId,
  resolveSelectedModelId,
  useChatSession,
} from "./useChatSession";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  StreamingUnavailableError: class StreamingUnavailableError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  askGrounded: vi.fn(),
  appendDesktopChatVoiceTurn: vi.fn(),
  createDesktopChat: vi.fn(),
  createProject: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchChats: vi.fn(),
  fetchModels: vi.fn(),
  fetchProjects: vi.fn(),
  sendDesktopChat: vi.fn(),
  sendDesktopChatStream: vi.fn(),
  runRealtimeGroundedTool: vi.fn(),
  updateChat: vi.fn(),
}));

vi.mock("@/lib/memory-api", () => ({
  acceptMemoryProposal: vi.fn(),
  forgetMemory: vi.fn(),
  rejectMemoryProposal: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  clearChatSessionBootstrapCacheForTests();
});

function model(patch: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "chat-a",
    kind: "chat",
    contextWindow: 16_000,
    maxOutputTokens: 2_000,
    toolCalling: false,
    structuredOutput: false,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: false,
    costClass: "medium",
    latencyClass: "standard",
    throughputHint: "test",
    preferredUseCases: [],
    knownLimitations: [],
    ...patch,
  };
}

function project(
  path = "/repo",
  patch: Partial<ProjectWithAvailability> = {},
): ProjectWithAvailability {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 2,
    available: true,
    ...patch,
  };
}

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "chat-1",
    projectPath: "/repo",
    title: "Release chat",
    selectedModel: "chat-a",
    createdAt: 1,
    updatedAt: 1,
    connectedScopes: [],
    localKnowledgeScopes: [],
    ...patch,
  } as Chat;
}

function message(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    chatId: "chat-1",
    role: "user",
    content: "Check grounding sources.",
    createdAt: 1,
    ...patch,
  } as ChatMessage;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useChatSession pure guards", () => {
  it("resolves request state and model eligibility deterministically", () => {
    const eligible = model({ id: "chat-live" });
    const ineligible = model({ id: "embed", kind: "embedding" });

    expect(isInFlight("queued")).toBe(true);
    expect(isInFlight("completed")).toBe(false);
    expect(pickChatModelId([ineligible, eligible])).toBe("chat-live");
    expect(resolveSelectedModelId("missing", [ineligible, eligible])).toBe("chat-live");
    expect(resolveSelectedModelId("chat-live", [eligible])).toBe("chat-live");
  });
});

describe("useChatSession bootstrap", () => {
  it("loads the newest existing chat and falls back from a stale selected model", async () => {
    const latest = chat({ id: "chat-latest", selectedModel: "stale-model", updatedAt: 20 });
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "embed", kind: "embedding" }), model({ id: "chat-live" })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [chat({ id: "chat-old", updatedAt: 1 }), latest],
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [message({ id: "msg-latest", chatId: "chat-latest" })],
    });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchChats).toHaveBeenCalledWith("/repo");
    expect(fetchChatMessages).toHaveBeenCalledWith("chat-latest", "/repo");
    expect(result.current.activeChat?.id).toBe("chat-latest");
    expect(result.current.selectedModel).toBe("chat-live");
    expect(result.current.messages).toHaveLength(1);
  });

  it("shares concurrent cold bootstrap requests across session instances", async () => {
    const latest = chat({ id: "chat-latest", selectedModel: "chat-live", updatedAt: 20 });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [latest] });
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [message({ id: "msg-latest", chatId: "chat-latest" })],
    });

    const first = renderHook(() => useChatSession({ autoCreate: false }));
    const second = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
      expect(second.result.current.loading).toBe(false);
    });
    expect(fetchModels).toHaveBeenCalledTimes(1);
    expect(fetchProjects).toHaveBeenCalledTimes(1);
    expect(fetchChats).toHaveBeenCalledTimes(1);
    expect(fetchChatMessages).toHaveBeenCalledTimes(1);
    expect(first.result.current.activeChat?.id).toBe("chat-latest");
    expect(second.result.current.activeChat?.id).toBe("chat-latest");
  });

  it("uses one shared DOM listener pair for chat mutations across session instances", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat({ id: "chat-live-id" })] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [message()] });

    const first = renderHook(() => useChatSession({ autoCreate: false }));
    const second = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
      expect(second.result.current.loading).toBe(false);
    });
    expect(addSpy.mock.calls.filter(([event]) => event === "keiko:chat-upsert")).toHaveLength(1);
    expect(addSpy.mock.calls.filter(([event]) => event === "keiko:chat-delete")).toHaveLength(1);

    first.unmount();
    expect(removeSpy.mock.calls.filter(([event]) => event === "keiko:chat-upsert")).toHaveLength(0);

    second.unmount();
    expect(removeSpy.mock.calls.filter(([event]) => event === "keiko:chat-upsert")).toHaveLength(1);
    expect(removeSpy.mock.calls.filter(([event]) => event === "keiko:chat-delete")).toHaveLength(1);
  });

  it("creates the first chat when auto-create is enabled and no chats exist", async () => {
    const created = chat({ id: "chat-created", title: "New chat", updatedAt: 30 });
    const upsertListener = vi.fn();
    window.addEventListener("keiko:chat-upsert", upsertListener);
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    vi.mocked(createDesktopChat).mockResolvedValue({
      chat: created,
      project: project("/repo"),
      projects: [project("/repo")],
      chats: [created],
      messages: [],
    });

    const { result } = renderHook(() => useChatSession());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(createDesktopChat).toHaveBeenCalledWith({
      modelId: "chat-live",
      title: "New chat",
      projectPath: "/repo",
    });
    expect(result.current.activeChat?.id).toBe("chat-created");
    expect(upsertListener).toHaveBeenCalledTimes(1);
    window.removeEventListener("keiko:chat-upsert", upsertListener);
  });

  it("opens a new chat with a trimmed title and explicit project override", async () => {
    const created = chat({
      id: "chat-project-override",
      projectPath: "/other",
      title: "Grounding release check",
      updatedAt: 50,
    });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo"), project("/other")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    vi.mocked(createDesktopChat).mockResolvedValue({
      chat: created,
      project: project("/other"),
      projects: [project("/repo"), project("/other")],
      chats: [created],
      messages: [message({ id: "created-msg", chatId: "chat-project-override" })],
    });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let opened: Chat | undefined;
    await act(async () => {
      opened = await result.current.openNewChat(project("/other"), "  Grounding release check  ");
    });

    expect(createDesktopChat).toHaveBeenCalledWith({
      modelId: "chat-live",
      title: "Grounding release check",
      projectPath: "/other",
    });
    expect(opened?.id).toBe("chat-project-override");
    expect(result.current.activeProject?.path).toBe("/other");
    expect(result.current.messages[0]?.id).toBe("created-msg");
  });

  it("does not auto-create when no conversation-eligible model is available", async () => {
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "embed", kind: "embedding" })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });

    const { result } = renderHook(() => useChatSession());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(createDesktopChat).not.toHaveBeenCalled();
    expect(result.current.selectedModel).toBeUndefined();
    expect(result.current.noEligibleModels).toBe(true);
  });

  it("accepts only typed chat-upsert and chat-delete events", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat({ id: "chat-live-id" })] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [message()] });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    window.dispatchEvent(new CustomEvent("keiko:chat-upsert", { detail: { id: 1 } }));
    expect(result.current.chats).toHaveLength(1);

    notifyChatUpsert(chat({ id: "chat-new", selectedModel: "chat-live", updatedAt: 40 }));
    await waitFor(() => expect(result.current.chats[0]?.id).toBe("chat-new"));

    notifyChatDeleted("chat-new");
    await waitFor(() =>
      expect(result.current.chats.some((item) => item.id === "chat-new")).toBe(false),
    );
  });
});

describe("useChatSession stale async landing guards", () => {
  async function setupSwitchSession(): Promise<
    ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>
  > {
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "chat-a", streaming: false })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [chat({ id: "chat-current", selectedModel: "chat-a" })],
    });
    vi.mocked(fetchChatMessages).mockResolvedValueOnce({
      messages: [message({ id: "msg-current", chatId: "chat-current" })],
    });

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("keeps the last selected chat when an earlier openChat resolves late", async () => {
    const rendered = await setupSwitchSession();
    const chatA = chat({ id: "chat-a", title: "A", updatedAt: 10 });
    const chatB = chat({ id: "chat-b", title: "B", updatedAt: 20 });
    const openA = deferred<{ messages: readonly ChatMessage[] }>();
    const openB = deferred<{ messages: readonly ChatMessage[] }>();
    vi.mocked(fetchChatMessages).mockImplementation((chatId: string) => {
      if (chatId === "chat-a") return openA.promise;
      if (chatId === "chat-b") return openB.promise;
      return Promise.resolve({ messages: [] });
    });

    let openAPromise!: Promise<void>;
    let openBPromise!: Promise<void>;
    act(() => {
      openAPromise = rendered.result.current.openChat(chatA);
      openBPromise = rendered.result.current.openChat(chatB);
    });

    await act(async () => {
      openB.resolve({ messages: [message({ id: "msg-b", chatId: "chat-b" })] });
      await openBPromise;
    });
    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    expect(rendered.result.current.messages.map((entry) => entry.id)).toEqual(["msg-b"]);

    await act(async () => {
      openA.resolve({ messages: [message({ id: "msg-a", chatId: "chat-a" })] });
      await openAPromise;
    });
    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    expect(rendered.result.current.messages.map((entry) => entry.id)).toEqual(["msg-b"]);
  });

  it("keeps project and chat state aligned when an earlier openProject resolves late", async () => {
    const rendered = await setupSwitchSession();
    const projectA = project("/repo-a");
    const projectB = project("/repo-b");
    const chatA = chat({ id: "chat-a", projectPath: "/repo-a", title: "A", updatedAt: 10 });
    const chatB = chat({ id: "chat-b", projectPath: "/repo-b", title: "B", updatedAt: 20 });
    const chatsA = deferred<{ chats: readonly Chat[] }>();
    const chatsB = deferred<{ chats: readonly Chat[] }>();
    vi.mocked(fetchChats).mockImplementation((projectPath: string) => {
      if (projectPath === "/repo-a") return chatsA.promise;
      if (projectPath === "/repo-b") return chatsB.promise;
      return Promise.resolve({ chats: [] });
    });
    vi.mocked(fetchChatMessages).mockImplementation((chatId: string) => {
      if (chatId === "chat-b") {
        return Promise.resolve({ messages: [message({ id: "msg-b", chatId: "chat-b" })] });
      }
      return Promise.resolve({ messages: [message({ id: "msg-a", chatId: "chat-a" })] });
    });

    let openAPromise!: Promise<void>;
    let openBPromise!: Promise<void>;
    act(() => {
      openAPromise = rendered.result.current.openProject(projectA);
      openBPromise = rendered.result.current.openProject(projectB);
    });

    await act(async () => {
      chatsB.resolve({ chats: [chatB] });
      await openBPromise;
    });
    expect(rendered.result.current.activeProject?.path).toBe("/repo-b");
    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    expect(rendered.result.current.messages.map((entry) => entry.id)).toEqual(["msg-b"]);

    await act(async () => {
      chatsA.resolve({ chats: [chatA] });
      await openAPromise;
    });
    expect(rendered.result.current.activeProject?.path).toBe("/repo-b");
    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    expect(rendered.result.current.messages.map((entry) => entry.id)).toEqual(["msg-b"]);
  });

  it("drops a buffered send result after switching to another chat", async () => {
    const rendered = await setupSwitchSession();
    const chatB = chat({ id: "chat-b", title: "B", updatedAt: 20 });
    const send = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat).mockReturnValue(send.promise);
    vi.mocked(fetchChatMessages).mockImplementation((chatId: string) => {
      if (chatId === "chat-b") {
        return Promise.resolve({ messages: [message({ id: "msg-b", chatId: "chat-b" })] });
      }
      return Promise.resolve({ messages: [] });
    });

    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = rendered.result.current.sendMessage({ text: "question for A" });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));

    await act(async () => {
      await rendered.result.current.openChat(chatB);
    });
    expect(rendered.result.current.activeChat?.id).toBe("chat-b");

    await act(async () => {
      send.resolve({
        chat: chat({ id: "chat-current", title: "Current", updatedAt: 30 }),
        messages: [message({ id: "msg-a-answer", chatId: "chat-current", role: "assistant" })],
      });
      await sendPromise;
    });

    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    expect(rendered.result.current.messages.map((entry) => entry.id)).toEqual(["msg-b"]);
    expect(rendered.result.current.sendStatus).toBe("cancelled");
  });
});

describe("useChatSession pending attachment validation", () => {
  async function setupAttachmentSession(
    models: readonly ModelCapability[] = [model({ id: "chat-a" })],
  ): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>> {
    vi.mocked(fetchModels).mockResolvedValue({ models: [...models] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat()] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("rejects empty attachments before MIME or model-capability checks", async () => {
    const { result } = await setupAttachmentSession();

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(
        new File([], "empty.txt", { type: "text/plain" }),
      );
      expect(outcome).toEqual({ ok: false, reason: "empty" });
    });

    expect(result.current.pendingAttachments).toHaveLength(0);
  });

  it("rejects oversized attachments before MIME or model-capability checks", async () => {
    const { result } = await setupAttachmentSession();
    const file = new File(["x"], "large.txt", { type: "text/plain" });
    Object.defineProperty(file, "size", { value: MAX_ATTACHMENT_BYTES + 1 });

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(file);
      expect(outcome).toEqual({ ok: false, reason: "oversized" });
    });

    expect(result.current.pendingAttachments).toHaveLength(0);
  });

  it("rejects unsupported attachment MIME types", async () => {
    const { result } = await setupAttachmentSession();

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(
        new File(["payload"], "payload.bin", { type: "application/octet-stream" }),
      );
      expect(outcome).toEqual({ ok: false, reason: "unsupported-type" });
    });

    expect(result.current.pendingAttachments).toHaveLength(0);
  });

  // GEN-DUP-SEMANTIC-013 — adopting the shared contracts classifier widened the client document
  // allowlist to match the server (previously the client under-approximated it). application/xml
  // now classifies as a document rather than "unsupported-type".
  it("accepts application/xml as a document once the classifier matches the server", async () => {
    const { result } = await setupAttachmentSession([
      model({ id: "chat-a", supportsDocumentInput: true }),
    ]);

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(
        new File(["<root/>"], "data.xml", { type: "application/xml" }),
      );
      expect(outcome).toEqual({ ok: true });
    });

    expect(result.current.pendingAttachments).toHaveLength(1);
    expect(result.current.pendingAttachments[0]?.kind).toBe("document");
  });

  // GEN-DUP-SEMANTIC-013 — image/svg+xml is script-carrying and stays rejected client-side even
  // for an image-capable model, matching the server's SVG deny.
  it("rejects image/svg+xml even for an image-capable model", async () => {
    const { result } = await setupAttachmentSession([
      model({ id: "chat-a", supportsImageInput: true }),
    ]);

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(
        new File(["<svg/>"], "vector.svg", { type: "image/svg+xml" }),
      );
      expect(outcome).toEqual({ ok: false, reason: "unsupported-type" });
    });

    expect(result.current.pendingAttachments).toHaveLength(0);
  });

  it("rejects image attachments when the selected model is text-only", async () => {
    const { result } = await setupAttachmentSession([
      model({ id: "chat-a", supportsImageInput: false }),
    ]);

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(
        new File(["image"], "screen.png", { type: "image/png" }),
      );
      expect(outcome).toEqual({ ok: false, reason: "text-only-model" });
    });

    expect(result.current.pendingAttachments).toHaveLength(0);
  });

  it("rejects document attachments when the selected model cannot read documents", async () => {
    const { result } = await setupAttachmentSession([
      model({ id: "chat-a", supportsDocumentInput: false }),
    ]);

    await act(async () => {
      const outcome = await result.current.addPendingAttachment(
        new File(["{}"], "context.json", { type: "application/json" }),
      );
      expect(outcome).toEqual({ ok: false, reason: "text-only-model" });
    });

    expect(result.current.pendingAttachments).toHaveLength(0);
  });
});

describe("useChatSession sendMessage — grounded attachment guard", () => {
  // Helper: bootstrap the hook with a grounded chat and a model that accepts documents.
  async function setupGroundedSession(): Promise<
    ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>
  > {
    const groundedChat = chat({
      id: "chat-grounded",
      selectedModel: "chat-doc",
      // connectedScopes is non-empty → hasGroundingScope returns true
      connectedScopes: [{ kind: "files" as const, relativePaths: ["README.md"], connectedAtMs: 1 }],
    });
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "chat-doc", supportsDocumentInput: true })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [groundedChat] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("sets GROUNDED_ATTACHMENT_NOTICE and does not call askGrounded when an attachment is present", async () => {
    const { result } = await setupGroundedSession();

    // Stage a document attachment (text/plain → "document" kind, no FileReader needed).
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await act(async () => {
      const outcome = await result.current.addPendingAttachment(file);
      expect(outcome).toEqual({ ok: true });
    });
    expect(result.current.pendingAttachments).toHaveLength(1);

    // Set a non-empty draft so the content guard passes.
    act(() => {
      result.current.setDraft("Summarise the repo.");
    });

    // sendMessage must block and surface the notice — NOT forward to askGrounded.
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(result.current.error).toBe(GROUNDED_ATTACHMENT_NOTICE);
    expect(askGrounded).not.toHaveBeenCalled();
    // The optimistic user message must NOT have been appended.
    expect(result.current.messages).toHaveLength(0);
  });

  // GEN-PERF-CHAT-008 (keiko-ui side) — a grounded turn must issue EXACTLY ONE messages fetch and
  // EXACTLY ONE chats fetch to reconcile after the ask (no duplicate refetch storm). The deeper fix
  // (server returning the {chat, messages} delta so the client applies it locally with zero
  // refetch) is a cross-package follow-up in keiko-server/keiko-contracts; this pins the client
  // never regresses to more than one of each per grounded turn.
  it("issues exactly one messages fetch and one chats fetch per grounded turn", async () => {
    const { result } = await setupGroundedSession();

    // Reset the boot-time fetch counts so we measure only the grounded turn's traffic.
    vi.mocked(fetchChatMessages).mockClear();
    vi.mocked(fetchChats).mockClear();
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [message({ id: "u1", role: "user" }), message({ id: "a1", role: "assistant" })],
    });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [chat({ id: "chat-grounded", updatedAt: 99 })],
    });
    // askGrounded resolves with a grounded answer (shape is not inspected before the reconcile).
    vi.mocked(askGrounded).mockResolvedValue({
      answer: "grounded reply",
      citations: [],
    } as unknown as Awaited<ReturnType<typeof askGrounded>>);

    act(() => {
      result.current.setDraft("Summarise the repo.");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(askGrounded).toHaveBeenCalledTimes(1);
    // Exactly one of each reconcile fetch — no duplicate messages/chats refetch.
    expect(fetchChatMessages).toHaveBeenCalledTimes(1);
    expect(fetchChats).toHaveBeenCalledTimes(1);
  });
});

describe("useChatSession sendMessage — ungrounded attachment descriptors", () => {
  async function setupUngroundedAttachmentSession(): Promise<
    ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>
  > {
    vi.mocked(fetchModels).mockResolvedValue({
      models: [
        model({
          id: "chat-attachments",
          streaming: false,
          supportsImageInput: true,
          supportsDocumentInput: true,
        }),
      ],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [chat({ selectedModel: "chat-attachments" })],
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat({ selectedModel: "chat-attachments" }),
      messages: [],
      memory: undefined,
    } as never);

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("sends image and document attachment descriptors on the ungrounded path", async () => {
    const { result } = await setupUngroundedAttachmentSession();

    await act(async () => {
      expect(
        await result.current.addPendingAttachment(
          new File(["image"], "screen.png", { type: "image/png" }),
        ),
      ).toEqual({ ok: true });
      expect(
        await result.current.addPendingAttachment(
          new File(["hello"], "notes.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });
    act(() => {
      result.current.setDraft("Use the attached context.");
    });

    await act(async () => {
      await result.current.sendMessage();
    });

    expect(sendDesktopChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      attachments: [
        {
          kind: "image",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
        {
          kind: "document",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
      ],
      documentContext: [
        {
          displayName: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          text: "hello",
        },
      ],
    });
    expect(result.current.pendingAttachments).toHaveLength(0);
  });
});

describe("useChatSession appendVoiceTurn", () => {
  async function setupVoiceTurnSession(): Promise<
    ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>
  > {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-a" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat({ selectedModel: "chat-a" })] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("retries one transient voice-turn append failure before surfacing an error", async () => {
    const updated = chat({ updatedAt: 20, title: "spoken turn" });
    const user = message({ id: "voice-user", role: "user", content: "Remember the release gate." });
    const assistant = message({
      id: "voice-assistant",
      role: "assistant",
      content: "I will remember it.",
    });
    vi.mocked(appendDesktopChatVoiceTurn)
      .mockRejectedValueOnce(new ApiError("INTERNAL", "temporary", 500))
      .mockResolvedValueOnce({
        chat: updated,
        messages: [user, assistant],
      });
    const { result } = await setupVoiceTurnSession();

    await act(async () => {
      await result.current.appendVoiceTurn?.([
        { role: "user", content: "Remember the release gate." },
        { role: "assistant", content: "I will remember it." },
      ]);
    });

    expect(appendDesktopChatVoiceTurn).toHaveBeenCalledTimes(2);
    const firstInput = vi.mocked(appendDesktopChatVoiceTurn).mock.calls[0]?.[0];
    const secondInput = vi.mocked(appendDesktopChatVoiceTurn).mock.calls[1]?.[0];
    expect(firstInput?.idempotencyKey).toBeDefined();
    expect(secondInput?.idempotencyKey).toBe(firstInput?.idempotencyKey);
    expect(secondInput?.messages.map((entry) => entry.timestamp)).toEqual(
      firstInput?.messages.map((entry) => entry.timestamp),
    );
    expect(result.current.error).toBeUndefined();
    expect(result.current.messages.map((entry) => [entry.role, entry.content])).toEqual([
      ["user", "Remember the release gate."],
      ["assistant", "I will remember it."],
    ]);
  });
});

describe("useChatSession sendMessage — explicit text option (Issue #1561)", () => {
  // The voice dialogue session hands a committed spoken transcript to sendMessage via `options.text`.
  // It must send that text through the same context-bearing path as a typed draft, and must not depend
  // on the async draft state (which a setDraft+sendMessage pair in one tick would read stale).
  async function setupUngroundedSession(): Promise<
    ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>
  > {
    vi.mocked(fetchModels).mockResolvedValue({
      // Non-streaming → buffered sendDesktopChat path (deterministic to assert).
      models: [model({ id: "chat-a", streaming: false })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat({ selectedModel: "chat-a" })] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockResolvedValue({
      chat: chat({ selectedModel: "chat-a" }),
      messages: [],
      memory: undefined,
    } as never);

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("sends the explicit text even when the composer draft is empty", async () => {
    const { result } = await setupUngroundedSession();
    expect(result.current.draft).toBe("");

    await act(async () => {
      await result.current.sendMessage({ text: "what changed in the build?" });
    });

    expect(sendDesktopChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]?.content).toBe(
      "what changed in the build?",
    );
  });

  it("maps real provider context overflow errors to the actionable context message", async () => {
    vi.mocked(sendDesktopChat).mockRejectedValueOnce(
      new ApiError("GATEWAY_CONTEXT_OVERFLOW", "provider reported context length exceeded", 413),
    );
    const { result } = await setupUngroundedSession();

    await act(async () => {
      await result.current.sendMessage({ text: "summarise the retained conversation" });
    });

    expect(result.current.error).toBe(CONTEXT_OVERSIZED_USER_MESSAGE);
  });

  it("prefers the explicit text over the current draft and clears the draft afterward", async () => {
    const { result } = await setupUngroundedSession();
    act(() => {
      result.current.setDraft("stale draft");
    });

    await act(async () => {
      await result.current.sendMessage({ text: "spoken question wins" });
    });

    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]?.content).toBe("spoken question wins");
    expect(result.current.draft).toBe("");
  });

  it("ignores a whitespace-only explicit text (committed-only invariant)", async () => {
    const { result } = await setupUngroundedSession();

    await act(async () => {
      await result.current.sendMessage({ text: "   " });
    });

    expect(sendDesktopChat).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(0);
  });

  it("is idempotent for the explicit-text path — a same-tick double send fires once", async () => {
    // The in-flight guard reads sendStatusRef synchronously before the content source, so a barge of
    // two explicit-text sends in one tick (which the voice loop must never double-submit) collapses to
    // a single request, exactly like the draft path's Issue #152 guard.
    const { result } = await setupUngroundedSession();

    await act(async () => {
      const first = result.current.sendMessage({ text: "first" });
      const second = result.current.sendMessage({ text: "second" });
      await Promise.all([first, second]);
    });

    expect(sendDesktopChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]?.content).toBe("first");
  });
});
