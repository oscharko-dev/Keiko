"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { classifyAttachmentMime, MAX_ATTACHMENT_BYTES } from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import { ATTACHMENT_CLEANUP_DEFERRED_ERROR } from "@/lib/chat-session-error";
import type { ConversationAttachmentDescriptorWire, MemoryId } from "@oscharko-dev/keiko-contracts";
import {
  MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS,
  MAX_DESKTOP_CHAT_INPUT_BYTES,
  MAX_DESKTOP_CHAT_INPUT_CHARS,
  canonicalDesktopChatTurnReferenceSeed,
  isGroundingScopeIdentity,
} from "@oscharko-dev/keiko-contracts/bff-wire";
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
  patchChatMessage,
  projectResponseWarningMessage,
  resetModelRequestCache,
  regenerateDesktopChat,
  sendDesktopChat,
  sendDesktopChatStream,
  uploadConversationAttachment,
  deleteConversationAttachment,
  updateChat,
} from "@/lib/api";
import type { SseDonePayload } from "@/lib/api";
import {
  acceptMemoryProposal,
  forgetMemory,
  loadMemoryAutonomyMode,
  rejectMemoryProposal,
} from "@/lib/memory-api";
import { GATEWAY_CONFIG_UPDATED_EVENT } from "../widgets/shared/gatewaySetupBus";
import { sortProjects } from "@/lib/sidebar-sort";
import {
  classifyRunReport,
  formatRunSummaryFromManifest,
  type RunSummaryFallbackKind,
  type TerminalRunSummary,
} from "@/lib/run-summary";
import type {
  Chat,
  ChatMessage,
  ConversationDocumentContextWire,
  ConversationMemoryCaptureSurfaceWire,
  ConversationMemoryRequestWire,
  ConversationMemoryResultWire,
  GroundedAnswer as GroundedAnswerWire,
  ModelCapability,
  ProjectWithAvailability,
} from "@/lib/types";
import { isConversationEligibleModel } from "@/lib/types";
import { formatUserError } from "../format-error";
import { canonicalVoiceSha256Hex } from "./canonical-voice-hasher";
import { extractDocumentContext, type PendingDocument } from "./documentContext";
import {
  currentConversationMemoryModeRevision,
  useConversationMemorySettings,
} from "./memorySettings";

// ─── Attachment types (Issue #147) ────────────────────────────────────────────
//
// Client-side validation only. Server-side modality enforcement is deferred to
// issue #149. Pending attachments are cleared on successful sendMessage.

type PendingAttachmentKind = "image" | "document";

// Why: attachment rejection reasons are a closed, typed union so callers can
// show human-readable messages per reason without string matching.
export type AttachmentRejectionReason =
  | "text-only-model" // model capability forbids this attachment kind
  | "unsupported-type" // MIME not in the image/* / document allowlist
  | "oversized" // exceeds MAX_ATTACHMENT_BYTES (8 MiB)
  | "empty" // file.size === 0
  | "delivery-refused";

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
  readonly attachmentRef?: string | undefined;
  readonly sha256?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly projectPath?: string | undefined;
  readonly chatId?: string | undefined;
}

// Issue #148 — disclosure projection for documents that contributed extracted text to the most
// recent send. Carries only basename + truncation flag (never a path or bytes) so the UI can
// tell the user which documents were included and whether any was cut.
export interface SentDocumentDisclosure {
  readonly id: string;
  readonly displayName: string;
  readonly truncated: boolean;
}

export interface SentImageDisclosure {
  readonly id: string;
  readonly displayName: string;
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

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 32_768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function imageUploadProjection(file: File): Promise<{
  readonly sha256: string;
  readonly contentBase64: string;
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { sha256: bytesToHex(digest), contentBase64: bytesToBase64(bytes) };
}

type PendingAttachmentValidation =
  | { readonly ok: true; readonly kind: PendingAttachmentKind }
  | { readonly ok: false; readonly reason: AttachmentRejectionReason };

interface PendingImageUpload {
  readonly attachmentRef: string;
  readonly expiresAt: number;
  readonly sha256: string;
  readonly projectPath: string;
  readonly chatId: string;
}

type PendingAttachmentPreparation =
  | {
      readonly ok: true;
      readonly previewUrl?: string;
      readonly upload?: PendingImageUpload;
    }
  | { readonly ok: false; readonly reason: AttachmentRejectionReason };

function validatePendingAttachment(
  file: File,
  selectedModel: ModelCapability | undefined,
): PendingAttachmentValidation {
  if (file.size === 0) return { ok: false, reason: "empty" };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: "oversized" };
  const kind = classifyMime(file.type);
  if (kind === "unsupported-type") return { ok: false, reason: kind };
  if (kind === "image" && selectedModel?.supportsImageInput === false) {
    return { ok: false, reason: "text-only-model" };
  }
  if (kind === "document" && selectedModel?.supportsDocumentInput === false) {
    return { ok: false, reason: "text-only-model" };
  }
  return { ok: true, kind };
}

async function preparePendingAttachment(
  file: File,
  kind: PendingAttachmentKind,
  activeChat: Chat | undefined,
): Promise<PendingAttachmentPreparation> {
  if (kind === "document") return { ok: true };
  let previewUrl: string;
  try {
    previewUrl = URL.createObjectURL(file);
  } catch {
    return { ok: false, reason: "unsupported-type" };
  }
  if (activeChat === undefined) {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, reason: "delivery-refused" };
  }
  try {
    const projection = await imageUploadProjection(file);
    const uploaded = await uploadConversationAttachment({
      projectPath: activeChat.projectPath,
      chatId: activeChat.id,
      mimeType: file.type,
      sizeBytes: file.size,
      sha256: projection.sha256,
      contentBase64: projection.contentBase64,
    });
    return {
      ok: true,
      previewUrl,
      upload: {
        attachmentRef: uploaded.attachmentRef,
        expiresAt: uploaded.expiresAt,
        sha256: projection.sha256,
        projectPath: activeChat.projectPath,
        chatId: activeChat.id,
      },
    };
  } catch {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, reason: "delivery-refused" };
  }
}

async function deletePendingImage(attachment: PendingAttachment): Promise<void> {
  if (
    attachment.kind !== "image" ||
    attachment.attachmentRef === undefined ||
    attachment.sha256 === undefined ||
    attachment.projectPath === undefined ||
    attachment.chatId === undefined
  ) {
    return;
  }
  await deleteConversationAttachment({
    attachmentRef: attachment.attachmentRef,
    projectPath: attachment.projectPath,
    chatId: attachment.chatId,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
  });
}

const DEFAULT_CHAT_TITLE = "New chat";
const DEFAULT_CONVERSATION_MEMORY_USER_ID = "local-operator";
const CHAT_UPSERT_EVENT = "keiko:chat-upsert";
const CHAT_DELETE_EVENT = "keiko:chat-delete";
const RUN_SUMMARY_SYNC_INTERVAL_MS = 1_000;
const RUN_SUMMARY_SYNC_MAX_ATTEMPTS = 120;
const RUN_SUMMARY_SYNC_MAX_INTERVAL_MS = 15_000;
const CANONICAL_VOICE_QUEUE_REGULAR_MAX_ITEMS = 128;
const CANONICAL_VOICE_QUEUE_MAX_ITEMS = CANONICAL_VOICE_QUEUE_REGULAR_MAX_ITEMS + 1;
const CANONICAL_VOICE_QUEUE_MAX_BYTES =
  CANONICAL_VOICE_QUEUE_MAX_ITEMS * MAX_DESKTOP_CHAT_INPUT_BYTES;
const CANONICAL_VOICE_IN_PROGRESS_MAX_POLLS = 3;
const CANONICAL_VOICE_ADMISSION_MAX_ATTEMPTS = 3;
const CANONICAL_USER_RECONCILIATION_TIMEOUT_MS = 5_000;
const CANONICAL_VOICE_RECONCILE_INTERVAL_MS = 1_500;
const CANONICAL_VOICE_QUEUE_ERROR =
  "The spoken-turn queue is full. Wait for the pending turns to finish, then try again.";
const CANONICAL_VOICE_PENDING_ERROR =
  "The spoken turn is still pending. Retry it before sending another message.";
const CANONICAL_VOICE_INPUT_ERROR =
  "The final spoken transcript or its turn identity is outside the supported size limit.";
const CANONICAL_VOICE_IDENTITY_ERROR =
  "A spoken turn identity was reused with different transcript content.";
const CANONICAL_VOICE_SCOPE_IDENTITY_ERROR =
  "The chat grounding scope could not be frozen for this spoken turn. Reload the chat and try again.";
const CANONICAL_VOICE_HASHING_ERROR =
  "The spoken transcript could not be added to chat. Restart Voice and try again.";

function raceUiAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => {
      finish(() => {
        reject(new DOMException("Reconciliation cancelled.", "AbortError"));
      });
    };
    void work.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error);
        });
      },
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

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

// 0.3.0 release audit — the chat list deliberately carries trashed conversations (status
// "closed") so Chat History's Deleted tab can restore them, and the panel filters them out of the
// visible list. The resume paths did not filter: taking `sorted[0]` could land the session on a
// conversation the user had just trashed — invisible in Chat History, and refused by the server
// on every send with 409 CHAT_CLOSED. One helper, used by every path that resumes a conversation,
// so a future resume path cannot reintroduce the omission.
function pickResumableChat(sortedChats: readonly Chat[]): Chat | undefined {
  return sortedChats.find((chat) => chat.status !== "closed");
}

// Sonar S2004 — the upsert/remove/replace/rollback list transforms below are extracted to
// module scope (out of the deeply nested setState updaters that build them) so each nested
// callback resets its own nesting depth instead of stacking onto the caller's.
function upsertChatIntoList(chats: readonly Chat[], chat: Chat): Chat[] {
  return sortChats([chat, ...chats.filter((existing) => existing.id !== chat.id)]);
}

function removeChatFromList(chats: readonly Chat[], chatId: string): Chat[] {
  return chats.filter((chat) => chat.id !== chatId);
}

function replaceChatInList(chats: readonly Chat[], updatedChat: Chat): Chat[] {
  return chats.map((chat) => (chat.id === updatedChat.id ? updatedChat : chat));
}

function restoreChatSelectedModel(
  chats: readonly Chat[],
  activeChatId: string,
  rollbackChats: readonly Chat[],
): Chat[] {
  return chats.map((chat) => {
    if (chat.id !== activeChatId) return chat;
    const restored = rollbackChats.find((candidate) => candidate.id === activeChatId);
    return restored !== undefined ? { ...chat, selectedModel: restored.selectedModel } : chat;
  });
}

function removeMessagesByIds(
  messages: readonly ChatMessage[],
  excludedIds: readonly string[],
): ChatMessage[] {
  return messages.filter((message) => !excludedIds.includes(message.id));
}

function replaceCanonicalTurnMessages(
  messages: readonly ChatMessage[],
  localIds: readonly string[],
  canonical: readonly ChatMessage[],
): ChatMessage[] {
  const local = new Set(localIds);
  const canonicalIds = new Set(canonical.map((message) => message.id));
  const result: ChatMessage[] = [];
  let inserted = false;
  for (const message of messages) {
    if (local.has(message.id)) {
      if (!inserted) result.push(...canonical);
      inserted = true;
      continue;
    }
    if (!canonicalIds.has(message.id)) result.push(message);
  }
  if (!inserted) result.push(...canonical);
  return result;
}

// AC2 (#2670) — the BFF persists the canonical user row at admission, before generation
// completes. A fetched non-local user row with the projection's exact content stamped at or
// after the projection therefore proves a durable admission (the same proof shape as
// hasNewCanonicalUserMessage); re-appending the held projection would render the transcript twice.
// The proof is strong enough to SUPPRESS the re-append but deliberately not to release the held
// projection: an identical-content sibling turn still queued behind this row could match too, and
// only the turn's own settle path knows which turn the durable row belongs to. One implementation
// answers for every re-append site — the reopen-a-chat merge below and the queue's re-projection of
// the same turn identity in sendMessage.
function hasDurableCanonicalUserRow(
  messages: readonly ChatMessage[],
  content: string,
  sinceTimestamp: number,
): boolean {
  return messages.some(
    (message) =>
      message.role === "user" &&
      !message.id.startsWith("local-") &&
      message.content === content &&
      message.timestamp >= sinceTimestamp,
  );
}

function mergeCanonicalVoiceProjections(
  messages: readonly ChatMessage[],
  chatId: string,
  projections: ReadonlyMap<string, CanonicalVoiceProjection>,
  excludedLocalIds: readonly string[] = [],
): ChatMessage[] {
  const ids = new Set(messages.map((message) => message.id));
  const excluded = new Set(excludedLocalIds);
  const pending = [...projections.values()]
    .filter(
      (projection) =>
        projection.chatId === chatId &&
        !excluded.has(projection.message.id) &&
        !ids.has(projection.message.id) &&
        !hasDurableCanonicalUserRow(messages, projection.content, projection.message.timestamp),
    )
    .map((projection) => projection.message);
  return pending.length === 0 ? Array.from(messages) : [...messages, ...pending];
}

function canonicalVoiceDeliveryKey(chatId: string, clientTurnId: string): string {
  return `${chatId}\u0000${clientTurnId}`;
}

function canonicalVoiceContentDigest(content: string): string {
  const domainSeparated = `keiko:canonical-voice-turn-content:v1\u0000${content}`;
  return canonicalVoiceSha256Hex(domainSeparated);
}

