import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_DESKTOP_CHAT_INPUT_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { Chat, ChatMessage, ModelCapability, ProjectWithAvailability } from "@/lib/types";
import {
  ApiError,
  askGrounded,
  createDesktopChat,
  createProject,
  deleteConversationAttachment,
  fetchChatMessages,
  fetchChats,
  fetchRunReport,
  fetchModels,
  fetchProjects,
  patchChatMessage,
  regenerateDesktopChat,
  resetModelRequestCache,
  sendDesktopChat,
  uploadConversationAttachment,
} from "@/lib/api";
import {
  CONTEXT_OVERSIZED_USER_MESSAGE,
  GROUNDED_ATTACHMENT_NOTICE,
  MAX_ATTACHMENT_BYTES,
  canonicalVoicePageOutboxRetainsPlaintextForTests,
  clearCanonicalVoicePageOutboxForTests,
  clearChatSessionBootstrapCacheForTests,
  canonicalTurnReferenceForClient,
  isInFlight,
  notifyChatDeleted,
  notifyChatUpsert,
  pickChatModelId,
  RUN_SUMMARY_SYNC_INTERVAL_MS,
  resolveSelectedModelId,
  type SendMessageOutcome,
  type ChatSessionApi,
  useChatSession,
} from "./useChatSession";
import {
  resetConversationMemorySettingsForTests,
  useConversationMemorySettings,
} from "./memorySettings";
import { loadMemoryAutonomyMode } from "@/lib/memory-api";
import {
  clearCanonicalVoiceHasherForTests,
  prepareCanonicalVoiceHasher,
} from "./canonical-voice-hasher";
import {
  notifyGatewayConfigUpdated,
  requestGatewayModelCatalogRefresh,
  notifyGatewayModelReadinessUpdated,
} from "../widgets/shared/gatewaySetupBus";

beforeAll(async () => {
  await prepareCanonicalVoiceHasher();
});

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
  createDesktopChat: vi.fn(),
  createProject: vi.fn(),
  projectResponseWarningMessage: (response: {
    readonly warning?: { readonly message: string; readonly correlationId: string };
  }): string | undefined =>
    response.warning === undefined
      ? undefined
      : `${response.warning.message} Support ID: ${response.warning.correlationId}`,
  fetchChatMessages: vi.fn(),
  fetchChats: vi.fn(),
  fetchEvidenceManifest: vi.fn(),
  fetchRunReport: vi.fn(),
  fetchModels: vi.fn(),
  fetchProjects: vi.fn(),
  patchChatMessage: vi.fn(),
  regenerateDesktopChat: vi.fn(),
  resetModelRequestCache: vi.fn(),
  sendDesktopChat: vi.fn(),
  sendDesktopChatStream: vi.fn(),
  uploadConversationAttachment: vi.fn().mockResolvedValue({
    attachmentRef: `chat-attachment:${"a".repeat(64)}`,
    expiresAt: 60_000,
  }),
  deleteConversationAttachment: vi.fn().mockResolvedValue(undefined),
  updateChat: vi.fn(),
}));

vi.mock("@/lib/memory-api", () => ({
  acceptMemoryProposal: vi.fn(),
  forgetMemory: vi.fn(),
  rejectMemoryProposal: vi.fn(),
  loadMemoryAutonomyMode: vi.fn().mockResolvedValue({
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
    deploymentCeiling: "governed-assist",
    revision: 0,
  }),
}));

afterEach(() => {
  clearCanonicalVoicePageOutboxForTests();
  vi.clearAllMocks();
  clearChatSessionBootstrapCacheForTests();
  resetConversationMemorySettingsForTests();
});

function model(patch: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id: "chat-a",
    kind: "chat",
    conversationReady: true,
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
    groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    ...patch,
  } as Chat;
}

function canonicalVoiceTurn(
  text: string,
  clientTurnId: string,
  targetChat: Chat = chat(),
  modelId: string = targetChat.selectedModel,
): {
  readonly text: string;
  readonly clientTurnId: string;
  readonly target: { readonly chat: Chat; readonly modelId: string };
  readonly allowReservedCapacity?: true;
} {
  return { text, clientTurnId, target: { chat: targetChat, modelId } };
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

async function canonicalMessage(
  clientTurnId: string,
  patch: Partial<ChatMessage> = {},
): Promise<ChatMessage> {
  const durable = message(patch);
  return {
    ...durable,
    canonicalTurnRef: await canonicalTurnReferenceForClient(durable.chatId, clientTurnId),
  };
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
    const unready = { ...model({ id: "chat-unready" }), conversationReady: false };
    const eligible = model({ id: "chat-live" });
    const ineligible = model({ id: "embed", kind: "embedding" });

    expect(isInFlight("queued")).toBe(true);
    expect(isInFlight("completed")).toBe(false);
    expect(pickChatModelId([unready, ineligible, eligible])).toBe("chat-live");
    expect(resolveSelectedModelId("chat-unready", [unready, ineligible, eligible])).toBe(
      "chat-live",
    );
    expect(resolveSelectedModelId("chat-live", [eligible])).toBe("chat-live");
  });
});

function ImmediateChatBinding({
  session,
  target,
}: {
  readonly session: ChatSessionApi;
  readonly target: Chat;
}): ReactNode {
  const { activeChat, loading, openChat } = session;
  useEffect((): void => {
    if (!loading && activeChat?.id !== target.id) void openChat(target);
  }, [activeChat?.id, loading, openChat, target]);
  return <output data-testid="immediate-chat-binding">{activeChat?.id ?? "none"}</output>;
}

function ImmediateChatBindingHarness({ target }: { readonly target: Chat }): ReactNode {
  const session = useChatSession({ autoCreate: false });
  return <ImmediateChatBinding session={session} target={target} />;
}

