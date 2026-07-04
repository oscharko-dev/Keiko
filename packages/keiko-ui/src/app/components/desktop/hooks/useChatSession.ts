"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classifyAttachmentMime, MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts";
import type { ConversationAttachmentDescriptorWire, MemoryId } from "@oscharko-dev/keiko-contracts";
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
  regenerateDesktopChat,
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
  // Defined for image kind; undefined for document kind (AC #4 — no path leaked).
  // GEN-PERF-MEMORY-001 — this is an object URL (URL.createObjectURL) rather than a base64 data
  // URL: it gives the same path-safety guarantee (it carries no filesystem path) without the
  // synchronous main-thread base64 encode + full-file in-memory copy. It MUST be revoked on every
  // removal path (remove/clear/model-switch-drop/unmount) so no blob is retained.
  readonly previewUrl?: string | undefined;
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

// Hard 8 MiB byte limit + the MIME allowlist/classifier are the canonical policy from
// keiko-contracts (GEN-DUP-SEMANTIC-013/-014). This client-side gate provides immediate feedback
// without a round-trip; the server re-enforces the identical policy as the trust boundary. Re-
// exported so existing importers of this constant keep resolving it from here.
export { MAX_ATTACHMENT_BYTES };

// Map the shared 'image'|'document'|'unsupported' classification onto this hook's attachment
// union. Adopting the contracts classifier widens the client document allowlist to match the
// server it previously under-approximated (application/xml, application/javascript,
// application/typescript now classify as documents); image/svg+xml stays rejected.
function classifyMime(mimeType: string): PendingAttachmentKind | "unsupported-type" {
  const classification = classifyAttachmentMime(mimeType);
  return classification === "unsupported" ? "unsupported-type" : classification;
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

// GEN-PERF-MEMORY-001 — revoke a pending attachment's object-URL preview if it carries one. Safe to
// call on any attachment (documents have no previewUrl) and idempotent enough for the removal paths.
function revokeAttachmentPreview(attachment: PendingAttachment): void {
  if (attachment.previewUrl !== undefined && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export const DEFAULT_CHAT_TITLE = "New chat";
export const DEFAULT_CONVERSATION_MEMORY_USER_ID = "local-operator";
const CHAT_UPSERT_EVENT = "keiko:chat-upsert";
const CHAT_DELETE_EVENT = "keiko:chat-delete";
const RUN_SUMMARY_SYNC_INTERVAL_MS = 1_000;
const RUN_SUMMARY_SYNC_MAX_ATTEMPTS = 120;
const RUN_SUMMARY_SYNC_MAX_INTERVAL_MS = 15_000;
const VOICE_TURN_APPEND_MAX_ATTEMPTS = 2;

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

function shouldRetryVoiceTurnAppend(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

function makeVoiceTurnIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function appendDesktopChatVoiceTurnWithRetry(
  input: Parameters<typeof appendDesktopChatVoiceTurn>[0],
): ReturnType<typeof appendDesktopChatVoiceTurn> {
  let lastError: unknown;
  const baseTimestamp = Date.now();
  const durableInput: Parameters<typeof appendDesktopChatVoiceTurn>[0] = {
    ...input,
    idempotencyKey: input.idempotencyKey ?? makeVoiceTurnIdempotencyKey(),
    messages: input.messages.map((message, index) => ({
      ...message,
      timestamp: message.timestamp ?? baseTimestamp + index,
    })),
  };
  for (let attempt = 0; attempt < VOICE_TURN_APPEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await appendDesktopChatVoiceTurn(durableInput);
    } catch (caught) {
      lastError = caught;
      if (!shouldRetryVoiceTurnAppend(caught)) {
        break;
      }
    }
  }
  throw lastError;
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

type ChatMutation =
  | { readonly type: "upsert"; readonly chat: Chat }
  | { readonly type: "delete"; readonly chatId: string };

type ChatMutationSubscriber = (mutation: ChatMutation) => void;

const chatMutationSubscribers = new Set<ChatMutationSubscriber>();
let chatMutationListenersAttached = false;

function emitChatMutation(mutation: ChatMutation): void {
  for (const subscriber of chatMutationSubscribers) {
    subscriber(mutation);
  }
}

function onChatUpsertEvent(event: Event): void {
  const chat = (event as CustomEvent<unknown>).detail;
  if (!isChatPayload(chat)) return;
  invalidateSharedBootstrap();
  emitChatMutation({ type: "upsert", chat });
}

function onChatDeleteEvent(event: Event): void {
  const payload = (event as CustomEvent<unknown>).detail;
  if (!isChatDeletePayload(payload)) return;
  invalidateSharedBootstrap();
  emitChatMutation({ type: "delete", chatId: payload.chatId });
}

function ensureChatMutationListeners(): void {
  if (chatMutationListenersAttached || typeof window === "undefined") return;
  window.addEventListener(CHAT_UPSERT_EVENT, onChatUpsertEvent);
  window.addEventListener(CHAT_DELETE_EVENT, onChatDeleteEvent);
  chatMutationListenersAttached = true;
}

function removeChatMutationListenersIfIdle(): void {
  if (!chatMutationListenersAttached || chatMutationSubscribers.size > 0) return;
  window.removeEventListener(CHAT_UPSERT_EVENT, onChatUpsertEvent);
  window.removeEventListener(CHAT_DELETE_EVENT, onChatDeleteEvent);
  chatMutationListenersAttached = false;
}

function subscribeChatMutations(subscriber: ChatMutationSubscriber): () => void {
  chatMutationSubscribers.add(subscriber);
  ensureChatMutationListeners();
  return () => {
    chatMutationSubscribers.delete(subscriber);
    removeChatMutationListenersIfIdle();
  };
}

export function notifyChatUpsert(chat: Chat): void {
  invalidateSharedBootstrap();
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_UPSERT_EVENT, { detail: chat }));
}

export function notifyChatDeleted(chatId: string): void {
  invalidateSharedBootstrap();
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
  // Live assistant text for the active streaming turn. Kept outside `messages`
  // so token deltas do not rewrite or scan the full conversation history.
  readonly streamingAssistantMessage?: ChatMessage | undefined;
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
  regeneratingMessageId: string | undefined;
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
  regenerateMessage: (assistantMessageId: string) => Promise<void>;
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

const SHARED_BOOTSTRAP_TTL_MS = 2_000;

interface SharedBootstrapCacheEntry {
  readonly expiresAt: number;
  readonly value: Partial<SessionState>;
}

let sharedBootstrapCache: SharedBootstrapCacheEntry | undefined;
let sharedBootstrapInflight: Promise<Partial<SessionState>> | undefined;
let sharedBootstrapVersion = 0;
const sharedChatListInflight = new Map<string, Promise<{ readonly chats: readonly Chat[] }>>();
const sharedChatMessagesInflight = new Map<
  string,
  Promise<{ readonly messages: readonly ChatMessage[] }>
>();

function cloneSessionPatch(patch: Partial<SessionState>): Partial<SessionState> {
  const cloned: Partial<SessionState> = { ...patch };
  if (patch.projects !== undefined) cloned.projects = [...patch.projects];
  if (patch.chats !== undefined) cloned.chats = [...patch.chats];
  if (patch.messages !== undefined) cloned.messages = [...patch.messages];
  if (patch.models !== undefined) cloned.models = [...patch.models];
  return cloned;
}

function invalidateSharedBootstrap(): void {
  sharedBootstrapVersion += 1;
  sharedBootstrapCache = undefined;
  sharedBootstrapInflight = undefined;
}

function cloneChatListPayload(payload: { readonly chats: readonly Chat[] }): {
  readonly chats: readonly Chat[];
} {
  return { chats: Array.from(payload.chats) };
}

function cloneChatMessagesPayload(payload: { readonly messages: readonly ChatMessage[] }): {
  readonly messages: readonly ChatMessage[];
} {
  return { messages: Array.from(payload.messages) };
}

function sharedFetchChats(projectPath: string): Promise<{ readonly chats: readonly Chat[] }> {
  const existing = sharedChatListInflight.get(projectPath);
  if (existing !== undefined) return existing.then(cloneChatListPayload);
  const pending = fetchChats(projectPath)
    .then(cloneChatListPayload)
    .finally(() => {
      if (sharedChatListInflight.get(projectPath) === pending) {
        sharedChatListInflight.delete(projectPath);
      }
    });
  sharedChatListInflight.set(projectPath, pending);
  return pending.then(cloneChatListPayload);
}

function sharedFetchChatMessages(
  chatId: string,
  projectPath: string,
): Promise<{ readonly messages: readonly ChatMessage[] }> {
  const key = `${projectPath}\u0000${chatId}`;
  const existing = sharedChatMessagesInflight.get(key);
  if (existing !== undefined) return existing.then(cloneChatMessagesPayload);
  const pending = fetchChatMessages(chatId, projectPath)
    .then(cloneChatMessagesPayload)
    .finally(() => {
      if (sharedChatMessagesInflight.get(key) === pending) {
        sharedChatMessagesInflight.delete(key);
      }
    });
  sharedChatMessagesInflight.set(key, pending);
  return pending.then(cloneChatMessagesPayload);
}

export function clearChatSessionBootstrapCacheForTests(): void {
  invalidateSharedBootstrap();
  sharedChatListInflight.clear();
  sharedChatMessagesInflight.clear();
}

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

// GEN-PERF-CHAT-011 — an abort-aware sleep: resolves after `ms`, or rejects immediately if the
// signal aborts (or is already aborted), so a parked poll loop stops at the sleep edge instead of
// burning the full delay before its next abort check.
class PollAbortError extends Error {
  public constructor() {
    super("run-summary poll aborted");
    this.name = "PollAbortError";
  }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new PollAbortError());
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(new PollAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function runSummarySyncDelayMs(attempt: number): number {
  return Math.min(
    RUN_SUMMARY_SYNC_INTERVAL_MS * 2 ** Math.min(attempt, 4),
    RUN_SUMMARY_SYNC_MAX_INTERVAL_MS,
  );
}

interface RunSummarySyncResult {
  readonly chatId: string;
  readonly messageId: string;
  readonly message: ChatMessage;
}

const sharedRunSummarySyncs = new Map<string, Promise<RunSummarySyncResult | undefined>>();

function runSummarySharedSyncKey(chat: Chat, projectPath: string, message: ChatMessage): string {
  return `${chat.id}:${projectPath}:${message.id}:${message.runId ?? ""}`;
}

async function pollRunSummaryPatch(
  chat: Chat,
  projectPath: string,
  message: ChatMessage,
  signal?: AbortSignal,
): Promise<RunSummarySyncResult | undefined> {
  const runId = message.runId;
  if (runId === undefined) return undefined;
  const fallbackKind = runSummaryFallbackKind(message);

  for (let attempt = 0; attempt < RUN_SUMMARY_SYNC_MAX_ATTEMPTS; attempt += 1) {
    // GEN-PERF-CHAT-011 — abort at the fetch edge: once the owning hook unmounts, stop issuing
    // network requests instead of running out the remaining attempts.
    if (signal?.aborted === true) return undefined;
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
          const manifestSummary = formatRunSummaryFromManifest(response.manifest, fallbackKind);
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
        return undefined;
      }
    }

    if (summary !== undefined) {
      const patched = await patchChatMessage(message.id, chat.id, projectPath, summary);
      return { chatId: chat.id, messageId: message.id, message: patched.message };
    }

    if (attempt < RUN_SUMMARY_SYNC_MAX_ATTEMPTS - 1) {
      try {
        await abortableSleep(runSummarySyncDelayMs(attempt), signal);
      } catch {
        // GEN-PERF-CHAT-011 — aborted mid-wait: park the loop instead of spinning to max attempts.
        return undefined;
      }
    }
  }

  return undefined;
}

function sharedRunSummaryPatch(
  chat: Chat,
  projectPath: string,
  message: ChatMessage,
  signal?: AbortSignal,
): Promise<RunSummarySyncResult | undefined> {
  const key = runSummarySharedSyncKey(chat, projectPath, message);
  const existing = sharedRunSummarySyncs.get(key);
  if (existing !== undefined) return existing;
  // GEN-PERF-CHAT-011 — the poll is aborted when the owning hook unmounts (signal from the hook's
  // AbortController). The shared cache is keyed per (chat, project, message, runId); chat is a
  // singleton window (Step 03) so a single hook owns the poll for a given run.
  const pending = pollRunSummaryPatch(chat, projectPath, message, signal).finally(() => {
    if (sharedRunSummarySyncs.get(key) === pending) {
      sharedRunSummarySyncs.delete(key);
    }
  });
  sharedRunSummarySyncs.set(key, pending);
  return pending;
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
    const chatPayload = await sharedFetchChats(project.path).catch(() => ({ chats: [] }));
    const sortedChats = sortChats(chatPayload.chats);
    const latestChat = sortedChats[0];
    if (latestChat !== undefined) {
      const messagePayload = await sharedFetchChatMessages(latestChat.id, project.path);
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

function sharedBootstrapSession(autoCreate: boolean): Promise<Partial<SessionState>> {
  if (autoCreate) return bootstrapSession(autoCreate);
  const now = Date.now();
  if (sharedBootstrapCache !== undefined && sharedBootstrapCache.expiresAt > now) {
    return Promise.resolve(cloneSessionPatch(sharedBootstrapCache.value));
  }
  if (sharedBootstrapInflight !== undefined) {
    return sharedBootstrapInflight.then(cloneSessionPatch);
  }
  const version = sharedBootstrapVersion;
  const pending = bootstrapSession(false)
    .then((patch) => {
      const value = cloneSessionPatch(patch);
      if (sharedBootstrapVersion === version) {
        sharedBootstrapCache = {
          expiresAt: Date.now() + SHARED_BOOTSTRAP_TTL_MS,
          value,
        };
      }
      return cloneSessionPatch(value);
    })
    .finally(() => {
      if (sharedBootstrapInflight === pending) sharedBootstrapInflight = undefined;
    });
  sharedBootstrapInflight = pending;
  return pending.then(cloneSessionPatch);
}

export interface UseChatSessionOptions {
  readonly autoCreate?: boolean;
}

export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionResult {
  const autoCreate = options.autoCreate ?? true;
  const [state, setState] = useState<SessionState>(INITIAL_STATE);
  const [streamingAssistantMessage, setStreamingAssistantMessage] = useState<
    ChatMessage | undefined
  >();
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  // Issue #152 — lifecycle is the source of truth; `sending` is derived.
  const [sendStatus, setSendStatus] = useState<SendStatus>("idle");
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | undefined>();
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
  // GEN-DUP-SEMANTIC-016 — two named predicates for the two repeated stale-landing guards so the
  // intent reads at the call site. `activeChatIdRef.current` is read at CALL time (not captured),
  // preserving the existing ref-based guard behaviour exactly.
  const isStillActiveChat = (id: string): boolean => activeChatIdRef.current === id;
  const isSupersededOrAborted = (id: string, signal: AbortSignal): boolean =>
    signal.aborted || activeChatIdRef.current !== id;
  const activeProjectPathRef = useRef<string | undefined>(undefined);
  const runSummarySyncingRef = useRef<Set<string>>(new Set());
  // GEN-PERF-CHAT-011 — a per-hook AbortController for the run-summary pollers, aborted on unmount
  // so the poll loop stops at its fetch/sleep edges instead of running out its remaining attempts.
  // Re-created in the mount effect (below) so a StrictMode mount→unmount→remount cycle gets a fresh,
  // un-aborted controller rather than reusing the one aborted by the simulated unmount.
  const runSummaryControllerRef = useRef<AbortController>(new AbortController());
  // GEN-PERF-CHAT-011 — syncKeys whose poll cycle finished without a terminal patch. A completed
  // non-terminal cycle parks here so an unrelated state.messages change does not re-arm the same
  // never-settling run over and over. Cleared per key when a genuinely new run message id appears.
  const runSummaryParkedRef = useRef<Set<string>>(new Set());
  const selectedModelPersistRef = useRef(0);
  // COMP-5 — synchronous read of the current model list inside setSelectedModel
  // (which is intentionally `useCallback(..., [])`) without recreating the callback.
  const modelsRef = useRef<readonly ModelCapability[]>([]);
  // Issue #147 — pending-attachment state. Cleared after a successful send (AC #3).
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachment[]>([]);
  // GEN-PERF-MEMORY-001 — live mirror of pendingAttachments so the unmount cleanup can revoke any
  // outstanding object-URL previews without re-subscribing the mount effect to attachment changes.
  const pendingAttachmentsRef = useRef<readonly PendingAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;
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

      // AC #4: generate a preview for images only; never store file.path.
      // GEN-PERF-MEMORY-001 — an object URL replaces the old base64 data-URL. It is synchronous
      // (no FileReader, no main-thread base64 encode / full-file copy) and carries no path, so the
      // path-safety guarantee is unchanged. It is revoked on every removal path (below + unmount).
      let previewUrl: string | undefined;
      if (kind === "image") {
        try {
          previewUrl = URL.createObjectURL(file);
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
        previewUrl,
        // Issue #148 — retain the File so the send path can extract document text.
        file,
      };
      setPendingAttachments((previous) => [...previous, attachment]);
      return { ok: true };
    },
    [state.models, state.selectedModel],
  );

  // AC #3: remove a single pending attachment by id.
  // GEN-PERF-MEMORY-001 — revoke the removed attachment's object-URL preview so no blob is retained.
  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((previous) => {
      const removed = previous.find((a) => a.id === id);
      if (removed !== undefined) revokeAttachmentPreview(removed);
      return previous.filter((a) => a.id !== id);
    });
  }, []);

  // Clears all pending attachments (called after successful sendMessage).
  // GEN-PERF-MEMORY-001 — revoke every removed attachment's object-URL preview.
  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((previous) => {
      for (const attachment of previous) revokeAttachmentPreview(attachment);
      return previous.length === 0 ? previous : [];
    });
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

  const buildAttachmentDescriptors = useCallback(
    (): readonly ConversationAttachmentDescriptorWire[] =>
      pendingAttachments.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      })),
    [pendingAttachments],
  );

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
    await forgetMemory(memoryId as MemoryId);
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
      try {
        const patched = await sharedRunSummaryPatch(
          chat,
          projectPath,
          message,
          runSummaryControllerRef.current?.signal,
        );
        if (patched === undefined) {
          // GEN-PERF-CHAT-011 — the cycle finished without a terminal patch (exhausted attempts or
          // aborted). Park this syncKey so an unrelated state.messages change does not immediately
          // re-arm the same never-settling run. A genuinely new run message clears its own key
          // below (its syncKey — message.id:runId — differs), so fresh runs still poll.
          if (mountedRef.current) runSummaryParkedRef.current.add(syncKey);
          return;
        }
        if (!mountedRef.current || activeChatIdRef.current !== chat.id) return;
        // Not isStillActiveChat: this reads the setState updater's `previous` snapshot, not the
        // activeChatIdRef, so the predicate does not apply here.
        setState((previous) =>
          previous.activeChat?.id !== chat.id
            ? previous
            : {
                ...previous,
                messages: previous.messages.map((existing) =>
                  existing.id === patched.messageId ? patched.message : existing,
                ),
              },
        );
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
    activeProjectPathRef.current = state.activeProject?.path;
  }, [state.activeProject?.path]);

  useEffect(() => {
    modelsRef.current = state.models;
  }, [state.models]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      setLoading(true);
      setError(undefined);
      try {
        const patch = await sharedBootstrapSession(autoCreate);
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
    return subscribeChatMutations((mutation) => {
      if (mutation.type === "upsert") {
        const { chat } = mutation;
        setState((previous) => ({
          ...previous,
          chats: sortChats([chat, ...previous.chats.filter((existing) => existing.id !== chat.id)]),
          activeChat: previous.activeChat?.id === chat.id ? chat : previous.activeChat,
          selectedModel:
            previous.activeChat?.id === chat.id
              ? resolveSelectedModelId(chat.selectedModel, previous.models)
              : previous.selectedModel,
        }));
        return;
      }
      setState((previous) => ({
        ...previous,
        chats: previous.chats.filter((chat) => chat.id !== mutation.chatId),
        activeChat: previous.activeChat?.id === mutation.chatId ? undefined : previous.activeChat,
        messages: previous.activeChat?.id === mutation.chatId ? [] : previous.messages,
      }));
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // GEN-PERF-CHAT-011 — install a fresh controller for this mount so a StrictMode remount (which
    // re-runs this effect after the cleanup aborted the previous one) polls with a live signal.
    if (runSummaryControllerRef.current.signal.aborted) {
      runSummaryControllerRef.current = new AbortController();
    }
    return () => {
      mountedRef.current = false;
      sendControllerRef.current?.abort();
      // GEN-PERF-CHAT-011 — abort the run-summary pollers so their loops stop at the next fetch/
      // sleep edge instead of running out their remaining (up to 120) attempts after unmount.
      runSummaryControllerRef.current.abort();
      // GEN-PERF-MEMORY-001 — revoke any outstanding object-URL previews so no blob leaks when the
      // hook unmounts with pending image attachments still queued.
      for (const attachment of pendingAttachmentsRef.current) revokeAttachmentPreview(attachment);
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
      // GEN-PERF-CHAT-011 — do not re-arm a poll cycle that already completed without settling.
      if (runSummaryParkedRef.current.has(syncKey)) continue;
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
    setPendingAttachments((previous) => {
      const kept = previous.filter((a) => isAttachmentSupported(a, id, modelsRef.current));
      if (kept.length === previous.length) return previous;
      // GEN-PERF-MEMORY-001 — revoke the object-URL preview of every dropped attachment.
      const keptIds = new Set(kept.map((a) => a.id));
      for (const attachment of previous) {
        if (!keptIds.has(attachment.id)) revokeAttachmentPreview(attachment);
      }
      return kept;
    });
    const activeChatId = activeChatIdRef.current;
    if (activeChatId === undefined) return;
    const requestId = selectedModelPersistRef.current + 1;
    selectedModelPersistRef.current = requestId;
    void updateChat(activeChatId, { selectedModel: id })
      .then((result) => {
        if (selectedModelPersistRef.current !== requestId) return;
        // Not isStillActiveChat: this compares the active ref against the PATCH RESPONSE's chat
        // id (result.chat.id), not a stable captured chat id, so the shared predicate is a
        // different check.
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
        // would clobber the now-active chat's selection. Not isStillActiveChat: this compares
        // against the captured-at-send-time local `activeChatId`, not a per-call chat.id.
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
      setStreamingAssistantMessage(undefined);
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
        if (targetPath !== undefined && activeProjectPathRef.current !== targetPath) {
          return undefined;
        }
        activeChatIdRef.current = created.chat.id;
        activeProjectPathRef.current = created.project.path;
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
      setStreamingAssistantMessage(undefined);
      activeProjectPathRef.current = project.path;
      setState((previous) => ({ ...previous, activeProject: project }));
      try {
        const chatPayload = await sharedFetchChats(project.path);
        if (activeProjectPathRef.current !== project.path) return;
        const sorted = sortChats(chatPayload.chats);
        const latest = sorted[0];
        if (latest === undefined) {
          if (activeProjectPathRef.current !== project.path) return;
          await openNewChat(project);
          return;
        }
        const messagePayload = await sharedFetchChatMessages(latest.id, project.path);
        if (activeProjectPathRef.current !== project.path) return;
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
        if (activeProjectPathRef.current !== project.path) return;
        setError(errorMessage(caught));
      }
    },
    [openNewChat, state.models],
  );

  const openChat = useCallback(
    async (chat: Chat): Promise<void> => {
      if (activeChatIdRef.current === chat.id && state.activeChat?.id === chat.id) return;
      setError(undefined);
      setStreamingAssistantMessage(undefined);
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
        const messagePayload = await sharedFetchChatMessages(chat.id, chat.projectPath);
        if (!isStillActiveChat(chat.id)) return;
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
        if (!isStillActiveChat(chat.id)) return;
        setError(errorMessage(caught));
      }
    },
    [state.activeChat?.id, state.models],
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
    setStreamingAssistantMessage((current) => (current?.id === id ? undefined : current));
    setState((previous) => ({
      ...previous,
      messages: previous.messages.filter((m) => m.id !== id),
    }));
  }, []);

  // Builds the StreamHandlers for a streaming request. Extracted to keep
  // streamUngrounded within the 50-line function limit.
  const buildStreamHandlers = useCallback(
    (
      chatId: string,
      tempAssistantId: string,
      optimisticId: string,
      signal: AbortSignal,
      resolve: (status: SendStatus) => void,
    ): import("@/lib/api").StreamHandlers => {
      let statusFlippedToStreaming = false;
      // GEN-PERF-CHAT-007 — coalesce streamed token deltas. Each onToken appends to a buffer and
      // schedules (at most) one requestAnimationFrame; the frame applies the whole accumulated
      // buffer in ONE setStreamingAssistantMessage. This collapses a burst of N tokens landing in
      // one frame into a single state commit while preserving order (appends are synchronous into
      // the ref). Every terminal handler flushes any residual buffer and cancels the pending frame
      // so no final token is dropped.
      let pendingText = "";
      let rafHandle: number | null = null;
      const canRaf = typeof requestAnimationFrame === "function";
      const flush = (): void => {
        rafHandle = null;
        if (pendingText.length === 0) return;
        const buffered = pendingText;
        pendingText = "";
        setStreamingAssistantMessage((current) =>
          current?.id === tempAssistantId
            ? { ...current, content: current.content + buffered }
            : current,
        );
      };
      const cancelFlush = (): void => {
        if (rafHandle !== null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(rafHandle);
        }
        rafHandle = null;
      };
      return {
        onToken: (text: string): void => {
          if (isSupersededOrAborted(chatId, signal)) return;
          if (!statusFlippedToStreaming) {
            updateSendStatus("streaming");
            statusFlippedToStreaming = true;
          }
          pendingText += text;
          if (!canRaf) {
            flush();
            return;
          }
          if (rafHandle === null) {
            rafHandle = requestAnimationFrame(flush);
          }
        },
        onDone: (payload: SseDonePayload): void => {
          cancelFlush();
          flush();
          if (isSupersededOrAborted(chatId, signal)) {
            setStreamingAssistantMessage((current) =>
              current?.id === tempAssistantId ? undefined : current,
            );
            resolve("cancelled");
            return;
          }
          setStreamingAssistantMessage((current) =>
            current?.id === tempAssistantId ? undefined : current,
          );
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
          // GEN-PERF-CHAT-007 — cancel any pending frame; onError/onCancelled remove the temp
          // bubble entirely (AC#3, no partial kept), so the buffered text must NOT be flushed.
          cancelFlush();
          pendingText = "";
          if (isSupersededOrAborted(chatId, signal)) {
            removeTempMessage(tempAssistantId);
            resolve("cancelled");
            return;
          }
          setError(errorMessage(new ApiError(code, message, 0)));
          removeTempMessage(tempAssistantId);
          resolve("failed");
        },
        onCancelled: (): void => {
          cancelFlush();
          pendingText = "";
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
      attachments: readonly ConversationAttachmentDescriptorWire[],
    ): Promise<SendStatus> => {
      const tempAssistantId = `stream-${String(Date.now())}`;
      setStreamingAssistantMessage({
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
      });
      const requestBody = {
        chatId: chat.id,
        projectPath: project.path,
        content,
        modelId,
        memory: buildMemoryRequest(chat, project),
        ...(documentContext.length > 0 ? { documentContext } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      return new Promise<SendStatus>((resolve, reject) => {
        const handlers = buildStreamHandlers(
          chat.id,
          tempAssistantId,
          optimisticId,
          signal,
          resolve,
        );
        sendDesktopChatStream(requestBody, signal, handlers).catch((caught: unknown) => {
          removeTempMessage(tempAssistantId);
          if (caught instanceof StreamingUnavailableError) {
            // Pre-stream failure (e.g. STREAMING_UNSUPPORTED, or a JSON error before any SSE
            // header). Reject so sendUngrounded falls back to the buffered path instead of
            // surfacing a hard failure to the user.
            reject(caught);
          } else if (caught instanceof DOMException && caught.name === "AbortError") {
            resolve("cancelled");
          } else if (isSupersededOrAborted(chat.id, signal)) {
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
      attachments: readonly ConversationAttachmentDescriptorWire[],
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
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          signal,
        );
        if (isSupersededOrAborted(chat.id, signal)) return "cancelled";
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
        if (isSupersededOrAborted(chat.id, signal)) return "cancelled";
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
      attachments: readonly ConversationAttachmentDescriptorWire[],
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
          attachments,
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
          attachments,
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
        attachments,
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
        if (!isStillActiveChat(chat.id)) {
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
    setRegeneratingMessageId(undefined);
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
        const attachmentDescriptors: readonly ConversationAttachmentDescriptorWire[] = isGrounded
          ? []
          : buildAttachmentDescriptors();
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
              attachmentDescriptors,
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
      buildAttachmentDescriptors,
      clearPendingAttachments,
      updateSendStatus,
    ],
  );

  const regenerateMessage = useCallback(
    async (assistantMessageId: string): Promise<void> => {
      if (isInFlight(sendStatusRef.current)) return;
      const chat = state.activeChat;
      const project = state.activeProject;
      const modelId = resolveSelectedModelId(state.selectedModel, state.models);
      if (chat === undefined || project === undefined || modelId === undefined) return;
      updateSendStatus("queued");
      setRegeneratingMessageId(assistantMessageId);
      setError(undefined);
      setLatestGrounded(undefined);
      setLatestMemory(undefined);
      const controller = new AbortController();
      sendControllerRef.current = controller;
      try {
        updateSendStatus("contacting");
        const result = await regenerateDesktopChat(
          {
            chatId: chat.id,
            projectPath: project.path,
            assistantMessageId,
            modelId,
            memory: buildMemoryRequest(chat, project),
          },
          controller.signal,
        );
        if (controller.signal.aborted) {
          updateSendStatus("cancelled");
          return;
        }
        const replacement = result.messages.find((message) => message.id === assistantMessageId);
        setState((previous) => ({
          ...previous,
          activeChat: result.chat,
          chats: sortChats([
            result.chat,
            ...previous.chats.filter((existing) => existing.id !== result.chat.id),
          ]),
          messages:
            replacement === undefined
              ? previous.messages
              : previous.messages.map((message) =>
                  message.id === assistantMessageId ? replacement : message,
                ),
        }));
        notifyChatUpsert(result.chat);
        setLatestMemory(result.memory);
        updateSendStatus("completed");
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          updateSendStatus("cancelled");
          return;
        }
        setError(errorMessage(caught));
        updateSendStatus("failed");
      } finally {
        sendControllerRef.current = null;
        setRegeneratingMessageId(undefined);
      }
    },
    [
      state.activeChat,
      state.activeProject,
      state.selectedModel,
      state.models,
      buildMemoryRequest,
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
        const result = await appendDesktopChatVoiceTurnWithRetry({
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
        if (isStillActiveChat(chat.id) && result.memory !== undefined) {
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
      if (!mountedRef.current || !isStillActiveChat(chat.id)) {
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

  const noEligibleModels =
    !loading && resolveSelectedModelId(state.selectedModel, state.models) === undefined;

  return useMemo<UseChatSessionResult>(
    () => ({
      projects: state.projects,
      chats: state.chats,
      messages: state.messages,
      streamingAssistantMessage,
      models: state.models,
      activeProject: state.activeProject,
      activeChat: state.activeChat,
      selectedModel: state.selectedModel,
      noEligibleModels,
      draft,
      loading,
      sending,
      sendStatus,
      regeneratingMessageId,
      error,
      clearError,
      setDraft,
      setSelectedModel,
      openNewChat,
      openProject,
      openChat,
      addProject,
      sendMessage,
      regenerateMessage,
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
    }),
    [
      state.projects,
      state.chats,
      state.messages,
      streamingAssistantMessage,
      state.models,
      state.activeProject,
      state.activeChat,
      state.selectedModel,
      noEligibleModels,
      draft,
      loading,
      sending,
      sendStatus,
      regeneratingMessageId,
      error,
      clearError,
      setSelectedModel,
      openNewChat,
      openProject,
      openChat,
      addProject,
      sendMessage,
      regenerateMessage,
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
    ],
  );
}