function canonicalVoiceOptimisticMessage(chatId: string, content: string): ChatMessage {
  return {
    id: `local-voice-${crypto.randomUUID()}`,
    chatId,
    role: "user",
    content,
    timestamp: Date.now(),
    runId: undefined,
    workflowId: undefined,
    workflowStatus: undefined,
    shortResult: undefined,
    taskType: undefined,
  };
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
  if (mutation.type === "delete") purgeCanonicalVoicePageOutboxChat(mutation.chatId);
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
// spoken transcript and must send it through THIS chat path so the spoken turn carries the same
// context a typed turn would: the staged attachments (→ documentContext + descriptors),
// repository/local-knowledge grounding scope, and memory. ADR-0154 D1/D5 make that parity the
// contract — one canonical pipeline, no Voice-specific substitute, and equal final text plus equal
// chat context must make the same retrieval decisions. The staged attachments are captured into
// `canonicalVoiceTarget.attachments` at handoff rather than read live at drain time (see that field),
// and a grounded chat carries scope instead of attachments for spoken and typed turns alike — with
// GROUNDED_ATTACHMENT_NOTICE surfaced either way, never a silent drop (#2843).
// It cannot rely on `setDraft(text)` + `sendMessage()` in the same tick: `sendMessage`
// reads `draft` from React state captured in its closure, so the just-set draft is invisible until the
// next render and the send would early-return on an empty draft. Passing the committed text directly
// decouples the send from the async draft state. The field is content-only (the committed transcript,
// already equal to what a typed message carries) — it adds NO audio and NO new wire field, preserving
// exact context equivalence with the typed path.
interface SendMessageOptions {
  // When present, this text is sent instead of the current draft. Trimmed and empty-guarded identically
  // to the draft path. The user's independent typed draft is preserved across a spoken turn.
  readonly text?: string;
  // Internal admission/result acknowledgement for the canonical Voice Twin handoff. Ordinary typed
  // callers retain the historical Promise<void> surface; Voice uses the terminal outcome so a blocked
  // send cannot silently consume a final transcript or arm speech for an unrelated later answer.
  readonly reportOutcome?: true;
  // Stable opaque identity for safe retry of a Voice final. It is body-only and never used as a
  // header/log identifier; the BFF store scope-hashes it before persistence.
  readonly clientTurnId?: string;
  // Queue-owned target captured when Realtime hands off the final transcript. Keeping this target
  // outside React's active-chat state lets the FIFO survive chat and mode switches without scope drift.
  readonly canonicalVoiceTarget?: CanonicalVoiceSendTarget;
  // The FIFO projects this message immediately at handoff time. The send path reuses that exact local
  // identity and reconciles it to the durable row instead of creating a second optimistic bubble.
  readonly optimisticMessage?: ChatMessage;
  // Canonical Voice uses the buffered transport so an inactive target chat never receives streaming
  // deltas in the currently visible chat. Both transports share the same server admission pipeline.
  readonly forceBuffered?: true;
}

interface CanonicalVoiceSendTarget {
  readonly chat: Chat;
  readonly project: CanonicalChatProjectTarget;
  readonly modelId: string;
  readonly memory: ConversationMemoryRequestWire;
  // #2843 — the composer's staged attachments, snapshotted with the rest of the immutable target
  // during the synchronous handoff (ADR-0154 D1). The FIFO can drain after the user switched chats or
  // staged different files, so reading live composer state at drain time would attach the wrong files
  // to this turn; the snapshot binds exactly what was staged when the transcript settled. Nothing
  // here reaches the Realtime session — descriptors and extracted text ride the canonical BFF
  // request, which is the only path that ever carried them (ADR-0154 D2/D5).
  readonly attachments: readonly PendingAttachment[];
}

interface CanonicalChatProjectTarget {
  readonly path: string;
}

interface UngroundedSendRequest {
  readonly chat: Chat;
  readonly project: CanonicalChatProjectTarget;
  readonly content: string;
  readonly optimisticId: string;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly documentContext: readonly ConversationDocumentContextWire[];
  readonly attachments: readonly ConversationAttachmentDescriptorWire[];
  readonly memory: ConversationMemoryRequestWire;
  readonly clientTurnId: string | undefined;
}

function desktopChatInputForUngrounded(
  request: UngroundedSendRequest,
): Parameters<typeof sendDesktopChat>[0] {
  const { chat, project, content, modelId, documentContext, attachments, memory, clientTurnId } =
    request;
  return {
    chatId: chat.id,
    projectPath: project.path,
    content,
    modelId,
    memory,
    ...(documentContext.length > 0 ? { documentContext } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(attachments.some((attachment) => attachment.kind === "image")
      ? { attachmentIntent: "deliver-images-to-selected-model" as const }
      : {}),
    ...(clientTurnId === undefined ? {} : { clientTurnId }),
    ...(clientTurnId === undefined || chat.groundingScopeIdentity === undefined
      ? {}
      : { expectedGroundingScopeIdentity: chat.groundingScopeIdentity }),
  };
}

interface SendAttemptRequest {
  readonly chat: Chat;
  readonly project: CanonicalChatProjectTarget;
  readonly content: string;
  readonly optimisticId: string;
  readonly modelId: string;
  readonly signal: AbortSignal;
  readonly canonicalTarget: CanonicalVoiceSendTarget | undefined;
  readonly forceBuffered: boolean;
  readonly clientTurnId: string | undefined;
}

interface SendAttemptExecution {
  readonly terminal: SendAttemptOutcome;
  readonly disclosures: readonly SentDocumentDisclosure[];
  // #2843 — the staged attachments this attempt actually put on the wire. A settled send releases
  // exactly these, so files staged while the send was in flight (the composer stays editable, F041,
  // and a queued Voice turn can settle much later) are never dropped unsent.
  readonly consumedAttachmentIds: readonly string[];
}

interface CompletedSendOutcome {
  readonly status: "completed";
  readonly assistantMessageId: string;
  readonly deliveredImageIds?: readonly string[] | undefined;
}

interface FailedSendOutcome {
  readonly status: "failed";
  // A scope-bound 409 from the canonical BFF is authoritative proof that this exact
  // clientTurnId was already admitted. Keep that proof distinct from an arbitrary transport or
  // validation failure so reconciliation never has to guess from equal message text.
  readonly canonicalTurnInProgress?: true;
  // Deterministic request rejection is terminal only after reconciliation proves that the server
  // did not admit this identity. Transport failures remain retryable because their commit state is
  // unknown.
  readonly permanentFailure?: true;
  readonly identityConflict?: true;
  readonly scopeChanged?: true;
  readonly chatClosed?: true;
}

type SendAttemptOutcome =
  CompletedSendOutcome | FailedSendOutcome | { readonly status: "cancelled" };

export type SendMessageOutcome =
  | CompletedSendOutcome
  | {
      readonly status: "failed";
      readonly retryable?: false;
      readonly userPersisted?: true;
      readonly suspend?: true;
    }
  | { readonly status: "in-progress" | "not-sent" }
  | {
      readonly status: "cancelled";
      readonly userPersisted: boolean;
      // The local human deliberately ended this turn: a Voice barge-in, or an explicit discard of a
      // wedged spoken turn. ADR-0154 D4 returns the floor to input capture and the dialog generation
      // has already advanced, so a re-sent turn could never speak. Terminal regardless of
      // persistence, which is strictly stronger than D1/D4's persisted-cancellation rule and never
      // weakens it. A cancellation Keiko did not ask for (chat switch, unmount, unknown
      // reconciliation) carries no such proof of intent and stays retryable.
      readonly interrupted?: true;
    };

interface CanonicalVoiceTurnInput {
  readonly text: string;
  readonly clientTurnId: string;
  // The production Realtime handoff may consume the single bounded reserve slot. Once regular
  // capacity is reached, ChatWindow synchronously tells Realtime to stop capture, so no finalized
  // transcript remains component-local across a mode switch or unmount.
  readonly allowReservedCapacity?: true;
  // Frozen by ChatWindow at the first Realtime handoff. A rejected handoff remains owned by the
  // Realtime session and may be retried after navigation or a scope mutation; deriving this target
  // from live session state on a later retry could route an A transcript through chat/scope B.
  readonly target: {
    readonly chat: Chat;
    readonly modelId: string;
  };
}

type EnqueueCanonicalVoiceTurn = (
  input: CanonicalVoiceTurnInput,
) => Promise<SendMessageOutcome> | undefined;

interface CanonicalVoiceQueueItem {
  readonly key: string;
  readonly content: string;
  readonly contentDigest: string;
  readonly clientTurnId: string;
  readonly target: CanonicalVoiceSendTarget;
  readonly optimistic: ChatMessage;
  readonly byteLength: number;
  readonly promise: Promise<SendMessageOutcome>;
  readonly resolve: (outcome: SendMessageOutcome) => void;
}

interface CanonicalVoiceProjection {
  readonly chatId: string;
  readonly content: string;
  readonly message: ChatMessage;
  readonly byteLength: number;
}

interface CanonicalVoiceSettledDelivery {
  readonly contentDigest: string;
  readonly outcome: SendMessageOutcome;
}

interface CanonicalVoiceOutboxStatus {
  // The chat that owns the head-of-queue spoken turn whose bounded delivery window ran out. The
  // outbox itself is page-scoped, but its suspension is reported per chat: a single wedged turn must
  // never disable typed sending in every other conversation on the page.
  readonly suspendedChatId: string | undefined;
  // Bumped on every membership change so a chat-scoped gate derived from the queue re-renders even
  // when the suspended chat itself does not change.
  readonly revision: number;
}

interface CanonicalVoicePageOutbox {
  readonly queueRef: { current: CanonicalVoiceQueueItem[] };
  readonly queueBytesRef: { current: number };
  readonly projectionRef: { current: Map<string, CanonicalVoiceProjection> };
  readonly projectionBytesRef: { current: number };
  readonly deliveriesRef: {
    current: Map<
      string,
      { readonly contentDigest: string; readonly promise: Promise<SendMessageOutcome> }
    >;
  };
  readonly settledRef: { current: Map<string, CanonicalVoiceSettledDelivery> };
  drainingOwner: symbol | undefined;
  activeDelivery: { readonly key: string; readonly abort: () => void } | undefined;
  readonly wakes: Set<() => void>;
  readonly statusSubscribers: Set<(status: CanonicalVoiceOutboxStatus) => void>;
  status: CanonicalVoiceOutboxStatus;
}

// Page-lifecycle outbox: accepted provider finals survive ChatSession/Voice component replacement
// without placing raw transcript text in localStorage or another unencrypted browser store. The
// stable clientTurnId makes every resumed delivery safe to replay through the server idempotency
// boundary; the bounded queue/byte ceilings below remain authoritative across all hook instances.
const canonicalVoicePageOutbox: CanonicalVoicePageOutbox = {
  queueRef: { current: [] },
  queueBytesRef: { current: 0 },
  projectionRef: { current: new Map() },
  projectionBytesRef: { current: 0 },
  deliveriesRef: { current: new Map() },
  settledRef: { current: new Map() },
  drainingOwner: undefined,
  activeDelivery: undefined,
  wakes: new Set(),
  statusSubscribers: new Set(),
  status: { suspendedChatId: undefined, revision: 0 },
};

function publishCanonicalVoicePageOutboxStatus(suspendedChatId: string | undefined): void {
  canonicalVoicePageOutbox.status = {
    suspendedChatId,
    revision: canonicalVoicePageOutbox.status.revision + 1,
  };
  for (const subscriber of canonicalVoicePageOutbox.statusSubscribers) {
    subscriber(canonicalVoicePageOutbox.status);
  }
}

function setCanonicalVoicePageOutboxSuspended(suspendedChatId: string | undefined): void {
  if (canonicalVoicePageOutbox.status.suspendedChatId === suspendedChatId) return;
  publishCanonicalVoicePageOutboxStatus(suspendedChatId);
}

function canonicalVoicePageOutboxSuspended(): boolean {
  return canonicalVoicePageOutbox.status.suspendedChatId !== undefined;
}

function releaseCanonicalVoiceProjectionByKey(key: string): void {
  const projection = canonicalVoicePageOutbox.projectionRef.current.get(key);
  if (projection === undefined) return;
  canonicalVoicePageOutbox.projectionRef.current.delete(key);
  canonicalVoicePageOutbox.projectionBytesRef.current = Math.max(
    0,
    canonicalVoicePageOutbox.projectionBytesRef.current - projection.byteLength,
  );
}

function clearSettledCanonicalVoiceDeliveries(chatId: string): void {
  const keyPrefix = `${chatId}\u0000`;
  for (const key of canonicalVoicePageOutbox.settledRef.current.keys()) {
    if (key.startsWith(keyPrefix)) canonicalVoicePageOutbox.settledRef.current.delete(key);
  }
}

function cacheCanonicalVoiceSettledDelivery(
  key: string,
  entry: CanonicalVoiceSettledDelivery,
): void {
  const settled = canonicalVoicePageOutbox.settledRef.current;
  settled.set(key, entry);
  if (settled.size <= CANONICAL_VOICE_QUEUE_MAX_ITEMS * 2) return;
  const oldestKey = settled.keys().next().value as string | undefined;
  if (oldestKey !== undefined) settled.delete(oldestKey);
}

function abortRemovedCanonicalVoiceDelivery(removedKeys: ReadonlySet<string>): void {
  const activeDelivery = canonicalVoicePageOutbox.activeDelivery;
  if (activeDelivery !== undefined && removedKeys.has(activeDelivery.key)) activeDelivery.abort();
}

function resolveRemovedCanonicalVoiceItems(
  items: readonly CanonicalVoiceQueueItem[],
  outcome: SendMessageOutcome,
): number {
  let removedBytes = 0;
  for (const item of items) {
    releaseCanonicalVoiceProjectionByKey(item.key);
    canonicalVoicePageOutbox.deliveriesRef.current.delete(item.key);
    item.resolve(outcome);
    removedBytes += item.byteLength;
  }
  return removedBytes;
}

function removeCanonicalVoiceQueueItems(
  queue: CanonicalVoiceQueueItem[],
  removedKeys: ReadonlySet<string>,
): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (item !== undefined && removedKeys.has(item.key)) queue.splice(index, 1);
  }
}

