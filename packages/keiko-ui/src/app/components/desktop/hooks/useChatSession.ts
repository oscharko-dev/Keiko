"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  StreamingUnavailableError,
  askGrounded,
  createDesktopChat,
  createProject,
  fetchChatMessages,
  fetchChats,
  fetchEvidenceManifest,
  fetchRunReport,
  fetchModels,
  fetchProjects,
  appendDesktopChatVoiceTurn,
  patchChatMessage,
  sendDesktopChat,
  sendDesktopChatStream,
  runRealtimeGroundedTool as postRealtimeGroundedTool,
  updateChat,
  type AppendDesktopChatVoiceTurnMessage,
  type RealtimeGroundedToolOutput,
} from "@/lib/api";
import type { SseDonePayload } from "@/lib/api";
import { acceptMemoryProposal, forgetMemory, rejectMemoryProposal } from "@/lib/memory-api";
import { sortProjects } from "@/lib/sidebar-sort";
import { classifyRunReport, formatRunSummaryFromManifest } from "@/lib/run-summary";
import type {
  Chat,
  ChatMessage,
  ConversationDocumentContextWire,
  ConversationMemoryRequestWire,
  ConversationMemoryResultWire,
  GroundedAnswer as GroundedAnswerWire,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";
import { isConversationEligibleModel } from "@/lib/types";
import { formatUserError } from "../format-error";
import { extractDocumentContext, type PendingDocument } from "./documentContext";
import { useConversationMemorySettings } from "./memorySettings";

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
  // Issue #148 — the underlying File, retained so the send path can extract a
  // document's text into bounded conversation context. Never serialized to the
  // chip UI (no path/bytes are surfaced from it). Undefined only in synthetic
  // test fixtures that construct a PendingAttachment without a source File.
  readonly file?: File | undefined;
}

// Issue #148 — disclosure projection for documents that contributed extracted text to the most
// recent send. Carries only basename + truncation flag (never a path or bytes) so the UI can
// tell the user which documents were included and whether any was cut.
export interface SentDocumentDisclosure {
  readonly id: string;
  readonly displayName: string;
  readonly truncated: boolean;
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
const CHAT_UPSERT_EVENT = "keiko:chat-upsert";
const CHAT_DELETE_EVENT = "keiko:chat-delete";
const RUN_SUMMARY_SYNC_INTERVAL_MS = 1_000;
const RUN_SUMMARY_SYNC_MAX_ATTEMPTS = 120;

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
  "idle" | "queued" | "contacting" | "streaming" | "completed" | "failed" | "cancelled";

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
  "The conversation context exceeded the model's window. Open a new chat or pick a larger-context model.";
export const GROUNDED_ATTACHMENT_NOTICE =
  "Attachments are not supported for grounded chats. Remove the attachment or switch to a non-grounded chat.";
export const EMPTY_MODEL_RESPONSE_USER_MESSAGE =
  "The model request completed, but the provider did not return any answer text. Retry once; if it happens again, check the selected model deployment in Settings.";

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
const EMPTY_MODEL_RESPONSE_PHRASES = [
  "empty assistant response",
  "empty grounded answer",
  "without assistant content",
] as const;

function isContextOversizedError(error: unknown): boolean {
  if (error instanceof ApiError && CONTEXT_OVERSIZED_API_CODES.has(error.code)) return true;
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.length === 0) return false;
  return CONTEXT_OVERSIZED_PHRASES.some((phrase) => text.includes(phrase));
}

function isEmptyModelResponseError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  if (text.length === 0) return false;
  return EMPTY_MODEL_RESPONSE_PHRASES.some((phrase) => text.includes(phrase));
}

function errorMessage(error: unknown): string {
  // AC#3 — context-overflow provider errors map to a single actionable message.
  if (isContextOversizedError(error)) return CONTEXT_OVERSIZED_USER_MESSAGE;
  if (isEmptyModelResponseError(error)) {
    return error instanceof ApiError
      ? `${EMPTY_MODEL_RESPONSE_USER_MESSAGE} (${error.code})`
      : EMPTY_MODEL_RESPONSE_USER_MESSAGE;
  }
  // uiux-fix F041 (C171) — message first, machine code as trailing detail.
  return formatUserError(error, "Something went wrong. Try again.");
}

