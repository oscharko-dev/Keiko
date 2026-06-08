"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  startChatRun,
  updateChat,
} from "@/lib/api";
import { acceptMemoryProposal, rejectMemoryProposal } from "@/lib/memory-api";
import { findChatWorkflow } from "@/lib/chat-workflow-catalog";
import { isWorkflowEligibleModel } from "@/lib/workflow-eligibility";
import type {
  Chat,
  ChatMessage,
  ConversationMemoryRequestWire,
  ConversationMemoryResultWire,
  ConversationBudgetEstimate,
  GroundedAnswer as GroundedAnswerWire,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";
import { estimateConversationBudget, isConversationEligibleModel } from "@/lib/types";

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

// COMP-5: true when the model identified by `modelId` accepts the attachment's
// kind. A model that is absent from `models` (unresolved) is treated as
// permissive so we never silently drop a chip during a transient bootstrap gap.
function isAttachmentSupported(
  attachment: PendingAttachment,
  modelId: string,
  models: readonly ModelCapability[],
): boolean {
  const capability = models.find((m) => m.id === modelId);
  if (capability === undefined) return true;
  if (attachment.kind === "image") return capability.supportsImageInput;
  return capability.supportsDocumentInput;
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
export const DEFAULT_CONVERSATION_MEMORY_USER_ID = "local-operator";
export const DEFAULT_MEMORY_BUDGET_TOKENS = 1200;

// Issue #152 — conversation request lifecycle states (memory keiko-issue66).
// `idle` is the resting state; `queued` is set the moment sendMessage commits
// to a submission (synchronously, so concurrent calls observe it via the ref
// guard); `contacting` is the wait for the first byte from the gateway;
// `streaming` is reserved for the streaming-delta UX (today the backend send
// is non-streaming so we transition from contacting → completed directly, see
// Part 4 of the spec). `completed | failed | cancelled` are terminal —
// sendMessage re-arms to idle in those terminal cases on the next render.
//
// Engineering note: NO fake progress percentage. The status string is the
// only progress signal — UI copy must reflect that.
export type SendStatus =
  | "idle"
  | "queued"
  | "contacting"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL_SEND_STATUSES: readonly SendStatus[] = ["completed", "failed", "cancelled"] as const;

// True when the hook is mid-flight — i.e. between sendMessage entry and any
// terminal state. Exposed via the `sending` derived flag for backwards
// compatibility with existing call sites.
export function isInFlight(status: SendStatus): boolean {
  return status !== "idle" && !TERMINAL_SEND_STATUSES.includes(status);
}

// Issue #151 / AC#3 — user-facing copy when a provider or BFF error reports the
// conversation exceeded the model's context window. Exported so the test can
// pin the exact string without duplicating it.
export const CONTEXT_OVERSIZED_USER_MESSAGE =
  "The conversation context exceeded the model's window. Clear history or pick a larger-context model.";

// A typed BFF overflow surfaces under the conversation-layer code; a raw provider
// overflow surfaces under the gateway-layer code (CB-F2). Both map to the single
// actionable user message below.
const CONTEXT_OVERSIZED_API_CODES = new Set([
  "CONVERSATION_OVERSIZED_CONTEXT",
  "GATEWAY_CONTEXT_OVERFLOW",
]);
const CONTEXT_OVERSIZED_PHRASES = [
  "context length",
  "context_length_exceeded",
  "max_tokens",
  "too many tokens",
] as const;

function isContextOversizedError(error: unknown): boolean {
  if (error instanceof ApiError && CONTEXT_OVERSIZED_API_CODES.has(error.code)) return true;
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.length === 0) return false;
  return CONTEXT_OVERSIZED_PHRASES.some((phrase) => text.includes(phrase));
}

// CB-F1 / CB-F3 — the single unknown-limits-safe "over budget" predicate. A
// model with contextWindowTokens <= 0 (runtime-configured, unknown window) is
// NEVER treated as exceeded, mirroring BudgetIndicator's own self-hide guard.
export function isBudgetExceeded(budget: ConversationBudgetEstimate | undefined): boolean {
  return budget !== undefined && budget.contextWindowTokens > 0 && budget.pressure === "exceeded";
}

function errorMessage(error: unknown): string {
  // AC#3 — context-overflow provider errors map to a single actionable message.
  if (isContextOversizedError(error)) return CONTEXT_OVERSIZED_USER_MESSAGE;
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
  return models.find(isConversationEligibleModel)?.id;
}

// Reopened chats can persist a model id that is no longer present in the
// current eligible model list. Fail closed to a live eligible model, or to
// undefined so the UI blocks sends with the no-model alert.
export function resolveSelectedModelId(
  current: string | undefined,
  models: readonly ModelCapability[],
): string | undefined {
  if (
    current !== undefined &&
    models.some((model) => model.id === current && isConversationEligibleModel(model))
  ) {
    return current;
  }
  return pickChatModelId(models);
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
  // Issue #152 — derived: `sending = isInFlight(sendStatus)`. Kept for
  // backwards compatibility with call sites that only branch on "is a request
  // in flight" without caring about the lifecycle state name.
  sending: boolean;
  // Issue #152 — fine-grained conversation request lifecycle (memory
  // keiko-issue66). UI surfaces use this to render the right wait message and
  // to gate cancellation.
  sendStatus: SendStatus;
  error: string | undefined;
  setDraft: (value: string) => void;
  setSelectedModel: (id: string) => void;
  openNewChat: (project?: ProjectWithAvailability) => Promise<void>;
  openProject: (project: ProjectWithAvailability) => Promise<void>;
  openChat: (chat: Chat) => Promise<void>;
  addProject: (path: string) => Promise<void>;
  sendMessage: () => Promise<void>;
  // Issue #152 — cancel the in-flight send (grounded OR ungrounded). No-op
  // when sendStatus is terminal/idle. Sets sendStatus to "cancelled" and
  // preserves the user message so the user can retry without retyping.
  // Per AC#3, no partial assistant content is persisted as a completed answer.
  cancelSend: () => void;
  // Issue #184 — replaces the cached Chat after a wire mutation (e.g. connected-scope PATCH).
  // The caller is the API client wrapper; the hook only owns the local cache update so the
  // chat header re-renders with the new state without a full refetch.
  replaceChat: (chat: Chat) => void;
  // The most recent grounded answer (repository or local-knowledge) the ChatWindow renders
  // alongside the assistant message bubble. Undefined when the active chat has no active
  // grounding scope or no grounded turn has happened yet.
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
  // Issue #151 — approximate context-window pressure estimate for the active
  // chat. undefined while the selected model is unresolved. Token counts are
  // approximate; UI copy must say so.
  readonly budget: ConversationBudgetEstimate | undefined;
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
  readonly latestMemory: ConversationMemoryResultWire | undefined;
  readonly clearLatestMemory: () => void;
  readonly acceptMemoryCandidate: (proposalId: string) => Promise<void>;
  readonly rejectMemoryCandidate: (proposalId: string) => Promise<void>;
  // Issue #151 / AC#4 — reset the in-memory history for the next prompt
  // WITHOUT deleting the conversation row. The chat row in `chats` is
  // preserved; only `messages` is cleared. Downstream wiring for
  // connected-context byte counts (#177 / #189 / #204) is a follow-up; the
  // estimator already carries the fields end-to-end.
  readonly clearHistory: () => void;
  // Issue #153 — governed workflow handoff from the Conversation Center.
  // Validates the requested model against the STRICTER workflow filter
  // (chat + tool calling + structured output, per AC#2), looks up the workflow
  // catalog entry, builds the workflow input deterministically, and POSTs to
  // /api/chats/runs (which atomically writes the user message and the system
  // run-summary message and reserves the runId before starting the run).
  //
  // The chat handoff is INTENTIONALLY scoped to dry-run launches: `apply` is
  // omitted on the wire so patch application stays behind the existing
  // workflow surfaces (AC#4). Shell execution is not exposed by this path.
  readonly launchWorkflowFromConversation: (
    input: LaunchWorkflowFromConversationInput,
  ) => Promise<LaunchWorkflowFromConversationResult>;
}

export interface LaunchWorkflowFromConversationInput {
  readonly workflowId: string;
  readonly modelId: string;
  /** Free-text input the user typed into the chat launcher. */
  readonly text: string;
}

export type LaunchWorkflowFromConversationResult =
  | { readonly ok: true; readonly runId: string }
  | {
      readonly ok: false;
      readonly reason:
        | "not-workflow-eligible"
        | "unknown-workflow"
        | "missing-chat"
        | "missing-input"
        | "request-failed";
      readonly message?: string;
    };

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
      const selectedModel = resolveSelectedModelId(latestChat.selectedModel, chatModels);
      return {
        models: chatModels,
        selectedModel,
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
  // Issue #152 — lifecycle is the source of truth; `sending` is derived.
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const sending = isInFlight(sendStatus);
  // Mirror sendStatus in a ref so concurrent sendMessage calls observe the
  // current value synchronously without waiting for the next render — this is
  // the idempotency guard for AC#2.
  const sendStatusRef = useRef<SendStatus>("idle");
  // Issue #152 — single AbortController for the active send (grounded OR
  // ungrounded). cancelSend hits this and falls through to the per-path
  // cancellation paths (grounded uses the controller as signal; ungrounded
  // adds signal support to sendDesktopChat in this issue).
  const sendControllerRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | undefined>();
  // Issue #185 — most recent grounded answer for the active chat. Cleared when the active
  // chat changes (see openChat) so a stale answer never overhangs into another conversation.
  const [latestGrounded, setLatestGrounded] = useState<GroundedAnswerWire | undefined>();
  const [latestMemory, setLatestMemory] = useState<ConversationMemoryResultWire | undefined>();
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryBudgetTokens, setMemoryBudgetTokens] = useState(DEFAULT_MEMORY_BUDGET_TOKENS);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const selectedModelPersistRef = useRef(0);
  // COMP-5 — synchronous read of the current model list inside setSelectedModel
  // (which is intentionally `useCallback(..., [])`) without recreating the callback.
  const modelsRef = useRef<readonly ModelCapability[]>([]);
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
      // ATT-F2: readDataUrl rejects on FileReader.onerror — the addPendingAttachment
      // contract is "never throws", so a failed read becomes a typed rejection.
      let previewDataUrl: string | undefined;
      if (kind === "image") {
        try {
          previewDataUrl = await readDataUrl(file);
        } catch {
          return { ok: false, reason: "unsupported-type" };
        }
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

  const clearLatestMemory = useCallback(() => {
    setLatestMemory(undefined);
  }, []);

  const buildMemoryRequest = useCallback(
    (chat: Chat, project: ProjectWithAvailability): ConversationMemoryRequestWire => ({
      enabled: memoryEnabled,
      budgetTokens: memoryBudgetTokens,
      context: {
        userId: DEFAULT_CONVERSATION_MEMORY_USER_ID,
        workspaceId: project.path,
        projectId: project.path,
        conversationId: chat.id,
      },
    }),
    [memoryBudgetTokens, memoryEnabled],
  );

  const acceptMemoryCandidate = useCallback(async (proposalId: string): Promise<void> => {
    await acceptMemoryProposal(proposalId);
    setLatestMemory((previous) =>
      previous === undefined
        ? previous
        : {
            ...previous,
            actions: previous.actions.filter(
              (action) => !(action.kind === "candidate" && action.proposalId === proposalId),
            ),
          },
    );
  }, []);

  const rejectMemoryCandidate = useCallback(async (proposalId: string): Promise<void> => {
    await rejectMemoryProposal(proposalId);
    setLatestMemory((previous) =>
      previous === undefined
        ? previous
        : {
            ...previous,
            actions: previous.actions.filter(
              (action) => !(action.kind === "candidate" && action.proposalId === proposalId),
            ),
          },
    );
  }, []);

  // Single update site so the ref + state never drift. The ref is the source
  // for concurrent-call gating; the state is the source for renders.
  const updateSendStatus = useCallback((next: SendStatus) => {
    sendStatusRef.current = next;
    setSendStatus(next);
  }, []);

  useEffect(() => {
    activeChatIdRef.current = state.activeChat?.id;
  }, [state.activeChat?.id]);

  useEffect(() => {
    modelsRef.current = state.models;
  }, [state.models]);

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
      sendControllerRef.current?.abort();
    };
  }, []);

  const setSelectedModel = useCallback((id: string) => {
    setError(undefined);
    // Capture pre-update snapshot so the optimistic write can be rolled back if
    // the PATCH fails — without this the server and UI diverge permanently.
    let snapshot:
      | { selectedModel: string | undefined; activeChat: Chat | undefined; chats: Chat[] }
      | undefined;
    setState((previous) => {
      snapshot = {
        selectedModel: previous.selectedModel,
        activeChat: previous.activeChat,
        chats: previous.chats,
      };
      return {
        ...previous,
        selectedModel: id,
        activeChat:
          previous.activeChat === undefined
            ? previous.activeChat
            : { ...previous.activeChat, selectedModel: id },
        chats: previous.chats.map((chat) =>
          previous.activeChat !== undefined && chat.id === previous.activeChat.id
            ? { ...chat, selectedModel: id }
            : chat,
        ),
      };
    });
    // COMP-5: drop pending attachments the newly selected model can no longer
    // accept so an image chip queued under an image-capable model doesn't persist
    // after switching to a text-only model (the "blocked" invariant).
    setPendingAttachments((previous) =>
      previous.filter((a) => isAttachmentSupported(a, id, modelsRef.current)),
    );
    const activeChatId = activeChatIdRef.current;
    if (activeChatId === undefined) return;
    const requestId = selectedModelPersistRef.current + 1;
    selectedModelPersistRef.current = requestId;
    void updateChat(activeChatId, { selectedModel: id })
      .then((result) => {
        if (selectedModelPersistRef.current !== requestId) return;
        if (activeChatIdRef.current !== result.chat.id) return;
        setState((previous) => ({
          ...previous,
          selectedModel: result.chat.selectedModel,
          activeChat:
            previous.activeChat?.id === result.chat.id ? result.chat : previous.activeChat,
          chats: previous.chats.map((chat) => (chat.id === result.chat.id ? result.chat : chat)),
        }));
      })
      .catch((caught) => {
        if (selectedModelPersistRef.current !== requestId) return;
        // MS-F1: skip the rollback when the user has navigated to a different
        // chat since this PATCH was issued — restoring this chat's old model
        // would clobber the now-active chat's selection.
        if (activeChatIdRef.current !== activeChatId) return;
        setError(errorMessage(caught));
        // Roll back optimistic update so UI stays consistent with the server.
        if (snapshot !== undefined) {
          const rollback = snapshot;
          // MS-F2: restore ONLY the affected chat's selectedModel so concurrent
          // chat-list updates (re-sorts, new chats) are not discarded by replacing
          // the whole snapshot array.
          setState((previous) => ({
            ...previous,
            selectedModel:
              previous.activeChat?.id === activeChatId
                ? rollback.selectedModel
                : previous.selectedModel,
            activeChat:
              previous.activeChat?.id === activeChatId ? rollback.activeChat : previous.activeChat,
            chats: previous.chats.map((chat) => {
              if (chat.id !== activeChatId) return chat;
              const restored = rollback.chats.find((c) => c.id === activeChatId);
              return restored !== undefined
                ? { ...chat, selectedModel: restored.selectedModel }
                : chat;
            }),
          }));
        }
      });
  }, []);

  const openNewChat = useCallback(
    async (projectOverride?: ProjectWithAvailability): Promise<void> => {
      const modelId = resolveSelectedModelId(state.selectedModel, state.models);
      if (modelId === undefined) {
        setError("No conversation-eligible model is configured. Connect a gateway in Settings.");
        return;
      }
      setError(undefined);
      try {
        const input: { modelId: string; title: string; projectPath?: string } = {
          modelId,
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
        const selectedModel = resolveSelectedModelId(latest.selectedModel, state.models);
        setState((previous) => ({
          ...previous,
          chats: sorted,
          activeChat: latest,
          selectedModel,
          messages: Array.from(messagePayload.messages),
        }));
        setLatestMemory(undefined);
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [openNewChat, state.models],
  );

  const openChat = useCallback(
    async (chat: Chat): Promise<void> => {
      setError(undefined);
      // Issue #152 — opening a different chat must abort any in-flight send so
      // a late response from the prior chat never lands here.
      sendControllerRef.current?.abort();
      sendControllerRef.current = null;
      activeChatIdRef.current = chat.id;
      // Issue #185 — clear any prior grounded answer so the new chat doesn't render stale
      // citations from a previous conversation's last grounded turn.
      setLatestGrounded(undefined);
      setLatestMemory(undefined);
      try {
        const messagePayload = await fetchChatMessages(chat.id, chat.projectPath);
        const selectedModel = resolveSelectedModelId(chat.selectedModel, state.models);
        setState((previous) => {
          const project = previous.projects.find((item) => item.path === chat.projectPath);
          return {
            ...previous,
            activeProject: project,
            activeChat: chat,
            selectedModel,
            messages: Array.from(messagePayload.messages),
          };
        });
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [state.models],
  );

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
      signal: AbortSignal,
    ): Promise<SendStatus> => {
      try {
        // Issue #152 — non-streaming providers see a stable "contacting" wait
        // until the response lands (AC#4). When the BFF gains a true streaming
        // surface we'll transition to "streaming" on the first delta.
        // TODO(#152 follow-up): wire SSE for true streaming when the BFF
        // adds a /api/desktop/chat/stream surface.
        updateSendStatus("contacting");
        const result = await sendDesktopChat(
          {
            chatId: chat.id,
            projectPath: project.path,
            content,
            modelId,
            memory: buildMemoryRequest(chat, project),
          },
          signal,
        );
        // Issue #152 — the request may have been cancelled while the response
        // was in flight. Honor the cancel and do NOT persist the assistant
        // reply as a completed answer (AC#3).
        if (signal.aborted) return "cancelled";
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
        setLatestMemory(result.memory);
        return "completed";
      } catch (caught) {
        // Aborted ungrounded requests are not errors — silently fall back to
        // a cancelled state, preserving the user message (the optimistic row
        // was the user's own input; AC#3 says we don't persist a fake
        // assistant answer, but we keep the user's message visible).
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return "cancelled";
        }
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
        return "failed";
      }
    },
    [buildMemoryRequest, updateSendStatus],
  );

  // When the active chat carries either a Files connected scope or a local-knowledge scope,
  // the composer routes the submission through the grounded BFF path instead of the plain
  // gateway-backed chat path.
  // The route persists both messages and returns the redacted citation projection; the hook
  // refetches the message log on success so the bubbles reflect the canonical store state.
  const sendGrounded = useCallback(
    async (
      chat: Chat,
      project: ProjectWithAvailability,
      content: string,
      optimisticId: string,
      modelId: string,
      signal: AbortSignal,
    ): Promise<SendStatus> => {
      // Copilot PR #258 finding: clear the previous answer at the START of a new send so a
      // stale citation block doesn't briefly flash next to the new question.
      setLatestGrounded(undefined);
      try {
        updateSendStatus("contacting");
        const result = await askGrounded({ chatId: chat.id, content, modelId }, signal);
        if (activeChatIdRef.current !== chat.id) {
          return "completed";
        }
        if (signal.aborted) return "cancelled";
        setLatestGrounded(result);
        setLatestMemory(undefined);
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
        return "completed";
      } catch (caught) {
        // Issue #152 — abort preserves the user's optimistic message (AC#3:
        // no fake assistant content is persisted; the user's prompt remains
        // visible so they can edit & retry without retyping).
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return "cancelled";
        }
        setError(errorMessage(caught));
        setState((previous) => ({
          ...previous,
          messages: previous.messages.filter((message) => message.id !== optimisticId),
        }));
        return "failed";
      }
    },
    [updateSendStatus],
  );

  // Issue #152 — unified cancel that aborts any in-flight send (grounded OR
  // ungrounded). Replaces the prior `cancelGrounded`-only surface. When no
  // request is in flight this is a safe no-op. We flip sendStatus to
  // "cancelled" immediately so the UI re-renders out of the in-flight state
  // even before the fetch rejection reaches the awaited site.
  const cancelSend = useCallback(() => {
    if (!isInFlight(sendStatusRef.current)) return;
    sendControllerRef.current?.abort();
    sendControllerRef.current = null;
    updateSendStatus("cancelled");
  }, [updateSendStatus]);

  // Issue #185 → #152: cancelGrounded is preserved as a thin alias so existing
  // call sites (ChatWindow.tsx grounded TypingBubble) keep working. New code
  // should call cancelSend.
  const cancelGrounded = cancelSend;

  const sendMessage = useCallback(async (): Promise<void> => {
    // Issue #152 / AC#2 — idempotent send. Checking the ref (not the React
    // state) defends against the same tick double-submit (Enter held, click
    // burst, etc.). The terminal states are treated as "ready to send again"
    // — only mid-flight states block.
    if (isInFlight(sendStatusRef.current)) return;
    const content = draft.trim();
    const chat = state.activeChat;
    const project = state.activeProject;
    const modelId = resolveSelectedModelId(state.selectedModel, state.models);
    // AC #1: block submission when no eligible model is configured.
    if (
      content.length === 0 ||
      chat === undefined ||
      project === undefined ||
      modelId === undefined
    )
      return;
    // CB-F3: Enter / form-submit must honor the same exceeded-budget block the
    // send button enforces — otherwise the keyboard path bypasses the gate. Uses
    // the unknown-limits-safe guard (contextWindowTokens > 0) so a runtime
    // chat model with contextWindow: 0 is never blocked.
    const submitBudget = estimateConversationBudget({
      modelContextWindow: state.models.find((m) => m.id === modelId)?.contextWindow ?? 0,
      modelMaxOutputTokens: state.models.find((m) => m.id === modelId)?.maxOutputTokens ?? 0,
      userDraftText: content,
      conversationHistory: state.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    });
    if (isBudgetExceeded(submitBudget)) {
      setError(CONTEXT_OVERSIZED_USER_MESSAGE);
      return;
    }
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
    // Synchronously commit to "queued" so a re-entrant call in the same tick
    // hits the isInFlight guard above (AC#2).
    updateSendStatus("queued");
    setDraft("");
    setError(undefined);
    setState((previous) => ({ ...previous, messages: [...previous.messages, optimistic] }));
    // Issue #152 — fresh controller per send. The previous controller (if
    // any) was either already settled or already aborted via cancelSend.
    const controller = new AbortController();
    sendControllerRef.current = controller;
    setLatestMemory(undefined);
    try {
      // Merge resolution (PR #355 + Epic #142): route through sendGrounded
      // when EITHER a Files connected scope OR a local-knowledge scope is
      // attached. The epic's sendGrounded signature (with modelId + signal +
      // SendStatus return) is the canonical one; #355 expanded only the
      // routing predicate, not the underlying send path.
      const isGrounded =
        chat.connectedScope !== undefined || chat.localKnowledgeScope !== undefined;
      const terminal = isGrounded
        ? await sendGrounded(chat, project, content, optimistic.id, modelId, controller.signal)
        : await sendUngrounded(chat, project, content, optimistic.id, modelId, controller.signal);
      // If cancelSend already flipped the status to "cancelled", do not
      // override it with a stale "completed" — cancellation wins.
      if (sendStatusRef.current === "cancelled") {
        // The send path may have written the assistant message between abort
        // and the cancel registering. Remove the optimistic user-row's
        // assistant counterpart by trusting the path-returned terminal — but
        // for cancelled we already preserved the user row, and we did NOT
        // persist assistant content (signal.aborted check + AbortError
        // branch). Nothing to do here.
      } else {
        updateSendStatus(terminal);
      }
      if (terminal === "completed") {
        // AC #3 (#147): clear pending attachments after a successful send.
        clearPendingAttachments();
      }
    } finally {
      sendControllerRef.current = null;
    }
  }, [
    draft,
    state.activeChat,
    state.activeProject,
    state.selectedModel,
    state.models,
    state.messages,
    sendGrounded,
    sendUngrounded,
    clearPendingAttachments,
    updateSendStatus,
  ]);

  // Issue #151 / AC#4 — clear the in-memory history for the next prompt
  // without deleting the conversation row. The chat row stays in `chats`;
  // only `messages` is reset so the next send carries no prior history.
  // TODO(#151 follow-up): when the BFF gains a "history checkpoint" surface
  // we'll also persist this reset so reloads don't re-fetch the cleared turns.
  const clearHistory = useCallback(() => {
    setLatestGrounded(undefined);
    setLatestMemory(undefined);
    setState((previous) => ({ ...previous, messages: [] }));
  }, []);

  // Issue #151 / AC#1 — reactive context-pressure estimate. Derives from the
  // selected model's capability + current draft + visible history. Connected-
  // context byte counts from #177/#189/#204 are passed through as zero today;
  // they wire up to the estimator when those surfaces expose byte budgets in
  // a follow-up. The fields exist on the contract so consumers (BFF, audit,
  // UI) can carry the breakdown end-to-end without contract churn.
  const budget = useMemo<ConversationBudgetEstimate | undefined>(() => {
    const capability = state.models.find((m) => m.id === state.selectedModel);
    if (capability === undefined) return undefined;
    const history: readonly { readonly role: string; readonly content: string }[] = state.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    return estimateConversationBudget({
      modelContextWindow: capability.contextWindow,
      modelMaxOutputTokens: capability.maxOutputTokens,
      userDraftText: draft,
      conversationHistory: history,
      // TODO(#151 follow-up): wire repoContextPackBytes from #177 surface,
      // knowledgeCapsuleBytes from #189, memoryContextBytes from #204. The
      // estimator already counts them; this turn passes zero by omission.
    });
  }, [state.models, state.selectedModel, state.messages, draft]);

  // Issue #153 — governed workflow handoff from the Conversation Center. Three guard rails:
  //   1. The selected model must satisfy the STRICTER workflow filter (AC#2).
  //   2. The workflowId must match an entry in the in-chat catalog (a small UI-side allowlist
  //      so an unrecognized id never reaches /api/chats/runs).
  //   3. An active chat row is required so the user/system message pair lands inside a chat.
  //
  // `apply` is omitted on the wire so patch application stays behind the existing workflow
  // surfaces (AC#4). After a successful launch we refresh the active chat's messages so the
  // RunSummaryCard system message renders without round-tripping through state.
  const launchWorkflowFromConversation = useCallback(
    async (
      input: LaunchWorkflowFromConversationInput,
    ): Promise<LaunchWorkflowFromConversationResult> => {
      // WH-04: a workflow launch replaces the messages array on success, so a
      // duplicate submit while a send/launch is in flight risks clobbering the
      // optimistic state. Mirror sendMessage's idempotency guard.
      if (isInFlight(sendStatusRef.current)) {
        return { ok: false, reason: "request-failed", message: "A request is already in flight." };
      }
      const trimmed = input.text.trim();
      if (trimmed.length === 0) return { ok: false, reason: "missing-input" };

      const chat = state.activeChat;
      const project = state.activeProject;
      if (chat === undefined || project === undefined) {
        return { ok: false, reason: "missing-chat" };
      }

      const capability = state.models.find((m) => m.id === input.modelId);
      if (capability === undefined || !isWorkflowEligibleModel(capability)) {
        return { ok: false, reason: "not-workflow-eligible" };
      }

      const entry = findChatWorkflow(input.workflowId);
      if (entry === undefined) return { ok: false, reason: "unknown-workflow" };

      const now = Date.now();
      const workflowInput = entry.buildInput(project.path, trimmed);
      try {
        const result = await startChatRun({
          chatId: chat.id,
          projectPath: project.path,
          run: {
            workflowId: input.workflowId,
            input: workflowInput,
            modelId: input.modelId,
          },
          user: { content: trimmed, timestamp: now },
          summary: { content: `Launched: ${entry.label}`, timestamp: now + 1 },
        });
        // Refresh the local messages so the system run-summary lands in the chat without
        // a network round-trip; the BFF already wrote both rows atomically.
        setState((previous) => ({
          ...previous,
          messages: Array.from(result.messages),
        }));
        return { ok: true, runId: result.run.runId };
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        return { ok: false, reason: "request-failed", message };
      }
    },
    [state.activeChat, state.activeProject, state.models],
  );

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
    noEligibleModels:
      !loading && resolveSelectedModelId(state.selectedModel, state.models) === undefined,
    draft,
    loading,
    sending,
    sendStatus,
    error,
    setDraft,
    setSelectedModel,
    openNewChat,
    openProject,
    openChat,
    addProject,
    sendMessage,
    cancelSend,
    replaceChat,
    latestGrounded,
    cancelGrounded,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
    clearPendingAttachments,
    budget,
    memoryEnabled,
    setMemoryEnabled,
    memoryBudgetTokens,
    setMemoryBudgetTokens,
    latestMemory,
    clearLatestMemory,
    acceptMemoryCandidate,
    rejectMemoryCandidate,
    clearHistory,
    launchWorkflowFromConversation,
  };
}