function removeCanonicalVoicePageOutboxItems(
  removed: readonly CanonicalVoiceQueueItem[],
  outcome: SendMessageOutcome,
): void {
  const queue = canonicalVoicePageOutbox.queueRef.current;
  const removedKeys = new Set(removed.map((item) => item.key));
  abortRemovedCanonicalVoiceDelivery(removedKeys);
  const removedBytes = resolveRemovedCanonicalVoiceItems(removed, outcome);
  canonicalVoicePageOutbox.queueBytesRef.current = Math.max(
    0,
    canonicalVoicePageOutbox.queueBytesRef.current - removedBytes,
  );
  removeCanonicalVoiceQueueItems(queue, removedKeys);
  // Suspension outlives a removal only while the suspended chat still owns a queued turn; once its
  // last item is gone there is nothing left for the user to retry or discard.
  const suspendedChatId = canonicalVoicePageOutbox.status.suspendedChatId;
  const stillSuspended =
    suspendedChatId !== undefined && canonicalVoicePageOutboxHasPendingTurn(suspendedChatId);
  publishCanonicalVoicePageOutboxStatus(stillSuspended ? suspendedChatId : undefined);
  if (!stillSuspended) wakeCanonicalVoicePageOutbox();
}

function purgeCanonicalVoicePageOutboxChat(chatId: string): void {
  const removed = canonicalVoicePageOutbox.queueRef.current.filter(
    (item) => item.target.chat.id === chatId,
  );
  clearSettledCanonicalVoiceDeliveries(chatId);
  if (removed.length === 0) return;
  removeCanonicalVoicePageOutboxItems(removed, { status: "failed", retryable: false });
}

// The local human's escape hatch from a wedged spoken turn. Terminal by intent: the identity is
// cached as settled so a replayed final resolves from that cache instead of re-entering the queue,
// and the transcript is released from the outbox without ever reaching another store. Reports
// whether the discarded set owned the active delivery, so the caller can stop that request too
// instead of paying for an answer nobody will ever read.
function discardCanonicalVoicePageOutboxChat(chatId: string): {
  readonly discarded: boolean;
  readonly ownedActiveDelivery: boolean;
} {
  const removed = canonicalVoicePageOutbox.queueRef.current.filter(
    (item) => item.target.chat.id === chatId,
  );
  if (removed.length === 0) return { discarded: false, ownedActiveDelivery: false };
  const activeKey = canonicalVoicePageOutbox.activeDelivery?.key;
  const ownedActiveDelivery =
    activeKey !== undefined && removed.some((item) => item.key === activeKey);
  const outcome: SendMessageOutcome = {
    status: "cancelled",
    userPersisted: false,
    interrupted: true,
  };
  for (const item of removed) {
    cacheCanonicalVoiceSettledDelivery(item.key, { contentDigest: item.contentDigest, outcome });
  }
  removeCanonicalVoicePageOutboxItems(removed, outcome);
  return { discarded: true, ownedActiveDelivery };
}

export function canonicalVoicePageOutboxRetainsPlaintextForTests(content: string): boolean {
  return (
    canonicalVoicePageOutbox.queueRef.current.some((item) => item.content === content) ||
    [...canonicalVoicePageOutbox.projectionRef.current.values()].some(
      (projection) => projection.content === content || projection.message.content === content,
    )
  );
}

export function clearCanonicalVoicePageOutboxForTests(): void {
  for (const item of canonicalVoicePageOutbox.queueRef.current) {
    item.resolve({ status: "cancelled", userPersisted: false });
  }
  canonicalVoicePageOutbox.queueRef.current.splice(0);
  canonicalVoicePageOutbox.queueBytesRef.current = 0;
  canonicalVoicePageOutbox.projectionRef.current.clear();
  canonicalVoicePageOutbox.projectionBytesRef.current = 0;
  canonicalVoicePageOutbox.deliveriesRef.current.clear();
  canonicalVoicePageOutbox.settledRef.current.clear();
  canonicalVoicePageOutbox.drainingOwner = undefined;
  canonicalVoicePageOutbox.activeDelivery?.abort();
  canonicalVoicePageOutbox.activeDelivery = undefined;
  canonicalVoicePageOutbox.wakes.clear();
  setCanonicalVoicePageOutboxSuspended(undefined);
  canonicalVoicePageOutbox.statusSubscribers.clear();
}

function wakeCanonicalVoicePageOutbox(): void {
  for (const wake of canonicalVoicePageOutbox.wakes) wake();
}

function canonicalVoicePageOutboxHasCapacity(
  byteLength: number,
  allowReservedCapacity: boolean,
): boolean {
  const usedBytes = canonicalVoicePageOutbox.queueBytesRef.current;
  const itemLimit = allowReservedCapacity
    ? CANONICAL_VOICE_QUEUE_MAX_ITEMS
    : CANONICAL_VOICE_QUEUE_REGULAR_MAX_ITEMS;
  const byteLimit = allowReservedCapacity
    ? CANONICAL_VOICE_QUEUE_MAX_BYTES
    : CANONICAL_VOICE_QUEUE_REGULAR_MAX_ITEMS * MAX_DESKTOP_CHAT_INPUT_BYTES;
  if (
    canonicalVoicePageOutbox.queueRef.current.length >= itemLimit ||
    usedBytes < 0 ||
    usedBytes > byteLimit
  ) {
    return false;
  }
  return byteLength <= byteLimit - usedBytes;
}

function canonicalVoicePageOutboxHasPendingTurn(chatId: string): boolean {
  return canonicalVoicePageOutbox.queueRef.current.some((item) => item.target.chat.id === chatId);
}

function completedSendOutcome(
  messages: readonly ChatMessage[],
  attachmentDeliveries?: readonly { readonly id: string; readonly status: "delivered" }[],
): SendAttemptOutcome {
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const assistantMessage = assistantMessages.length === 1 ? assistantMessages[0] : undefined;
  return assistantMessage === undefined
    ? { status: "failed" }
    : {
        status: "completed",
        assistantMessageId: assistantMessage.id,
        ...(attachmentDeliveries === undefined || attachmentDeliveries.length === 0
          ? {}
          : { deliveredImageIds: attachmentDeliveries.map((delivery) => delivery.id) }),
      };
}

interface SendMessage {
  (options: SendMessageOptions & { readonly reportOutcome: true }): Promise<SendMessageOutcome>;
  (options?: SendMessageOptions): Promise<void>;
}

interface CanonicalVoiceDeliveryRuntime {
  readonly signal: AbortSignal;
  readonly waitForSendSlot: () => Promise<void>;
  readonly send: SendMessage;
  readonly onDeliveryDelayed: () => void;
  readonly onUserPersisted: () => void;
}

type CanonicalVoiceQueueDelivery =
  | { readonly kind: "terminal"; readonly outcome: SendMessageOutcome }
  | { readonly kind: "suspended" }
  | { readonly kind: "aborted" };

function canonicalVoiceOutcomeIsPersisted(outcome: SendMessageOutcome): boolean {
  return (
    outcome.status === "completed" ||
    outcome.status === "in-progress" ||
    (outcome.status === "failed" && outcome.userPersisted === true) ||
    (outcome.status === "cancelled" && outcome.userPersisted)
  );
}

function canonicalVoiceOutcomeIsTerminal(outcome: SendMessageOutcome): boolean {
  return (
    outcome.status === "completed" ||
    // ADR-0154 D1/D4 keep a persisted cancellation terminal. A deliberate interruption is terminal
    // as well, with or without a persisted user row: the dialog generation has moved on, so a resend
    // could only produce an answer the user never hears (#2842).
    (outcome.status === "cancelled" && (outcome.userPersisted || outcome.interrupted === true)) ||
    (outcome.status === "failed" && outcome.retryable === false && outcome.suspend !== true)
  );
}

async function requestCanonicalVoiceQueueOutcome(
  item: CanonicalVoiceQueueItem,
  runtime: CanonicalVoiceDeliveryRuntime,
): Promise<SendMessageOutcome | undefined> {
  try {
    await runtime.waitForSendSlot();
    if (runtime.signal.aborted) return undefined;
    return await runtime.send({
      text: item.content,
      reportOutcome: true,
      clientTurnId: item.clientTurnId,
      canonicalVoiceTarget: item.target,
      optimisticMessage: item.optimistic,
      forceBuffered: true,
    });
  } catch {
    return undefined;
  }
}

async function waitForCanonicalVoiceRetry(signal: AbortSignal): Promise<boolean> {
  try {
    await abortableSleep(CANONICAL_VOICE_RECONCILE_INTERVAL_MS, signal);
    return true;
  } catch {
    return false;
  }
}

interface CanonicalVoiceDeliveryProgress {
  admissionAttempts: number;
  inProgressPolls: number;
}

function interpretCanonicalVoiceQueueOutcome(
  outcome: SendMessageOutcome,
  runtime: CanonicalVoiceDeliveryRuntime,
  progress: CanonicalVoiceDeliveryProgress,
): CanonicalVoiceQueueDelivery | undefined {
  if (canonicalVoiceOutcomeIsPersisted(outcome)) runtime.onUserPersisted();
  if (canonicalVoiceOutcomeIsTerminal(outcome)) return { kind: "terminal", outcome };
  if (outcome.status === "failed" && outcome.suspend === true) {
    runtime.onDeliveryDelayed();
    return { kind: "suspended" };
  }
  if (outcome.status !== "in-progress") {
    progress.admissionAttempts += 1;
    return undefined;
  }
  progress.inProgressPolls += 1;
  if (progress.inProgressPolls < CANONICAL_VOICE_IN_PROGRESS_MAX_POLLS) return undefined;
  runtime.onDeliveryDelayed();
  return { kind: "suspended" };
}