describe("useChatSession bootstrap", () => {
  it("keeps configured catalog presence distinct from conversation-ready selection", async () => {
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "chat-unready", conversationReady: false })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configuredModelsAvailable).toBe(true);
    expect(result.current.models).toEqual([]);
    expect(result.current.selectedModel).toBeUndefined();
    expect(result.current.noEligibleModels).toBe(true);
  });

  it("honors a child window binding immediately after bootstrap", async () => {
    const bootstrapChat = chat({ id: "chat-bootstrap", updatedAt: 20 });
    const boundChat = chat({ id: "chat-bound", updatedAt: 10 });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [bootstrapChat, boundChat] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });

    render(<ImmediateChatBindingHarness target={boundChat} />);

    await waitFor(() =>
      expect(screen.getByTestId("immediate-chat-binding")).toHaveTextContent(boundChat.id),
    );
    expect(fetchChatMessages).toHaveBeenCalledWith(boundChat.id, boundChat.projectPath);
  });

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

  it("surfaces a project catalog bootstrap failure instead of treating it as empty", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockRejectedValue(new TypeError("project catalog unavailable"));

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("project catalog unavailable");
    expect(fetchChats).not.toHaveBeenCalled();
  });

  it("surfaces a chat catalog bootstrap failure instead of treating it as empty", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockRejectedValue(new TypeError("chat catalog unavailable"));

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("chat catalog unavailable");
    expect(result.current.activeProject).toBeUndefined();
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

  it("returns a persisted chat without replacing a project selected during creation", async (): Promise<void> => {
    const created = chat({
      id: "chat-created-in-background",
      projectPath: "/repo",
      title: "Background creation",
    });
    const otherChat = chat({ id: "chat-other", projectPath: "/other", title: "Other chat" });
    const creation = deferred<Awaited<ReturnType<typeof createDesktopChat>>>();
    const upsertListener = vi.fn();
    window.addEventListener("keiko:chat-upsert", upsertListener);
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({
      projects: [project("/repo"), project("/other")],
    });
    vi.mocked(fetchChats)
      .mockResolvedValueOnce({ chats: [chat()] })
      .mockResolvedValueOnce({ chats: [otherChat] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(createDesktopChat).mockReturnValueOnce(creation.promise);

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor((): void => expect(result.current.loading).toBe(false));

    let creationPromise: Promise<Chat | undefined>;
    act((): void => {
      creationPromise = result.current.openNewChat(project("/repo"), created.title);
    });
    await act(async (): Promise<void> => {
      await result.current.openProject(project("/other"));
    });
    await act(async (): Promise<void> => {
      creation.resolve({
        chat: created,
        project: project("/repo"),
        projects: [project("/repo"), project("/other")],
        chats: [created],
        messages: [],
      });
    });

    await expect(creationPromise!).resolves.toEqual(created);
    expect(result.current.activeProject?.path).toBe("/other");
    expect(result.current.activeChat?.id).toBe(otherChat.id);
    expect(upsertListener).toHaveBeenCalledOnce();
    expect((upsertListener.mock.calls[0]?.[0] as CustomEvent<Chat>).detail).toEqual(created);
    window.removeEventListener("keiko:chat-upsert", upsertListener);
  });

  it("selects a newly added folder even when no conversation model can create a chat", async () => {
    const initial = project("/repo");
    const selectedRoot = "/Users/oscharko-dev/Projects/Keiko";
    const added = project(selectedRoot);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchProjects)
      .mockResolvedValueOnce({ projects: [initial] })
      .mockResolvedValueOnce({ projects: [initial, added] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    vi.mocked(createProject).mockResolvedValue({
      project: added,
      warning: {
        code: "PROJECT_TRUST_GRANT_FAILED",
        message: "The project was registered but remains restricted.",
        correlationId: "chat-project-trust-correlation",
      },
    });
    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    let selected: unknown;
    await act(async () => {
      selected = await rendered.result.current.addProject(selectedRoot);
    });

    expect(selected).toEqual(added);
    expect(rendered.result.current.activeProject?.path).toBe(selectedRoot);
    expect(rendered.result.current.error).toContain("No conversation-eligible model");
    expect(rendered.result.current.error).not.toContain("chat-project-trust-correlation");
    expect(rendered.result.current.notice).toContain("chat-project-trust-correlation");
    expect(createDesktopChat).not.toHaveBeenCalled();

    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    await act(() => rendered.result.current.openChat(chat({ id: "other-chat" })));

    expect(rendered.result.current.notice).toBeUndefined();
  });

  it("surfaces bootstrap and navigation mutation failures without stale state", async () => {
    vi.mocked(fetchModels).mockRejectedValueOnce(new TypeError("bootstrap unavailable"));
    const failedBootstrap = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(failedBootstrap.result.current.loading).toBe(false));
    expect(failedBootstrap.result.current.error).toContain("bootstrap unavailable");
    failedBootstrap.unmount();
    clearChatSessionBootstrapCacheForTests();

    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    vi.mocked(createDesktopChat).mockRejectedValueOnce(new TypeError("create unavailable"));
    await act(async () => {
      await expect(rendered.result.current.openNewChat()).resolves.toBeUndefined();
    });
    expect(rendered.result.current.error).toContain("create unavailable");

    vi.mocked(fetchChats).mockRejectedValueOnce(new TypeError("project unavailable"));
    await act(async () => {
      await rendered.result.current.openProject(project("/other"));
    });
    expect(rendered.result.current.error).toContain("project unavailable");

    vi.mocked(fetchChatMessages).mockRejectedValueOnce(new TypeError("chat unavailable"));
    await act(async () => {
      await rendered.result.current.openChat(chat({ id: "chat-other", projectPath: "/other" }));
    });
    expect(rendered.result.current.error).toContain("chat unavailable");

    vi.mocked(createProject).mockRejectedValueOnce(new TypeError("add unavailable"));
    await act(async () => {
      await rendered.result.current.addProject("/added");
    });
    expect(rendered.result.current.error).toContain("add unavailable");
  });

  it("parks run-summary polling after a non-retryable report failure", async () => {
    const pendingSummary = message({
      id: "run-summary",
      role: "system",
      runId: "run-1",
      workflowStatus: "running",
    });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat()] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [pendingSummary] });
    vi.mocked(fetchRunReport).mockRejectedValue(new TypeError("report unavailable"));

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(fetchRunReport).toHaveBeenCalledWith("run-1"));
    expect(rendered.result.current.messages).toEqual([pendingSummary]);
  });

  it("keeps a shared run-summary poll alive while another session remains subscribed", async () => {
    const pendingSummary = message({
      id: "shared-run-summary",
      role: "system",
      runId: "run-shared",
      workflowStatus: "running",
    });
    const completedSummary = { ...pendingSummary, workflowStatus: "completed" as const };
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat()] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [pendingSummary] });
    vi.mocked(fetchRunReport)
      .mockResolvedValueOnce({ report: { status: "running" } })
      .mockResolvedValueOnce({ report: { status: "completed" } });
    vi.mocked(patchChatMessage).mockResolvedValue({ message: completedSummary });

    const first = renderHook(() => useChatSession({ autoCreate: false }));
    const second = renderHook(() => useChatSession({ autoCreate: false }));
    await vi.waitFor(() => expect(fetchRunReport).toHaveBeenCalledOnce());

    first.unmount();
    await vi.waitFor(() => expect(fetchRunReport).toHaveBeenCalledTimes(2), {
      timeout: RUN_SUMMARY_SYNC_INTERVAL_MS + 1_000,
    });
    await vi.waitFor(() => expect(second.result.current.messages).toEqual([completedSummary]));
    expect(patchChatMessage).toHaveBeenCalledOnce();
  });

  it("surfaces regeneration failures and releases the owned send state", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat()] });
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [message({ id: "assistant-1", role: "assistant" })],
    });
    vi.mocked(regenerateDesktopChat).mockRejectedValue(new TypeError("regeneration unavailable"));
    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    await act(async () => {
      await rendered.result.current.regenerateMessage("assistant-1");
    });

    expect(rendered.result.current.error).toContain("regeneration unavailable");
    expect(rendered.result.current.sendStatus).toBe("failed");
    expect(rendered.result.current.regeneratingMessageId).toBeUndefined();
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

    const memory = renderHook(() => useConversationMemorySettings("chat-new"));
    act(() => memory.result.current.setMemoryEnabled(true));

    notifyChatDeleted("chat-new");
    await waitFor(() =>
      expect(result.current.chats.some((item) => item.id === "chat-new")).toBe(false),
    );
    expect(memory.result.current.memoryEnabled).toBe(false);
  });

  it("keeps chat mutation broadcasts inside their owning project catalog", async () => {
    const projectBChat = chat({ id: "chat-b", projectPath: "/repo-b", updatedAt: 20 });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo-b")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [projectBChat] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      notifyChatUpsert(chat({ id: "chat-a", projectPath: "/repo-a", updatedAt: 40 }));
    });

    expect(result.current.chats.map((candidate) => candidate.id)).toEqual(["chat-b"]);
    expect(result.current.activeProject?.path).toBe("/repo-b");
  });

  it("drops the API model cache before refreshing after a gateway update", async () => {
    vi.mocked(fetchModels)
      .mockResolvedValueOnce({ models: [model({ id: "chat-before" })] })
      .mockResolvedValueOnce({ models: [model({ id: "chat-after" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() =>
      expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-before"]),
    );

    act(() => {
      notifyGatewayConfigUpdated();
    });

    await waitFor(() => expect(resetModelRequestCache).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-after"]),
    );
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it("refreshes conversation-ready models after a same-page readiness result", async () => {
    vi.mocked(fetchModels)
      .mockResolvedValueOnce({
        models: [model({ id: "chat-live", conversationReady: false })],
      })
      .mockResolvedValueOnce({ models: [model({ id: "chat-live", conversationReady: true })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configuredModelsAvailable).toBe(true);
    expect(result.current.models).toEqual([]);

    act(() => {
      notifyGatewayModelReadinessUpdated();
    });

    await waitFor(() =>
      expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-live"]),
    );
    expect(result.current.configuredModelsAvailable).toBe(true);
    expect(resetModelRequestCache).toHaveBeenCalledOnce();
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["configuration replacement", notifyGatewayConfigUpdated],
    ["readiness update", notifyGatewayModelReadinessUpdated],
    ["picker refresh", requestGatewayModelCatalogRefresh],
  ])(
    "invalidates selectable models synchronously during a %s and only restores them after a later current success",
    async (_label, refreshCatalog) => {
      const pending = deferred<{ models: ModelCapability[] }>();
      vi.mocked(fetchModels)
        .mockResolvedValueOnce({ models: [model({ id: "chat-before" })] })
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce({ models: [model({ id: "chat-recovered" })] });
      vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
      vi.mocked(fetchChats).mockResolvedValue({ chats: [] });

      const { result } = renderHook(() => useChatSession({ autoCreate: false }));
      await waitFor(() =>
        expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-before"]),
      );
      expect(result.current.selectedModel).toBe("chat-before");

      act(() => {
        refreshCatalog();
      });

      expect(result.current.models).toEqual([]);
      expect(result.current.selectedModel).toBeUndefined();

      await act(async () => {
        pending.reject(new Error("gateway unavailable"));
        try {
          await pending.promise;
        } catch {
          // The refresh path intentionally reports the failure through hook state.
        }
      });
      await waitFor(() => expect(result.current.error).toBe("gateway unavailable"));
      expect(result.current.models).toEqual([]);
      expect(result.current.selectedModel).toBeUndefined();

      act(() => {
        refreshCatalog();
      });
      await waitFor(() =>
        expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-recovered"]),
      );
      expect(result.current.selectedModel).toBe("chat-recovered");
    },
  );

  it("refreshes the eligible model catalog without emitting a configuration replacement", async () => {
    vi.mocked(fetchModels)
      .mockResolvedValueOnce({ models: [model({ id: "chat-before" })] })
      .mockResolvedValueOnce({ models: [model({ id: "chat-after" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    const onConfigUpdated = vi.fn();
    window.addEventListener("keiko:gateway-config-updated", onConfigUpdated);
    try {
      const { result } = renderHook(() => useChatSession({ autoCreate: false }));
      await waitFor(() =>
        expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-before"]),
      );

      act(() => {
        requestGatewayModelCatalogRefresh();
      });

      await waitFor(() =>
        expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-after"]),
      );
      expect(resetModelRequestCache).toHaveBeenCalledOnce();
      expect(fetchModels).toHaveBeenCalledTimes(2);
      expect(onConfigUpdated).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keiko:gateway-config-updated", onConfigUpdated);
    }
  });

  it("shares one gateway model refresh across concurrent chat sessions", async () => {
    vi.mocked(fetchModels)
      .mockResolvedValueOnce({ models: [model({ id: "chat-before" })] })
      .mockResolvedValueOnce({ models: [model({ id: "chat-after" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });

    const first = renderHook(() => useChatSession({ autoCreate: false }));
    const second = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => {
      expect(first.result.current.models.map((entry) => entry.id)).toEqual(["chat-before"]);
      expect(second.result.current.models.map((entry) => entry.id)).toEqual(["chat-before"]);
    });

    act(() => {
      notifyGatewayConfigUpdated();
    });

    await waitFor(() => {
      expect(first.result.current.models.map((entry) => entry.id)).toEqual(["chat-after"]);
      expect(second.result.current.models.map((entry) => entry.id)).toEqual(["chat-after"]);
    });
    expect(resetModelRequestCache).toHaveBeenCalledOnce();
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it("ignores an older gateway model refresh that resolves after the latest one", async () => {
    vi.mocked(fetchModels).mockResolvedValueOnce({ models: [model({ id: "chat-before" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    const older = deferred<{ models: ModelCapability[] }>();
    const latest = deferred<{ models: ModelCapability[] }>();

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() =>
      expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-before"]),
    );
    vi.mocked(fetchModels)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => latest.promise);

    act(() => {
      notifyGatewayConfigUpdated();
      notifyGatewayConfigUpdated();
    });
    await act(async () => {
      latest.resolve({ models: [model({ id: "chat-latest" })] });
      await latest.promise;
    });
    expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-latest"]);

    await act(async () => {
      older.resolve({ models: [model({ id: "chat-stale" })] });
      await older.promise;
    });
    expect(result.current.models.map((entry) => entry.id)).toEqual(["chat-latest"]);
  });

  // 0.3.0 release audit — the chat list carries trashed (status "closed") conversations so the
  // Chat History "Deleted" tab can offer Restore, but the resume path took `sorted[0]` with no
  // status filter. A user who trashed their most recent conversation was dropped back into it:
  // it is hidden from the list, and every send is refused by the server with CHAT_CLOSED.
  it("resumes the newest OPEN conversation and never a trashed one", async () => {
    const trashed = chat({ id: "chat-trashed", selectedModel: "chat-live", updatedAt: 30 });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [
        chat({ id: "chat-open", selectedModel: "chat-live", updatedAt: 20 }),
        { ...trashed, status: "closed" } as Chat,
      ],
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeChat?.id).toBe("chat-open");
    expect(fetchChatMessages).toHaveBeenCalledWith("chat-open", "/repo");
    // The trashed chat stays in the list — the Deleted tab still has something to restore.
    expect(result.current.chats.map((item) => item.id)).toEqual(["chat-trashed", "chat-open"]);
  });

  it("resumes nothing when every conversation is trashed, but keeps the list", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [
        { ...chat({ id: "chat-a", selectedModel: "chat-live", updatedAt: 20 }), status: "closed" },
        { ...chat({ id: "chat-b", selectedModel: "chat-live", updatedAt: 30 }), status: "closed" },
      ] as Chat[],
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeChat).toBeUndefined();
    expect(fetchChatMessages).not.toHaveBeenCalled();
    expect(result.current.chats.map((item) => item.id)).toEqual(["chat-b", "chat-a"]);
  });

  it("opens the newest OPEN conversation when a project is selected", async () => {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [chat({ id: "chat-boot", selectedModel: "chat-live", updatedAt: 5 })],
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    vi.mocked(fetchChats).mockResolvedValue({
      chats: [
        chat({ id: "other-open", projectPath: "/other", selectedModel: "chat-live", updatedAt: 1 }),
        {
          ...chat({
            id: "other-trashed",
            projectPath: "/other",
            selectedModel: "chat-live",
            updatedAt: 99,
          }),
          status: "closed",
        } as Chat,
      ],
    });
    await act(async () => {
      await result.current.openProject(project("/other"));
    });

    expect(result.current.activeChat?.id).toBe("other-open");
    expect(result.current.chats.map((item) => item.id)).toEqual(["other-trashed", "other-open"]);
  });

  it("does not create a replacement chat when an isolated window opens an empty project", async () => {
    const groundedChat = chat({
      id: "chat-boot",
      selectedModel: "chat-live",
      connectedScopes: [
        { kind: "workspace-root", root: "/repo", relativePaths: [], connectedAtMs: 1 },
      ],
    });
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [groundedChat] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(askGrounded).mockResolvedValue({
      answer: "grounded reply",
      citations: [],
    } as unknown as Awaited<ReturnType<typeof askGrounded>>);
    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async (): Promise<void> => {
      await result.current.sendMessage({ text: "Ground this first." });
    });
    expect(result.current.latestGrounded).toBeDefined();
    vi.mocked(fetchChats).mockResolvedValueOnce({ chats: [] });

    await act(async (): Promise<void> => {
      await result.current.openProject(project("/empty"));
    });

    expect(result.current.activeProject?.path).toBe("/empty");
    expect(result.current.activeChat).toBeUndefined();
    expect(result.current.messages).toEqual([]);
    expect(result.current.latestGrounded).toBeUndefined();
    expect(createDesktopChat).not.toHaveBeenCalled();
  });
});

// 0.3.0 release audit — a session's composer draft and staged attachments must stay bound to its
// conversation. ADR-0114 now mounts one session per chat window; switching a session still clears
// its own composer, while sibling windows have independent session instances.
describe("useChatSession conversation switch — composer isolation", () => {
  async function setupTwoChatSession(): Promise<
    ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>
  > {
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "chat-a", supportsImageInput: true, supportsDocumentInput: true })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({
      chats: [
        chat({ id: "chat-1", updatedAt: 20 }),
        chat({ id: "chat-2", title: "Second", updatedAt: 10 }),
      ],
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("drops the draft and the staged attachments when another chat is opened", async () => {
    const { result } = await setupTwoChatSession();
    expect(result.current.activeChat?.id).toBe("chat-1");

    await act(async () => {
      expect(
        await result.current.addPendingAttachment(
          new File(["confidential"], "salaries.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });
    act(() => {
      result.current.setDraft("only meant for chat one");
    });
    expect(result.current.pendingAttachments).toHaveLength(1);

    await act(async () => {
      await result.current.openChat(chat({ id: "chat-2", title: "Second", updatedAt: 10 }));
    });

    expect(result.current.activeChat?.id).toBe("chat-2");
    expect(result.current.draft).toBe("");
    expect(result.current.pendingAttachments).toEqual([]);
  });

  it("keeps the composer when the same chat is re-opened", async () => {
    const { result } = await setupTwoChatSession();
    act(() => {
      result.current.setDraft("still typing");
    });

    await act(async () => {
      await result.current.openChat(chat({ id: "chat-1", updatedAt: 20 }));
    });

    expect(result.current.draft).toBe("still typing");
  });

  it("drops the draft and the staged attachments when the project changes", async () => {
    const { result } = await setupTwoChatSession();
    await act(async () => {
      await result.current.addPendingAttachment(
        new File(["confidential"], "salaries.txt", { type: "text/plain" }),
      );
    });
    act(() => {
      result.current.setDraft("only meant for the first project");
    });

    vi.mocked(fetchChats).mockResolvedValue({
      chats: [chat({ id: "chat-other", projectPath: "/other", updatedAt: 3 })],
    });
    await act(async () => {
      await result.current.openProject(project("/other"));
    });

    expect(result.current.activeChat?.id).toBe("chat-other");
    expect(result.current.draft).toBe("");
    expect(result.current.pendingAttachments).toEqual([]);
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

  it("does not let a late grounded reconciliation restore the previous chat", async () => {
    const chatA = chat({
      id: "chat-a",
      title: "A",
      updatedAt: 30,
      connectedScopes: [{ kind: "files", relativePaths: ["README.md"], connectedAtMs: 1 }],
    });
    const chatB = chat({ id: "chat-b", title: "B", updatedAt: 20 });
    vi.mocked(fetchModels).mockResolvedValue({
      models: [model({ id: "chat-a", streaming: false })],
    });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chatA, chatB] });
    vi.mocked(fetchChatMessages).mockResolvedValueOnce({ messages: [] });
    vi.mocked(askGrounded).mockResolvedValue({
      assistantMessageId: "assistant-a",
      content: "grounded answer",
      citations: [],
    } as unknown as Awaited<ReturnType<typeof askGrounded>>);

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    const messagesA = deferred<{ messages: readonly ChatMessage[] }>();
    const chatsA = deferred<{ chats: readonly Chat[] }>();
    vi.mocked(fetchChatMessages).mockImplementation((chatId: string) =>
      chatId === chatA.id
        ? messagesA.promise
        : Promise.resolve({ messages: [message({ id: "msg-b", chatId: chatB.id })] }),
    );
    vi.mocked(fetchChats).mockReturnValue(chatsA.promise);

    let sendPromise!: Promise<SendMessageOutcome>;
    act(() => {
      sendPromise = rendered.result.current.sendMessage({
        text: "ground question for A",
        reportOutcome: true,
      });
    });
    await waitFor(() => expect(fetchChatMessages).toHaveBeenCalledWith(chatA.id, "/repo"));

    await act(async () => {
      await rendered.result.current.openChat(chatB);
    });
    expect(rendered.result.current.activeChat?.id).toBe(chatB.id);

    await act(async () => {
      messagesA.resolve({
        messages: [
          message({ id: "user-a", chatId: chatA.id, content: "ground question for A" }),
          message({ id: "assistant-a", chatId: chatA.id, role: "assistant" }),
        ],
      });
      chatsA.resolve({ chats: [{ ...chatA, updatedAt: 40 }, chatB] });
      await sendPromise;
    });

    expect(rendered.result.current.activeChat?.id).toBe(chatB.id);
    expect(rendered.result.current.messages.map((entry) => entry.id)).toEqual(["msg-b"]);
  });

  it("does not let a cancelled send overwrite the status of its replacement", async () => {
    const rendered = await setupSwitchSession();
    const first = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    const second = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    const completed = {
      chat: chat({ id: "chat-current", selectedModel: "chat-a", updatedAt: 40 }),
      messages: [
        message({ id: "user-b", chatId: "chat-current", content: "replacement" }),
        message({ id: "assistant-b", chatId: "chat-current", role: "assistant" }),
      ],
    } as Awaited<ReturnType<typeof sendDesktopChat>>;
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(completed);

    let firstSend!: Promise<SendMessageOutcome>;
    act(() => {
      firstSend = rendered.result.current.sendMessage({ text: "cancel me", reportOutcome: true });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));

    act(() => {
      rendered.result.current.cancelSend();
    });
    let replacement!: Promise<SendMessageOutcome>;
    act(() => {
      replacement = rendered.result.current.sendMessage({
        text: "replacement",
        reportOutcome: true,
      });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.reject(new DOMException("cancelled", "AbortError"));
      await firstSend;
    });
    expect(rendered.result.current.sendStatus).toBe("contacting");

    let thirdOutcome!: SendMessageOutcome;
    await act(async () => {
      thirdOutcome = await rendered.result.current.sendMessage({
        text: "must remain blocked",
        reportOutcome: true,
      });
    });
    expect(thirdOutcome).toEqual({ status: "not-sent" });
    expect(sendDesktopChat).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(completed);
      await replacement;
    });
  });

  it("does not let an old cancellation reconciliation delete a completed replacement", async () => {
    const rendered = await setupSwitchSession();
    const firstResponse = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    const staleReconciliation = deferred<{ messages: readonly ChatMessage[] }>();
    const replacementResponse = {
      chat: chat({ id: "chat-current", selectedModel: "chat-a", updatedAt: 50 }),
      messages: [
        message({ id: "canonical-user-b", chatId: "chat-current", content: "replacement" }),
        message({
          id: "canonical-assistant-b",
          chatId: "chat-current",
          role: "assistant",
          content: "replacement answer",
        }),
      ],
    } as Awaited<ReturnType<typeof sendDesktopChat>>;
    vi.mocked(fetchChatMessages).mockReturnValue(staleReconciliation.promise);
    vi.mocked(sendDesktopChat)
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce(replacementResponse);

    let firstSend!: Promise<SendMessageOutcome>;
    act(() => {
      firstSend = rendered.result.current.sendMessage({ text: "cancel me", reportOutcome: true });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));
    act(() => {
      rendered.result.current.cancelSend();
    });
    firstResponse.resolve(replacementResponse);
    await waitFor(() => expect(fetchChatMessages).toHaveBeenCalledTimes(2));

    await act(async () => {
      await rendered.result.current.sendMessage({ text: "replacement", reportOutcome: true });
    });
    expect(rendered.result.current.messages.map((entry) => entry.id)).toContain(
      "canonical-assistant-b",
    );

    await act(async () => {
      staleReconciliation.resolve({
        messages: [
          message({ id: "canonical-user-a", chatId: "chat-current", content: "cancel me" }),
        ],
      });
      await firstSend;
    });

    expect(rendered.result.current.messages.map((entry) => entry.id).slice(-2)).toEqual([
      "canonical-user-b",
      "canonical-assistant-b",
    ]);
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
  async function setupGroundedSession(
    initialMessages: readonly ChatMessage[] = [],
  ): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>> {
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
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: initialMessages });

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

    // Privacy default is off. This explicit action models the user's Brain-icon activation and
    // proves that the enabled retrieval request still receives the standard 1,200-token budget.
    act(() => {
      result.current.setMemoryEnabled(true);
    });

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
    expect(vi.mocked(askGrounded).mock.calls[0]?.[0]).toMatchObject({
      chatId: "chat-grounded",
      content: "Summarise the repo.",
      memory: {
        enabled: true,
        budgetTokens: 1200,
        mode: "governed-assist",
        context: {
          userId: "local-operator",
          conversationId: "chat-grounded",
          projectId: "/repo",
          workspaceId: "/repo",
        },
      },
    });
    // Exactly one of each reconcile fetch — no duplicate messages/chats refetch.
    expect(fetchChatMessages).toHaveBeenCalledTimes(1);
    expect(fetchChats).toHaveBeenCalledTimes(1);
  });

  it("reports the exact grounded assistant id for a canonical voice turn", async () => {
    const { result } = await setupGroundedSession();
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [
        message({ id: "grounded-user", chatId: "chat-grounded", role: "user" }),
        message({ id: "grounded-assistant", chatId: "chat-grounded", role: "assistant" }),
      ],
    });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat({ id: "chat-grounded" })] });
    vi.mocked(askGrounded).mockResolvedValue({
      assistantMessageId: "grounded-assistant",
      content: "Grounded answer",
      citations: [],
    } as unknown as Awaited<ReturnType<typeof askGrounded>>);
    let outcome: SendMessageOutcome | undefined;

    await act(async () => {
      outcome = await result.current.sendMessage({
        text: "ground this voice turn",
        clientTurnId: "grounded-voice-1",
        reportOutcome: true,
      });
    });

    expect(outcome).toEqual({
      status: "completed",
      assistantMessageId: "grounded-assistant",
    });
    expect(askGrounded).toHaveBeenCalledWith(
      expect.objectContaining({
        clientTurnId: "grounded-voice-1",
        expectedGroundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
      }),
      expect.any(AbortSignal),
    );
  });

  // #2843 — the grounded route has no attachment channel, so a grounded chat drops staged attachments
  // for typed AND spoken turns. A typed send is rejected before admission; a settled final transcript
  // must never be discarded (ADR-0154 D1), so the spoken turn proceeds and the SAME notice states that
  // the staged attachments were not part of it. Before this pin the spoken turn was silent: the user
  // saw an answer with no indication their attachment had been ignored.
  it("surfaces the grounded attachment notice for a spoken turn instead of dropping it silently", async (): Promise<void> => {
    const { result } = await setupGroundedSession();
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [
        message({ id: "grounded-user", chatId: "chat-grounded", role: "user" }),
        message({ id: "grounded-assistant", chatId: "chat-grounded", role: "assistant" }),
      ],
    });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [chat({ id: "chat-grounded" })] });
    vi.mocked(askGrounded).mockResolvedValue({
      assistantMessageId: "grounded-assistant",
      content: "Grounded answer",
      citations: [],
    } as unknown as Awaited<ReturnType<typeof askGrounded>>);
    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["hello"], "notes.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });

    let outcome: SendMessageOutcome | undefined;
    await act(async (): Promise<void> => {
      outcome = await result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(
          "summarise the connected repository",
          "grounded-voice-attachment",
          chat({
            id: "chat-grounded",
            selectedModel: "chat-doc",
            connectedScopes: [
              { kind: "files" as const, relativePaths: ["README.md"], connectedAtMs: 1 },
            ],
          }),
          "chat-doc",
        ),
      );
    });

    expect(outcome).toEqual({ status: "completed", assistantMessageId: "grounded-assistant" });
    expect(askGrounded).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe(GROUNDED_ATTACHMENT_NOTICE);
    // Nothing was consumed, so the file stays staged and the user can remove it or move it to a
    // non-grounded chat rather than silently losing it.
    expect(result.current.pendingAttachments).toHaveLength(1);
    expect(result.current.lastSentDocuments).toEqual([]);
  });

  it("does not mistake a stale identical server message for this failed admission", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const { result } = await setupGroundedSession();
      vi.mocked(askGrounded).mockRejectedValueOnce(new Error("transport failed"));
      vi.mocked(fetchChatMessages).mockResolvedValueOnce({
        messages: [
          message({
            id: "stale-same-content",
            chatId: "chat-grounded",
            content: "repeatable question",
            timestamp: 9_999,
          }),
        ],
      });
      let outcome: SendMessageOutcome | undefined;

      await act(async () => {
        outcome = await result.current.sendMessage({
          text: "repeatable question",
          reportOutcome: true,
        });
      });

      expect(outcome).toEqual({ status: "failed" });
    } finally {
      now.mockRestore();
    }
  });

  it("removes only the exact failed canonical row while preserving identical older turns", async (): Promise<void> => {
    const { result } = await setupGroundedSession();
    const earlier = await canonicalMessage("earlier-identical-turn", {
      id: "earlier-identical-user",
      chatId: "chat-grounded",
      content: "same question",
      timestamp: 10_000,
    });
    let failedTurnId: string | undefined;
    vi.mocked(askGrounded).mockImplementation(async (request): Promise<never> => {
      failedTurnId = request.clientTurnId;
      throw new Error("generation failed");
    });
    vi.mocked(fetchChatMessages).mockImplementation(
      async (): Promise<{ readonly messages: readonly ChatMessage[] }> => {
        if (failedTurnId === undefined) throw new Error("missing failed turn identity");
        return {
          messages: [
            earlier,
            await canonicalMessage(failedTurnId, {
              id: "failed-current-user",
              chatId: "chat-grounded",
              content: "same question",
              timestamp: 20_000,
            }),
          ],
        };
      },
    );

    let outcome: SendMessageOutcome | undefined;
    await act(async (): Promise<void> => {
      outcome = await result.current.sendMessage({
        text: "same question",
        reportOutcome: true,
      });
    });

    expect(outcome).toEqual({ status: "in-progress" });
    expect(result.current.messages).toEqual([earlier]);
  });

  it("recovers a fully committed canonical pair without splitting identical turns", async (): Promise<void> => {
    const { result } = await setupGroundedSession();
    const earlierUser = await canonicalMessage("earlier-completed-turn", {
      id: "earlier-completed-user",
      chatId: "chat-grounded",
      content: "same question",
      timestamp: 10_000,
    });
    const earlierAssistant = await canonicalMessage("earlier-completed-turn", {
      id: "earlier-completed-assistant",
      chatId: "chat-grounded",
      role: "assistant",
      content: "earlier answer",
      timestamp: 10_001,
    });
    let failedTurnId: string | undefined;
    vi.mocked(askGrounded).mockImplementation(async (request): Promise<never> => {
      failedTurnId = request.clientTurnId;
      throw new Error("response lost after commit");
    });
    vi.mocked(fetchChatMessages).mockImplementation(
      async (): Promise<{ readonly messages: readonly ChatMessage[] }> => {
        if (failedTurnId === undefined) throw new Error("missing failed turn identity");
        return {
          messages: [
            earlierUser,
            earlierAssistant,
            await canonicalMessage(failedTurnId, {
              id: "current-completed-user",
              chatId: "chat-grounded",
              content: "same question",
              timestamp: 20_000,
            }),
            await canonicalMessage(failedTurnId, {
              id: "current-completed-assistant",
              chatId: "chat-grounded",
              role: "assistant",
              content: "current answer",
              timestamp: 20_001,
            }),
          ],
        };
      },
    );

    let outcome: SendMessageOutcome | undefined;
    await act(async (): Promise<void> => {
      outcome = await result.current.sendMessage({
        text: "same question",
        reportOutcome: true,
      });
    });

    expect(outcome).toEqual({
      status: "completed",
      assistantMessageId: "current-completed-assistant",
    });
    expect(result.current.messages.map((entry) => entry.id)).toEqual([
      "earlier-completed-user",
      "earlier-completed-assistant",
      "current-completed-user",
      "current-completed-assistant",
    ]);
    expect(result.current.error).toBeUndefined();
  });

  it("accepts an identical canonical user message created at this admission boundary", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    try {
      const { result } = await setupGroundedSession();
      vi.mocked(askGrounded).mockRejectedValueOnce(new Error("response lost"));
      vi.mocked(fetchChatMessages).mockResolvedValueOnce({
        messages: [
          await canonicalMessage("accepted-question-turn", {
            id: "new-canonical-user",
            chatId: "chat-grounded",
            content: "accepted question",
            timestamp: 20_000,
          }),
        ],
      });
      let outcome: SendMessageOutcome | undefined;

      await act(async () => {
        outcome = await result.current.sendMessage({
          text: "accepted question",
          clientTurnId: "accepted-question-turn",
          reportOutcome: true,
        });
      });

      expect(outcome).toEqual({ status: "in-progress" });
    } finally {
      now.mockRestore();
    }
  });

  it("recognizes the existing canonical user row while a same-id retry is still active", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const canonicalUser = await canonicalMessage("same-provider-item", {
        id: "existing-canonical-user",
        chatId: "chat-grounded",
        content: "active canonical question",
        timestamp: 10_000,
      });
      const { result } = await setupGroundedSession();
      vi.mocked(fetchChatMessages).mockClear();
      vi.mocked(askGrounded).mockRejectedValueOnce(
        new ApiError("CHAT_TURN_IN_PROGRESS", "still active", 409),
      );
      vi.mocked(fetchChatMessages).mockResolvedValueOnce({ messages: [canonicalUser] });
      let outcome: SendMessageOutcome | undefined;

      await act(async () => {
        outcome = await result.current.sendMessage({
          text: "active canonical question",
          clientTurnId: "same-provider-item",
          reportOutcome: true,
        });
      });

      expect(outcome).toEqual({ status: "in-progress" });
      expect(fetchChatMessages).toHaveBeenCalledOnce();
      expect(result.current.messages).toEqual([canonicalUser]);
      expect(result.current.messages.some((entry) => entry.id.startsWith("local-"))).toBe(false);
    } finally {
      now.mockRestore();
    }
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
    const canonicalUser = message({
      id: "attachment-user",
      chatId: "chat-1",
      role: "user",
      content: "Use the attached context.",
    });
    const canonicalAssistant = message({
      id: "attachment-assistant",
      chatId: "chat-1",
      role: "assistant",
      content: "Attachment answer.",
    });
    vi.mocked(uploadConversationAttachment).mockResolvedValue({
      attachmentRef: `chat-attachment:${"a".repeat(64)}`,
      expiresAt: 60_000,
    });
    vi.mocked(sendDesktopChat).mockImplementation(async (request) => ({
      chat: chat({ selectedModel: "chat-attachments" }),
      messages: [canonicalUser, canonicalAssistant],
      attachmentDeliveries: (request.attachments ?? [])
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({ id: attachment.id, status: "delivered" as const })),
    }));

    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  it("sends image and document attachment descriptors on the ungrounded path", async () => {
    const { result } = await setupUngroundedAttachmentSession();
    const memorySettings = renderHook(() => useConversationMemorySettings());
    act(() => {
      memorySettings.result.current.setMemoryMode("autonomous-delivery");
    });

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
          attachmentRef: `chat-attachment:${"a".repeat(64)}`,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
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
      memory: { mode: "autonomous-delivery" },
    });
    expect(result.current.pendingAttachments).toHaveLength(0);
    expect(result.current.lastSentImages).toEqual([
      expect.objectContaining({ displayName: "screen.png" }),
    ]);
    expect(deleteConversationAttachment).toHaveBeenCalledTimes(1);
  });

  it("refuses an image when governed local upload is unavailable", async (): Promise<void> => {
    const { result } = await setupUngroundedAttachmentSession();
    vi.mocked(uploadConversationAttachment).mockRejectedValueOnce(
      new ApiError("NOT_FOUND", "Conversation attachment is unavailable.", 404),
    );

    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["image"], "screen.png", { type: "image/png" }),
        ),
      ).toEqual({ ok: false, reason: "delivery-refused" });
    });

    expect(result.current.pendingAttachments).toEqual([]);
    expect(sendDesktopChat).not.toHaveBeenCalled();
  });

  it("delivers an image alongside extracted document context", async (): Promise<void> => {
    const { result } = await setupUngroundedAttachmentSession();

    await act(async (): Promise<void> => {
      await result.current.addPendingAttachment(
        new File(["image"], "screen.png", { type: "image/png" }),
      );
      await result.current.addPendingAttachment(
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      );
    });
    act((): void => {
      result.current.setDraft("Use the attached context.");
    });

    await act(async (): Promise<void> => {
      await result.current.sendMessage();
    });

    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]?.documentContext).toHaveLength(1);
    expect(result.current.error).toBeUndefined();
  });

  it("clears attachments after reconciliation proves a lost response completed", async (): Promise<void> => {
    const { result } = await setupUngroundedAttachmentSession();
    let clientTurnId: string | undefined;
    vi.mocked(sendDesktopChat).mockImplementation(async (request): Promise<never> => {
      clientTurnId = request.clientTurnId;
      throw new TypeError("response lost after commit");
    });
    vi.mocked(fetchChatMessages).mockImplementation(
      async (): Promise<{ readonly messages: readonly ChatMessage[] }> => {
        if (clientTurnId === undefined) return { messages: [] };
        return {
          messages: [
            await canonicalMessage(clientTurnId, {
              id: "recovered-attachment-user",
              chatId: "chat-1",
              content: "Use the recovered attachment.",
            }),
            await canonicalMessage(clientTurnId, {
              id: "recovered-attachment-assistant",
              chatId: "chat-1",
              role: "assistant",
              content: "Recovered answer.",
            }),
          ],
        };
      },
    );
    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["release context"], "release.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });
    act((): void => {
      result.current.setDraft("Use the recovered attachment.");
    });

    let outcome: SendMessageOutcome | undefined;
    await act(async (): Promise<void> => {
      outcome = await result.current.sendMessage({ reportOutcome: true });
    });

    expect(outcome).toEqual({
      status: "completed",
      assistantMessageId: "recovered-attachment-assistant",
    });
    expect(result.current.pendingAttachments).toHaveLength(0);
    expect(result.current.lastSentDocuments).toEqual([
      expect.objectContaining({
        displayName: "release.txt",
        truncated: false,
      }),
    ]);
  });

  // #2843 — a spoken turn used to send `attachments: []` and no `documentContext` while the contract
  // comment above SendMessageOptions promised the identical context a typed turn carries, and the
  // operator runbook told the reviewer to attach a file and ask about it. ADR-0154 D1/D5 make the
  // parity the contract: one canonical pipeline, no Voice-specific substitute, and equal final text
  // plus equal chat context must make the same retrieval decisions typed or spoken. Nothing here
  // reaches the Realtime session — this is the canonical BFF request the composer already used.
  it("carries the staged attachments and document context on a spoken turn", async (): Promise<void> => {
    const { result } = await setupUngroundedAttachmentSession();
    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["spoken spec"], "spec.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });

    let outcome: SendMessageOutcome | undefined;
    await act(async (): Promise<void> => {
      outcome = await result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(
          "what does the attached spec say?",
          "voice-attachment-turn",
          chat({ selectedModel: "chat-attachments" }),
          "chat-attachments",
        ),
      );
    });

    expect(outcome).toEqual({ status: "completed", assistantMessageId: "attachment-assistant" });
    expect(sendDesktopChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      content: "what does the attached spec say?",
      attachments: [{ kind: "document", name: "spec.txt", mimeType: "text/plain", sizeBytes: 11 }],
      documentContext: [{ displayName: "spec.txt", mimeType: "text/plain", text: "spoken spec" }],
    });
    // The turn consumed the staged file, so the chips clear and the disclosure names that document.
    expect(result.current.pendingAttachments).toHaveLength(0);
    expect(result.current.lastSentDocuments).toEqual([
      expect.objectContaining({ displayName: "spec.txt", truncated: false }),
    ]);
  });

  // #2843 — presentCompletedSend returned early for a canonical target, so a completed spoken turn
  // left `lastSentDocuments` holding the PREVIOUS turn's list: a "documents included as context" note
  // stayed on screen asserting documents for a turn that carried none.
  it("replaces the previous turn's document disclosure when a spoken turn carries none", async (): Promise<void> => {
    const { result } = await setupUngroundedAttachmentSession();
    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["typed context"], "typed.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });
    act((): void => {
      result.current.setDraft("Use the attached file.");
    });
    await act(async (): Promise<void> => {
      await result.current.sendMessage();
    });
    expect(result.current.lastSentDocuments).toEqual([
      expect.objectContaining({ displayName: "typed.txt" }),
    ]);

    await act(async (): Promise<void> => {
      await result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(
          "and now a spoken follow-up with nothing staged",
          "voice-no-attachment-turn",
          chat({ selectedModel: "chat-attachments" }),
          "chat-attachments",
        ),
      );
    });

    const spokenRequest = vi.mocked(sendDesktopChat).mock.calls[1]?.[0];
    expect(spokenRequest?.attachments).toBeUndefined();
    expect(spokenRequest?.documentContext).toBeUndefined();
    expect(result.current.lastSentDocuments).toEqual([]);
  });

  // #2843 — the queue-owned target is captured at handoff (ADR-0154 D1), so the turn must carry the
  // files staged when the transcript settled. Reading live composer state at drain time instead would
  // attach a file the user staged for a later turn (or another chat) to this one, and would clear a
  // chip that was never sent.
  it("sends the files staged at handoff and keeps a later staged file for its own turn", async (): Promise<void> => {
    const { result } = await setupUngroundedAttachmentSession();
    const gate = deferred<{
      readonly chat: Chat;
      readonly messages: readonly ChatMessage[];
      readonly memory: undefined;
    }>();
    vi.mocked(sendDesktopChat).mockImplementationOnce(async () => gate.promise as never);
    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["first spec"], "first.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });

    let delivery: Promise<SendMessageOutcome> | undefined;
    await act(async (): Promise<void> => {
      delivery = result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(
          "what does the first spec say?",
          "voice-snapshot-turn",
          chat({ selectedModel: "chat-attachments" }),
          "chat-attachments",
        ),
      );
    });
    await waitFor((): void => {
      expect(sendDesktopChat).toHaveBeenCalledTimes(1);
    });
    // Staged AFTER the handoff: it belongs to the next turn, not this in-flight one.
    await act(async (): Promise<void> => {
      expect(
        await result.current.addPendingAttachment(
          new File(["second spec"], "second.txt", { type: "text/plain" }),
        ),
      ).toEqual({ ok: true });
    });
    gate.resolve({
      chat: chat({ selectedModel: "chat-attachments" }),
      messages: [
        message({ id: "attachment-user", chatId: "chat-1", role: "user" }),
        message({ id: "attachment-assistant", chatId: "chat-1", role: "assistant" }),
      ],
      memory: undefined,
    });
    let outcome: SendMessageOutcome | undefined;
    await act(async (): Promise<void> => {
      outcome = await delivery;
    });

    expect(outcome).toEqual({ status: "completed", assistantMessageId: "attachment-assistant" });
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ name: "first.txt" }],
      documentContext: [{ displayName: "first.txt", text: "first spec" }],
    });
    expect(result.current.pendingAttachments.map((attachment) => attachment.name)).toEqual([
      "second.txt",
    ]);
    expect(result.current.lastSentDocuments).toEqual([
      expect.objectContaining({ displayName: "first.txt" }),
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
      messages: [
        message({ id: "user-explicit", role: "user" }),
        message({ id: "assistant-explicit", role: "assistant" }),
      ],
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

  it("prefers the explicit text and preserves the user's typed draft", async () => {
    const { result } = await setupUngroundedSession();
    act(() => {
      result.current.setDraft("stale draft");
    });

    await act(async () => {
      await result.current.sendMessage({ text: "spoken question wins" });
    });

    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]?.content).toBe("spoken question wins");
    expect(result.current.draft).toBe("stale draft");
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

  it("reports canonical voice admission without changing the typed send surface", async () => {
    const { result } = await setupUngroundedSession();
    let firstOutcome: SendMessageOutcome | undefined;
    let blockedOutcome: SendMessageOutcome | undefined;

    await act(async () => {
      const first = result.current.sendMessage({
        text: "accepted voice final",
        clientTurnId: "voice-final-1",
        reportOutcome: true,
      });
      const blocked = result.current.sendMessage({
        text: "must remain pending",
        clientTurnId: "voice-final-2",
        reportOutcome: true,
      });
      [firstOutcome, blockedOutcome] = await Promise.all([first, blocked]);
    });

    expect(firstOutcome).toEqual({
      status: "completed",
      assistantMessageId: "assistant-explicit",
    });
    expect(blockedOutcome).toEqual({ status: "not-sent" });
    expect(sendDesktopChat).toHaveBeenCalledOnce();
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      clientTurnId: "voice-final-1",
    });
  });
});