function sortChats(chats: readonly Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

function isChatPayload(value: unknown): value is Chat {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { projectPath?: unknown }).projectPath === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { selectedModel?: unknown }).selectedModel === "string"
  );
}

function isChatDeletePayload(value: unknown): value is { readonly chatId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { chatId?: unknown }).chatId === "string"
  );
}

export function notifyChatUpsert(chat: Chat): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_UPSERT_EVENT, { detail: chat }));
}

export function notifyChatDeleted(chatId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_DELETE_EVENT, { detail: { chatId } }));
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

function hasGroundingScope(chat: Chat): boolean {
  return (
    chat.connectedScope !== undefined ||
    (chat.connectedScopes !== undefined && chat.connectedScopes.length > 0) ||
    chat.localKnowledgeScope !== undefined ||
    (chat.localKnowledgeScopes !== undefined && chat.localKnowledgeScopes.length > 0)
  );
}

export type ChatSessionApi = UseChatSessionResult;

// Issue #1561 — options for an explicit-text send. The voice dialogue session (Epic #1556) commits a
// spoken transcript and must send it through THIS chat path so the spoken turn carries the identical
// context (attachments → documentContext, repository/local-knowledge grounding scope, memory) a typed
// turn would. It cannot rely on `setDraft(text)` + `sendMessage()` in the same tick: `sendMessage`
// reads `draft` from React state captured in its closure, so the just-set draft is invisible until the
// next render and the send would early-return on an empty draft. Passing the committed text directly
// decouples the send from the async draft state. The field is content-only (the committed transcript,
// already equal to what a typed message carries) — it adds NO audio and NO new wire field, preserving
// exact context equivalence with the typed path.
export interface SendMessageOptions {
  // When present, this text is sent instead of the current draft. Trimmed and empty-guarded identically
  // to the draft path. The draft is still cleared on a successful send so the composer returns to rest.
  readonly text?: string;
}

export interface RealtimeGroundedToolCallInput {
  readonly callId: string;
  readonly query: string;
  readonly userTranscript?: string | undefined;
}

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
  clearError?: (() => void) | undefined;
  setDraft: (value: string) => void;
  setSelectedModel: (id: string) => void;
  // Optional `title` names the fresh conversation (e.g. from the New-Chat-window dialog);
  // blank/whitespace falls back to DEFAULT_CHAT_TITLE.
  openNewChat: (project?: ProjectWithAvailability, title?: string) => Promise<Chat | undefined>;
  openProject: (project: ProjectWithAvailability) => Promise<void>;
  openChat: (chat: Chat) => Promise<void>;
  addProject: (path: string) => Promise<void>;
  // Issue #1561 — `options.text` sends an explicit committed transcript (the spoken-turn handoff) through
  // the same context-bearing path as a typed send; absent, it sends the current draft as before.
  sendMessage: (options?: SendMessageOptions) => Promise<void>;
  // Realtime voice turns are already generated by the Realtime provider. Appending them must persist
  // the committed transcript into the existing chat history without triggering a second chat model call.
  appendVoiceTurn?: (messages: readonly AppendDesktopChatVoiceTurnMessage[]) => Promise<void>;
  // Realtime voice grounding tool bridge. It persists the committed spoken user turn and grounded
  // assistant answer through the same BFF grounding path as text chat, then returns the compact tool
  // output that the Realtime provider should speak. It does not call the normal chat model twice.
  runRealtimeGroundedTool?: (
    input: RealtimeGroundedToolCallInput,
    signal?: AbortSignal,
  ) => Promise<RealtimeGroundedToolOutput>;
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
  // Issue #148 — documents that contributed extracted text to the most recent send, for the
  // post-send disclosure note. Empty until a send includes at least one readable document.
  readonly lastSentDocuments: readonly SentDocumentDisclosure[];
  readonly memoryEnabled: boolean;
  readonly setMemoryEnabled: (next: boolean) => void;
  readonly memoryBudgetTokens: number;
  readonly setMemoryBudgetTokens: (next: number) => void;
  readonly latestMemory: ConversationMemoryResultWire | undefined;
  readonly clearLatestMemory: () => void;
  readonly acceptMemoryCandidate: (proposalId: string) => Promise<void>;
  readonly rejectMemoryCandidate: (proposalId: string) => Promise<void>;
  readonly forgetMemoryAction: (memoryId: string) => Promise<void>;
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

