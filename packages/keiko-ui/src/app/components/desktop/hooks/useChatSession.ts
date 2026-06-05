"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  askGrounded,
  createDesktopChat,
  createProject,
  fetchChatMessages,
  fetchChats,
  fetchModels,
  fetchProjects,
  sendDesktopChat,
} from "@/lib/api";
import type {
  Chat,
  ChatMessage,
  GroundedAnswer as GroundedAnswerWire,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";
import { isConversationEligibleModel } from "@/lib/types";

// ─── Attachment types (Issue #147) ────────────────────────────────────────────
//
// Client-side validation only. Server-side modality enforcement is deferred to
// issue #149. Pending attachments are cleared on successful sendMessage.

export type PendingAttachmentKind = "image" | "document";

// Why: attachment rejection reasons are a closed, typed union so callers can
// show human-readable messages per reason without string matching.
export type AttachmentRejectionReason =
  | "text-only-model" // model capability forbids this attachment kind
  | "unsupported-type" // MIME not in the image/* / document allowlist
  | "oversized" // exceeds MAX_ATTACHMENT_BYTES (8 MiB)
  | "empty"; // file.size === 0

export interface PendingAttachment {
  readonly id: string;
  readonly kind: PendingAttachmentKind;
  // file.name only — NEVER the full path (AC #4)
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  // Defined for image kind; undefined for document kind (AC #4 — no path leaked)
  readonly previewDataUrl?: string | undefined;
}

// Hard 8 MiB byte limit. Server enforces its own limit in #149; this client-side
// gate provides immediate feedback without a round-trip.
export const MAX_ATTACHMENT_BYTES = 8_388_608; // 8 MiB

// Document MIME allowlist. `text/*` covers plain text, markdown, CSV, etc.
// Specific application/* types are whitelisted individually.
const DOCUMENT_MIME_PREFIXES = ["text/"] as const;
const DOCUMENT_MIME_ALLOWLIST = new Set([
  "application/pdf",
  "application/json",
  "application/x-yaml",
  "application/yaml",
]);

function classifyMime(mimeType: string): PendingAttachmentKind | "unsupported-type" {
  if (mimeType.startsWith("image/")) return "image";
  if (DOCUMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return "document";
  if (DOCUMENT_MIME_ALLOWLIST.has(mimeType)) return "document";
  return "unsupported-type";
}

function readDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}

export const DEFAULT_CHAT_TITLE = "New chat";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

function sortChats(chats: readonly Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Returns the id of the first eligible model, or undefined when no models are
// available. Callers must NOT fall back to a placeholder id — downstream
// surfaces branch on undefined to show a clear "no model" error (AC #1 / #4).
export function pickChatModelId(models: readonly ModelCapability[]): string | undefined {
  return models[0]?.id;
}

export type ChatSessionApi = UseChatSessionResult;

export interface UseChatSessionResult {
  projects: ProjectWithAvailability[];
  chats: Chat[];
  messages: ChatMessage[];
  models: ModelCapability[];
  activeProject: ProjectWithAvailability | undefined;
  activeChat: Chat | undefined;
  // undefined when no conversation-eligible model is configured (AC #1 / #4).
  // Downstream surfaces must render an accessible error and block submission.
  selectedModel: string | undefined;
  // true when loading is complete and no eligible model is available.
  noEligibleModels: boolean;
  draft: string;
  loading: boolean;
  sending: boolean;
  error: string | undefined;
  setDraft: (value: string) => void;
  setSelectedModel: (id: string) => void;
  openNewChat: (project?: ProjectWithAvailability) => Promise<void>;
  openProject: (project: ProjectWithAvailability) => Promise<void>;
  openChat: (chat: Chat) => Promise<void>;
  addProject: (path: string) => Promise<void>;
  sendMessage: () => Promise<void>;
  // Issue #184 — replaces the cached Chat after a wire mutation (e.g. connected-scope PATCH).
  // The caller is the API client wrapper; the hook only owns the local cache update so the
  // chat header re-renders with the new state without a full refetch.
  replaceChat: (chat: Chat) => void;
  // Issue #185 — the most recent grounded answer (citations + uncertainty) the ChatWindow
  // renders alongside the assistant message bubble. undefined when the active chat has no
  // connectedScope or no grounded turn has happened yet.
  latestGrounded: GroundedAnswerWire | undefined;
  // Issue #185 AC3 — aborts the in-flight grounded request and clears the sending state.
  // No-op when no grounded request is in flight.
  cancelGrounded: () => void;
  // Issue #147 — client-side attachment intake (AC #1–#4).
  // Server-side enforcement is deferred to #149.
  readonly pendingAttachments: readonly PendingAttachment[];
  readonly addPendingAttachment: (
    file: File,
  ) => Promise<{ ok: true } | { ok: false; reason: AttachmentRejectionReason }>;
  readonly removePendingAttachment: (id: string) => void;
  readonly clearPendingAttachments: () => void;
}

interface SessionState {
  projects: ProjectWithAvailability[];
  chats: Chat[];
  messages: ChatMessage[];
  models: ModelCapability[];
  activeProject: ProjectWithAvailability | undefined;
  activeChat: Chat | undefined;
  selectedModel: string | undefined;
}

const INITIAL_STATE: SessionState = {
  projects: [],
  chats: [],
  messages: [],
  models: [],
  activeProject: undefined,
  activeChat: undefined,
  selectedModel: undefined,
};

async function bootstrapSession(): Promise<Partial<SessionState>> {
  const modelPayload = await fetchModels().catch(() => ({ models: [] }));
  // Issue #144: source of truth is the helper, not an inline kind check. Pin
  // ACs #1 / #2 — only chat-eligible models reach the conversation dropdown.
  const chatModels = modelPayload.models.filter(isConversationEligibleModel);
  const defaultModel = pickChatModelId(chatModels);

  const projectPayload = await fetchProjects().catch(() => ({ projects: [] }));
  const project =
    projectPayload.projects.find((item) => item.available) ?? projectPayload.projects[0];

  if (project !== undefined) {
    const chatPayload = await fetchChats(project.path).catch(() => ({ chats: [] }));
    const sortedChats = sortChats(chatPayload.chats);
    const latestChat = sortedChats[0];
    if (latestChat !== undefined) {
      const messagePayload = await fetchChatMessages(latestChat.id, project.path);
      return {
        models: chatModels,
        selectedModel: latestChat.selectedModel,
        projects: Array.from(projectPayload.projects),
        activeProject: project,
        chats: sortedChats,
        activeChat: latestChat,
        messages: Array.from(messagePayload.messages),
      };
    }
  }

  // AC #1: when no eligible model exists, set selectedModel to undefined so
  // downstream surfaces show a clear error instead of a placeholder id.
  if (defaultModel === undefined) {
    return {
      models: chatModels,
      selectedModel: undefined,
      projects: Array.from(projectPayload.projects),
      activeProject: project,
      chats: [],
      activeChat: undefined,
      messages: [],
    };
  }
  const input: { modelId: string; title: string; projectPath?: string } = {
    modelId: defaultModel,
    title: DEFAULT_CHAT_TITLE,
  };
  if (project?.available === true) input.projectPath = project.path;
  const created = await createDesktopChat(input);
  return {
    models: chatModels,
    selectedModel: created.chat.selectedModel,
    projects: Array.from(created.projects),
    activeProject: created.project,
    chats: sortChats(created.chats),
    activeChat: created.chat,
    messages: Array.from(created.messages),
  };
}

export function useChatSession(): UseChatSessionResult {
  const [state, setState] = useState<SessionState>(INITIAL_STATE);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Issue #185 — most recent grounded answer for the active chat. Cleared when the active
  // chat changes (see openChat) so a stale answer never overhangs into another conversation.
  const [latestGrounded, setLatestGrounded] = useState<GroundedAnswerWire | undefined>();
  // Issue #185 AC3 — holds the AbortController for the current grounded request so the UI
  // can cancel in-flight requests. null when no grounded request is in flight.
  const groundedControllerRef = useRef<AbortController | null>(null);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  // Issue #147 — pending-attachment state. Cleared after a successful send (AC #3).
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachment[]>([]);

  // addPendingAttachment validates MIME type, model capability, and byte limit before
  // adding the attachment to state. Returns ok:false + reason on rejection (AC #1/#2).
  // Never throws — rejections are surfaced as a typed result so callers can render a
  // role="alert" message (AC #2 / Part 2 implementation).
  const addPendingAttachment = useCallback(
    async (
      file: File,
    ): Promise<{ ok: true } | { ok: false; reason: AttachmentRejectionReason }> => {
      if (file.size === 0) return { ok: false, reason: "empty" };
      if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "oversized" };

      const kind = classifyMime(file.type);
      if (kind === "unsupported-type") return { ok: false, reason: "unsupported-type" };

      // AC #1: validate against the selected model's capabilities. Read state.models
      // and state.selectedModel inline so no stale closure issues.
      const selectedModelCapability = state.models.find((m) => m.id === state.selectedModel);
      if (selectedModelCapability !== undefined) {
        if (kind === "image" && !selectedModelCapability.supportsImageInput) {
          return { ok: false, reason: "text-only-model" };
        }
        if (kind === "document" && !selectedModelCapability.supportsDocumentInput) {
          return { ok: false, reason: "text-only-model" };
        }
      }

      // AC #4: generate previewDataUrl for images only; never store file.path.
      let previewDataUrl: string | undefined;
      if (kind === "image") {
        previewDataUrl = await readDataUrl(file);
      }

      const attachment: PendingAttachment = {
        id: crypto.randomUUID(),
        kind,
        name: file.name, // file.name is basename only — no path component (AC #4)
        mimeType: file.type,
        sizeBytes: file.size,
        previewDataUrl,
      };
      setPendingAttachments((previous) => [...previous, attachment]);
      return { ok: true };
    },
    [state.models, state.selectedModel],
  );

  // AC #3: remove a single pending attachment by id.
  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((previous) => previous.filter((a) => a.id !== id));
  }, []);

  // Clears all pending attachments (called after successful sendMessage).
  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments([]);
  }, []);

  useEffect(() => {
    activeChatIdRef.current = state.activeChat?.id;
  }, [state.activeChat?.id]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      setLoading(true);
      setError(undefined);
      try {
        const patch = await bootstrapSession();
        if (!cancelled) setState((previous) => ({ ...previous, ...patch }));
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      groundedControllerRef.current?.abort();
    };
  }, []);

  const setSelectedModel = useCallback((id: string) => {
    setState((previous) => ({ ...previous, selectedModel: id }));
  }, []);

  const openNewChat = useCallback(
    async (projectOverride?: ProjectWithAvailability): Promise<void> => {
      if (state.selectedModel === undefined) {
        setError("No conversation-eligible model is configured. Connect a gateway in Settings.");
        return;
      }
      setError(undefined);
      try {
        const input: { modelId: string; title: string; projectPath?: string } = {
          modelId: state.selectedModel,
          title: DEFAULT_CHAT_TITLE,
        };
        const targetPath = projectOverride?.path ?? state.activeProject?.path;
        if (targetPath !== undefined) input.projectPath = targetPath;
        const created = await createDesktopChat(input);
        activeChatIdRef.current = created.chat.id;
        setState({
          projects: Array.from(created.projects),
          chats: sortChats(created.chats),
          messages: Array.from(created.messages),
          models: state.models,
          activeProject: created.project,
          activeChat: created.chat,
          selectedModel: created.chat.selectedModel,
        });
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [state.selectedModel, state.activeProject, state.models],
  );

  const openProject = useCallback(
    async (project: ProjectWithAvailability): Promise<void> => {
      setError(undefined);
      setState((previous) => ({ ...previous, activeProject: project }));
      try {
        const chatPayload = await fetchChats(project.path);
        const sorted = sortChats(chatPayload.chats);
        const latest = sorted[0];
        if (latest === undefined) {
          await openNewChat(project);
          return;
        }
        const messagePayload = await fetchChatMessages(latest.id, project.path);
        activeChatIdRef.current = latest.id;
        setState((previous) => ({
          ...previous,
          chats: sorted,
          activeChat: latest,
          selectedModel: latest.selectedModel,
          messages: Array.from(messagePayload.messages),
        }));
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [openNewChat],
  );

  const openChat = useCallback(async (chat: Chat): Promise<void> => {
    setError(undefined);
    groundedControllerRef.current?.abort();
    groundedControllerRef.current = null;
    activeChatIdRef.current = chat.id;
    // Issue #185 — clear any prior grounded answer so the new chat doesn't render stale
    // citations from a previous conversation's last grounded turn.
    setLatestGrounded(undefined);
    try {
      const messagePayload = await fetchChatMessages(chat.id, chat.projectPath);
      setState((previous) => {
        const project = previous.projects.find((item) => item.path === chat.projectPath);
        return {
          ...previous,
          activeProject: project,
          activeChat: chat,
          selectedModel: chat.selectedModel,
          messages: Array.from(messagePayload.messages),
        };
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const addProject = useCallback(
    async (path: string): Promise<void> => {
      const trimmed = path.trim();
      if (trimmed.length === 0) return;
      setError(undefined);
      try {
        const created = await createProject({ path: trimmed });
        const projectPayload = await fetchProjects();
        setState((previous) => ({ ...previous, projects: Array.from(projectPayload.projects) }));
        await openNewChat(created.project);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [openNewChat],
  );

  const sendUngrounded = useCallback(
    async (
      chat: Chat,
      project: ProjectWithAvailability,
      content: string,
      optimisticId: string,
      modelId: string,
    ) => {
      try {
        const result = await sendDesktopChat({
          chatId: chat.id,
          projectPath: project.path,
          content,
          modelId,
        });
        setState((previous) => ({
          ...previous,
          activeChat: result.chat,
          chats: sortChats([
            result.chat,
            ...previous.chats.filter((existing) => existing.id !== result.chat.id),
          ]),
          messages: [
            ...previous.messages.filter((message) => message.id !== optimisticId),
            ...Array.from(result.messages),
          ],
        }));
      } catch (caught) {
        setError(errorMessage(caught));
        try {
          const messagePayload = await fetchChatMessages(chat.id, project.path);
          setState((previous) => ({ ...previous, messages: Array.from(messagePayload.messages) }));
        } catch {
          setState((previous) => ({
            ...previous,
            messages: previous.messages.filter((message) => message.id !== optimisticId),
          }));
        }
      }
    },
    [],
  );

  // Issue #185 — when the active chat carries a connectedScope binding the composer routes the
  // submission through the grounded BFF orchestrator instead of the gateway-backed chat path.
  // The route persists both messages and returns the redacted citation projection; the hook
  // refetches the message log on success so the bubbles reflect the canonical store state.
  const sendGrounded = useCallback(
    async (
      chat: Chat,
      project: ProjectWithAvailability,
      content: string,
      optimisticId: string,
      modelId: string,
    ) => {
      // Copilot PR #258 finding: clear the previous answer at the START of a new send so a
      // stale citation block doesn't briefly flash next to the new question.
      setLatestGrounded(undefined);
      const controller = new AbortController();
      groundedControllerRef.current = controller;
      try {
        const result = await askGrounded({ chatId: chat.id, content, modelId }, controller.signal);
        if (activeChatIdRef.current !== chat.id) {
          return;
        }
        setLatestGrounded(result);
        // Refresh BOTH messages AND chats so the sidebar reflects the new updated_at and
        // re-sorts the active chat to the top after the assistant reply lands.
        const [messagePayload, chatsPayload] = await Promise.all([
          fetchChatMessages(chat.id, project.path),
          fetchChats(project.path),
        ]);
        const refreshedActive = chatsPayload.chats.find((c) => c.id === chat.id);
        setState((previous) => ({
          ...previous,
          messages: Array.from(messagePayload.messages),
          chats: sortChats(chatsPayload.chats),
          activeChat: refreshedActive ?? previous.activeChat,
        }));
      } catch (caught) {
        // Aborted requests are not errors from the user's perspective — clear state silently.
        if (caught instanceof DOMException && caught.name === "AbortError") {
          setState((previous) => ({
            ...previous,
            messages: previous.messages.filter((message) => message.id !== optimisticId),
          }));
          return;
        }
        setError(errorMessage(caught));
        setState((previous) => ({
          ...previous,
          messages: previous.messages.filter((message) => message.id !== optimisticId),
        }));
      } finally {
        groundedControllerRef.current = null;
      }
    },
    [],
  );

  // Issue #185 AC3 — exposed to the UI so the cancel button can abort in-flight grounded
  // requests. Sets sending=false without persisting anything.
  const cancelGrounded = useCallback(() => {
    groundedControllerRef.current?.abort();
    groundedControllerRef.current = null;
    setSending(false);
  }, []);

  const sendMessage = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    const chat = state.activeChat;
    const project = state.activeProject;
    const modelId = state.selectedModel;
    // AC #1: block submission when no eligible model is configured.
    if (
      content.length === 0 ||
      chat === undefined ||
      project === undefined ||
      modelId === undefined
    )
      return;
    const optimistic: ChatMessage = {
      id: `local-${String(Date.now())}`,
      chatId: chat.id,
      role: "user",
      content,
      timestamp: Date.now(),
      runId: undefined,
      workflowId: undefined,
      workflowStatus: undefined,
      shortResult: undefined,
      taskType: undefined,
    };
    setDraft("");
    setSending(true);
    setError(undefined);
    setState((previous) => ({ ...previous, messages: [...previous.messages, optimistic] }));
    try {
      if (chat.connectedScope !== undefined) {
        await sendGrounded(chat, project, content, optimistic.id, modelId);
      } else {
        await sendUngrounded(chat, project, content, optimistic.id, modelId);
      }
      // AC #3: clear pending attachments after a successful send.
      clearPendingAttachments();
    } finally {
      setSending(false);
    }
  }, [
    draft,
    state.activeChat,
    state.activeProject,
    state.selectedModel,
    sendGrounded,
    sendUngrounded,
    clearPendingAttachments,
  ]);

  // Issue #184 — local cache update after a connected-scope PATCH (or any other surgical wire
  // mutation on the active Chat). Only the matched id is updated; the chat list keeps its
  // existing sort order so the pill flip is non-disruptive. activeChat is rewritten when its
  // id matches so the header re-renders with the new ChatConnectedScope.
  const replaceChat = useCallback((chat: Chat) => {
    setState((previous) => ({
      ...previous,
      chats: previous.chats.map((existing) => (existing.id === chat.id ? chat : existing)),
      activeChat: previous.activeChat?.id === chat.id ? chat : previous.activeChat,
    }));
  }, []);

  return {
    projects: state.projects,
    chats: state.chats,
    messages: state.messages,
    models: state.models,
    activeProject: state.activeProject,
    activeChat: state.activeChat,
    selectedModel: state.selectedModel,
    noEligibleModels: !loading && state.selectedModel === undefined,
    draft,
    loading,
    sending,
    error,
    setDraft,
    setSelectedModel,
    openNewChat,
    openProject,
    openChat,
    addProject,
    sendMessage,
    replaceChat,
    latestGrounded,
    cancelGrounded,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
    clearPendingAttachments,
  };
}