describe("useChatSession canonical Voice FIFO", () => {
  async function setupVoiceQueueSession(
    chats: readonly Chat[] = [chat()],
    projects: readonly ProjectWithAvailability[] = [project()],
    models: readonly ModelCapability[] = [model({ streaming: false })],
  ): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChatSession>, never>>> {
    vi.mocked(fetchModels).mockResolvedValue({ models: Array.from(models) });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: Array.from(projects) });
    vi.mocked(fetchChats).mockResolvedValue({ chats: Array.from(chats) });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const rendered = renderHook(() => useChatSession({ autoCreate: false }));
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));
    return rendered;
  }

  function completedTurn(
    content: string,
    assistantId: string,
    chatId = "chat-1",
  ): Awaited<ReturnType<typeof sendDesktopChat>> {
    return {
      chat: chat({ id: chatId }),
      messages: [
        message({ id: `${assistantId}-user`, chatId, content, role: "user" }),
        message({ id: assistantId, chatId, content: `Answer: ${content}`, role: "assistant" }),
      ],
      memory: undefined,
    } as unknown as Awaited<ReturnType<typeof sendDesktopChat>>;
  }

  it("fails closed without retaining a transcript when hashing was not prepared", async () => {
    const rendered = await setupVoiceQueueSession();
    const sentinel = "unprepared private spoken sentinel";
    clearCanonicalVoiceHasherForTests();

    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(sentinel, "unprepared-hasher-turn"),
        );
      });

      expect(delivery).toBeUndefined();
      expect(sendDesktopChat).not.toHaveBeenCalled();
      expect(canonicalVoicePageOutboxRetainsPlaintextForTests(sentinel)).toBe(false);
      expect(rendered.result.current.messages).not.toContainEqual(
        expect.objectContaining({ content: sentinel }),
      );
      expect(rendered.result.current.error).toContain("could not be added to chat");
    } finally {
      await prepareCanonicalVoiceHasher();
    }
  });

  // Issue #2550: a settled spoken final is answered by this same canonical chat pipeline, so the
  // server cannot infer that the turn came from Voice — only this caller knows. Declaring the origin
  // here is what lets the Memory Journal show what was learned during voice; without it every voice
  // capture is filed as desktop.
  it("declares the voice capture surface on a canonical voice final", async () => {
    const rendered = await setupVoiceQueueSession();

    await act(async () => {
      await rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("I prefer stand-ups at 9am.", "surface-voice-final"),
      );
    });

    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0].memory).toMatchObject({
      surface: "voice",
    });
  });

  it("leaves a typed send free of a Voice capture surface marker", async (): Promise<void> => {
    const rendered = await setupVoiceQueueSession();

    await act(async () => {
      await rendered.result.current.sendMessage({ text: "A typed turn." });
    });

    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0].memory).not.toHaveProperty("surface");
  });

  it("assigns fresh canonical identities to typed sends and preserves a supplied identity", async (): Promise<void> => {
    vi.mocked(sendDesktopChat).mockImplementation(
      (request): Promise<Awaited<ReturnType<typeof sendDesktopChat>>> =>
        Promise.resolve(completedTurn(request.content, `assistant-${request.content}`)),
    );
    const rendered = await setupVoiceQueueSession();

    await act(async (): Promise<void> => {
      await rendered.result.current.sendMessage({ text: "typed one" });
      await rendered.result.current.sendMessage({ text: "typed two" });
      await rendered.result.current.sendMessage({
        text: "spoken final",
        clientTurnId: "provider-supplied-turn",
      });
    });

    const turnIds = vi
      .mocked(sendDesktopChat)
      .mock.calls.map(([request]): string | undefined => request.clientTurnId);
    expect(turnIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(turnIds[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(turnIds[1]).not.toBe(turnIds[0]);
    expect(turnIds[2]).toBe("provider-supplied-turn");
  });

  it("persists a 16,001-character final as one user turn with one assistant before the next utterance", async () => {
    const rendered = await setupVoiceQueueSession();
    const longFinal = `${"a".repeat(8_000)} ${"b".repeat(8_000)}`;
    vi.mocked(sendDesktopChat).mockImplementation((request) =>
      Promise.resolve(
        completedTurn(
          request.content,
          request.clientTurnId === "long-voice-final" ? "long-assistant" : "next-assistant",
          request.chatId,
        ),
      ),
    );

    let firstOutcome: SendMessageOutcome | undefined;
    await act(async () => {
      firstOutcome = await rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(longFinal, "long-voice-final"),
      );
    });

    expect(firstOutcome).toEqual({
      status: "completed",
      assistantMessageId: "long-assistant",
    });
    expect(sendDesktopChat).toHaveBeenCalledOnce();
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0].content).toBe(longFinal);
    expect(
      rendered.result.current.messages.filter(
        (candidate) => candidate.role === "user" && candidate.content === longFinal,
      ),
    ).toHaveLength(1);
    expect(
      rendered.result.current.messages.filter((candidate) => candidate.id === "long-assistant"),
    ).toHaveLength(1);

    await act(async () => {
      await rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("A separate next utterance.", "next-voice-final"),
      );
    });

    expect(sendDesktopChat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendDesktopChat).mock.calls[1]?.[0].content).toBe(
      "A separate next utterance.",
    );
    expect(
      rendered.result.current.messages.filter(
        (candidate) => candidate.role === "user" && candidate.content === longFinal,
      ),
    ).toHaveLength(1);
  });

  it("retains only a digest after settlement and enforces duplicate identity by digest", async () => {
    const rendered = await setupVoiceQueueSession();
    const sentinel = "private spoken sentinel 4c75d49b";
    vi.mocked(sendDesktopChat).mockResolvedValue(completedTurn(sentinel, "digest-assistant"));

    let first: Promise<SendMessageOutcome> | undefined;
    act(() => {
      first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(sentinel, "voice-digest-id"),
      );
    });
    await expect(first).resolves.toEqual({
      status: "completed",
      assistantMessageId: "digest-assistant",
    });
    expect(canonicalVoicePageOutboxRetainsPlaintextForTests(sentinel)).toBe(false);

    let duplicate: Promise<SendMessageOutcome> | undefined;
    let conflict: Promise<SendMessageOutcome> | undefined;
    act(() => {
      duplicate = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn(sentinel, "voice-digest-id"),
      );
      conflict = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("different content", "voice-digest-id"),
      );
    });
    await expect(duplicate).resolves.toEqual({
      status: "completed",
      assistantMessageId: "digest-assistant",
    });
    expect(conflict).toBeUndefined();
    expect(sendDesktopChat).toHaveBeenCalledOnce();
    expect(rendered.result.current.error).toContain("identity was reused");
  });

  it("purges a suspended transcript when its chat is deleted", async () => {
    const rendered = await setupVoiceQueueSession();
    const sentinel = "deleted spoken sentinel a0eb470c";
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockRejectedValue(new TypeError("network unavailable"));
    vi.useFakeTimers();
    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(sentinel, "voice-delete-pending"),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);
      expect(canonicalVoicePageOutboxRetainsPlaintextForTests(sentinel)).toBe(true);

      act(() => {
        notifyChatDeleted("chat-1");
      });
      await expect(delivery).resolves.toEqual({ status: "failed", retryable: false });
      expect(canonicalVoicePageOutboxRetainsPlaintextForTests(sentinel)).toBe(false);
      expect(rendered.result.current.activeChat).toBeUndefined();
      expect(rendered.result.current.messages).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a cancelled Voice turn before advancing when reconciliation is unknown", async () => {
    const rendered = await setupVoiceQueueSession();
    const neverReconciles = deferred<{ messages: readonly ChatMessage[] }>();
    vi.mocked(fetchChatMessages).mockClear();
    vi.mocked(fetchChatMessages).mockReturnValue(neverReconciles.promise);
    const requestIds: Array<string | undefined> = [];
    vi.mocked(sendDesktopChat).mockImplementation((request, signal) => {
      requestIds.push(request.clientTurnId);
      if (requestIds.length === 2) {
        return Promise.resolve(completedTurn("first final", "first-assistant"));
      }
      if (requestIds.length === 3) {
        return Promise.resolve(completedTurn("second final", "second-assistant"));
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    });
    vi.useFakeTimers();
    try {
      let first: Promise<SendMessageOutcome> | undefined;
      let second: Promise<SendMessageOutcome> | undefined;
      act(() => {
        first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("first final", "voice-reconcile-timeout-first"),
        );
        second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("second final", "voice-reconcile-timeout-second"),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(sendDesktopChat).toHaveBeenCalledTimes(1);

      act(() => {
        rendered.result.current.cancelSend();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_000);
      });

      await expect(first).resolves.toEqual({
        status: "completed",
        assistantMessageId: "first-assistant",
      });
      await expect(second).resolves.toEqual({
        status: "completed",
        assistantMessageId: "second-assistant",
      });
      expect(requestIds).toEqual([
        "voice-reconcile-timeout-first",
        "voice-reconcile-timeout-first",
        "voice-reconcile-timeout-second",
      ]);
      expect(vi.mocked(fetchChatMessages).mock.calls[0]?.[2]?.aborted).toBe(true);
      expect(
        rendered.result.current.messages.filter(
          (candidate) => candidate.role === "user" && candidate.content === "first final",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed Voice turn before advancing when reconciliation finds no row", async () => {
    const rendered = await setupVoiceQueueSession();
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const requestIds: Array<string | undefined> = [];
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      requestIds.push(request.clientTurnId);
      if (requestIds.length === 1) return Promise.reject(new TypeError("network unavailable"));
      return Promise.resolve(
        completedTurn(
          request.content,
          requestIds.length === 2 ? "first-network-assistant" : "second-network-assistant",
        ),
      );
    });
    vi.useFakeTimers();
    try {
      let first: Promise<SendMessageOutcome> | undefined;
      let second: Promise<SendMessageOutcome> | undefined;
      act(() => {
        first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("first network final", "voice-network-first"),
        );
        second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("second network final", "voice-network-second"),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      await expect(first).resolves.toEqual({
        status: "completed",
        assistantMessageId: "first-network-assistant",
      });
      await expect(second).resolves.toEqual({
        status: "completed",
        assistantMessageId: "second-network-assistant",
      });
      expect(requestIds).toEqual([
        "voice-network-first",
        "voice-network-first",
        "voice-network-second",
      ]);
      expect(
        rendered.result.current.messages.filter(
          (candidate) => candidate.role === "user" && candidate.content === "first network final",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry an identity conflict before advancing the Voice FIFO", async () => {
    const rendered = await setupVoiceQueueSession();
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const requestIds: Array<string | undefined> = [];
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      requestIds.push(request.clientTurnId);
      return requestIds.length === 1
        ? Promise.reject(
            new ApiError("CHAT_TURN_IDEMPOTENCY_CONFLICT", "Turn identity conflicts.", 409),
          )
        : Promise.resolve(completedTurn("second after conflict", "conflict-second-assistant"));
    });

    let first: Promise<SendMessageOutcome> | undefined;
    let second: Promise<SendMessageOutcome> | undefined;
    let duplicate: Promise<SendMessageOutcome> | undefined;
    act(() => {
      first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("conflicting first final", "voice-conflict-first"),
      );
      second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("second after conflict", "voice-conflict-second"),
      );
    });

    await expect(first).resolves.toEqual({ status: "failed", retryable: false });
    await expect(second).resolves.toEqual({
      status: "completed",
      assistantMessageId: "conflict-second-assistant",
    });
    act(() => {
      duplicate = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("conflicting first final", "voice-conflict-first"),
      );
    });
    await expect(duplicate).resolves.toEqual({ status: "failed", retryable: false });
    expect(requestIds).toEqual(["voice-conflict-first", "voice-conflict-second"]);
  });

  it("releases capacity for terminal unpersisted conflicts and caches their identities", async () => {
    const rendered = await setupVoiceQueueSession();
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockRejectedValue(
      new ApiError("CHAT_TURN_IDEMPOTENCY_CONFLICT", "Turn identity conflicts.", 409),
    );

    for (let index = 0; index < 129; index += 1) {
      let outcome: SendMessageOutcome | undefined;
      await act(async () => {
        outcome = await rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(`conflict ${String(index)}`, `terminal-conflict-${String(index)}`),
        );
      });
      expect(outcome).toEqual({ status: "failed", retryable: false });
    }
    let duplicate: Promise<SendMessageOutcome> | undefined;
    act(() => {
      duplicate = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("conflict 0", "terminal-conflict-0"),
      );
    });

    await expect(duplicate).resolves.toEqual({ status: "failed", retryable: false });
    expect(sendDesktopChat).toHaveBeenCalledTimes(129);
    expect(rendered.result.current.error).not.toContain("queue is full");
  });

  it("settles a persisted scope conflict once before advancing the Voice FIFO", async () => {
    const rendered = await setupVoiceQueueSession();
    const requestIds: Array<string | undefined> = [];
    vi.mocked(fetchChatMessages).mockRejectedValue(new TypeError("reconciliation unavailable"));
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      requestIds.push(request.clientTurnId);
      return requestIds.length === 1
        ? Promise.reject(
            new ApiError("GROUNDING_SCOPE_CHANGED", "The grounding scope changed.", 409),
          )
        : Promise.resolve(completedTurn("second after scope change", "scope-second-assistant"));
    });

    let first: Promise<SendMessageOutcome> | undefined;
    let duplicate: Promise<SendMessageOutcome> | undefined;
    let second: Promise<SendMessageOutcome> | undefined;
    act(() => {
      first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("scope-bound first final", "voice-scope-first"),
      );
      second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("second after scope change", "voice-scope-second"),
      );
    });

    await expect(first).resolves.toEqual({
      status: "failed",
      retryable: false,
      userPersisted: true,
    });
    await expect(second).resolves.toEqual({
      status: "completed",
      assistantMessageId: "scope-second-assistant",
    });
    act(() => {
      duplicate = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("scope-bound first final", "voice-scope-first"),
      );
    });
    await expect(duplicate).resolves.toEqual({
      status: "failed",
      retryable: false,
      userPersisted: true,
    });
    expect(requestIds).toEqual(["voice-scope-first", "voice-scope-second"]);
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      expectedGroundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    });
  });

  it("requires an explicit retry after a finite unpersisted window and preserves FIFO order", async () => {
    const rendered = await setupVoiceQueueSession();
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    const requestIds: Array<string | undefined> = [];
    let serviceAvailable = false;
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      requestIds.push(request.clientTurnId);
      if (!serviceAvailable) return Promise.reject(new TypeError("network unavailable"));
      return Promise.resolve(
        completedTurn(
          request.content,
          request.clientTurnId === "voice-offline-first"
            ? "offline-first-assistant"
            : "offline-second-assistant",
        ),
      );
    });
    vi.useFakeTimers();
    try {
      let first: Promise<SendMessageOutcome> | undefined;
      let second: Promise<SendMessageOutcome> | undefined;
      let firstSettled = false;
      act(() => {
        first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("offline first final", "voice-offline-first"),
        );
        second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("offline second final", "voice-offline-second"),
        );
        void first?.then(() => {
          firstSettled = true;
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(firstSettled).toBe(false);
      expect(requestIds).toEqual([
        "voice-offline-first",
        "voice-offline-first",
        "voice-offline-first",
      ]);
      expect(requestIds.every((id) => id === "voice-offline-first")).toBe(true);
      expect(rendered.result.current.error).toContain("spoken turn is still pending");
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(requestIds).toHaveLength(3);

      let typedOutcome: SendMessageOutcome | undefined;
      await act(async () => {
        typedOutcome = await rendered.result.current.sendMessage({
          text: "typed overtaker",
          reportOutcome: true,
        });
      });
      expect(typedOutcome).toEqual({ status: "not-sent" });
      expect(requestIds).toHaveLength(3);

      serviceAvailable = true;
      rendered.unmount();
      const resumed = renderHook(() => useChatSession({ autoCreate: false }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requestIds).toHaveLength(3);
      expect(resumed.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);
      act(() => {
        resumed.result.current.retryPendingCanonicalVoiceTurn?.();
      });
      await expect(first).resolves.toEqual({
        status: "completed",
        assistantMessageId: "offline-first-assistant",
      });
      await expect(second).resolves.toEqual({
        status: "completed",
        assistantMessageId: "offline-second-assistant",
      });
      expect(requestIds.at(-2)).toBe("voice-offline-first");
      expect(requestIds.at(-1)).toBe("voice-offline-second");
      expect(
        resumed.result.current.messages.filter(
          (candidate) => candidate.role === "user" && candidate.content === "offline first final",
        ),
      ).toHaveLength(1);
      resumed.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the suspended head retry visible and actionable after switching chats", async () => {
    const chatA = chat({ id: "chat-a", updatedAt: 2 });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const rendered = await setupVoiceQueueSession([chatA, chatB]);
    const requestIds: Array<string | undefined> = [];
    let serviceAvailable = false;
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      requestIds.push(request.clientTurnId);
      if (!serviceAvailable) return Promise.reject(new TypeError("network unavailable"));
      return Promise.resolve(
        completedTurn(
          request.content,
          request.clientTurnId === "voice-a" ? "assistant-a" : "assistant-b",
          request.chatId,
        ),
      );
    });
    vi.useFakeTimers();
    try {
      let first: Promise<SendMessageOutcome> | undefined;
      let second: Promise<SendMessageOutcome> | undefined;
      act(() => {
        first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("voice in A", "voice-a", chatA),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await rendered.result.current.openChat(chatB);
      });
      act(() => {
        second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("voice in B", "voice-b", chatB),
        );
      });

      expect(rendered.result.current.activeChat?.id).toBe("chat-b");
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);
      expect(requestIds).toEqual(["voice-a", "voice-a", "voice-a"]);

      serviceAvailable = true;
      act(() => {
        rendered.result.current.retryPendingCanonicalVoiceTurn?.();
      });
      await expect(first).resolves.toEqual({
        status: "completed",
        assistantMessageId: "assistant-a",
      });
      await expect(second).resolves.toEqual({
        status: "completed",
        assistantMessageId: "assistant-b",
      });
      expect(requestIds.slice(-2)).toEqual(["voice-a", "voice-b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume a suspended head when a later chat is deleted", async () => {
    const chatA = chat({ id: "chat-a", updatedAt: 2 });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const rendered = await setupVoiceQueueSession([chatA, chatB]);
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockRejectedValue(new TypeError("network unavailable"));
    vi.useFakeTimers();
    try {
      let second: Promise<SendMessageOutcome> | undefined;
      act(() => {
        void rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("suspended A", "suspended-a", chatA),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      act(() => {
        second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("queued B", "queued-b", chatB),
        );
        notifyChatDeleted("chat-b");
      });
      await expect(second).resolves.toEqual({ status: "failed", retryable: false });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(sendDesktopChat).toHaveBeenCalledTimes(3);
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects one final transcript immediately while a composer turn owns the send slot", async () => {
    const composer = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat)
      .mockReturnValueOnce(composer.promise)
      .mockResolvedValueOnce(completedTurn("queued voice final", "voice-assistant"));
    const rendered = await setupVoiceQueueSession();
    let composerPromise: Promise<void> | undefined;
    act(() => {
      composerPromise = rendered.result.current.sendMessage({ text: "typed first" });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    let delivery: Promise<SendMessageOutcome> | undefined;
    let duplicate: Promise<SendMessageOutcome> | undefined;
    act(() => {
      delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("queued voice final", "voice-fifo-1"),
      );
      duplicate = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("queued voice final", "voice-fifo-1"),
      );
    });

    expect(delivery).toBe(duplicate);
    expect(
      rendered.result.current.messages.filter(
        (candidate) => candidate.role === "user" && candidate.content === "queued voice final",
      ),
    ).toHaveLength(1);
    expect(rendered.result.current.messages.map((candidate) => candidate.content)).toEqual([
      "typed first",
      "queued voice final",
    ]);
    expect(sendDesktopChat).toHaveBeenCalledOnce();
    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 100)).toBe(false);

    composer.resolve(completedTurn("typed first", "typed-assistant"));
    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      await composerPromise;
      outcome = await delivery;
    });

    expect(outcome).toEqual({ status: "completed", assistantMessageId: "voice-assistant" });
    expect(sendDesktopChat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendDesktopChat).mock.calls[1]?.[0]).toMatchObject({
      content: "queued voice final",
      clientTurnId: "voice-fifo-1",
    });
    expect(vi.mocked(sendDesktopChat).mock.calls[1]?.[0]).not.toHaveProperty("documentContext");
    expect(vi.mocked(sendDesktopChat).mock.calls[1]?.[0]).not.toHaveProperty("attachments");
    expect(
      rendered.result.current.messages.filter(
        (candidate) => candidate.role === "user" && candidate.content === "queued voice final",
      ),
    ).toHaveLength(1);
    expect(rendered.result.current.messages.map((candidate) => candidate.content)).toEqual([
      "typed first",
      "Answer: typed first",
      "queued voice final",
      "Answer: queued voice final",
    ]);
  });

  it("elects another live subscriber when the outbox drain owner unmounts", async () => {
    const firstRequest = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat)
      .mockImplementationOnce((_request, signal) => {
        signal?.addEventListener(
          "abort",
          () => firstRequest.reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
        return firstRequest.promise;
      })
      .mockResolvedValueOnce(completedTurn("multi-window final", "multi-window-assistant"));
    const windowA = await setupVoiceQueueSession();
    const windowB = await setupVoiceQueueSession();
    let delivery: Promise<SendMessageOutcome> | undefined;
    act(() => {
      delivery = windowB.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("multi-window final", "multi-window-turn"),
      );
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());

    windowB.unmount();
    await expect(delivery).resolves.toEqual({
      status: "completed",
      assistantMessageId: "multi-window-assistant",
    });
    expect(vi.mocked(sendDesktopChat).mock.calls.map(([request]) => request.clientTurnId)).toEqual([
      "multi-window-turn",
      "multi-window-turn",
    ]);
    windowA.unmount();
  });

  it("reconciles a fallback delivery into the remounted target chat session", async () => {
    const chatA = chat({ id: "chat-a", updatedAt: 2 });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const firstRequest = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    const fallbackRequest = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat)
      .mockImplementationOnce((_request, signal) => {
        signal?.addEventListener(
          "abort",
          () => firstRequest.reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
        return firstRequest.promise;
      })
      .mockReturnValueOnce(fallbackRequest.promise);
    const fallbackWindow = await setupVoiceQueueSession([chatA, chatB]);
    const targetWindow = await setupVoiceQueueSession([chatA, chatB]);
    await act(async () => targetWindow.result.current.openChat(chatB));
    let delivery: Promise<SendMessageOutcome> | undefined;
    act(() => {
      delivery = targetWindow.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("survives remount", "voice-remount", chatB),
      );
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());

    targetWindow.unmount();
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(2));
    const replacementA = await setupVoiceQueueSession([chatA, chatB]);
    const replacementB = await setupVoiceQueueSession([chatA, chatB]);
    await act(async () => {
      await Promise.all([
        replacementA.result.current.openChat(chatB),
        replacementB.result.current.openChat(chatB),
      ]);
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [
        message({ id: "voice-remount-user", chatId: chatB.id, content: "survives remount" }),
        message({
          id: "voice-remount-assistant",
          chatId: chatB.id,
          content: "Answer: survives remount",
          role: "assistant",
        }),
      ],
    });
    vi.mocked(fetchChatMessages).mockClear();
    vi.mocked(fetchChats).mockClear();

    fallbackRequest.resolve(completedTurn("survives remount", "voice-remount-assistant", chatB.id));
    await act(async () => {
      await delivery;
    });

    for (const replacement of [replacementA, replacementB]) {
      expect(replacement.result.current.messages).toContainEqual(
        expect.objectContaining({ id: "voice-remount-assistant", chatId: chatB.id }),
      );
      replacement.unmount();
    }
    expect(fetchChatMessages).toHaveBeenCalledOnce();
    expect(fetchChats).toHaveBeenCalledOnce();
    fallbackWindow.unmount();
  });

  it("delivers each queued turn through the chat session that accepted it", async () => {
    const chatA = chat({ id: "chat-a", updatedAt: 2 });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const firstRequest = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat)
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(completedTurn("voice from B", "assistant-b", chatB.id));
    const windowA = await setupVoiceQueueSession([chatA, chatB]);
    const windowB = await setupVoiceQueueSession([chatA, chatB]);
    await act(async () => windowB.result.current.openChat(chatB));

    let first: Promise<SendMessageOutcome> | undefined;
    let second: Promise<SendMessageOutcome> | undefined;
    act(() => {
      first = windowA.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("voice from A", "voice-owner-a", chatA),
      );
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());
    act(() => {
      second = windowB.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("voice from B", "voice-owner-b", chatB),
      );
    });

    firstRequest.resolve(completedTurn("voice from A", "assistant-a", chatA.id));
    await act(async () => {
      await first;
      await second;
    });

    expect(windowA.result.current.messages).toContainEqual(
      expect.objectContaining({ id: "assistant-a", chatId: chatA.id }),
    );
    expect(windowB.result.current.messages).toContainEqual(
      expect.objectContaining({ id: "assistant-b", chatId: chatB.id }),
    );
    windowA.unmount();
    windowB.unmount();
  });

  it("keeps a final bound to its chat project while another project is opening", async () => {
    const originalProject = project("/repo");
    const nextProject = project("/next");
    const originalChat = chat({ projectPath: originalProject.path });
    const nextChat = chat({ id: "chat-next", projectPath: nextProject.path });
    const rendered = await setupVoiceQueueSession([originalChat], [originalProject, nextProject]);
    const projectChats = deferred<Awaited<ReturnType<typeof fetchChats>>>();
    vi.mocked(fetchChats).mockReturnValueOnce(projectChats.promise);
    vi.mocked(sendDesktopChat).mockResolvedValue(
      completedTurn("project transition final", "voice-project-assistant"),
    );

    let projectSwitch: Promise<void> | undefined;
    act(() => {
      projectSwitch = rendered.result.current.openProject(nextProject);
    });
    await waitFor(() => expect(rendered.result.current.activeProject?.path).toBe("/next"));

    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      outcome = await rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("project transition final", "voice-project-transition", originalChat),
      );
    });

    expect(outcome).toEqual({
      status: "completed",
      assistantMessageId: "voice-project-assistant",
    });
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      chatId: originalChat.id,
      projectPath: originalProject.path,
      clientTurnId: "voice-project-transition",
    });

    projectChats.resolve({ chats: [nextChat] });
    await act(async () => {
      await projectSwitch;
    });
  });

  it("reserves one production final across ChatSession replacement before capture pauses", async () => {
    vi.mocked(sendDesktopChat).mockImplementation((request, signal) => {
      if (request.clientTurnId !== undefined) {
        return Promise.resolve(
          completedTurn(request.content, `assistant-${request.clientTurnId}`, request.chatId),
        );
      }
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(new DOMException("cancelled", "AbortError"));
        if (signal?.aborted === true) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const first = await setupVoiceQueueSession();
    let composerSend: Promise<void> | undefined;
    act(() => {
      composerSend = first.result.current.sendMessage({ text: "hold the shared send slot" });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());

    const regularDeliveries: Array<Promise<SendMessageOutcome>> = [];
    act(() => {
      for (let index = 0; index < 128; index += 1) {
        const delivery = first.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("regular queued final", `regular-${String(index)}`),
        );
        if (delivery !== undefined) regularDeliveries.push(delivery);
      }
    });
    expect(regularDeliveries).toHaveLength(128);
    expect(first.result.current.canonicalVoiceCaptureMustPause?.()).toBe(true);

    let reservedDelivery: Promise<SendMessageOutcome> | undefined;
    let overflowDelivery: Promise<SendMessageOutcome> | undefined;
    act(() => {
      reservedDelivery = first.result.current.enqueueCanonicalVoiceTurn?.({
        ...canonicalVoiceTurn("reserved final survives replacement", "reserved-final"),
        allowReservedCapacity: true,
      });
      overflowDelivery = first.result.current.enqueueCanonicalVoiceTurn?.({
        ...canonicalVoiceTurn("absolute overflow must fail", "absolute-overflow"),
        allowReservedCapacity: true,
      });
    });
    expect(reservedDelivery).toBeDefined();
    expect(overflowDelivery).toBeUndefined();
    expect(first.result.current.canonicalVoiceCaptureMustPause?.()).toBe(true);

    first.unmount();
    await act(async () => {
      await composerSend;
    });
    const replacement = await setupVoiceQueueSession();
    const admittedReserve = reservedDelivery;
    if (admittedReserve === undefined)
      throw new Error("Expected the reserved final to be admitted.");
    let reserveOutcome: SendMessageOutcome | undefined;
    await act(async () => {
      reserveOutcome = await admittedReserve;
    });

    expect(reserveOutcome).toEqual({
      status: "completed",
      assistantMessageId: "assistant-reserved-final",
    });
    const reservedRequests = vi
      .mocked(sendDesktopChat)
      .mock.calls.filter(([request]) => request.clientTurnId === "reserved-final");
    expect(reservedRequests).toHaveLength(1);
    expect(reservedRequests[0]?.[0].content).toBe("reserved final survives replacement");
    expect(replacement.result.current.canonicalVoiceCaptureMustPause?.()).toBe(false);
    replacement.unmount();
  });

  it("keeps a queue-rejected final bound to chat A when capacity returns after opening B", async () => {
    const chatA = chat({
      id: "chat-a",
      projectPath: "/repo-a",
      selectedModel: "model-a",
      groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
      updatedAt: 2,
    });
    const chatB = chat({
      id: "chat-b",
      projectPath: "/repo-b",
      selectedModel: "model-b",
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
      updatedAt: 1,
    });
    const composer = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat).mockImplementation((request) =>
      request.clientTurnId === undefined
        ? composer.promise
        : Promise.resolve(
            completedTurn(request.content, `assistant-${request.clientTurnId}`, request.chatId),
          ),
    );
    const rendered = await setupVoiceQueueSession(
      [chatA, chatB],
      [project("/repo-a"), project("/repo-b")],
      [model({ id: "model-a", streaming: false }), model({ id: "model-b", streaming: false })],
    );
    let composerSend: Promise<void> | undefined;
    act(() => {
      composerSend = rendered.result.current.sendMessage({ text: "occupy A" });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());
    const filler = "capacity filler";
    const queued: Array<Promise<SendMessageOutcome>> = [];
    const captured = canonicalVoiceTurn(
      "final captured under A",
      "captured-chat-a",
      chatA,
      "model-a",
    );
    act(() => {
      for (let index = 0; index < 128; index += 1) {
        const delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(filler, `capacity-a-${String(index)}`, chatA, "model-a"),
        );
        if (delivery !== undefined) queued.push(delivery);
      }
    });
    let rejected: Promise<SendMessageOutcome> | undefined;
    act(() => {
      rejected = rendered.result.current.enqueueCanonicalVoiceTurn?.(captured);
    });
    expect(rejected).toBeUndefined();

    await act(async () => {
      await rendered.result.current.openChat(chatB);
    });
    composer.resolve(completedTurn("occupy A", "composer-a", chatA.id));
    await act(async () => {
      await composerSend;
      await queued[0];
    });
    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      outcome = await rendered.result.current.enqueueCanonicalVoiceTurn?.(captured);
    });

    expect(outcome).toEqual({
      status: "completed",
      assistantMessageId: "assistant-captured-chat-a",
    });
    const request = vi
      .mocked(sendDesktopChat)
      .mock.calls.find(([candidate]) => candidate.clientTurnId === "captured-chat-a")?.[0];
    expect(request).toMatchObject({
      chatId: "chat-a",
      projectPath: "/repo-a",
      modelId: "model-a",
      expectedGroundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    });
    expect(askGrounded).not.toHaveBeenCalled();
  });

  it("keeps a queue-rejected final on its captured plain route after the chat becomes grounded", async () => {
    const plain = chat({
      id: "scope-chat",
      projectPath: "/repo",
      selectedModel: "model-a",
      connectedScopes: [],
      groundingScopeIdentity: `gsi-v1:${"a".repeat(64)}`,
    });
    const grounded = chat({
      ...plain,
      connectedScopes: [
        { kind: "files" as const, relativePaths: ["src/index.ts"], connectedAtMs: 2 },
      ],
      groundingScopeIdentity: `gsi-v1:${"b".repeat(64)}`,
      updatedAt: plain.updatedAt + 1,
    });
    const composer = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      if (request.clientTurnId === undefined) return composer.promise;
      if (request.clientTurnId === "captured-scope-a") {
        return Promise.reject(
          new ApiError("GROUNDING_SCOPE_CHANGED", "The grounding scope changed.", 409),
        );
      }
      return Promise.resolve(
        completedTurn(request.content, `assistant-${request.clientTurnId}`, request.chatId),
      );
    });
    vi.mocked(fetchChatMessages).mockRejectedValue(new TypeError("reconciliation unavailable"));
    const rendered = await setupVoiceQueueSession(
      [plain],
      [project()],
      [model({ id: "model-a", streaming: false })],
    );
    let composerSend: Promise<void> | undefined;
    act(() => {
      composerSend = rendered.result.current.sendMessage({ text: "occupy plain route" });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());
    const filler = "capacity filler";
    const queued: Array<Promise<SendMessageOutcome>> = [];
    const captured = canonicalVoiceTurn(
      "final captured before grounding",
      "captured-scope-a",
      plain,
      "model-a",
    );
    act(() => {
      for (let index = 0; index < 128; index += 1) {
        const delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(filler, `capacity-scope-${String(index)}`, plain, "model-a"),
        );
        if (delivery !== undefined) queued.push(delivery);
      }
    });
    let rejected: Promise<SendMessageOutcome> | undefined;
    act(() => {
      rejected = rendered.result.current.enqueueCanonicalVoiceTurn?.(captured);
    });
    expect(rejected).toBeUndefined();
    act(() => rendered.result.current.replaceChat(grounded));
    await waitFor(() =>
      expect(rendered.result.current.activeChat?.groundingScopeIdentity).toBe(
        grounded.groundingScopeIdentity,
      ),
    );

    composer.resolve(completedTurn("occupy plain route", "composer-plain", plain.id));
    await act(async () => {
      await composerSend;
      await queued[0];
    });
    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      outcome = await rendered.result.current.enqueueCanonicalVoiceTurn?.(captured);
    });

    expect(outcome).toEqual({ status: "failed", retryable: false, userPersisted: true });
    const request = vi
      .mocked(sendDesktopChat)
      .mock.calls.find(([candidate]) => candidate.clientTurnId === "captured-scope-a")?.[0];
    expect(request).toMatchObject({
      chatId: plain.id,
      projectPath: plain.projectPath,
      modelId: "model-a",
      expectedGroundingScopeIdentity: plain.groundingScopeIdentity,
    });
    expect(askGrounded).not.toHaveBeenCalled();
  });

  it("keeps a Composer send bound to its chat while another project is opening", async () => {
    const originalProject = project("/repo");
    const nextProject = project("/next");
    const originalChat = chat({ projectPath: originalProject.path });
    const nextChat = chat({ id: "chat-next", projectPath: nextProject.path });
    const rendered = await setupVoiceQueueSession([originalChat], [originalProject, nextProject]);
    const projectChats = deferred<Awaited<ReturnType<typeof fetchChats>>>();
    vi.mocked(fetchChats).mockReturnValueOnce(projectChats.promise);
    vi.mocked(sendDesktopChat).mockResolvedValue(
      completedTurn("composer during project transition", "composer-project-assistant"),
    );

    let projectSwitch: Promise<void> | undefined;
    act(() => {
      projectSwitch = rendered.result.current.openProject(nextProject);
    });
    await waitFor(() => expect(rendered.result.current.activeProject?.path).toBe("/next"));

    await act(async () => {
      await rendered.result.current.sendMessage({ text: "composer during project transition" });
    });

    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
      chatId: originalChat.id,
      projectPath: originalProject.path,
    });

    projectChats.resolve({ chats: [nextChat] });
    await act(async () => {
      await projectSwitch;
    });
  });

  it("settles a durably admitted permanent model failure and advances the FIFO", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const retiredChat = chat({ selectedModel: "retired-chat-deployment" });
      const rendered = await setupVoiceQueueSession([retiredChat], [project()], []);
      const durableUser = await canonicalMessage("voice-retired-model", {
        id: "durable-retired-model-user",
        content: "final after model removal",
        role: "user",
        timestamp: 10_000,
      });
      vi.mocked(fetchChatMessages).mockResolvedValue({
        messages: [durableUser],
      });
      vi.mocked(sendDesktopChat)
        .mockRejectedValueOnce(
          new ApiError("MODEL_NOT_FOUND", "The configured chat deployment is unavailable.", 400),
        )
        .mockResolvedValueOnce({
          chat: retiredChat,
          messages: [
            message({
              id: "next-permanent-user",
              content: "next final after permanent failure",
              role: "user",
            }),
            message({
              id: "next-permanent-assistant",
              content: "Answer: next final after permanent failure",
              role: "assistant",
            }),
          ],
        });
      let first: Promise<SendMessageOutcome> | undefined;
      let second: Promise<SendMessageOutcome> | undefined;
      act(() => {
        first = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("final after model removal", "voice-retired-model", retiredChat),
        );
        second = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(
            "next final after permanent failure",
            "voice-after-retired-model",
            retiredChat,
          ),
        );
      });

      await expect(first).resolves.toEqual({
        status: "failed",
        retryable: false,
        userPersisted: true,
      });
      await expect(second).resolves.toEqual({
        status: "completed",
        assistantMessageId: "next-permanent-assistant",
      });
      expect(
        vi.mocked(sendDesktopChat).mock.calls.map(([request]) => request.clientTurnId),
      ).toEqual(["voice-retired-model", "voice-after-retired-model"]);
      expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[0]).toMatchObject({
        chatId: retiredChat.id,
        modelId: "retired-chat-deployment",
        clientTurnId: "voice-retired-model",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("does not use an older identical user message as proof of canonical admission", async () => {
    const rendered = await setupVoiceQueueSession();
    vi.mocked(sendDesktopChat).mockRejectedValue(
      new ApiError("MODEL_NOT_FOUND", "The configured chat deployment is unavailable.", 400),
    );
    vi.mocked(fetchChatMessages).mockResolvedValue({
      messages: [
        await canonicalMessage("older-provider-item", {
          id: "older-identical-user",
          content: "repeat this final",
          role: "user",
          timestamp: 1,
        }),
      ],
    });

    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      outcome = await rendered.result.current.sendMessage({
        text: "repeat this final",
        clientTurnId: "new-provider-item",
        reportOutcome: true,
      });
    });

    expect(outcome).toEqual({ status: "failed" });
    expect(rendered.result.current.messages).toContainEqual(
      expect.objectContaining({
        content: "repeat this final",
        id: expect.stringMatching(/^local-voice-/),
      }),
    );
  });

  it("suspends persisted in-progress reconciliation until an explicit exact-id retry", async () => {
    const rendered = await setupVoiceQueueSession();
    const canonicalUser = await canonicalMessage("voice-reconcile-long", {
      id: "durable-voice-user",
      content: "long reconciliation",
      role: "user",
      timestamp: 10_000,
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [canonicalUser] });
    let canonicalCompleted = false;
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      return request.clientTurnId === "voice-reconcile-long" && !canonicalCompleted
        ? Promise.reject(new ApiError("CHAT_TURN_IN_PROGRESS", "still active", 409))
        : Promise.resolve(
            completedTurn(
              request.content,
              request.clientTurnId === "voice-reconcile-long"
                ? "reconciled-assistant"
                : "bounded-next-assistant",
            ),
          );
    });
    vi.useFakeTimers();
    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      let next: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("long reconciliation", "voice-reconcile-long"),
        );
        next = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("next after bounded poll", "voice-after-bounded-poll"),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);
      expect(
        vi.mocked(sendDesktopChat).mock.calls.map(([request]) => request.clientTurnId),
      ).toEqual(["voice-reconcile-long", "voice-reconcile-long", "voice-reconcile-long"]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(sendDesktopChat).toHaveBeenCalledTimes(3);

      canonicalCompleted = true;
      act(() => {
        rendered.result.current.retryPendingCanonicalVoiceTurn?.();
      });
      await expect(delivery).resolves.toEqual({
        status: "completed",
        assistantMessageId: "reconciled-assistant",
      });
      await expect(next).resolves.toEqual({
        status: "completed",
        assistantMessageId: "bounded-next-assistant",
      });
      expect(
        vi.mocked(sendDesktopChat).mock.calls.map(([request]) => request.clientTurnId),
      ).toEqual([
        "voice-reconcile-long",
        "voice-reconcile-long",
        "voice-reconcile-long",
        "voice-reconcile-long",
        "voice-after-bounded-poll",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets an admitted Voice request finish against its captured chat after navigation", async () => {
    const chatA = chat({ id: "chat-a", updatedAt: 2 });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const rendered = await setupVoiceQueueSession([chatA, chatB]);
    const response = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat).mockReturnValue(response.promise);
    vi.mocked(fetchChatMessages).mockImplementation((chatId: string) =>
      Promise.resolve({
        messages:
          chatId === "chat-a" ? completedTurn("voice for A", "assistant-a", "chat-a").messages : [],
      }),
    );
    let delivery: Promise<SendMessageOutcome> | undefined;
    act(() => {
      delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("voice for A", "voice-chat-switch", chatA),
      );
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());
    const requestSignal = vi.mocked(sendDesktopChat).mock.calls[0]?.[1];

    await act(async () => {
      await rendered.result.current.openChat(chatB);
    });
    expect(requestSignal?.aborted).toBe(false);
    response.resolve(completedTurn("voice for A", "assistant-a", "chat-a"));
    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      outcome = await delivery;
    });

    expect(outcome).toEqual({ status: "completed", assistantMessageId: "assistant-a" });
    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    await act(async () => {
      await rendered.result.current.openChat(chatA);
    });
    expect(rendered.result.current.messages.map((candidate) => candidate.id)).toEqual([
      "assistant-a-user",
      "assistant-a",
    ]);
  });

  it("renders a reopened in-flight admitted Voice transcript exactly once", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(30_000);
    try {
      const chatA = chat({ id: "chat-a", updatedAt: 2 });
      const chatB = chat({ id: "chat-b", updatedAt: 1 });
      const rendered = await setupVoiceQueueSession([chatA, chatB]);
      const response = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
      vi.mocked(sendDesktopChat).mockReturnValue(response.promise);
      // The BFF persists the canonical user row at admission, long before generation completes;
      // a reopen while the delivery is still pending fetches that durable row.
      const durableUser = await canonicalMessage("voice-inflight-reopen", {
        id: "assistant-inflight-user",
        chatId: "chat-a",
        content: "voice while generating",
        role: "user",
        timestamp: 30_000,
      });
      vi.mocked(fetchChatMessages).mockImplementation((chatId: string) =>
        Promise.resolve({ messages: chatId === "chat-a" ? [durableUser] : [] }),
      );
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("voice while generating", "voice-inflight-reopen", chatA),
        );
      });
      await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());

      await act(async () => {
        await rendered.result.current.openChat(chatB);
      });
      await act(async () => {
        await rendered.result.current.openChat(chatA);
      });

      expect(
        rendered.result.current.messages.filter(
          (candidate) => candidate.content === "voice while generating",
        ),
      ).toHaveLength(1);

      response.resolve(completedTurn("voice while generating", "assistant-inflight", "chat-a"));
      let outcome: SendMessageOutcome | undefined;
      await act(async () => {
        outcome = await delivery;
      });
      expect(outcome).toEqual({ status: "completed", assistantMessageId: "assistant-inflight" });
      expect(
        rendered.result.current.messages.filter(
          (candidate) => candidate.content === "voice while generating",
        ),
      ).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("suppresses without swallowing a projection matched by an identical earlier turn", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(30_000);
    try {
      const chatA = chat({ id: "chat-a", updatedAt: 2 });
      const chatB = chat({ id: "chat-b", updatedAt: 1 });
      const rendered = await setupVoiceQueueSession([chatA, chatB]);
      const response = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
      vi.mocked(sendDesktopChat).mockReturnValue(response.promise);
      // A durable row from an EARLIER identical-content turn has a different scoped identity.
      // It must remain visible and cannot prove or replace the current turn's projection.
      const earlierIdenticalUser = await canonicalMessage("earlier-identical-turn", {
        id: "earlier-turn-user",
        chatId: "chat-a",
        content: "yes",
        role: "user",
        timestamp: 30_000,
      });
      vi.mocked(fetchChatMessages).mockImplementation((chatId: string) =>
        Promise.resolve({ messages: chatId === "chat-a" ? [earlierIdenticalUser] : [] }),
      );
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("yes", "voice-two-identical", chatA),
        );
      });
      await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());

      await act(async () => {
        await rendered.result.current.openChat(chatB);
      });
      await act(async () => {
        await rendered.result.current.openChat(chatA);
      });

      expect(
        rendered.result.current.messages.filter((candidate) => candidate.content === "yes"),
      ).toHaveLength(1);

      response.resolve(completedTurn("yes", "voice-two", "chat-a"));
      let outcome: SendMessageOutcome | undefined;
      await act(async () => {
        outcome = await delivery;
      });
      expect(outcome).toEqual({ status: "completed", assistantMessageId: "voice-two" });
      const userRows = rendered.result.current.messages.filter(
        (candidate) => candidate.content === "yes" && candidate.role === "user",
      );
      expect(userRows.map((candidate) => candidate.id).sort()).toEqual([
        "earlier-turn-user",
        "voice-two-user",
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("renders a durably admitted transcript once across a queue re-attempt", async () => {
    const rendered = await setupVoiceQueueSession();
    const spoken = "voice retried after a lost socket";
    // The BFF persists the canonical user row at admission, so the row outlives a transport
    // failure with an unknown commit state. Reconciliation rebuilds `messages` from that row and
    // drops the projection's local row — the queue then re-attempts the SAME turn identity.
    const durableUser = await canonicalMessage("voice-durable-retry", {
      id: "durable-retry-user",
      content: spoken,
      role: "user",
      timestamp: 30_000,
    });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [durableUser] });
    const pending = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    const sends: Array<string | undefined> = [];
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      sends.push(request.clientTurnId);
      // Attempt 1 loses the socket mid-generation (retryable, commit state unknown); attempt 2
      // never settles, so the assertions observe the state the re-attempt leaves on screen.
      return sends.length === 1
        ? Promise.reject(new TypeError("network unavailable"))
        : pending.promise;
    });
    const spokenUserRowIds = (): string[] =>
      rendered.result.current.messages
        .filter((candidate) => candidate.role === "user" && candidate.content === spoken)
        .map((candidate) => candidate.id);
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(spoken, "voice-durable-retry"),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(delivery).toBeDefined();
      expect(sends).toEqual(["voice-durable-retry"]);
      expect(spokenUserRowIds()).toEqual(["durable-retry-user"]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(sends).toHaveLength(2);
      expect(spokenUserRowIds()).toEqual(["durable-retry-user"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not surface a late grounded Voice failure in a different chat", async () => {
    const chatA = chat({
      id: "chat-a",
      updatedAt: 2,
      connectedScopes: [{ kind: "files" as const, relativePaths: ["README.md"], connectedAtMs: 1 }],
    });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const rendered = await setupVoiceQueueSession([chatA, chatB]);
    const response = deferred<Awaited<ReturnType<typeof askGrounded>>>();
    vi.mocked(askGrounded).mockReturnValue(response.promise);
    const durableUser = await canonicalMessage("grounded-chat-switch", {
      id: "grounded-chat-switch-user",
      chatId: "chat-a",
      content: "grounded voice for A",
      role: "user",
      timestamp: Date.now(),
    });
    vi.mocked(fetchChatMessages).mockImplementation((chatId: string) =>
      Promise.resolve({
        messages: chatId === "chat-a" ? [durableUser] : [],
      }),
    );

    let delivery: Promise<SendMessageOutcome> | undefined;
    act(() => {
      delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("grounded voice for A", "grounded-chat-switch", chatA),
      );
    });
    await waitFor(() => expect(askGrounded).toHaveBeenCalledOnce());
    await act(async () => {
      await rendered.result.current.openChat(chatB);
    });

    response.reject(new ApiError("GROUNDING_FAILED", "A failed after navigation.", 500));
    await act(async () => {
      await delivery;
    });

    expect(rendered.result.current.activeChat?.id).toBe("chat-b");
    expect(rendered.result.current.error).toBeUndefined();
  });

  it("accepts 128 maximum-size finals, rejects item 129, and retains the FIFO on teardown", async () => {
    vi.mocked(sendDesktopChat).mockImplementation((_request, signal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    });
    const rendered = await setupVoiceQueueSession();
    act(() => {
      void rendered.result.current.sendMessage({ text: "occupy send slot" });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());
    const maximumFinal = "q".repeat(MAX_DESKTOP_CHAT_INPUT_CHARS);
    const queued: Promise<SendMessageOutcome>[] = [];
    act(() => {
      for (let index = 0; index < 128; index += 1) {
        const promise = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(maximumFinal, `queued-id-${String(index)}`),
        );
        if (promise !== undefined) queued.push(promise);
      }
    });
    let overflow: SendMessageOutcome | undefined;
    await act(async () => {
      overflow = await rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("overflow final", "overflow-id"),
      );
    });

    expect(overflow).toBeUndefined();
    expect(queued).toHaveLength(128);
    expect(rendered.result.current.error).toContain("queue is full");
    const firstQueued = queued[0];
    let firstSettled = false;
    void firstQueued?.then(() => {
      firstSettled = true;
    });
    act(() => rendered.unmount());
    await act(async () => {
      await Promise.resolve();
    });
    expect(firstSettled).toBe(false);
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  // #2842 / ADR-0154 D4 — barge-in returns the floor to capture and advances the dialog generation,
  // so the interrupted turn can never speak. Re-sending it produces an answer nobody hears and, on
  // exhaustion, suspends the outbox. The interruption must be terminal for that utterance.
  it("keeps a barged-in spoken turn terminal and never resends it", async () => {
    const rendered = await setupVoiceQueueSession();
    const requestIds: Array<string | undefined> = [];
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockImplementation((request, signal) => {
      requestIds.push(request.clientTurnId);
      if (request.clientTurnId !== "barge-in-turn") {
        return Promise.resolve(completedTurn(request.content, "typed-assistant"));
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    });
    vi.useFakeTimers();
    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("interrupted transcript", "barge-in-turn"),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(requestIds).toEqual(["barge-in-turn"]);

      const interrupt = rendered.result.current.interruptCanonicalVoiceDelivery;
      expect(interrupt).toBeTypeOf("function");
      act(() => {
        interrupt?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      await expect(delivery).resolves.toEqual({
        status: "cancelled",
        userPersisted: false,
        interrupted: true,
      });
      expect(requestIds).toEqual(["barge-in-turn"]);
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(false);

      let typed: SendMessageOutcome | undefined;
      await act(async () => {
        typed = await rendered.result.current.sendMessage({
          text: "typed after barge-in",
          reportOutcome: true,
        });
      });
      expect(typed).toEqual({ status: "completed", assistantMessageId: "typed-assistant" });
      expect(requestIds.filter((id) => id === "barge-in-turn")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // #2842 — the interrupt is scoped by send owner exactly like openChat's abort: a typed composer
  // send is a separate user intent and must survive a barge-in untouched.
  it("leaves a typed composer send untouched when Voice barges in", async () => {
    const composer = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat).mockReturnValueOnce(composer.promise);
    const rendered = await setupVoiceQueueSession();

    let typed: Promise<SendMessageOutcome> | undefined;
    act(() => {
      typed = rendered.result.current.sendMessage({
        text: "typed while listening",
        reportOutcome: true,
      });
    });
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledOnce());

    const interrupt = rendered.result.current.interruptCanonicalVoiceDelivery;
    expect(interrupt).toBeTypeOf("function");
    act(() => {
      interrupt?.();
    });
    composer.resolve(completedTurn("typed while listening", "typed-assistant"));
    let outcome: SendMessageOutcome | undefined;
    await act(async () => {
      outcome = await typed;
    });

    expect(outcome).toEqual({ status: "completed", assistantMessageId: "typed-assistant" });
    expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[1]?.aborted).toBe(false);
    expect(rendered.result.current.sendStatus).toBe("completed");
  });

  // #2842 — the outbox is module-global, but its suspension must not be. One chat's wedged spoken
  // turn cannot disable typed sending in every other chat on the page.
  it("keeps typed sending alive in another chat while one chat's spoken turn is wedged", async () => {
    const chatA = chat({ id: "chat-a", updatedAt: 2 });
    const chatB = chat({ id: "chat-b", updatedAt: 1 });
    const rendered = await setupVoiceQueueSession([chatA, chatB]);
    const requestIds: Array<string | undefined> = [];
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      requestIds.push(request.clientTurnId);
      if (request.clientTurnId === "wedged-a") {
        return Promise.reject(new TypeError("network unavailable"));
      }
      return Promise.resolve(completedTurn(request.content, "typed-b-assistant", request.chatId));
    });
    vi.useFakeTimers();
    try {
      act(() => {
        void rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("wedged spoken turn", "wedged-a", chatA),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(requestIds).toEqual(["wedged-a", "wedged-a", "wedged-a"]);
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);

      await act(async () => {
        await rendered.result.current.openChat(chatB);
      });
      expect(rendered.result.current.activeChat?.id).toBe("chat-b");
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(false);

      let typed: SendMessageOutcome | undefined;
      await act(async () => {
        typed = await rendered.result.current.sendMessage({
          text: "typed in B",
          reportOutcome: true,
        });
      });
      expect(typed).toEqual({ status: "completed", assistantMessageId: "typed-b-assistant" });
      expect(requestIds.at(-1)).not.toBe("wedged-a");
    } finally {
      vi.useRealTimers();
    }
  });

  // #2842 — a wedged turn needs an actionable escape hatch next to the retry, otherwise the owning
  // chat's composer stays dead for as long as the delivery keeps failing.
  it("discards a wedged spoken turn so its own chat can send typed messages again", async () => {
    const rendered = await setupVoiceQueueSession();
    const sentinel = "wedged spoken sentinel 6f1c9a";
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockImplementation((request) => {
      if (request.clientTurnId === "wedged-discard") {
        return Promise.reject(new TypeError("network unavailable"));
      }
      return Promise.resolve(completedTurn(request.content, "typed-assistant"));
    });
    vi.useFakeTimers();
    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn(sentinel, "wedged-discard"),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(true);

      let blocked: SendMessageOutcome | undefined;
      await act(async () => {
        blocked = await rendered.result.current.sendMessage({
          text: "typed while wedged",
          reportOutcome: true,
        });
      });
      expect(blocked).toEqual({ status: "not-sent" });
      expect(rendered.result.current.error).toContain("spoken turn is still pending");

      const discard = rendered.result.current.discardPendingCanonicalVoiceTurn;
      expect(discard).toBeTypeOf("function");
      act(() => {
        discard?.();
      });

      await expect(delivery).resolves.toEqual({
        status: "cancelled",
        userPersisted: false,
        interrupted: true,
      });
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(false);
      expect(rendered.result.current.error).toBeUndefined();
      expect(canonicalVoicePageOutboxRetainsPlaintextForTests(sentinel)).toBe(false);

      let typed: SendMessageOutcome | undefined;
      await act(async () => {
        typed = await rendered.result.current.sendMessage({
          text: "typed after discard",
          reportOutcome: true,
        });
      });
      expect(typed).toEqual({ status: "completed", assistantMessageId: "typed-assistant" });
    } finally {
      vi.useRealTimers();
    }
  });

  // #2842 — discarding the turn whose request is already on the wire must stop that request too;
  // paying for an answer the user has just thrown away is the same waste barge-in produces.
  it("stops the request when the discarded spoken turn owns the active delivery", async () => {
    const rendered = await setupVoiceQueueSession();
    const requestIds: Array<string | undefined> = [];
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
    vi.mocked(sendDesktopChat).mockImplementation((request, signal) => {
      requestIds.push(request.clientTurnId);
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    });
    vi.useFakeTimers();
    try {
      let delivery: Promise<SendMessageOutcome> | undefined;
      act(() => {
        delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
          canonicalVoiceTurn("discard while in flight", "discard-in-flight"),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(requestIds).toEqual(["discard-in-flight"]);

      act(() => {
        rendered.result.current.discardPendingCanonicalVoiceTurn?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(vi.mocked(sendDesktopChat).mock.calls[0]?.[1]?.aborted).toBe(true);
      await expect(delivery).resolves.toEqual({
        status: "cancelled",
        userPersisted: false,
        interrupted: true,
      });
      expect(requestIds).toEqual(["discard-in-flight"]);
      expect(rendered.result.current.canonicalVoiceTurnRequiresRetry).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects ownership without a server-issued scope identity before any canonical request", async () => {
    const unprojected = chat({ groundingScopeIdentity: undefined });
    const rendered = await setupVoiceQueueSession([unprojected]);

    let delivery: Promise<SendMessageOutcome> | undefined;
    act(() => {
      delivery = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("retain until chat reload", "missing-scope-token", unprojected),
      );
    });

    expect(delivery).toBeUndefined();
    await waitFor(() =>
      expect(rendered.result.current.error).toContain("scope could not be frozen"),
    );
    expect(sendDesktopChat).not.toHaveBeenCalled();
    expect(askGrounded).not.toHaveBeenCalled();
  });

  // KEIKO-0485 — ADR-0154 D1 characterization pin. The canonical Voice FIFO captures the memory
  // request at enqueue time and delivers it verbatim; a memory-settings change made after the turn
  // was queued does NOT retroactively rewrite the queued turn's memory (or its target modelId).
  // This test exists so a future change cannot silently start re-deriving settings at drain time —
  // that would directly contradict ADR-0154 D1's accepted "immutable target captured during
  // handoff" text and needs an ADR amendment, not a quiet behavior change.
  it("pins the memory request captured at enqueue time even if settings change before drain", async () => {
    const rendered = await setupVoiceQueueSession();
    const settings = renderHook(() => useConversationMemorySettings());
    await waitFor(() => expect(rendered.result.current.loading).toBe(false));

    // Initial settings at ENQUEUE time for the target turn.
    act(() => {
      settings.result.current.setMemoryEnabled(true);
      settings.result.current.setMemoryBudgetTokens(1234);
      settings.result.current.setMemoryMode("supervised-coding");
    });

    // Codex on PR #3089 (3764952038): to actually catch a regression that moves memory capture
    // from enqueue time to drain time, the target turn has to sit in the FIFO — behind an earlier
    // turn — while settings change. A deferred sendDesktopChat delays only the RESPONSE, not
    // queue advancement, so the target's request object was constructed pre-mutation regardless
    // of when the derivation actually runs. Block the FIFO with a prior turn instead.
    const blockerGate = deferred<Awaited<ReturnType<typeof sendDesktopChat>>>();
    vi.mocked(sendDesktopChat)
      .mockImplementationOnce(async () => blockerGate.promise as never)
      .mockImplementationOnce(async () =>
        completedTurn("pinned memory turn", "memory-pin-assistant"),
      );

    let blocker: Promise<SendMessageOutcome> | undefined;
    let target: Promise<SendMessageOutcome> | undefined;
    act(() => {
      blocker = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("blocker turn", "voice-memory-blocker"),
      );
      target = rendered.result.current.enqueueCanonicalVoiceTurn?.(
        canonicalVoiceTurn("pinned memory turn", "voice-memory-pin"),
      );
    });
    // The FIFO drains one at a time; the target must still be queued behind the blocker.
    await waitFor(() => expect(sendDesktopChat).toHaveBeenCalledTimes(1));

    // Mutate every memory input WHILE the target sits in the FIFO. A re-derivation at drain
    // time would land these values on the pending turn — the pin exists to prove that never
    // happens.
    act(() => {
      settings.result.current.setMemoryEnabled(false);
      settings.result.current.setMemoryBudgetTokens(9999);
      settings.result.current.setMemoryMode("autonomous-delivery");
    });

    // Release the blocker so the target advances through the FIFO — the derivation, if any,
    // would run now, under the mutated settings.
    blockerGate.resolve(completedTurn("blocker turn", "blocker-assistant"));
    await act(async () => {
      await blocker;
      await target;
    });

    // KfQ 3765528715: pin that both the blocker AND the target actually reached the wire — if the
    // target never drained, `targetRequest?.memory` would be `undefined` and every `not.toMatchObject`
    // assertion would trivially pass, hiding a regression that stopped draining the queue.
    expect(sendDesktopChat).toHaveBeenCalledTimes(2);
    // The target turn is the SECOND sendDesktopChat call.
    const targetRequest = vi.mocked(sendDesktopChat).mock.calls[1]?.[0];
    // ADR-0154 D1: memory captured at enqueue time survives every intervening settings change,
    // even when drain happens after the change.
    expect(targetRequest?.memory).toMatchObject({
      enabled: true,
      budgetTokens: 1234,
      mode: "supervised-coding",
      surface: "voice",
    });
    expect(targetRequest?.memory).not.toMatchObject({ enabled: false });
    expect(targetRequest?.memory).not.toMatchObject({ budgetTokens: 9999 });
    expect(targetRequest?.memory).not.toMatchObject({ mode: "autonomous-delivery" });
  });
});

describe("useChatSession memory autonomy hydration", () => {
  function mockMinimalBootstrap(): void {
    vi.mocked(fetchModels).mockResolvedValue({ models: [model({ id: "chat-live" })] });
    vi.mocked(fetchProjects).mockResolvedValue({ projects: [project("/repo")] });
    vi.mocked(fetchChats).mockResolvedValue({ chats: [] });
    vi.mocked(fetchChatMessages).mockResolvedValue({ messages: [] });
  }

  it("applies the persisted mode on mount", async () => {
    mockMinimalBootstrap();
    vi.mocked(loadMemoryAutonomyMode).mockResolvedValue({
      requestedMode: "autonomous-delivery",
      effectiveMode: "autonomous-delivery",
      deploymentCeiling: "autonomous-delivery",
      revision: 1,
    });

    renderHook(() => useChatSession({ autoCreate: false }));
    const settings = renderHook(() => useConversationMemorySettings());

    await waitFor(() => expect(settings.result.current.memoryMode).toBe("autonomous-delivery"));
  });

  it("shares one in-flight policy hydration across concurrent session mounts", async () => {
    mockMinimalBootstrap();
    const hydration = deferred<{
      requestedMode: "supervised-coding";
      effectiveMode: "supervised-coding";
      deploymentCeiling: "supervised-coding";
      revision: number;
    }>();
    vi.mocked(loadMemoryAutonomyMode).mockReturnValue(hydration.promise);

    renderHook(() => useChatSession({ autoCreate: false }));
    renderHook(() => useChatSession({ autoCreate: false }));

    expect(loadMemoryAutonomyMode).toHaveBeenCalledOnce();
    await act(async () => {
      hydration.resolve({
        requestedMode: "supervised-coding",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        revision: 1,
      });
      await hydration.promise;
    });
  });

  it("does not let a stale hydration response overwrite a newer selection", async () => {
    mockMinimalBootstrap();
    const hydration = deferred<{
      requestedMode: "supervised-coding";
      effectiveMode: "supervised-coding";
      deploymentCeiling: "supervised-coding";
      revision: number;
    }>();
    vi.mocked(loadMemoryAutonomyMode).mockReturnValue(hydration.promise);

    renderHook(() => useChatSession({ autoCreate: false }));
    const settings = renderHook(() => useConversationMemorySettings());

    act(() => {
      settings.result.current.setMemoryMode("autonomous-delivery");
    });

    await act(async () => {
      hydration.resolve({
        requestedMode: "supervised-coding",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        revision: 0,
      });
      await hydration.promise;
    });

    expect(settings.result.current.memoryMode).toBe("autonomous-delivery");
  });

  it("does not let an ABA mode change disguise a stale hydration response", async () => {
    mockMinimalBootstrap();
    const hydration = deferred<{
      requestedMode: "supervised-coding";
      effectiveMode: "supervised-coding";
      deploymentCeiling: "supervised-coding";
      revision: number;
    }>();
    vi.mocked(loadMemoryAutonomyMode).mockReturnValue(hydration.promise);

    renderHook(() => useChatSession({ autoCreate: false }));
    const settings = renderHook(() => useConversationMemorySettings());

    act(() => {
      settings.result.current.setMemoryMode("autonomous-delivery");
      settings.result.current.setMemoryMode("governed-assist");
    });

    await act(async () => {
      hydration.resolve({
        requestedMode: "supervised-coding",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        revision: 0,
      });
      await hydration.promise;
    });

    expect(settings.result.current.memoryMode).toBe("governed-assist");
  });

  it("fails closed to the default mode without console output when hydration fails", async () => {
    mockMinimalBootstrap();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadMemoryAutonomyMode).mockRejectedValue(new Error("network unavailable"));

    const { result } = renderHook(() => useChatSession({ autoCreate: false }));
    const settings = renderHook(() => useConversationMemorySettings());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(settings.result.current.memoryMode).toBe("governed-assist");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