async function deliverCanonicalVoiceQueueItem(
  item: CanonicalVoiceQueueItem,
  runtime: CanonicalVoiceDeliveryRuntime,
): Promise<CanonicalVoiceQueueDelivery> {
  const progress: CanonicalVoiceDeliveryProgress = { admissionAttempts: 0, inProgressPolls: 0 };
  while (!runtime.signal.aborted) {
    const outcome = await requestCanonicalVoiceQueueOutcome(item, runtime);
    if (outcome !== undefined) {
      const delivery = interpretCanonicalVoiceQueueOutcome(outcome, runtime, progress);
      if (delivery !== undefined) return delivery;
    } else if (!runtime.signal.aborted) {
      progress.admissionAttempts += 1;
    }
    if (progress.admissionAttempts >= CANONICAL_VOICE_ADMISSION_MAX_ATTEMPTS) {
      runtime.onDeliveryDelayed();
      return { kind: "suspended" };
    }
    if (!(await waitForCanonicalVoiceRetry(runtime.signal))) break;
  }
  return { kind: "aborted" };
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
  notice?: string | undefined;
  clearError?: (() => void) | undefined;
  clearNotice?: (() => void) | undefined;
  setDraft: (value: string) => void;
  setSelectedModel: (id: string) => void;
  // Optional `title` names the fresh conversation (e.g. from the New-Chat-window dialog);
  // blank/whitespace falls back to DEFAULT_CHAT_TITLE.
  openNewChat: (project?: ProjectWithAvailability, title?: string) => Promise<Chat | undefined>;
  openProject: (project: ProjectWithAvailability) => Promise<void>;
  openChat: (chat: Chat) => Promise<void>;
  addProject: (path: string) => Promise<ProjectWithAvailability | undefined>;
  // Issue #1561 — `options.text` sends an explicit committed transcript (the spoken-turn handoff) through
  // the same context-bearing path as a typed send; absent, it sends the current draft as before.
  sendMessage: SendMessage;
  // Present on the production session. Optional keeps isolated component fixtures source-compatible;
  // ChatWindow falls back to sendMessage only in such synthetic sessions.
  enqueueCanonicalVoiceTurn?: EnqueueCanonicalVoiceTurn | undefined;
  canonicalVoiceCaptureMustPause?: (() => boolean) | undefined;
  // A finite delivery window has ended without a terminal canonical result for the active chat.
  // The transcript remains in the page-lifecycle outbox until this explicit action starts one more
  // bounded window with the same immutable clientTurnId. No background poll is armed. True only for
  // a chat that still owns a queued turn, so a wedged conversation never gates the whole page.
  canonicalVoiceTurnRequiresRetry?: boolean | undefined;
  retryPendingCanonicalVoiceTurn?: (() => void) | undefined;
  // The second half of that recovery: drop the active chat's queued spoken turns instead of
  // retrying them, so a delivery that keeps failing cannot leave the composer permanently dead.
  discardPendingCanonicalVoiceTurn?: (() => void) | undefined;
  // ADR-0154 D4 barge-in. Cancels the in-flight canonical send ONLY while Voice owns it — a typed
  // composer send is a separate user intent — and makes that cancellation terminal for the
  // interrupted utterance so the Chat-owned queue never re-sends it.
  interruptCanonicalVoiceDelivery?: (() => void) | undefined;
  regenerateMessage: (assistantMessageId: string) => Promise<void>;
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
  readonly lastSentImages?: readonly SentImageDisclosure[] | undefined;
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

function projectOptimisticMessage(
  previous: SessionState,
  chatId: string,
  optimistic: ChatMessage,
  queueOwned: boolean,
): SessionState {
  const alreadyVisible = previous.messages.some((message): boolean => message.id === optimistic.id);
  const alreadyDurable =
    queueOwned &&
    hasDurableCanonicalUserRow(previous.messages, optimistic.content, optimistic.timestamp);
  if (previous.activeChat?.id !== chatId || alreadyVisible || alreadyDurable) return previous;
  return { ...previous, messages: [...previous.messages, optimistic] };
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

function canonicalProjectTarget(chat: Chat): CanonicalChatProjectTarget {
  return { path: chat.projectPath };
}

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

// GEN-PERF-CHAT-011 — outcome of a single poll attempt: a terminal summary was found, the run is
// still in flight (keep polling), or the fetch failed in a way that should stop the poll
// outright. Splitting this out of pollRunSummaryPatch keeps each fetch/fallback path
// independently readable (Sonar S3776).
type RunSummaryAttemptResult =
  | { readonly kind: "summary"; readonly summary: TerminalRunSummary }
  | { readonly kind: "retry" }
  | { readonly kind: "abort" };

async function runSummaryFromManifestFallback(
  runId: string,
  fallbackKind: RunSummaryFallbackKind,
): Promise<RunSummaryAttemptResult> {
  try {
    const response = await fetchEvidenceManifest(runId);
    const manifestSummary = formatRunSummaryFromManifest(response.manifest, fallbackKind);
    const workflowStatus =
      manifestSummary.workflowStatus === "failed" || manifestSummary.workflowStatus === "cancelled"
        ? manifestSummary.workflowStatus
        : "completed";
    return {
      kind: "summary",
      summary: { workflowStatus, shortResult: manifestSummary.shortResult },
    };
  } catch {
    // Evidence may not exist yet while the worker is still settling; keep polling.
    return { kind: "retry" };
  }
}

async function attemptRunSummaryFetch(
  runId: string,
  fallbackKind: RunSummaryFallbackKind,
): Promise<RunSummaryAttemptResult> {
  try {
    const response = await fetchRunReport(runId);
    const outcome = classifyRunReport(response.report, fallbackKind);
    return outcome.kind === "terminal"
      ? { kind: "summary", summary: outcome.summary }
      : { kind: "retry" };
  } catch (error_) {
    if (!(error_ instanceof ApiError) || error_.status !== 404) return { kind: "abort" };
    return runSummaryFromManifestFallback(runId, fallbackKind);
  }
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

    const attemptResult = await attemptRunSummaryFetch(runId, fallbackKind);
    if (attemptResult.kind === "abort") return undefined;

    if (attemptResult.kind === "summary") {
      const patched = await patchChatMessage(
        message.id,
        chat.id,
        projectPath,
        attemptResult.summary,
      );
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

  const chatPayload =
    project === undefined
      ? { chats: [] as readonly Chat[] }
      : await sharedFetchChats(project.path).catch(() => ({ chats: [] as readonly Chat[] }));
  const sortedChats = sortChats(chatPayload.chats);
  const latestChat = pickResumableChat(sortedChats);
  if (project !== undefined && latestChat !== undefined) {
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

  // AC #1: when no eligible model exists, set selectedModel to undefined so
  // downstream surfaces show a clear error instead of a placeholder id.
  //
  // 0.3.0 release audit — the trashed conversations stay in `chats` even though none of them may
  // be resumed: Chat History's Deleted tab is the surface that restores them.
  if (defaultModel === undefined || !autoCreate) {
    return {
      models: chatModels,
      selectedModel: defaultModel,
      projects: Array.from(projects),
      activeProject: project,
      chats: sortedChats,
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

function refreshSessionModels(
  previous: SessionState,
  capabilities: readonly ModelCapability[],
): SessionState {
  const models = capabilities.filter(isConversationEligibleModel);
  return {
    ...previous,
    models,
    selectedModel: resolveSelectedModelId(previous.selectedModel, models),
  };
}

interface SessionModelRefreshContext {
  readonly isCancelled: () => boolean;
  readonly setError: Dispatch<SetStateAction<string | undefined>>;
  readonly setState: Dispatch<SetStateAction<SessionState>>;
}

async function loadRefreshedSessionModels(context: SessionModelRefreshContext): Promise<void> {
  try {
    const { models } = await fetchModels();
    if (!context.isCancelled()) {
      context.setState((previous) => refreshSessionModels(previous, models));
    }
  } catch (error_) {
    if (!context.isCancelled()) context.setError(errorMessage(error_));
  }
}

// Sonar S2004 — extracted out of streamUngrounded's `.catch` handler (itself already nested
// inside a `new Promise` executor inside the useCallback body) so this setState updater is not
// a fifth level of nested function. Takes the specific dispatchers/values it needs rather than
// closing over hook state, matching the module-scope helpers above.
function handleStreamUngroundedTransportFailure(
  caught: unknown,
  setError: Dispatch<SetStateAction<string | undefined>>,
  resolve: (outcome: SendAttemptOutcome) => void,
): void {
  setError(errorMessage(caught));
  resolve({ status: "failed" });
}

function canonicalTurnInProgressFailure(error: unknown): FailedSendOutcome {
  if (error instanceof ApiError && error.code === "CHAT_TURN_IN_PROGRESS") {
    return { status: "failed", canonicalTurnInProgress: true };
  }
  if (error instanceof ApiError && error.code === "CHAT_TURN_IDEMPOTENCY_CONFLICT") {
    return { status: "failed", permanentFailure: true, identityConflict: true };
  }
  if (error instanceof ApiError && error.code === "GROUNDING_SCOPE_CHANGED") {
    return { status: "failed", permanentFailure: true, scopeChanged: true };
  }
  if (error instanceof ApiError && error.code === "CHAT_CLOSED") {
    return { status: "failed", permanentFailure: true, chatClosed: true };
  }
  return error instanceof ApiError && [400, 404, 413, 422].includes(error.status)
    ? { status: "failed", permanentFailure: true }
    : { status: "failed" };
}

type UserPersistenceProof = "persisted" | "missing" | "unknown";

type SendMessageAdmission =
  | { readonly kind: "rejected"; readonly error?: string }
  | {
      readonly kind: "accepted";
      readonly canonicalTarget: CanonicalVoiceSendTarget | undefined;
      readonly chat: Chat;
      readonly project: CanonicalChatProjectTarget;
      readonly content: string;
      readonly modelId: string;
    };

function resolveSendMessageAdmission(input: {
  readonly options: SendMessageOptions | undefined;
  readonly draft: string;
  readonly activeChat: Chat | undefined;
  readonly selectedModel: string | undefined;
  readonly models: readonly ModelCapability[];
  readonly pendingAttachmentCount: number;
  readonly sendInFlight: boolean;
}): SendMessageAdmission {
  const {
    options,
    draft,
    activeChat,
    selectedModel,
    models,
    pendingAttachmentCount,
    sendInFlight,
  } = input;
  const canonicalTarget = options?.canonicalVoiceTarget;
  const chat = canonicalTarget?.chat ?? activeChat;
  if (
    canonicalTarget === undefined &&
    chat !== undefined &&
    canonicalVoicePageOutboxHasPendingTurn(chat.id)
  ) {
    return { kind: "rejected", error: CANONICAL_VOICE_PENDING_ERROR };
  }
  if (sendInFlight) return { kind: "rejected" };
  const content = (options?.text ?? draft).trim();
  const project = canonicalTarget?.project ?? (chat && canonicalProjectTarget(chat));
  const modelId = canonicalTarget?.modelId ?? resolveSelectedModelId(selectedModel, models);
  if (
    content.length === 0 ||
    chat === undefined ||
    project === undefined ||
    modelId === undefined
  ) {
    return { kind: "rejected" };
  }
  if (canonicalTarget === undefined && hasGroundingScope(chat) && pendingAttachmentCount > 0) {
    return { kind: "rejected", error: GROUNDED_ATTACHMENT_NOTICE };
  }
  return { kind: "accepted", canonicalTarget, chat, project, content, modelId };
}

function settledSendMessageOutcome(input: {
  readonly settled: SendAttemptOutcome;
  readonly terminal: SendAttemptOutcome;
  readonly persistence: UserPersistenceProof;
  readonly canonicalTarget: CanonicalVoiceSendTarget | undefined;
  readonly interrupted: boolean;
}): SendMessageOutcome {
  const { settled, terminal, persistence, canonicalTarget, interrupted } = input;
  if (settled.status === "cancelled") {
    const userPersisted = persistence === "persisted";
    return interrupted
      ? { status: "cancelled", userPersisted, interrupted: true }
      : { status: "cancelled", userPersisted };
  }
  const canonicalFailure =
    settled.status === "failed" && terminal.status === "failed" && canonicalTarget !== undefined;
  if (canonicalFailure && terminal.scopeChanged === true) {
    return { status: "failed", retryable: false, userPersisted: true };
  }
  if (canonicalFailure && terminal.chatClosed === true) return { status: "failed", suspend: true };
  if (canonicalFailure && terminal.permanentFailure === true) {
    return persistence === "persisted"
      ? { status: "failed", retryable: false, userPersisted: true }
      : { status: "failed", retryable: false };
  }
  if (settled.status === "failed" && persistence === "persisted") {
    return { status: "in-progress" };
  }
  return settled.status === "completed" ? settled : { status: "failed" };
}

export async function canonicalTurnReferenceForClient(
  chatId: string,
  clientTurnId: string,
): Promise<string> {
  const runtime = await import("./canonical-voice-hasher-runtime");
  return runtime.sha256Hex(canonicalDesktopChatTurnReferenceSeed(chatId, clientTurnId));
}

function isExactCanonicalUserMessage(message: ChatMessage, canonicalTurnRef: string): boolean {
  return message.role === "user" && message.canonicalTurnRef === canonicalTurnRef;
}

function hasExactCanonicalUserMessage(
  messages: readonly ChatMessage[],
  canonicalTurnRef: string,
): boolean {
  return messages.some((message): boolean =>
    isExactCanonicalUserMessage(message, canonicalTurnRef),
  );
}

function exactCanonicalAssistant(
  messages: readonly ChatMessage[],
  canonicalTurnRef: string,
): ChatMessage | undefined {
  return messages.find(
    (message): boolean =>
      message.role === "assistant" && message.canonicalTurnRef === canonicalTurnRef,
  );
}

function canonicalTurnPresentation(
  messages: readonly ChatMessage[],
  canonicalTurnRef: string,
  canonicalUser: FailedSendPresentation["canonicalUser"],
): readonly ChatMessage[] {
  const hasUser = hasExactCanonicalUserMessage(messages, canonicalTurnRef);
  const hasAssistant = exactCanonicalAssistant(messages, canonicalTurnRef) !== undefined;
  if (hasUser && hasAssistant) return messages;
  return messages.filter(
    (message): boolean =>
      message.canonicalTurnRef !== canonicalTurnRef ||
      (message.role === "user" && canonicalUser === "preserve"),
  );
}

interface FailedSendPresentation {
  readonly canonicalUser: "hide" | "preserve";
  readonly missingOptimistic: "hide" | "preserve";
}

interface CanonicalTurnReconciliation {
  readonly persistence: UserPersistenceProof;
  readonly completedAssistantMessageId?: string;
}

interface SendAttemptSettlementRequest {
  readonly terminal: SendAttemptOutcome;
  readonly chat: Chat;
  readonly projectPath: string;
  readonly optimistic: ChatMessage;
  readonly clientTurnId: string;
  readonly signal: AbortSignal;
  readonly preserveUserOnMissing: boolean;
}

interface SettledSendAttempt {
  readonly settled: SendAttemptOutcome;
  readonly persistence: UserPersistenceProof;
}

function failedSendPresentation(
  exactTurnInProgress: boolean,
  settled: SendAttemptOutcome,
  preserveUserOnMissing: boolean,
): FailedSendPresentation {
  const keepRetryableUser = settled.status === "cancelled" || preserveUserOnMissing;
  return {
    canonicalUser: exactTurnInProgress || keepRetryableUser ? "preserve" : "hide",
    missingOptimistic: !exactTurnInProgress && keepRetryableUser ? "preserve" : "hide",
  };
}

export interface UseChatSessionOptions {
  readonly autoCreate?: boolean;
  readonly loadMemoryAutonomyModeImpl?: typeof loadMemoryAutonomyMode;
}

export function useChatSession(options: UseChatSessionOptions = {}): UseChatSessionResult {
  // 0.3.0 release audit — the pre-send attachment notices are user-facing text and were hardcoded
  // English. `documentContext` is not a component and cannot call a hook, so the session hook
  // resolves the translator once and passes it down. Outside an I18nProvider this falls back to the
  // shipped English catalog rather than throwing, which keeps the pure-function tests provider-free.
  const t = useTranslate();
  const autoCreate = options.autoCreate ?? true;
  const loadMemoryAutonomyModeImpl = options.loadMemoryAutonomyModeImpl ?? loadMemoryAutonomyMode;
  const [state, setState] = useState<SessionState>(INITIAL_STATE);
  const sessionStateRef = useRef<SessionState>(state);
  sessionStateRef.current = state;
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
  const sendControllerOwnerRef = useRef<"composer" | "canonical-voice" | null>(null);
  // Set only by the deliberate Voice interrupt, and read once by the attempt that owns this exact
  // signal. It is the proof of intent that makes the resulting cancellation terminal for the queue;
  // any other abort (chat switch, unmount, replacement) leaves it untouched and stays retryable.
  const interruptedSendSignalRef = useRef<AbortSignal | null>(null);
  const sendSlotWaitersRef = useRef<Set<() => void>>(new Set());
  // Unlike sendControllerRef this remains bound to a cancelled attempt until that attempt settles.
  // A replacement writes a new signal synchronously, preventing late callbacks from the old attempt
  // from changing the replacement's status or clearing its controller.
  const latestSendSignalRef = useRef<AbortSignal | null>(null);
  const reconciliationControllersRef = useRef(
    new Map<AbortController, ReturnType<typeof setTimeout>>(),
  );
  const sendMessageRef = useRef<SendMessage | null>(null);
  const canonicalVoiceQueueRef = canonicalVoicePageOutbox.queueRef;
  const canonicalVoiceQueueOwnerRef = useRef(Symbol("canonical-voice-page-outbox-owner"));
  const canonicalVoiceQueueControllerRef = useRef(new AbortController());
  const canonicalVoiceProjectionRef = canonicalVoicePageOutbox.projectionRef;
  const canonicalVoiceProjectionBytesRef = canonicalVoicePageOutbox.projectionBytesRef;
  const canonicalVoiceDeliveriesRef = canonicalVoicePageOutbox.deliveriesRef;
  const canonicalVoiceSettledRef = canonicalVoicePageOutbox.settledRef;
  const drainCanonicalVoiceQueueRef = useRef<() => void>(() => undefined);
  const [canonicalVoiceOutboxStatus, setCanonicalVoiceOutboxStatus] = useState(
    canonicalVoicePageOutbox.status,
  );
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  // Issue #185 — most recent grounded answer for the active chat. Cleared when the active
  // chat changes (see openChat) so a stale answer never overhangs into another conversation.
  const [latestGrounded, setLatestGrounded] = useState<GroundedAnswerWire | undefined>();
  const [latestMemory, setLatestMemory] = useState<ConversationMemoryResultWire | undefined>();
  const {
    memoryEnabled,
    setMemoryEnabled,
    memoryBudgetTokens,
    setMemoryBudgetTokens,
    memoryMode,
    setMemoryMode,
  } = useConversationMemorySettings();
  // Hydrate the server-persisted autonomy mode once per session mount so chat/voice requests use
  // the user's actual selection even if no autonomy-settings surface is opened. The settings
  // store is a module-level singleton, so redundant hydration across multiple mounted sessions is
  // a harmless no-op (publish() skips an identical value); a failure leaves the safe
  // "governed-assist" default untouched.
  useEffect(() => {
    let active = true;
    const revisionAtHydrationStart = currentConversationMemoryModeRevision();
    void loadMemoryAutonomyModeImpl()
      .then((policy) => {
        // A newer selection (this hydration in another mounted session, or a change made through
        // MemoriaVivaWindow) already landed while this request was in flight — applying the stale
        // response now would overwrite it, so skip.
        if (active && currentConversationMemoryModeRevision() === revisionAtHydrationStart) {
          setMemoryMode(policy.requestedMode);
        }
      })
      .catch(() => {
        // Fail closed to the existing default; MemoriaVivaWindow surfaces a visible error if the
        // user opens that window, this background hydration stays silent toward chat/voice by
        // design (a top-level session error would misrepresent an unrelated settings hiccup as a
        // chat failure, and keiko-ui has no client-side diagnostic sink to route through instead
        // of console.*, which product code must not call directly).
      });
    return () => {
      active = false;
    };
  }, [loadMemoryAutonomyModeImpl, setMemoryMode]);
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
  const [lastSentImages, setLastSentImages] = useState<readonly SentImageDisclosure[]>([]);

  // addPendingAttachment validates MIME type, model capability, and byte limit before
  // adding the attachment to state. Returns ok:false + reason on rejection (AC #1/#2).
  // Never throws — rejections are surfaced as a typed result so callers can render a
  // role="alert" message (AC #2 / Part 2 implementation).
  const addPendingAttachment = useCallback(
    async (
      file: File,
    ): Promise<{ ok: true } | { ok: false; reason: AttachmentRejectionReason }> => {
      const selectedModelCapability = state.models.find((m) => m.id === state.selectedModel);
      const validation = validatePendingAttachment(file, selectedModelCapability);
      if (!validation.ok) return validation;
      const prepared = await preparePendingAttachment(file, validation.kind, state.activeChat);
      if (!prepared.ok) return prepared;
      const attachment: PendingAttachment = {
        id: crypto.randomUUID(),
        kind: validation.kind,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: prepared.previewUrl,
        ...(validation.kind === "document" ? { file } : {}),
        ...prepared.upload,
      };
      setPendingAttachments((previous) => [...previous, attachment]);
      return { ok: true };
    },
    [state.activeChat, state.models, state.selectedModel],
  );

  // AC #3: remove a single pending attachment by id.
  // GEN-PERF-MEMORY-001 — revoke the removed attachment's object-URL preview so no blob is retained.
  const removePendingAttachment = useCallback((id: string) => {
    const removed = pendingAttachmentsRef.current.find((attachment) => attachment.id === id);
    if (removed !== undefined) {
      revokeAttachmentPreview(removed);
      void deletePendingImage(removed).catch(() => {
        setError(ATTACHMENT_CLEANUP_DEFERRED_ERROR);
      });
    }
    setPendingAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
  }, []);

  // Clears all pending attachments (exposed on the session API for surfaces that discard the whole
  // staging area). GEN-PERF-MEMORY-001 — revoke every removed attachment's object-URL preview.
  const clearPendingAttachments = useCallback(() => {
    const removed = pendingAttachmentsRef.current;
    for (const attachment of removed) {
      revokeAttachmentPreview(attachment);
      void deletePendingImage(attachment).catch(() => {
        setError(ATTACHMENT_CLEANUP_DEFERRED_ERROR);
      });
    }
    setPendingAttachments((previous) => (previous.length === 0 ? previous : []));
  }, []);

  // #2843 — releases exactly the attachments a settled send consumed, rather than clearing the whole
  // staging area. The composer stays editable during a send (uiux-fix F041) and a queued canonical
  // Voice turn can settle turns later still, so anything staged AFTER the consumed set must survive
  // to be sent by its own turn. GEN-PERF-MEMORY-001 — revoke the released previews.
  const releasePendingAttachments = useCallback((ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const consumed = new Set(ids);
    const removed = pendingAttachmentsRef.current.filter((attachment) =>
      consumed.has(attachment.id),
    );
    for (const attachment of removed) {
      revokeAttachmentPreview(attachment);
      void deletePendingImage(attachment).catch(() => {
        setError(ATTACHMENT_CLEANUP_DEFERRED_ERROR);
      });
    }
    setPendingAttachments((previous) => {
      const retained = previous.filter((attachment) => !consumed.has(attachment.id));
      if (retained.length === previous.length) return previous;
      return retained;
    });
  }, []);

  // 0.3.0 release audit — the composer (draft text + staged attachment queue) is ONE app-wide
  // slot because the chat window is a singleton (ADR-0114). Switching the active conversation
  // reset the stream bubble, the grounded answer, the latest memory and the document note, but
  // never the composer — so a document staged in chat A was extracted and sent into chat B, under
  // whatever model and provider chat B had selected. Content a user staged for one conversation
  // must never ride along into another: every path that changes the active conversation clears it
  // fail-closed. Placed here, on the state that owns the composer, so a new switch path cannot
  // forget to call it.
  const resetComposerForConversationSwitch = useCallback((): void => {
    setDraft("");
    clearPendingAttachments();
  }, [clearPendingAttachments]);

  // Issue #148 — extract bounded text from the staged DOCUMENT attachments for the send body.
  // Images are excluded here (they stay on the metadata-only attachments path). A document with
  // no retained File (synthetic fixture) is skipped. Read failures surface a fixed, path-safe
  // alert and never abort the send. Returns the wire entries to attach plus a disclosure list.
  // #2843 — the staged set is an argument, not closed-over state: a canonical Voice turn passes the
  // snapshot captured at handoff, so a turn is never built from a composer the user has since changed.
  //
  // 0.3.0 release audit — the metadata-only path is exactly why an image cannot reach the model,
  // so every staged image is disclosed by name through the same pre-send alert channel the
  // document skips already use. The notice is emitted whether or not any document is attached,
  // and it is derived from the SAME staged snapshot as the extraction, so a spoken turn discloses
  // what that turn actually carries rather than what the composer happens to hold now.
  const buildDocumentContext = useCallback(
    async (
      staged: readonly PendingAttachment[],
    ): Promise<{
      readonly entries: readonly ConversationDocumentContextWire[];
      readonly disclosures: readonly SentDocumentDisclosure[];
    }> => {
      const documents: PendingDocument[] = staged
        .filter((a) => a.kind === "document" && a.file !== undefined)
        .map((a) => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          file: a.file as File,
        }));
      const extracted =
        documents.length === 0
          ? { entries: [] as readonly ConversationDocumentContextWire[], failures: [] }
          : await extractDocumentContext(documents, t);
      const notices = extracted.failures;
      if (notices.length > 0) setError(notices.join(" "));
      const disclosures = extracted.entries.map((e) => ({
        id: e.id,
        displayName: e.displayName,
        truncated: e.truncated,
      }));
      return { entries: extracted.entries, disclosures };
    },
    [t],
  );

  const buildAttachmentDescriptors = useCallback(
    (staged: readonly PendingAttachment[]): readonly ConversationAttachmentDescriptorWire[] =>
      staged.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(attachment.attachmentRef === undefined
          ? {}
          : { attachmentRef: attachment.attachmentRef }),
        ...(attachment.sha256 === undefined ? {} : { sha256: attachment.sha256 }),
      })),
    [],
  );

  const clearLatestMemory = useCallback(() => {
    setLatestMemory(undefined);
  }, []);

  // `surface` declares where the turn originated so a capture made during a spoken turn is attributed
  // to Voice in the Memory Journal (Issue #2550). Realtime Voice answers every settled final through
  // this same canonical chat pipeline, so the server cannot infer the origin — only the caller knows.
  // Omitted for typed sends, which keeps the request byte-identical to the pre-#2550 shape.
  const buildMemoryRequest = useCallback(
    (
      chat: Chat,
      project: { readonly path: string },
      surface?: ConversationMemoryCaptureSurfaceWire,
    ): ConversationMemoryRequestWire => ({
      enabled: memoryEnabled,
      budgetTokens: memoryBudgetTokens,
      mode: memoryMode,
      ...(surface === undefined ? {} : { surface }),
      context: {
        userId: DEFAULT_CONVERSATION_MEMORY_USER_ID,
        workspaceId: project.path,
        projectId: project.path,
        conversationId: chat.id,
      },
    }),
    [memoryBudgetTokens, memoryEnabled, memoryMode],
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
    const wasInFlight = isInFlight(sendStatusRef.current);
    sendStatusRef.current = next;
    setSendStatus(next);
    if (!wasInFlight || isInFlight(next)) return;
    for (const release of sendSlotWaitersRef.current) release();
    sendSlotWaitersRef.current.clear();
  }, []);

  const waitForCanonicalVoiceSendSlot = useCallback((signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(new DOMException("cancelled", "AbortError"));
    if (!isInFlight(sendStatusRef.current)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        sendSlotWaitersRef.current.delete(release);
        signal.removeEventListener("abort", onAbort);
      };
      const release = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException("cancelled", "AbortError"));
      };
      sendSlotWaitersRef.current.add(release);
      signal.addEventListener("abort", onAbort, { once: true });
      // Close the check/register race: a terminal update between the first check and registration
      // already fired its waiter set, so observe the ref once more after registration.
      if (!isInFlight(sendStatusRef.current)) release();
    });
  }, []);

  const updateOwnedSendStatus = useCallback(
    (signal: AbortSignal, next: SendStatus): void => {
      if (latestSendSignalRef.current === signal) updateSendStatus(next);
    },
    [updateSendStatus],
  );

  const reconcileCanonicalUserPersistence = useCallback(
    async (
      chatId: string,
      projectPath: string,
      optimistic: ChatMessage,
      clientTurnId: string,
      presentation: FailedSendPresentation,
      signal: AbortSignal,
    ): Promise<CanonicalTurnReconciliation> => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, CANONICAL_USER_RECONCILIATION_TIMEOUT_MS);
      reconciliationControllersRef.current.set(controller, timer);
      try {
        const canonicalTurnRef = await canonicalTurnReferenceForClient(chatId, clientTurnId);
        const payload = await raceUiAbort(
          fetchChatMessages(chatId, projectPath, controller.signal),
          controller.signal,
        );
        const persistence = hasExactCanonicalUserMessage(payload.messages, canonicalTurnRef)
          ? "persisted"
          : "missing";
        const assistant = exactCanonicalAssistant(payload.messages, canonicalTurnRef);
        if (
          mountedRef.current &&
          activeChatIdRef.current === chatId &&
          latestSendSignalRef.current === signal
        ) {
          const visibleMessages = canonicalTurnPresentation(
            payload.messages,
            canonicalTurnRef,
            presentation.canonicalUser,
          );
          setState((previous) => ({
            ...previous,
            messages: [
              ...visibleMessages,
              ...(persistence === "missing" && presentation.missingOptimistic === "preserve"
                ? [optimistic]
                : []),
              ...previous.messages.filter(
                (message) => message.id.startsWith("local-") && message.id !== optimistic.id,
              ),
            ],
          }));
        }
        return {
          persistence,
          ...(assistant === undefined ? {} : { completedAssistantMessageId: assistant.id }),
        };
      } catch {
        // A failed reconciliation cannot prove that the request was rejected. Keep the reviewed user
        // text visible and report an uncertain outcome; silently removing it would lose a final voice
        // transcript that the server may already have persisted.
        if (
          mountedRef.current &&
          activeChatIdRef.current === chatId &&
          latestSendSignalRef.current === signal
        ) {
          setState((previous) =>
            previous.messages.some((message) => message.id === optimistic.id)
              ? previous
              : { ...previous, messages: [...previous.messages, optimistic] },
          );
        }
        return { persistence: "unknown" };
      } finally {
        clearTimeout(timer);
        reconciliationControllersRef.current.delete(controller);
      }
    },
    [],
  );

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
        if (!cancelled) {
          setState((previous) => {
            const next = { ...previous, ...patch };
            return next.activeChat === undefined
              ? next
              : {
                  ...next,
                  messages: mergeCanonicalVoiceProjections(
                    next.messages,
                    next.activeChat.id,
                    canonicalVoiceProjectionRef.current,
                  ),
                };
          });
        }
      } catch (error_) {
        if (!cancelled) setError(errorMessage(error_));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [autoCreate, canonicalVoiceProjectionRef]);

  useEffect(() => {
    let cancelled = false;
    let refreshGeneration = 0;
    const refreshModels = (): void => {
      refreshGeneration += 1;
      const generation = refreshGeneration;
      invalidateSharedBootstrap();
      resetModelRequestCache();
      void loadRefreshedSessionModels({
        isCancelled: () => cancelled || generation !== refreshGeneration,
        setError,
        setState,
      });
    };
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, refreshModels);
    return () => {
      cancelled = true;
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, refreshModels);
    };
  }, []);

  useEffect(() => {
    return subscribeChatMutations((mutation) => {
      if (mutation.type === "upsert") {
        const { chat } = mutation;
        setState((previous) => ({
          ...previous,
          chats: upsertChatIntoList(previous.chats, chat),
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
        chats: removeChatFromList(previous.chats, mutation.chatId),
        activeChat: previous.activeChat?.id === mutation.chatId ? undefined : previous.activeChat,
        messages: previous.activeChat?.id === mutation.chatId ? [] : previous.messages,
      }));
    });
  }, []);

  useEffect(() => {
    const reconciliationControllers = reconciliationControllersRef.current;
    mountedRef.current = true;
    // GEN-PERF-CHAT-011 — install a fresh controller for this mount so a StrictMode remount (which
    // re-runs this effect after the cleanup aborted the previous one) polls with a live signal.
    if (runSummaryControllerRef.current.signal.aborted) {
      runSummaryControllerRef.current = new AbortController();
    }
    if (canonicalVoiceQueueControllerRef.current.signal.aborted) {
      canonicalVoiceQueueControllerRef.current = new AbortController();
    }
    return () => {
      mountedRef.current = false;
      sendStatusRef.current = "cancelled";
      sendControllerRef.current?.abort();
      sendControllerRef.current = null;
      sendControllerOwnerRef.current = null;
      latestSendSignalRef.current = null;
      for (const [controller, timer] of reconciliationControllers) {
        clearTimeout(timer);
        controller.abort();
      }
      reconciliationControllers.clear();
      canonicalVoiceQueueControllerRef.current.abort();
      // Accepted Voice finals and their optimistic projections belong to the page-lifecycle outbox,
      // not this component instance. The next ChatSession attachment resumes the same identities;
      // only the in-flight HTTP wait owned by this unmounting hook is cancelled here.
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
          previous.activeChat?.id === chat.id ? { ...chat, selectedModel: id } : chat,
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
          chats: replaceChatInList(previous.chats, result.chat),
        }));
      })
      .catch((error_): void => {
        if (selectedModelPersistRef.current !== requestId) return;
        // MS-F1: skip the rollback when the user has navigated to a different
        // chat since this PATCH was issued — restoring this chat's old model
        // would clobber the now-active chat's selection. Not isStillActiveChat: this compares
        // against the captured-at-send-time local `activeChatId`, not a per-call chat.id.
        if (activeChatIdRef.current !== activeChatId) return;
        setError(errorMessage(error_));
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
            chats: restoreChatSelectedModel(previous.chats, activeChatId, rollback.chats),
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
      // 0.3.0 release audit — a new conversation is a different conversation: whatever was staged
      // for the previous one must not be carried into it.
      resetComposerForConversationSwitch();
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
          return created.chat;
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
      } catch (error_) {
        setError(errorMessage(error_));
        return undefined;
      }
    },
    [resetComposerForConversationSwitch, state.selectedModel, state.activeProject, state.models],
  );

  const openProject = useCallback(
    async (project: ProjectWithAvailability): Promise<void> => {
      setError(undefined);
      setStreamingAssistantMessage(undefined);
      // 0.3.0 release audit — a project switch changes the active conversation, so the one
      // app-wide composer must not carry the previous project's draft or staged files into it.
      resetComposerForConversationSwitch();
      activeProjectPathRef.current = project.path;
      setState((previous) => ({ ...previous, activeProject: project }));
      try {
        const chatPayload = await sharedFetchChats(project.path);
        if (activeProjectPathRef.current !== project.path) return;
        const sorted = sortChats(chatPayload.chats);
        const latest = pickResumableChat(sorted);
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
          messages: mergeCanonicalVoiceProjections(
            messagePayload.messages,
            latest.id,
            canonicalVoiceProjectionRef.current,
          ),
        }));
        setLatestMemory(undefined);
      } catch (error_) {
        if (activeProjectPathRef.current !== project.path) return;
        setError(errorMessage(error_));
      }
    },
    [canonicalVoiceProjectionRef, openNewChat, resetComposerForConversationSwitch, state.models],
  );

  const openChat = useCallback(
    async (chat: Chat): Promise<void> => {
      if (activeChatIdRef.current === chat.id && state.activeChat?.id === chat.id) return;
      setError(undefined);
      setStreamingAssistantMessage(undefined);
      // Issue #152 — opening a different chat must abort any in-flight send so
      // a late response from the prior chat never lands here.
      if (sendControllerOwnerRef.current !== "canonical-voice") {
        sendControllerRef.current?.abort();
        sendControllerRef.current = null;
        sendControllerOwnerRef.current = null;
      }
      activeChatIdRef.current = chat.id;
      // Issue #185 — clear any prior grounded answer so the new chat doesn't render stale
      // citations from a previous conversation's last grounded turn.
      setLatestGrounded(undefined);
      setLatestMemory(undefined);
      // Issue #148 — clear the document-disclosure note so it never bleeds across chats.
      setLastSentDocuments([]);
      setLastSentImages([]);
      // 0.3.0 release audit — and neither may the draft or the staged attachments.
      resetComposerForConversationSwitch();
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
            messages: mergeCanonicalVoiceProjections(
              messagePayload.messages,
              chat.id,
              canonicalVoiceProjectionRef.current,
            ),
          };
        });
      } catch (error_) {
        if (!isStillActiveChat(chat.id)) return;
        setError(errorMessage(error_));
      }
    },
    [
      canonicalVoiceProjectionRef,
      resetComposerForConversationSwitch,
      state.activeChat?.id,
      state.models,
    ],
  );

  const addProject = useCallback(
    async (path: string): Promise<ProjectWithAvailability | undefined> => {
      const trimmed = path.trim();
      if (trimmed.length === 0) return undefined;
      setError(undefined);
      setNotice(undefined);
      try {
        const created = await createProject({ path: trimmed });
        const projectPayload = await fetchProjects();
        setState((previous) => ({ ...previous, projects: Array.from(projectPayload.projects) }));
        await openProject(created.project);
        setNotice(projectResponseWarningMessage(created));
        return created.project;
      } catch (error_) {
        setError(errorMessage(error_));
        return undefined;
      }
    },
    [openProject],
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
      resolve: (outcome: SendAttemptOutcome) => void,
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
            updateOwnedSendStatus(signal, "streaming");
            statusFlippedToStreaming = true;
          }
          pendingText += text;
          if (!canRaf) {
            flush();
            return;
          }
          rafHandle ??= requestAnimationFrame(flush);
        },
        onDone: (payload: SseDonePayload): void => {
          cancelFlush();
          flush();
          if (isSupersededOrAborted(chatId, signal)) {
            setStreamingAssistantMessage((current) =>
              current?.id === tempAssistantId ? undefined : current,
            );
            resolve({ status: "cancelled" });
            return;
          }
          setStreamingAssistantMessage((current) =>
            current?.id === tempAssistantId ? undefined : current,
          );
          setState((previous) => ({
            ...previous,
            activeChat: payload.chat,
            chats: upsertChatIntoList(previous.chats, payload.chat),
            messages: replaceCanonicalTurnMessages(
              previous.messages,
              [optimisticId, tempAssistantId],
              payload.messages,
            ),
          }));
          notifyChatUpsert(payload.chat);
          if (payload.memory !== undefined) setLatestMemory(payload.memory);
          const outcome = completedSendOutcome(payload.messages, payload.attachmentDeliveries);
          if (outcome.status === "failed") setError(EMPTY_MODEL_RESPONSE_USER_MESSAGE);
          resolve(outcome);
        },
        onError: ({ code, message }: { code: string; message: string }): void => {
          // GEN-PERF-CHAT-007 — cancel any pending frame; onError/onCancelled remove the temp
          // bubble entirely (AC#3, no partial kept), so the buffered text must NOT be flushed.
          cancelFlush();
          pendingText = "";
          if (isSupersededOrAborted(chatId, signal)) {
            removeTempMessage(tempAssistantId);
            resolve({ status: "cancelled" });
            return;
          }
          if (code === "CHAT_TURN_IN_PROGRESS") {
            removeTempMessage(tempAssistantId);
            resolve({ status: "failed", canonicalTurnInProgress: true });
            return;
          }
          setError(errorMessage(new ApiError(code, message, 0)));
          removeTempMessage(tempAssistantId);
          resolve({ status: "failed" });
        },
        onCancelled: (): void => {
          cancelFlush();
          pendingText = "";
          removeTempMessage(tempAssistantId);
          resolve({ status: "cancelled" });
        },
      };
    },
    [removeTempMessage, updateOwnedSendStatus],
  );

  // Issue #152 Layer 3 — streaming path for canStream models. Inserts a temp
  // assistant bubble that accumulates token deltas, then replaces it with the
  // canonical messages on done. On cancel/error the temp bubble is removed so
  // no partial content persists (AC#3).
  const streamUngrounded = useCallback(
    (request: UngroundedSendRequest): Promise<SendAttemptOutcome> => {
      const {
        chat,
        project,
        content,
        optimisticId,
        modelId,
        signal,
        documentContext,
        attachments,
        memory,
        clientTurnId,
      } = request;
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
        memory,
        ...(documentContext.length > 0 ? { documentContext } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(clientTurnId === undefined ? {} : { clientTurnId }),
        ...(clientTurnId === undefined || chat.groundingScopeIdentity === undefined
          ? {}
          : { expectedGroundingScopeIdentity: chat.groundingScopeIdentity }),
      };
      return new Promise<SendAttemptOutcome>((resolve, reject) => {
        const handlers = buildStreamHandlers(
          chat.id,
          tempAssistantId,
          optimisticId,
          signal,
          resolve,
        );
        sendDesktopChatStream(requestBody, signal, handlers).catch((error_: unknown): void => {
          removeTempMessage(tempAssistantId);
          if (error_ instanceof StreamingUnavailableError) {
            // Pre-stream failure (e.g. STREAMING_UNSUPPORTED, or a JSON error before any SSE
            // header). Reject so sendUngrounded falls back to the buffered path instead of
            // surfacing a hard failure to the user.
            reject(error_);
          } else if (error_ instanceof DOMException && error_.name === "AbortError") {
            resolve({ status: "cancelled" });
          } else if (isSupersededOrAborted(chat.id, signal)) {
            resolve({ status: "cancelled" });
          } else {
            // Mid-stream client error (e.g. network drop, reader TypeError). Surface it so the
            // UI does not silently swallow the failure. The server has already persisted the
            // user message at this point; removing it here is UI-only — it reappears on reload,
            // which matches the behaviour of sendUngroundedBuffered and sendGrounded.
            handleStreamUngroundedTransportFailure(error_, setError, resolve);
          }
        });
      });
    },
    [buildStreamHandlers, removeTempMessage],
  );

  // Issue #152 Layer 3 — non-streaming fallback path (canStream=false or
  // StreamingUnavailableError pre-stream). Kept separate so sendUngrounded
  // stays within the 50-line function limit.
  const sendUngroundedBuffered = useCallback(
    async (request: UngroundedSendRequest): Promise<SendAttemptOutcome> => {
      const { chat, optimisticId, signal } = request;
      try {
        updateOwnedSendStatus(signal, "contacting");
        // Issue #148 — byte-bounded document context on the request body.
        const result = await sendDesktopChat(desktopChatInputForUngrounded(request), signal);
        if (signal.aborted) return { status: "cancelled" };
        const outcome = completedSendOutcome(result.messages, result.attachmentDeliveries);
        if (!isStillActiveChat(chat.id)) return outcome;
        setState((previous) => ({
          ...previous,
          activeChat: result.chat,
          chats: sortChats([
            result.chat,
            ...previous.chats.filter((existing) => existing.id !== result.chat.id),
          ]),
          messages: replaceCanonicalTurnMessages(
            previous.messages,
            [optimisticId],
            result.messages,
          ),
        }));
        notifyChatUpsert(result.chat);
        setLatestMemory(result.memory);
        if (outcome.status === "failed") setError(EMPTY_MODEL_RESPONSE_USER_MESSAGE);
        return outcome;
      } catch (error_) {
        if (error_ instanceof DOMException && error_.name === "AbortError") {
          return { status: "cancelled" };
        }
        if (isSupersededOrAborted(chat.id, signal)) return { status: "cancelled" };
        const failure = canonicalTurnInProgressFailure(error_);
        if (failure.canonicalTurnInProgress !== true) setError(errorMessage(error_));
        return failure;
      }
    },
    [updateOwnedSendStatus],
  );

  const sendUngrounded = useCallback(
    async (request: UngroundedSendRequest): Promise<SendAttemptOutcome> => {
      const { modelId, signal } = request;
      const canStream = state.models.find((m) => m.id === modelId)?.streaming === true;
      if (!canStream) {
        return sendUngroundedBuffered(request);
      }
      updateOwnedSendStatus(signal, "contacting");
      try {
        return await streamUngrounded(request);
      } catch (error_) {
        // StreamingUnavailableError before SSE headers — fall back to buffered.
        if (!(error_ instanceof StreamingUnavailableError)) throw error_;
      }
      return sendUngroundedBuffered(request);
    },
    [state.models, sendUngroundedBuffered, streamUngrounded, updateOwnedSendStatus],
  );

  // When the active chat carries either a Files connected scope or a local-knowledge scope,
  // the composer routes the submission through the grounded BFF path instead of the plain
  // gateway-backed chat path.
  // The route persists both messages and returns the redacted citation projection; the hook
  // refetches the message log on success so the bubbles reflect the canonical store state.
  const sendGrounded = useCallback(
    async (
      chat: Chat,
      content: string,
      optimisticId: string,
      modelId: string,
      signal: AbortSignal,
      memory: ConversationMemoryRequestWire,
      clientTurnId: string | undefined,
    ): Promise<SendAttemptOutcome> => {
      // Copilot PR #258 finding: clear the previous answer at the START of a new send so a
      // stale citation block doesn't briefly flash next to the new question.
      setLatestGrounded(undefined);
      try {
        updateOwnedSendStatus(signal, "contacting");
        const result = await askGrounded(
          {
            chatId: chat.id,
            content,
            modelId,
            memory,
            ...(clientTurnId === undefined ? {} : { clientTurnId }),
            ...(clientTurnId === undefined || chat.groundingScopeIdentity === undefined
              ? {}
              : { expectedGroundingScopeIdentity: chat.groundingScopeIdentity }),
          },
          signal,
        );
        if (!isStillActiveChat(chat.id)) {
          return { status: "completed", assistantMessageId: result.assistantMessageId };
        }
        if (signal.aborted) return { status: "cancelled" };
        setLatestGrounded(result);
        setLatestMemory(result.memory);
        // Refresh BOTH messages AND chats so the sidebar reflects the new updated_at and
        // re-sorts the active chat to the top after the assistant reply lands.
        const [messagePayload, chatsPayload] = await Promise.all([
          fetchChatMessages(chat.id, chat.projectPath),
          fetchChats(chat.projectPath),
        ]);
        if (!isStillActiveChat(chat.id)) {
          return { status: "completed", assistantMessageId: result.assistantMessageId };
        }
        if (signal.aborted) return { status: "cancelled" };
        const refreshedActive = chatsPayload.chats.find((c) => c.id === chat.id);
        setState((previous) =>
          activeChatIdRef.current !== chat.id || previous.activeChat?.id !== chat.id
            ? previous
            : {
                ...previous,
                messages: mergeCanonicalVoiceProjections(
                  messagePayload.messages,
                  chat.id,
                  canonicalVoiceProjectionRef.current,
                  [optimisticId],
                ),
                chats: sortChats(chatsPayload.chats),
                activeChat: refreshedActive ?? previous.activeChat,
              },
        );
        if (refreshedActive !== undefined) notifyChatUpsert(refreshedActive);
        return { status: "completed", assistantMessageId: result.assistantMessageId };
      } catch (error_) {
        // Issue #152 — abort preserves the user's optimistic message (AC#3:
        // no fake assistant content is persisted; the user's prompt remains
        // visible so they can edit & retry without retyping).
        if (error_ instanceof DOMException && error_.name === "AbortError") {
          return { status: "cancelled" };
        }
        if (isSupersededOrAborted(chat.id, signal)) return { status: "cancelled" };
        const failure = canonicalTurnInProgressFailure(error_);
        if (failure.canonicalTurnInProgress !== true) setError(errorMessage(error_));
        return failure;
      }
    },
    [canonicalVoiceProjectionRef, updateOwnedSendStatus],
  );

  const executeSendAttempt = useCallback(
    async (request: SendAttemptRequest): Promise<SendAttemptExecution> => {
      const { chat, canonicalTarget, signal } = request;
      const grounded = hasGroundingScope(chat);
      // #2843 — the ONLY route without an attachment channel is the grounded one: it derives context
      // from the repository / Knowledge Pod scope instead. A spoken turn is not a second reason to
      // drop supplemental context; ADR-0154 D1/D5 require it to carry the same context a typed turn
      // would, and the queue-captured snapshot binds exactly the files staged at handoff.
      const staged = canonicalTarget?.attachments ?? pendingAttachments;
      const documentBundle = grounded
        ? { entries: [] as readonly ConversationDocumentContextWire[], disclosures: [] }
        : await buildDocumentContext(staged);
      const attachments: readonly ConversationAttachmentDescriptorWire[] = grounded
        ? []
        : buildAttachmentDescriptors(staged);
      const consumedAttachmentIds = grounded ? [] : staged.map((attachment) => attachment.id);
      const memory = canonicalTarget?.memory ?? buildMemoryRequest(chat, request.project);
      if (grounded) {
        // A typed send in this state is rejected before admission (resolveSendMessageAdmission), so
        // only a spoken turn can reach here with files staged. A settled final transcript must never
        // be discarded (ADR-0154 D1), so the turn proceeds on the grounded route and the SAME notice
        // states that the staged attachments were not part of it. Unconditional on purpose: whichever
        // caller arrives here with staged files, the user is told rather than silently ignored.
        if (staged.length > 0) setError(GROUNDED_ATTACHMENT_NOTICE);
        const terminal = await sendGrounded(
          chat,
          request.content,
          request.optimisticId,
          request.modelId,
          signal,
          memory,
          request.clientTurnId,
        );
        return { terminal, disclosures: documentBundle.disclosures, consumedAttachmentIds };
      }
      const ungroundedRequest: UngroundedSendRequest = {
        chat,
        project: request.project,
        content: request.content,
        optimisticId: request.optimisticId,
        modelId: request.modelId,
        signal,
        documentContext: documentBundle.entries,
        attachments,
        memory,
        clientTurnId: request.clientTurnId,
      };
      const terminal =
        request.forceBuffered || staged.some((attachment) => attachment.kind === "image")
          ? await sendUngroundedBuffered(ungroundedRequest)
          : await sendUngrounded(ungroundedRequest);
      return { terminal, disclosures: documentBundle.disclosures, consumedAttachmentIds };
    },
    [
      buildAttachmentDescriptors,
      buildDocumentContext,
      buildMemoryRequest,
      pendingAttachments,
      sendGrounded,
      sendUngrounded,
      sendUngroundedBuffered,
    ],
  );

  const settleSendAttempt = useCallback(
    async (request: SendAttemptSettlementRequest): Promise<SettledSendAttempt> => {
      let settled: SendAttemptOutcome = request.signal.aborted
        ? { status: "cancelled" }
        : request.terminal;
      if (settled.status === "completed") return { settled, persistence: "persisted" };
      const exactTurnInProgress =
        request.terminal.status === "failed" && request.terminal.canonicalTurnInProgress === true;
      const reconciliation = await reconcileCanonicalUserPersistence(
        request.chat.id,
        request.projectPath,
        request.optimistic,
        request.clientTurnId,
        failedSendPresentation(exactTurnInProgress, settled, request.preserveUserOnMissing),
        request.signal,
      );
      const persistence = exactTurnInProgress ? "persisted" : reconciliation.persistence;
      if (
        reconciliation.persistence !== "persisted" ||
        reconciliation.completedAssistantMessageId === undefined
      ) {
        return { settled, persistence };
      }
      settled = {
        status: "completed",
        assistantMessageId: reconciliation.completedAssistantMessageId,
      };
      if (
        mountedRef.current &&
        activeChatIdRef.current === request.chat.id &&
        latestSendSignalRef.current === request.signal
      ) {
        setError(undefined);
      }
      return { settled, persistence };
    },
    [reconcileCanonicalUserPersistence],
  );

  // #2843 — a spoken turn settles here too. It used to return early for a canonical target, which
  // left the staged chips claiming to be unsent and left `lastSentDocuments` holding the PREVIOUS
  // turn's disclosure list, so a "documents included as context" note could sit on screen next to a
  // spoken answer that carried different documents (or none). Typed and spoken turns now settle
  // identically here; only the visible chat's own latest settled turn may rewrite the disclosure note.
  const presentCompletedSend = useCallback(
    (input: {
      readonly settled: SendAttemptOutcome;
      readonly chatId: string;
      readonly signal: AbortSignal;
      readonly disclosures: readonly SentDocumentDisclosure[];
      readonly consumedAttachmentIds: readonly string[];
    }): void => {
      if (input.settled.status !== "completed" || !mountedRef.current) return;
      // The consumed files are on the wire, so they are released whichever chat is visible now:
      // leaving a chip staged after its turn sent it claims the opposite and would re-send the same
      // document on the next turn. Only the disclosure note is chat- and supersession-scoped.
      releasePendingAttachments(input.consumedAttachmentIds);
      if (
        activeChatIdRef.current !== input.chatId ||
        latestSendSignalRef.current !== input.signal
      ) {
        return;
      }
      setLastSentDocuments(input.disclosures);
      const delivered = new Set(input.settled.deliveredImageIds ?? []);
      setLastSentImages(
        pendingAttachmentsRef.current
          .filter((attachment) => delivered.has(attachment.id))
          .map((attachment) => ({ id: attachment.id, displayName: attachment.name })),
      );
    },
    [releasePendingAttachments],
  );

  // Issue #152 — unified cancel that aborts any in-flight send (grounded OR
  // ungrounded). Replaces the prior `cancelGrounded`-only surface. When no
  // request is in flight this is a safe no-op. We flip sendStatus to
  // "cancelled" immediately so the UI re-renders out of the in-flight state
  // even before the fetch rejection reaches the awaited site.
  const releaseCancelledSendController = useCallback((): void => {
    sendControllerRef.current = null;
    sendControllerOwnerRef.current = null;
    setRegeneratingMessageId(undefined);
    updateSendStatus("cancelled");
  }, [updateSendStatus]);

  const cancelSend = useCallback(() => {
    if (!isInFlight(sendStatusRef.current)) return;
    sendControllerRef.current?.abort();
    releaseCancelledSendController();
  }, [releaseCancelledSendController]);

  // ADR-0154 D4 barge-in. Unlike cancelSend (the visible stop control, which cancels whatever the
  // user can see in flight) this is scoped by send owner exactly like openChat's abort: a typed
  // composer send belongs to a different intent and must survive. The interrupted signal is recorded
  // first so the attempt reports a terminal cancellation and the Chat-owned queue advances instead
  // of re-sending an answer whose dialog generation has already been retired (#2842).
  const interruptCanonicalVoiceDelivery = useCallback((): void => {
    if (!isInFlight(sendStatusRef.current)) return;
    if (sendControllerOwnerRef.current !== "canonical-voice") return;
    const controller = sendControllerRef.current;
    if (controller !== null) {
      interruptedSendSignalRef.current = controller.signal;
      controller.abort();
    }
    releaseCancelledSendController();
  }, [releaseCancelledSendController]);

  // Issue #185 → #152: cancelGrounded is preserved as a thin alias so existing
  // call sites (ChatWindow.tsx grounded TypingBubble) keep working. New code
  // should call cancelSend.
  const cancelGrounded = cancelSend;

  const sendMessage = useCallback(
    async (options?: SendMessageOptions): Promise<SendMessageOutcome> => {
      const admission = resolveSendMessageAdmission({
        options,
        draft,
        activeChat: state.activeChat,
        selectedModel: state.selectedModel,
        models: state.models,
        pendingAttachmentCount: pendingAttachments.length,
        sendInFlight: isInFlight(sendStatusRef.current),
      });
      if (admission.kind === "rejected") {
        if (admission.error !== undefined) setError(admission.error);
        return { status: "not-sent" };
      }
      const { canonicalTarget, chat, project, content, modelId } = admission;
      const clientTurnId = options?.clientTurnId ?? crypto.randomUUID();
      const optimistic =
        options?.optimisticMessage ?? canonicalVoiceOptimisticMessage(chat.id, content);
      // Synchronously commit to "queued" so a re-entrant call in the same tick
      // hits the isInFlight guard above (AC#2).
      updateSendStatus("queued");
      if (options?.text === undefined) {
        setDraft("");
      }
      setError(undefined);
      // AC2 (#2670) — the queue re-attempts a retryable transport failure with the SAME optimistic
      // row, whose id reconciliation already replaced with the durable row it fetched. The id guard
      // alone would therefore project the transcript a second time next to that row, so a
      // queue-owned re-projection (optimisticMessage present) also consults the durable-admission
      // proof. The typed Composer path stays untouched: there identical text is a new turn.
      setState((previous) =>
        projectOptimisticMessage(
          previous,
          chat.id,
          optimistic,
          options?.optimisticMessage !== undefined,
        ),
      );
      // Issue #152 — fresh controller per send. The previous controller (if
      // any) was either already settled or already aborted via cancelSend.
      const controller = new AbortController();
      sendControllerRef.current = controller;
      sendControllerOwnerRef.current =
        canonicalTarget === undefined ? "composer" : "canonical-voice";
      latestSendSignalRef.current = controller.signal;
      setLatestMemory(undefined);
      try {
        const { terminal, disclosures, consumedAttachmentIds } = await executeSendAttempt({
          chat,
          project,
          content,
          optimisticId: optimistic.id,
          modelId,
          signal: controller.signal,
          canonicalTarget,
          forceBuffered: options?.forceBuffered === true,
          clientTurnId,
        });
        const { settled, persistence } = await settleSendAttempt({
          terminal,
          chat,
          projectPath: project.path,
          optimistic,
          clientTurnId,
          signal: controller.signal,
          preserveUserOnMissing: options?.clientTurnId !== undefined,
        });
        // Only the latest attempt owns the shared lifecycle. cancelSend leaves this attempt's signal
        // as owner until settlement; an immediate replacement installs a different signal and cannot
        // be clobbered by this continuation.
        updateOwnedSendStatus(controller.signal, settled.status);
        presentCompletedSend({
          settled,
          chatId: chat.id,
          signal: controller.signal,
          disclosures,
          consumedAttachmentIds,
        });
        return settledSendMessageOutcome({
          settled,
          terminal,
          persistence,
          canonicalTarget,
          interrupted: interruptedSendSignalRef.current === controller.signal,
        });
      } finally {
        if (sendControllerRef.current === controller) {
          sendControllerRef.current = null;
          sendControllerOwnerRef.current = null;
        }
        if (latestSendSignalRef.current === controller.signal) {
          latestSendSignalRef.current = null;
        }
        if (interruptedSendSignalRef.current === controller.signal) {
          interruptedSendSignalRef.current = null;
        }
      }
    },
    [
      draft,
      state.activeChat,
      state.selectedModel,
      state.models,
      pendingAttachments,
      executeSendAttempt,
      presentCompletedSend,
      settleSendAttempt,
      updateOwnedSendStatus,
      updateSendStatus,
    ],
  ) as SendMessage;

  sendMessageRef.current = sendMessage;

  const releaseCanonicalVoiceProjection = useCallback(
    (item: CanonicalVoiceQueueItem): void => {
      const projection = canonicalVoiceProjectionRef.current.get(item.key);
      if (projection?.message.id !== item.optimistic.id) return;
      canonicalVoiceProjectionRef.current.delete(item.key);
      canonicalVoiceProjectionBytesRef.current -= projection.byteLength;
    },
    [canonicalVoiceProjectionBytesRef, canonicalVoiceProjectionRef],
  );

  const cacheSettledCanonicalVoiceDelivery = useCallback(
    (item: CanonicalVoiceQueueItem, outcome: SendMessageOutcome): void => {
      cacheCanonicalVoiceSettledDelivery(item.key, { contentDigest: item.contentDigest, outcome });
    },
    [],
  );

  const requestQueuedCanonicalVoiceDelivery = useCallback(
    async (
      item: CanonicalVoiceQueueItem,
      signal: AbortSignal,
    ): Promise<CanonicalVoiceQueueDelivery | undefined> => {
      const sender = sendMessageRef.current;
      if (sender === null) return undefined;
      const itemController = new AbortController();
      const abortItem = (): void => itemController.abort();
      signal.addEventListener("abort", abortItem, { once: true });
      canonicalVoicePageOutbox.activeDelivery = { key: item.key, abort: abortItem };
      try {
        return await deliverCanonicalVoiceQueueItem(item, {
          signal: itemController.signal,
          send: sender,
          waitForSendSlot: () => waitForCanonicalVoiceSendSlot(itemController.signal),
          onDeliveryDelayed: () => {
            setError(CANONICAL_VOICE_PENDING_ERROR);
          },
          onUserPersisted: () => {
            releaseCanonicalVoiceProjection(item);
          },
        });
      } finally {
        signal.removeEventListener("abort", abortItem);
        if (canonicalVoicePageOutbox.activeDelivery?.key === item.key) {
          canonicalVoicePageOutbox.activeDelivery = undefined;
        }
      }
    },
    [releaseCanonicalVoiceProjection, waitForCanonicalVoiceSendSlot],
  );

  const settleQueuedCanonicalVoiceDelivery = useCallback(
    (
      item: CanonicalVoiceQueueItem,
      delivery: CanonicalVoiceQueueDelivery | undefined,
      signal: AbortSignal,
    ): boolean => {
      if (delivery === undefined) return false;
      if (delivery.kind === "suspended") {
        setCanonicalVoicePageOutboxSuspended(item.target.chat.id);
        return false;
      }
      if (delivery.kind === "aborted") {
        return !signal.aborted && canonicalVoiceQueueRef.current[0] !== item;
      }
      const { outcome } = delivery;
      if (signal.aborted && !canonicalVoiceOutcomeIsPersisted(outcome)) return false;
      if (canonicalVoiceOutcomeIsPersisted(outcome) || canonicalVoiceOutcomeIsTerminal(outcome)) {
        releaseCanonicalVoiceProjection(item);
        cacheSettledCanonicalVoiceDelivery(item, outcome);
      }
      item.resolve(outcome);
      canonicalVoiceDeliveriesRef.current.delete(item.key);
      if (canonicalVoiceQueueRef.current[0] === item) {
        canonicalVoiceQueueRef.current.shift();
        canonicalVoicePageOutbox.queueBytesRef.current = Math.max(
          0,
          canonicalVoicePageOutbox.queueBytesRef.current - item.byteLength,
        );
      }
      return true;
    },
    [
      cacheSettledCanonicalVoiceDelivery,
      canonicalVoiceDeliveriesRef,
      canonicalVoiceQueueRef,
      releaseCanonicalVoiceProjection,
    ],
  );

  const drainCanonicalVoiceQueue = useCallback(async (): Promise<void> => {
    const owner = canonicalVoiceQueueOwnerRef.current;
    if (
      loading ||
      canonicalVoicePageOutbox.drainingOwner !== undefined ||
      canonicalVoicePageOutboxSuspended()
    )
      return;
    canonicalVoicePageOutbox.drainingOwner = owner;
    const signal = canonicalVoiceQueueControllerRef.current.signal;
    try {
      while (
        canonicalVoicePageOutbox.drainingOwner === owner &&
        !signal.aborted &&
        canonicalVoiceQueueRef.current.length > 0
      ) {
        const item = canonicalVoiceQueueRef.current[0];
        if (item === undefined) break;
        const delivery = await requestQueuedCanonicalVoiceDelivery(item, signal);
        if (!settleQueuedCanonicalVoiceDelivery(item, delivery, signal)) break;
      }
    } finally {
      if (canonicalVoicePageOutbox.drainingOwner === owner) {
        canonicalVoicePageOutbox.drainingOwner = undefined;
      }
      if (canonicalVoiceQueueRef.current.length > 0 && !canonicalVoicePageOutboxSuspended()) {
        wakeCanonicalVoicePageOutbox();
      }
    }
  }, [
    canonicalVoiceQueueRef,
    loading,
    requestQueuedCanonicalVoiceDelivery,
    settleQueuedCanonicalVoiceDelivery,
  ]);

  drainCanonicalVoiceQueueRef.current = () => {
    void drainCanonicalVoiceQueue();
  };

  useEffect(() => {
    const observeStatus = (status: CanonicalVoiceOutboxStatus): void => {
      setCanonicalVoiceOutboxStatus(status);
    };
    canonicalVoicePageOutbox.statusSubscribers.add(observeStatus);
    observeStatus(canonicalVoicePageOutbox.status);
    return () => {
      canonicalVoicePageOutbox.statusSubscribers.delete(observeStatus);
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const wake = (): void => {
      if (
        canonicalVoiceQueueControllerRef.current.signal.aborted ||
        canonicalVoicePageOutboxSuspended()
      )
        return;
      drainCanonicalVoiceQueueRef.current();
    };
    canonicalVoicePageOutbox.wakes.add(wake);
    wake();
    return () => {
      canonicalVoicePageOutbox.wakes.delete(wake);
    };
  }, [loading]);

  const enqueueCanonicalVoiceTurn = useCallback<EnqueueCanonicalVoiceTurn>(
    (input) => {
      const content = input.text.trim();
      const clientTurnId = input.clientTurnId;
      const chat = input.target.chat;
      // The chat is the canonical conversation identity. Derive every request and memory scope from
      // its persisted project path, even while the project list or active-project selection is stale.
      // The BFF validates that path at the authority boundary; UI metadata must never redirect or
      // silently discard a final transcript before admission.
      const project = canonicalProjectTarget(chat);
      // A deployment can disappear after the Voice session has already produced its final. Keep
      // the transcript on the canonical request path with the chat's persisted model identity; the
      // server still validates compatibility and fails closed, while the optimistic user row stays
      // visible instead of being silently discarded by a client-only no-model guard.
      const modelId = input.target.modelId;
      const byteLength = new TextEncoder().encode(content).byteLength;
      if (
        content.length === 0 ||
        content.length > MAX_DESKTOP_CHAT_INPUT_CHARS ||
        byteLength > MAX_DESKTOP_CHAT_INPUT_BYTES ||
        clientTurnId.length === 0 ||
        clientTurnId.length > MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS
      ) {
        setError(CANONICAL_VOICE_INPUT_ERROR);
        return undefined;
      }
      if (!isGroundingScopeIdentity(chat.groundingScopeIdentity)) {
        setError(CANONICAL_VOICE_SCOPE_IDENTITY_ERROR);
        return undefined;
      }
      let contentDigest: string;
      try {
        contentDigest = canonicalVoiceContentDigest(content);
      } catch {
        setError(CANONICAL_VOICE_HASHING_ERROR);
        return undefined;
      }
      const key = canonicalVoiceDeliveryKey(chat.id, clientTurnId);
      const active = canonicalVoiceDeliveriesRef.current.get(key);
      if (active !== undefined) {
        if (active.contentDigest === contentDigest) return active.promise;
        setError(CANONICAL_VOICE_IDENTITY_ERROR);
        return undefined;
      }
      const settled = canonicalVoiceSettledRef.current.get(key);
      if (settled !== undefined) {
        if (settled.contentDigest === contentDigest) return Promise.resolve(settled.outcome);
        setError(CANONICAL_VOICE_IDENTITY_ERROR);
        return undefined;
      }
      const existingProjection = canonicalVoiceProjectionRef.current.get(key);
      if (existingProjection !== undefined && existingProjection.content !== content) {
        setError(CANONICAL_VOICE_IDENTITY_ERROR);
        return undefined;
      }
      if (
        existingProjection === undefined &&
        !canonicalVoicePageOutboxHasCapacity(byteLength, input.allowReservedCapacity === true)
      ) {
        setError(CANONICAL_VOICE_QUEUE_ERROR);
        return undefined;
      }
      const optimistic =
        existingProjection?.message ?? canonicalVoiceOptimisticMessage(chat.id, content);
      let resolveOutcome: (outcome: SendMessageOutcome) => void = () => undefined;
      const promise = new Promise<SendMessageOutcome>((resolve) => {
        resolveOutcome = resolve;
      });
      const item: CanonicalVoiceQueueItem = {
        key,
        content,
        contentDigest,
        clientTurnId,
        target: {
          chat,
          project,
          modelId,
          memory: buildMemoryRequest(chat, project, "voice"),
          // #2843 — snapshot the staged attachments with the rest of the immutable target so the
          // spoken turn carries the files the user had staged when the transcript settled, not
          // whatever the composer happens to hold whenever the FIFO drains.
          attachments: pendingAttachmentsRef.current,
        },
        optimistic,
        byteLength,
        promise,
        resolve: resolveOutcome,
      };
      canonicalVoiceDeliveriesRef.current.set(key, { contentDigest, promise });
      canonicalVoiceQueueRef.current.push(item);
      canonicalVoicePageOutbox.queueBytesRef.current += byteLength;
      if (existingProjection === undefined) {
        canonicalVoiceProjectionRef.current.set(key, {
          chatId: chat.id,
          content,
          message: optimistic,
          byteLength,
        });
        canonicalVoiceProjectionBytesRef.current += byteLength;
      }
      setError(undefined);
      setState((previous) =>
        previous.activeChat?.id !== chat.id ||
        previous.messages.some((message) => message.id === optimistic.id)
          ? previous
          : { ...previous, messages: [...previous.messages, optimistic] },
      );
      if (!canonicalVoicePageOutboxSuspended()) void drainCanonicalVoiceQueue();
      return promise;
    },
    [
      buildMemoryRequest,
      canonicalVoiceDeliveriesRef,
      canonicalVoiceProjectionBytesRef,
      canonicalVoiceProjectionRef,
      canonicalVoiceQueueRef,
      canonicalVoiceSettledRef,
      drainCanonicalVoiceQueue,
    ],
  );

  const retryPendingCanonicalVoiceTurn = useCallback((): void => {
    if (!canonicalVoicePageOutboxSuspended() || canonicalVoiceQueueRef.current.length === 0) return;
    setError(undefined);
    setCanonicalVoicePageOutboxSuspended(undefined);
    void drainCanonicalVoiceQueue();
  }, [canonicalVoiceQueueRef, drainCanonicalVoiceQueue]);

  const discardPendingCanonicalVoiceTurn = useCallback((): void => {
    const chatId = activeChatIdRef.current;
    if (chatId === undefined) return;
    const { discarded, ownedActiveDelivery } = discardCanonicalVoicePageOutboxChat(chatId);
    if (!discarded) return;
    // Reached only when the discard took the turn whose request is on the wire (the wedged case has
    // no delivery in flight). Scoped to that turn: the interrupt is a no-op unless Voice still owns
    // the send, so a typed composer send is never touched.
    if (ownedActiveDelivery) interruptCanonicalVoiceDelivery();
    setError(undefined);
    // A head-of-line wedge in another chat leaves the outbox suspended and this drain returns
    // immediately; otherwise the queue resumes with the remaining turns.
    void drainCanonicalVoiceQueue();
  }, [drainCanonicalVoiceQueue, interruptCanonicalVoiceDelivery]);

  const canonicalVoiceCaptureMustPause = useCallback((): boolean => {
    return canonicalVoiceQueueRef.current.length >= CANONICAL_VOICE_QUEUE_REGULAR_MAX_ITEMS;
  }, [canonicalVoiceQueueRef]);

  // #2842 — the outbox suspends page-wide because its FIFO is page-wide, but the composer gate is
  // per chat: only a conversation that still owns a queued spoken turn is asked to retry or discard.
  // Every other chat keeps a live composer. The status object's revision is what makes a membership
  // change (an enqueue here, a discard elsewhere) publish a fresh identity and re-derive this gate.
  const canonicalVoiceTurnRequiresRetry =
    canonicalVoiceOutboxStatus.suspendedChatId !== undefined &&
    state.activeChat !== undefined &&
    canonicalVoicePageOutboxHasPendingTurn(state.activeChat.id);

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
      sendControllerOwnerRef.current = "composer";
      latestSendSignalRef.current = controller.signal;
      try {
        updateOwnedSendStatus(controller.signal, "contacting");
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
          updateOwnedSendStatus(controller.signal, "cancelled");
          return;
        }
        if (activeChatIdRef.current !== chat.id) return;
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
        updateOwnedSendStatus(controller.signal, "completed");
      } catch (error_) {
        if (error_ instanceof DOMException && error_.name === "AbortError") {
          updateOwnedSendStatus(controller.signal, "cancelled");
          return;
        }
        if (latestSendSignalRef.current === controller.signal) setError(errorMessage(error_));
        updateOwnedSendStatus(controller.signal, "failed");
      } finally {
        if (sendControllerRef.current === controller) {
          sendControllerRef.current = null;
          sendControllerOwnerRef.current = null;
        }
        if (latestSendSignalRef.current === controller.signal) {
          latestSendSignalRef.current = null;
          setRegeneratingMessageId(undefined);
        }
      }
    },
    [
      state.activeChat,
      state.activeProject,
      state.selectedModel,
      state.models,
      buildMemoryRequest,
      updateOwnedSendStatus,
      updateSendStatus,
    ],
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
  const clearNotice = useCallback((): void => {
    setNotice(undefined);
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
      notice,
      clearError,
      clearNotice,
      setDraft,
      setSelectedModel,
      openNewChat,
      openProject,
      openChat,
      addProject,
      sendMessage,
      enqueueCanonicalVoiceTurn,
      canonicalVoiceCaptureMustPause,
      canonicalVoiceTurnRequiresRetry,
      retryPendingCanonicalVoiceTurn,
      discardPendingCanonicalVoiceTurn,
      interruptCanonicalVoiceDelivery,
      regenerateMessage,
      cancelSend,
      replaceChat,
      latestGrounded,
      cancelGrounded,
      pendingAttachments,
      addPendingAttachment,
      removePendingAttachment,
      clearPendingAttachments,
      lastSentDocuments,
      lastSentImages,
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
      notice,
      clearError,
      clearNotice,
      setSelectedModel,
      openNewChat,
      openProject,
      openChat,
      addProject,
      sendMessage,
      enqueueCanonicalVoiceTurn,
      canonicalVoiceCaptureMustPause,
      canonicalVoiceTurnRequiresRetry,
      retryPendingCanonicalVoiceTurn,
      discardPendingCanonicalVoiceTurn,
      interruptCanonicalVoiceDelivery,
      regenerateMessage,
      cancelSend,
      replaceChat,
      latestGrounded,
      cancelGrounded,
      pendingAttachments,
      addPendingAttachment,
      removePendingAttachment,
      clearPendingAttachments,
      lastSentDocuments,
      lastSentImages,
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
