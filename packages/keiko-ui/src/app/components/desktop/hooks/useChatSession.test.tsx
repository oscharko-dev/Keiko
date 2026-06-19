import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, ModelCapability, ProjectWithAvailability } from "@/lib/types";
import {
  askGrounded,
  createDesktopChat,
  fetchChatMessages,
  fetchChats,
  fetchModels,
  fetchProjects,
} from "@/lib/api";
import {
  GROUNDED_ATTACHMENT_NOTICE,
  MAX_ATTACHMENT_BYTES,
  isBudgetExceeded,
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
  askGrounded: vi.fn(),
  createDesktopChat: vi.fn(),
  createProject: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchChats: vi.fn(),
  fetchModels: vi.fn(),
  fetchProjects: vi.fn(),
  sendDesktopChat: vi.fn(),
  sendDesktopChatStream: vi.fn(),
  startChatRun: vi.fn(),
  startGroundedWorkflowHandoff: vi.fn(),
  updateChat: vi.fn(),
}));

vi.mock("@/lib/memory-api", () => ({
  acceptMemoryProposal: vi.fn(),
  forgetMemory: vi.fn(),
  rejectMemoryProposal: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
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

describe("useChatSession pure guards", () => {
  it("resolves request state, model eligibility, and budget pressure deterministically", () => {
    const eligible = model({ id: "chat-live" });
    const ineligible = model({ id: "embed", kind: "embedding" });

    expect(isInFlight("queued")).toBe(true);
    expect(isInFlight("completed")).toBe(false);
    expect(pickChatModelId([ineligible, eligible])).toBe("chat-live");
    expect(resolveSelectedModelId("missing", [ineligible, eligible])).toBe("chat-live");
    expect(resolveSelectedModelId("chat-live", [eligible])).toBe("chat-live");
    expect(
      isBudgetExceeded({
        approximateBytes: 640,
        approximateTokens: 160,
        contextWindowTokens: 100,
        reservedOutputTokens: 40,
        availableInputTokens: 60,
        pressure: "exceeded",
        breakdown: {
          draftBytes: 120,
          historyBytes: 0,
          documentBytes: 0,
          repoContextBytes: 0,
          knowledgeBytes: 0,
          memoryBytes: 0,
        },
      }),
    ).toBe(true);
    expect(isBudgetExceeded(undefined)).toBe(false);
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

describe("useChatSession pending attachment validation", () => {
  async function setupAttachmentSession(
    models: readonly ModelCapability[] = [model({ id: "chat-a" })],
  ): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>> {
    vi.mocked(fetchModels).mockResolvedValue({ models });
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
});