function isPendingRunSummaryMessage(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    typeof message.runId === "string" &&
    (message.workflowStatus === undefined ||
      message.workflowStatus === "pending" ||
      message.workflowStatus === "running")
  );
}

function runSummaryFallbackKind(message: ChatMessage): {
  readonly workflowId?: string;
  readonly taskType?: string;
} {
  return {
    ...(message.workflowId === undefined ? {} : { workflowId: message.workflowId }),
    ...(message.taskType === undefined ? {} : { taskType: message.taskType }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function bootstrapSession(autoCreate: boolean): Promise<Partial<SessionState>> {
  const modelPayload = await fetchModels();
  // Issue #144: source of truth is the helper, not an inline kind check. Pin
  // ACs #1 / #2 — only chat-eligible models reach the conversation dropdown.
  const chatModels = modelPayload.models.filter(isConversationEligibleModel);
  const defaultModel = pickChatModelId(chatModels);

  const projectPayload = await fetchProjects().catch(() => ({ projects: [] }));
  const projects = sortProjects(projectPayload.projects);
  const project = projects.find((item) => item.available) ?? projects[0];

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
        projects: Array.from(projects),
        activeProject: project,
        chats: sortedChats,
        activeChat: latestChat,
        messages: Array.from(messagePayload.messages),
      };
    }
  }

  // AC #1: when no eligible model exists, set selectedModel to undefined so
  // downstream surfaces show a clear error instead of a placeholder id.
  if (defaultModel === undefined || !autoCreate) {
    return {
      models: chatModels,
      selectedModel: defaultModel,
      projects: Array.from(projects),
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
  notifyChatUpsert(created.chat);
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

export interface UseChatSessionOptions {
  readonly autoCreate?: boolean;
}

export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionResult {
  const autoCreate = options.autoCreate ?? true;
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
  const { memoryEnabled, setMemoryEnabled, memoryBudgetTokens, setMemoryBudgetTokens } =
    useConversationMemorySettings();
  const mountedRef = useRef(true);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  const runSummarySyncingRef = useRef<Set<string>>(new Set());
  const selectedModelPersistRef = useRef(0);
  // COMP-5 — synchronous read of the current model list inside setSelectedModel
  // (which is intentionally `useCallback(..., [])`) without recreating the callback.
  const modelsRef = useRef<readonly ModelCapability[]>([]);
  // Issue #147 — pending-attachment state. Cleared after a successful send (AC #3).
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachment[]>([]);
  // Issue #148 — documents that contributed extracted context to the most recent send. Drives
  // the post-send disclosure note (which docs were included + whether any was truncated).
  const [lastSentDocuments, setLastSentDocuments] = useState<readonly SentDocumentDisclosure[]>([]);

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
        // Issue #148 — retain the File so the send path can extract document text.
        file,
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

  // Issue #148 — extract bounded text from the pending DOCUMENT attachments for the send body.
  // Images are excluded here (they stay on the metadata-only attachments path). A document with
  // no retained File (synthetic fixture) is skipped. Read failures surface a fixed, path-safe
  // alert and never abort the send. Returns the wire entries to attach plus a disclosure list.
  const buildDocumentContext = useCallback(async (): Promise<{
    readonly entries: readonly ConversationDocumentContextWire[];
    readonly disclosures: readonly SentDocumentDisclosure[];
  }> => {
    const documents: PendingDocument[] = pendingAttachments
      .filter((a) => a.kind === "document" && a.file !== undefined)
      .map((a) => ({
        id: a.id,
        name: a.name,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        file: a.file as File,
      }));
    if (documents.length === 0) return { entries: [], disclosures: [] };
    const { entries, failures } = await extractDocumentContext(documents);
    if (failures.length > 0) setError(failures.join(" "));
    const disclosures = entries.map((e) => ({
      id: e.id,
      displayName: e.displayName,
      truncated: e.truncated,
    }));
    return { entries, disclosures };
  }, [pendingAttachments]);

  const clearLatestMemory = useCallback(() => {
    setLatestMemory(undefined);
  }, []);

  const buildMemoryRequest = useCallback(
    (chat: Chat, project: { readonly path: string }): ConversationMemoryRequestWire => ({
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

  const forgetMemoryAction = useCallback(async (memoryId: string): Promise<void> => {
    await forgetMemory(memoryId as MemoryId, "user-initiated forget from Conversation Center");
    setLatestMemory((previous) =>
      previous === undefined
        ? previous
        : {
            ...previous,
            actions: previous.actions.filter(
              (action) => !(action.kind === "forget" && action.memoryId === memoryId),
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

  const syncRunSummaryMessage = useCallback(
    async (chat: Chat, projectPath: string, message: ChatMessage, syncKey: string) => {
      const runId = message.runId;
      if (runId === undefined) {
        runSummarySyncingRef.current.delete(syncKey);
        return;
      }
      const fallbackKind = runSummaryFallbackKind(message);
      try {
        for (let attempt = 0; attempt < RUN_SUMMARY_SYNC_MAX_ATTEMPTS; attempt += 1) {
          if (!mountedRef.current || activeChatIdRef.current !== chat.id) return;

          let summary:
            | {
                readonly workflowStatus: "completed" | "failed" | "cancelled";
                readonly shortResult: string;
              }
            | undefined;

          try {
            const response = await fetchRunReport(runId);
            const outcome = classifyRunReport(response.report, fallbackKind);
            if (outcome.kind === "terminal") summary = outcome.summary;
          } catch (caught) {
            if (caught instanceof ApiError && caught.status === 404) {
              try {
                const response = await fetchEvidenceManifest(runId);
                const manifestSummary = formatRunSummaryFromManifest(
                  response.manifest,
                  fallbackKind,
                );
                summary = {
                  workflowStatus:
                    manifestSummary.workflowStatus === "failed" ||
                    manifestSummary.workflowStatus === "cancelled"
                      ? manifestSummary.workflowStatus
                      : "completed",
                  shortResult: manifestSummary.shortResult,
                };
              } catch {
                // Evidence may not exist yet while the worker is still settling; keep polling.
              }
            } else {
              return;
            }
          }

          if (summary !== undefined) {
            const patched = await patchChatMessage(message.id, chat.id, projectPath, summary);
            if (!mountedRef.current || activeChatIdRef.current !== chat.id) return;
            setState((previous) =>
              previous.activeChat?.id !== chat.id
                ? previous
                : {
                    ...previous,
                    messages: previous.messages.map((existing) =>
                      existing.id === message.id ? patched.message : existing,
                    ),
                  },
            );
            return;
          }

          if (attempt < RUN_SUMMARY_SYNC_MAX_ATTEMPTS - 1) {
            await sleep(RUN_SUMMARY_SYNC_INTERVAL_MS);
          }
        }
      } finally {
        runSummarySyncingRef.current.delete(syncKey);
      }
    },
    [],
  );

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
        const patch = await bootstrapSession(autoCreate);
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
  }, [autoCreate]);

  useEffect(() => {
    const onUpsert = (event: Event): void => {
      const chat = (event as CustomEvent<unknown>).detail;
      if (!isChatPayload(chat)) return;
      setState((previous) => ({
        ...previous,
        chats: sortChats([chat, ...previous.chats.filter((existing) => existing.id !== chat.id)]),
        activeChat: previous.activeChat?.id === chat.id ? chat : previous.activeChat,
        selectedModel:
          previous.activeChat?.id === chat.id
            ? resolveSelectedModelId(chat.selectedModel, previous.models)
            : previous.selectedModel,
      }));
    };
    const onDelete = (event: Event): void => {
      const payload = (event as CustomEvent<unknown>).detail;
      if (!isChatDeletePayload(payload)) return;
      setState((previous) => ({
        ...previous,
        chats: previous.chats.filter((chat) => chat.id !== payload.chatId),
        activeChat: previous.activeChat?.id === payload.chatId ? undefined : previous.activeChat,
        messages: previous.activeChat?.id === payload.chatId ? [] : previous.messages,
      }));
    };
    window.addEventListener(CHAT_UPSERT_EVENT, onUpsert);
    window.addEventListener(CHAT_DELETE_EVENT, onDelete);
    return () => {
      window.removeEventListener(CHAT_UPSERT_EVENT, onUpsert);
      window.removeEventListener(CHAT_DELETE_EVENT, onDelete);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const chat = state.activeChat;
    const project = state.activeProject;
    if (chat === undefined || project === undefined) return;

    for (const message of state.messages) {
      if (!isPendingRunSummaryMessage(message)) continue;
      const runId = message.runId;
      if (runId === undefined) continue;
      const syncKey = `${message.id}:${runId}`;
      if (runSummarySyncingRef.current.has(syncKey)) continue;
      runSummarySyncingRef.current.add(syncKey);
      void syncRunSummaryMessage(chat, project.path, message, syncKey);
    }
  }, [state.activeChat, state.activeProject, state.messages, syncRunSummaryMessage]);

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
        notifyChatUpsert(result.chat);
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
    async (
      projectOverride?: ProjectWithAvailability,
      title?: string,
    ): Promise<Chat | undefined> => {
      const modelId = resolveSelectedModelId(state.selectedModel, state.models);
      if (modelId === undefined) {
        setError("No conversation-eligible model is configured. Connect a gateway in Settings.");
        return undefined;
      }
      setError(undefined);
      try {
        const trimmedTitle = title?.trim();
        const input: { modelId: string; title: string; projectPath?: string } = {
          modelId,
          title:
            trimmedTitle !== undefined && trimmedTitle.length > 0
              ? trimmedTitle
              : DEFAULT_CHAT_TITLE,
        };
        const targetPath = projectOverride?.path ?? state.activeProject?.path;
        if (targetPath !== undefined) input.projectPath = targetPath;
        const created = await createDesktopChat(input);
        activeChatIdRef.current = created.chat.id;
        notifyChatUpsert(created.chat);
        setState({
          projects: Array.from(created.projects),
          chats: sortChats(created.chats),
          messages: Array.from(created.messages),
          models: state.models,
          activeProject: created.project,
          activeChat: created.chat,
          selectedModel: created.chat.selectedModel,
        });
        return created.chat;
      } catch (caught) {
        setError(errorMessage(caught));
        return undefined;
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
      // Issue #148 — clear the document-disclosure note so it never bleeds across chats.
      setLastSentDocuments([]);
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

  // Removes a temp optimistic message from state by id (AC#3 — no partial kept).
  const removeTempMessage = useCallback((id: string): void => {
    setState((previous) => ({
      ...previous,
      messages: previous.messages.filter((m) => m.id !== id),
    }));
  }, []);

  // Builds the StreamHandlers for a streaming request. Extracted to keep
  // streamUngrounded within the 50-line function limit.
  const buildStreamHandlers = useCallback(
    (
      tempAssistantId: string,
      optimisticId: string,
      resolve: (status: SendStatus) => void,
    ): import("@/lib/api").StreamHandlers => {
      let statusFlippedToStreaming = false;
      return {
        onToken: (text: string): void => {
          if (!statusFlippedToStreaming) {
            updateSendStatus("streaming");
            statusFlippedToStreaming = true;
          }
          setState((previous) => ({
            ...previous,
            messages: previous.messages.map((m) =>
              m.id === tempAssistantId ? { ...m, content: m.content + text } : m,
            ),
          }));
        },
        onDone: (payload: SseDonePayload): void => {
          setState((previous) => ({
            ...previous,
            activeChat: payload.chat,
            chats: sortChats([
              payload.chat,
              ...previous.chats.filter((existing) => existing.id !== payload.chat.id),
            ]),
            messages: [
              ...previous.messages.filter((m) => m.id !== optimisticId && m.id !== tempAssistantId),
              ...Array.from(payload.messages),
            ],
          }));
          notifyChatUpsert(payload.chat);
          if (payload.memory !== undefined) setLatestMemory(payload.memory);
          resolve("completed");
        },
        onError: ({ code, message }: { code: string; message: string }): void => {
          setError(errorMessage(new ApiError(code, message, 0)));
          removeTempMessage(tempAssistantId);
          resolve("failed");
        },
        onCancelled: (): void => {
          removeTempMessage(tempAssistantId);
          resolve("cancelled");
        },
      };
    },
    [removeTempMessage, updateSendStatus],
  );

  // Issue #152 Layer 3 — streaming path for canStream models. Inserts a temp
  // assistant bubble that accumulates token deltas, then replaces it with the
  // canonical messages on done. On cancel/error the temp bubble is removed so
  // no partial content persists (AC#3).
  const streamUngrounded = useCallback(
    (
      chat: Chat,
      project: ProjectWithAvailability,
      content: string,
      optimisticId: string,
      modelId: string,
      signal: AbortSignal,
      documentContext: readonly ConversationDocumentContextWire[],
    ): Promise<SendStatus> => {
      const tempAssistantId = `stream-${String(Date.now())}`;
      setState((previous) => ({
        ...previous,
        messages: [
          ...previous.messages,
          {
            id: tempAssistantId,
            chatId: chat.id,
            role: "assistant" as const,
            content: "",
            timestamp: Date.now(),
            runId: undefined,
            workflowId: undefined,
            workflowStatus: undefined,
            shortResult: undefined,
            taskType: undefined,
          },
        ],
      }));
      const requestBody = {
        chatId: chat.id,
        projectPath: project.path,
        content,
        modelId,
        memory: buildMemoryRequest(chat, project),
        ...(documentContext.length > 0 ? { documentContext } : {}),
      };
      return new Promise<SendStatus>((resolve, reject) => {
        const handlers = buildStreamHandlers(tempAssistantId, optimisticId, resolve);
        sendDesktopChatStream(requestBody, signal, handlers).catch((caught: unknown) => {
          removeTempMessage(tempAssistantId);
          if (caught instanceof StreamingUnavailableError) {
            // Pre-stream failure (e.g. STREAMING_UNSUPPORTED, or a JSON error before any SSE
            // header). Reject so sendUngrounded falls back to the buffered path instead of
            // surfacing a hard failure to the user.
            reject(caught);
          } else if (caught instanceof DOMException && caught.name === "AbortError") {
            resolve("cancelled");
          } else {
            // Mid-stream client error (e.g. network drop, reader TypeError). Surface it so the
            // UI does not silently swallow the failure. The server has already persisted the
            // user message at this point; removing it here is UI-only — it reappears on reload,
            // which matches the behaviour of sendUngroundedBuffered and sendGrounded.
            setError(errorMessage(caught));
            setState((previous) => ({
              ...previous,
              messages: previous.messages.filter((message) => message.id !== optimisticId),
            }));
            resolve("failed");
          }
        });
      });
    },
    [buildMemoryRequest, buildStreamHandlers, removeTempMessage],
  );

  // Issue #152 Layer 3 — non-streaming fallback path (canStream=false or
  // StreamingUnavailableError pre-stream). Kept separate so sendUngrounded
  // stays within the 50-line function limit.
  const sendUngroundedBuffered = useCallback(
    async (
      chat: Chat,
      project: ProjectWithAvailability,
      content: string,
      optimisticId: string,
      modelId: string,
      signal: AbortSignal,
      documentContext: readonly ConversationDocumentContextWire[],
    ): Promise<SendStatus> => {
      try {
        updateSendStatus("contacting");
        // Issue #148 — byte-bounded document context on the request body.
        const result = await sendDesktopChat(
          {
            chatId: chat.id,
            projectPath: project.path,
            content,
            modelId,
            memory: buildMemoryRequest(chat, project),
            ...(documentContext.length > 0 ? { documentContext } : {}),
          },
          signal,
        );
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
        notifyChatUpsert(result.chat);
        setLatestMemory(result.memory);
        return "completed";
      } catch (caught) {
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

  const sendUngrounded = useCallback(
    async (
      chat: Chat,
      project: ProjectWithAvailability,
      content: string,
      optimisticId: string,
      modelId: string,
      signal: AbortSignal,
      documentContext: readonly ConversationDocumentContextWire[],
    ): Promise<SendStatus> => {
      const canStream = state.models.find((m) => m.id === modelId)?.streaming === true;
      if (!canStream) {
        return sendUngroundedBuffered(
          chat,
          project,
          content,
          optimisticId,
          modelId,
          signal,
          documentContext,
        );
      }
      updateSendStatus("contacting");
      try {
        return await streamUngrounded(
          chat,
          project,
          content,
          optimisticId,
          modelId,
          signal,
          documentContext,
        );
      } catch (caught) {
        // StreamingUnavailableError before SSE headers — fall back to buffered.
        if (!(caught instanceof StreamingUnavailableError)) throw caught;
      }
      return sendUngroundedBuffered(
        chat,
        project,
        content,
        optimisticId,
        modelId,
        signal,
        documentContext,
      );
    },
    [state.models, sendUngroundedBuffered, streamUngrounded, updateSendStatus],
  );

  // When the active chat carries either a Files connected scope or a local-knowledge scope,
  // the composer routes the submission through the grounded BFF path instead of the plain
  // gateway-backed chat path.
  // The route persists both messages and returns the redacted citation projection; the hook
  // refetches the message log on success so the bubbles reflect the canonical store state.
  const sendGrounded = useCallback(
    async (
      chat: Chat,
      _project: ProjectWithAvailability,
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
          fetchChatMessages(chat.id, chat.projectPath),
          fetchChats(chat.projectPath),
        ]);
        const refreshedActive = chatsPayload.chats.find((c) => c.id === chat.id);
        setState((previous) => ({
          ...previous,
          messages: Array.from(messagePayload.messages),
          chats: sortChats(chatsPayload.chats),
          activeChat: refreshedActive ?? previous.activeChat,
        }));
        if (refreshedActive !== undefined) notifyChatUpsert(refreshedActive);
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

  const sendMessage = useCallback(
    async (options?: SendMessageOptions): Promise<void> => {
      // Issue #152 / AC#2 — idempotent send. Checking the ref (not the React
      // state) defends against the same tick double-submit (Enter held, click
      // burst, etc.). The terminal states are treated as "ready to send again"
      // — only mid-flight states block.
      if (isInFlight(sendStatusRef.current)) return;
      // Issue #1561 — an explicit `options.text` (the committed spoken transcript) is sent instead of the
      // draft. The voice dialogue session cannot use the draft here: it would have to call setDraft(text)
      // then sendMessage() in the same tick, but this callback closes over the React `draft` state, so the
      // just-set value is invisible until the next render and the send would early-return on empty content.
      // Reading the override directly makes the spoken turn flow through the identical context-bearing path.
      const content = (options?.text ?? draft).trim();
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
      // Issue #4 — block grounded sends that would silently discard attachments.
      // The grounded path derives context from the repo/local-knowledge scope and
      // ignores pendingAttachments entirely. Surface a notice and abort so the
      // user can remove the attachment before sending.
      if (hasGroundingScope(chat) && pendingAttachments.length > 0) {
        setError(GROUNDED_ATTACHMENT_NOTICE);
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
        const isGrounded = hasGroundingScope(chat);
        // Issue #148 — extract bounded document text for the ungrounded path only. The grounded
        // path derives its context from the repo/local-knowledge scope, not from attachments.
        const { entries: documentContext, disclosures } = isGrounded
          ? { entries: [] as readonly ConversationDocumentContextWire[], disclosures: [] }
          : await buildDocumentContext();
        const terminal = isGrounded
          ? await sendGrounded(chat, project, content, optimistic.id, modelId, controller.signal)
          : await sendUngrounded(
              chat,
              project,
              content,
              optimistic.id,
              modelId,
              controller.signal,
              documentContext,
            );
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
          // Issue #148 — record which documents contributed context so the UI can disclose them.
          setLastSentDocuments(disclosures);
        }
      } finally {
        sendControllerRef.current = null;
      }
    },
    [
      draft,
      state.activeChat,
      state.activeProject,
      state.selectedModel,
      state.models,
      pendingAttachments,
      sendGrounded,
      sendUngrounded,
      buildDocumentContext,
      clearPendingAttachments,
      updateSendStatus,
    ],
  );

  const appendVoiceTurn = useCallback(
    async (messages: readonly AppendDesktopChatVoiceTurnMessage[]): Promise<void> => {
      const chat = state.activeChat;
      if (chat === undefined || messages.length === 0) {
        return;
      }
      const projectPath = state.activeProject?.path ?? chat.projectPath;
      const modelId = resolveSelectedModelId(state.selectedModel, state.models);
      try {
        const result = await appendDesktopChatVoiceTurn({
          chatId: chat.id,
          projectPath,
          messages,
          ...(modelId === undefined ? {} : { modelId }),
          memory: buildMemoryRequest(chat, state.activeProject ?? { path: projectPath }),
        });
        if (!mountedRef.current) {
          return;
        }
        notifyChatUpsert(result.chat);
        if (activeChatIdRef.current === chat.id && result.memory !== undefined) {
          setLatestMemory(result.memory);
        }
        setState((previous) => {
          const isActiveChat = previous.activeChat?.id === chat.id;
          const existingIds = new Set(previous.messages.map((message) => message.id));
          const appended = isActiveChat
            ? result.messages.filter((message) => !existingIds.has(message.id))
            : [];
          const chats = sortChats([
            result.chat,
            ...previous.chats.filter((existing) => existing.id !== result.chat.id),
          ]);
          return {
            ...previous,
            activeChat: isActiveChat ? result.chat : previous.activeChat,
            chats,
            messages: [...previous.messages, ...appended],
          };
        });
      } catch (caught) {
        setError(errorMessage(caught));
      }
    },
    [buildMemoryRequest, state.activeChat, state.activeProject, state.models, state.selectedModel],
  );

  const runRealtimeGroundedTool = useCallback(
    async (
      input: RealtimeGroundedToolCallInput,
      signal?: AbortSignal,
    ): Promise<RealtimeGroundedToolOutput> => {
      const chat = state.activeChat;
      if (chat === undefined) {
        throw new Error("No active chat is available for grounded voice.");
      }
      const project = state.activeProject ?? { path: chat.projectPath };
      const modelId = resolveSelectedModelId(state.selectedModel, state.models);
      const result = await postRealtimeGroundedTool(
        {
          chatId: chat.id,
          projectPath: project.path,
          callId: input.callId,
          query: input.query,
          ...(input.userTranscript === undefined ? {} : { userTranscript: input.userTranscript }),
          ...(modelId === undefined ? {} : { modelId }),
          memory: buildMemoryRequest(chat, project),
        },
        signal,
      );
      if (!mountedRef.current || activeChatIdRef.current !== chat.id) {
        return result.toolOutput;
      }
      notifyChatUpsert(result.chat);
      setLatestGrounded(result.groundedAnswer);
      if (result.memory !== undefined) setLatestMemory(result.memory);
      setState((previous) => {
        if (previous.activeChat?.id !== chat.id) {
          return previous;
        }
        const existingIds = new Set(previous.messages.map((message) => message.id));
        const appended = result.messages.filter((message) => !existingIds.has(message.id));
        return {
          ...previous,
          activeChat: result.chat,
          chats: sortChats([
            result.chat,
            ...previous.chats.filter((existing) => existing.id !== result.chat.id),
          ]),
          messages: [...previous.messages, ...appended],
        };
      });
      return result.toolOutput;
    },
    [buildMemoryRequest, state.activeChat, state.activeProject, state.models, state.selectedModel],
  );

  // Issue #184 — local cache update after a connected-scope PATCH (or any other surgical wire
  // mutation on the active Chat). Only the matched id is updated; the chat list keeps its
  // existing sort order so the pill flip is non-disruptive. activeChat is rewritten when its
  // id matches so the header re-renders with the new ChatConnectedScope.
  const replaceChat = useCallback((chat: Chat) => {
    notifyChatUpsert(chat);
    setState((previous) => ({
      ...previous,
      chats: previous.chats.map((existing) => (existing.id === chat.id ? chat : existing)),
      activeChat: previous.activeChat?.id === chat.id ? chat : previous.activeChat,
    }));
  }, []);
  const clearError = useCallback((): void => {
    setError(undefined);
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
    clearError,
    setDraft,
    setSelectedModel,
    openNewChat,
    openProject,
    openChat,
    addProject,
    sendMessage,
    appendVoiceTurn,
    runRealtimeGroundedTool,
    cancelSend,
    replaceChat,
    latestGrounded,
    cancelGrounded,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
    clearPendingAttachments,
    lastSentDocuments,
    memoryEnabled,
    setMemoryEnabled,
    memoryBudgetTokens,
    setMemoryBudgetTokens,
    latestMemory,
    clearLatestMemory,
    acceptMemoryCandidate,
    rejectMemoryCandidate,
    forgetMemoryAction,
  };
}
