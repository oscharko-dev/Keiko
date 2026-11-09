import {
  isJiraOperationBinding,
  jiraOperationActionDigest,
  type JiraOperationBinding,
} from "../atlassian/jiraOperationRegistry.js";
import { jiraMutationToolId } from "../atlassian/jiraMutationToolId.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChatToolBatchProgress,
  ChatToolExchange,
  ChatToolTranscript,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  CHAT_TOOL_BATCH_TOOL_NAME,
  isChatToolBatchProgress,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isChatToolReadGrantView,
  isChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts/runtime/desktop-chat-stream-wire";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts";
import {
  isJiraHumanInputView,
  type JiraHumanInputView,
  JIRA_MUTATION_OUTCOMES,
  JIRA_MUTATION_OPERATIONS,
  JIRA_MANAGED_READ_TOOLS,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  ToolDescriptor,
  ToolResultEnvelope,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, deepRedactStrings, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  captureCatalogJson,
  validateToolResultEnvelope,
  verifyToolDescriptor,
  type ToolResultValidationBinding,
} from "@oscharko-dev/keiko-tool-catalog";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { processServerLogSink } from "../process-log-sink.js";
import { CHAT_TOOL_TURN_BUDGET } from "../chat-tool-turn-budget.js";
import { admitsApprovalTransition, admitsFirstApproval } from "./chatToolApprovalTransition.js";
import { invalidRequest, notFound } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";

export type ChatToolTranscriptUpdate =
  | { readonly kind: "human-input"; readonly callId: string; readonly view: JiraHumanInputView }
  | {
      /** An observed native Coding result: start and settlement are one existing-store transaction. */
      readonly kind: "captured";
      readonly call: ChatToolExchange["call"];
      readonly operationBinding?: JiraOperationBinding;
      readonly nativeArgumentsDigest?: string;
      readonly result: ToolResultEnvelope;
      readonly binding: ToolResultValidationBinding;
      readonly mutationOutcome?: JiraMutationOutcome;
    }
  | {
      readonly kind: "started";
      readonly call: ChatToolExchange["call"];
      readonly operationBinding?: JiraOperationBinding;
      /** Existing Coding invocation digest, before protected-input waiting; never a result. */
      readonly nativeArgumentsDigest?: string;
    }
  | { readonly kind: "write-prepared"; readonly callId: string; readonly sourceDigest: string }
  | {
      readonly kind: "settled";
      readonly callId: string;
      readonly result: ToolResultEnvelope;
      readonly binding?: ToolResultValidationBinding;
      readonly mutationOutcome?: JiraMutationOutcome;
      readonly draftProgress?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Counted progress of the running draft batch call; retained when the call settles. */
      readonly kind: "progress";
      readonly callId: string;
      readonly batchProgress: ChatToolBatchProgress;
    }
  | { readonly kind: "read-consent"; readonly grant: ChatToolReadGrantView }
  | {
      readonly kind: "write-approval";
      readonly callId: string;
      readonly approval: ChatToolWriteApprovalView;
      readonly operationBinding?: JiraOperationBinding;
    };
interface StoredExchange extends ChatToolExchange {
  /** Immutable private snapshot; history does not depend on the installed registry version. */
  readonly operationBinding?: JiraOperationBinding;
  readonly sourceDigest?: string;
  readonly nativeArgumentsDigest?: string;
  readonly resultBinding?: ToolResultValidationBinding;
}
interface StoredTranscript extends ChatToolTranscript {
  readonly exchanges: readonly StoredExchange[];
}
// One exchange per tool call the turn's Authority Envelope admits (#4175).
const MAX_EXCHANGES = CHAT_TOOL_TURN_BUDGET.maxToolCalls;
const MAX_TRANSCRIPT_BYTES = 16_777_216;
// The envelope, approval view, mutation outcome and grant share one exchange adds beside its
// call, bounded result and descriptor binding; generous so the reservation is an upper bound.
const EXCHANGE_OVERHEAD_BYTES = 16_384;
/**
 * The stored transcript's byte bound, and the share its schema and read grants hold (#4175). A
 * turn reserves each exchange's worst case before it starts, so it ends as budget-exhausted
 * instead of starting a call whose result could not be persisted.
 */
export const CHAT_TOOL_TRANSCRIPT_MAX_BYTES = MAX_TRANSCRIPT_BYTES;
export const CHAT_TOOL_TRANSCRIPT_BASE_BYTES = 65_536;
export function chatToolExchangeReservation(
  call: ChatToolExchange["call"],
  descriptor: ToolDescriptor,
): number {
  return (
    Buffer.byteLength(JSON.stringify(call)) +
    descriptor.bounds.maxResultBytes +
    Buffer.byteLength(JSON.stringify(descriptor)) +
    EXCHANGE_OVERHEAD_BYTES
  );
}

/** Body-free occupancy for the existing transcript reservation owner, before native dispatch. */
export function chatToolTranscriptOccupancy(
  db: DatabaseSync,
  messageId: string,
): { readonly bytes: number; readonly exchangeCount: number } {
  const row = db
    .prepare(
      "SELECT chat_id, tool_transcript_json, client_turn_state FROM chat_messages WHERE id=? AND role='user'",
    )
    .get(messageId);
  if (row === undefined || typeof row.chat_id !== "string") throw notFound("Message");
  if (row.client_turn_state !== null && row.client_turn_state !== "pending")
    throw invalidRequest("Tool turn is no longer pending.");
  if (row.tool_transcript_json === null) return { bytes: 0, exchangeCount: 0 };
  if (typeof row.tool_transcript_json !== "string") throw invalidTranscript();
  const transcript = decodeStoredTranscript(row.tool_transcript_json, {
    chatId: row.chat_id,
    messageId,
  });
  if (transcript === undefined) throw invalidTranscript();
  return {
    bytes: Buffer.byteLength(row.tool_transcript_json),
    exchangeCount: transcript.exchanges.length,
  };
}
const UPDATE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-transcript.updated",
  category: "process",
  owner: "keiko-server",
  emitter: "store.chatToolTranscript.updateChatToolTranscript",
  fields: {
    messageDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "started",
        "captured",
        "write-prepared",
        "settled",
        "progress",
        "read-consent",
        "write-approval",
        "human-input",
      ],
    },
    batchPhase: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["outlining", "drafting", "complete"],
    },
    batchDraftedCount: { type: "integer", dataClass: "count", required: false },
    batchPlannedCount: { type: "integer", dataClass: "count", required: false },
    batchFailedCount: { type: "integer", dataClass: "count", required: false },
    exchangeCount: { type: "integer", dataClass: "count", required: true },
    draftReceiptCount: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-transcript.updated.line"],
  releaseImpact: "minor",
});
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
/** Current calls retain the previous reader's three keys; legacy provenance is never rewritten. */
function canonicalCall(call: ChatToolExchange["call"]): ChatToolExchange["call"] {
  return { id: call.id, name: call.name, arguments: call.arguments };
}
function encodeTranscript(transcript: StoredTranscript): string {
  return JSON.stringify({
    ...transcript,
    exchanges: transcript.exchanges.map((exchange) => ({
      ...exchange,
      call: canonicalCall(exchange.call),
    })),
  });
}
function validCall(value: unknown): value is ChatToolExchange["call"] {
  return (
    object(value) &&
    exact(value, ["id", "name", "arguments", "origin"]) &&
    (value.origin === undefined || value.origin === "runtime") &&
    typeof value.id === "string" &&
    /^[\w-]{1,128}$/.test(value.id) &&
    typeof value.name === "string" &&
    /^[\w.-]{1,128}$/.test(value.name) &&
    object(value.arguments) &&
    object(captureCatalogJson(value.arguments, 262_144))
  );
}
interface TranscriptIdentity {
  readonly messageId: string;
  readonly chatId: string;
}
const MUTATION_ALIASES = new Map<string, string>(
  JIRA_MUTATION_OPERATIONS.map((operation) => [
    operation.replace(/[.-]/gu, "_"),
    jiraMutationToolId(operation),
  ]),
);
function approvalActionDigest(
  approval: ChatToolWriteApprovalView,
  argumentsDigest: string,
  operationBinding?: JiraOperationBinding,
  sourceDigest?: string,
  humanInputRevision?: string,
): string {
  return approval.kind === "jira-chat-write"
    ? jiraOperationActionDigest(
        approval.operation,
        argumentsDigest,
        operationBinding,
        sourceDigest,
        humanInputRevision,
      )
    : sha256Hex(canonicalise({ operation: approval.operation, argumentsDigest }));
}
function matchesApprovalCall(
  approval: ChatToolWriteApprovalView,
  call: ChatToolExchange["call"],
  identity: TranscriptIdentity,
  operationBinding?: JiraOperationBinding,
  sourceDigest?: string,
  humanInputRevision?: string,
): boolean {
  return (
    (approval.kind === "jira-chat-write" ||
      (operationBinding === undefined && sourceDigest === undefined)) &&
    approval.chatId === identity.chatId &&
    approval.invocationId ===
      sha256Hex(canonicalise({ messageId: identity.messageId, callId: call.id })) &&
    call.name === approval.operation.replace(/[.-]/gu, "_") &&
    approval.actionDigest ===
      approvalActionDigest(
        approval,
        sha256Hex(canonicalise(call.arguments)),
        operationBinding,
        sourceDigest,
        humanInputRevision,
      )
  );
}
function validNativeArgumentsDigest(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
  binding: unknown,
): boolean {
  return (
    value.nativeArgumentsDigest === undefined ||
    (validSourceDigest(value.nativeArgumentsDigest) &&
      binding !== undefined &&
      call.id.startsWith("mcp-"))
  );
}
function validPrivateBindings(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
): value is Record<string, unknown> & {
  operationBinding?: JiraOperationBinding;
  sourceDigest?: string;
} {
  const binding = value.operationBinding;
  if (binding !== undefined && !isJiraOperationBinding(binding)) return false;
  if (binding !== undefined && !MUTATION_ALIASES.has(call.name)) return false;
  if (!validNativeArgumentsDigest(value, call, binding)) return false;
  if (
    value.sourceDigest !== undefined &&
    (!validSourceDigest(value.sourceDigest) ||
      binding === undefined ||
      !MUTATION_ALIASES.has(call.name))
  )
    return false;
  return true;
}
function validApproval(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
  identity: TranscriptIdentity | undefined,
): boolean {
  if (!validPrivateBindings(value, call)) return false;
  if (value.approval === undefined) return true;
  return (
    isChatToolWriteApprovalView(value.approval) &&
    identity !== undefined &&
    matchesApprovalCall(
      value.approval,
      call,
      identity,
      value.operationBinding,
      value.sourceDigest,
      isJiraHumanInputView(value.humanInput) ? value.humanInput.revision : undefined,
    )
  );
}

function isMcpMutationProjection(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
  canonicalId: unknown,
): boolean {
  if (
    !call.name.startsWith("mcp_") ||
    typeof canonicalId !== "string" ||
    !/^keiko\.mcp\.t[a-f0-9]{64}$/u.test(canonicalId) ||
    !object(value.resultBinding)
  )
    return false;
  const descriptor = verifyToolDescriptor(value.resultBinding.descriptor);
  return (
    descriptor.toolRef.canonicalId === canonicalId &&
    descriptor.actionMapping.some((mapping) => mapping.action === call.name)
  );
}
function validMutationProjection(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
): boolean {
  if (value.mutationOutcome === undefined) return true;
  const result = value.result;
  return (
    object(result) &&
    object(result.toolRef) &&
    (MUTATION_ALIASES.get(call.name) === result.toolRef.canonicalId ||
      isMcpMutationProjection(value, call, result.toolRef.canonicalId)) &&
    (JIRA_MUTATION_OUTCOMES as readonly unknown[]).includes(value.mutationOutcome)
  );
}
function validEffectProjections(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
  identity: TranscriptIdentity | undefined,
): boolean {
  return validApproval(value, call, identity) && validMutationProjection(value, call);
}
function validResultBinding(value: Record<string, unknown>): boolean {
  return (
    value.resultBinding === undefined ||
    (object(value.resultBinding) && exact(value.resultBinding, ["descriptor", "projectionDigest"]))
  );
}
function validStoredResult(value: Record<string, unknown>): boolean {
  if (value.result !== undefined)
    validateToolResultEnvelope(
      value.result,
      value.resultBinding as ToolResultValidationBinding | undefined,
    );
  else if (value.resultBinding !== undefined) return false;
  return true;
}
function validExchange(
  value: unknown,
  identity: TranscriptIdentity | undefined,
): value is StoredExchange {
  if (
    !object(value) ||
    !exact(value, [
      "call",
      "result",
      "resultBinding",
      "approval",
      "operationBinding",
      "sourceDigest",
      "nativeArgumentsDigest",
      "mutationOutcome",
      "draftProgress",
      "humanInput",
      "batchProgress",
    ]) ||
    !validCall(value.call)
  )
    return false;
  if (!validEffectProjections(value, value.call, identity)) return false;
  if (value.humanInput !== undefined && !validHumanInput(value.humanInput, value.call))
    return false;
  if (!validResultBinding(value)) return false;
  if (!validStoredResult(value)) return false;
  if (value.draftProgress !== undefined) validateDraftProgress(value as unknown as StoredExchange);
  return validBatchProgress(value, value.call);
}
/** Batch progress belongs to the draft batch call alone and stays a closed, bounded record. */
function validBatchProgress(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
): boolean {
  return (
    value.batchProgress === undefined ||
    (call.name === CHAT_TOOL_BATCH_TOOL_NAME && isChatToolBatchProgress(value.batchProgress))
  );
}
function validReadGrants(
  value: Record<string, unknown>,
  identity: TranscriptIdentity | undefined,
): boolean {
  const valid = (grant: unknown): grant is ChatToolReadGrantView =>
    isChatToolReadGrantView(grant) && (identity === undefined || grant.chatId === identity.chatId);
  if (value.readGrant !== undefined && !valid(value.readGrant)) return false;
  if (value.readGrants === undefined) return true;
  if (
    !Array.isArray(value.readGrants) ||
    value.readGrants.length > 2 ||
    !value.readGrants.every(valid)
  )
    return false;
  const grants = value.readGrants;
  return (
    new Set(grants.map((grant) => grant.kind)).size === grants.length &&
    new Set(grants.map((grant) => grant.grantId)).size === grants.length &&
    (value.readGrant === undefined ||
      grants.some((grant) => canonicalise(grant) === canonicalise(value.readGrant)))
  );
}

function validTranscript(
  value: unknown,
  identity: TranscriptIdentity | undefined,
): value is StoredTranscript {
  if (!object(value) || !exact(value, ["schemaVersion", "exchanges", "readGrant", "readGrants"]))
    return false;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.exchanges) ||
    value.exchanges.length > MAX_EXCHANGES
  )
    return false;
  if (!value.exchanges.every((exchange: unknown) => validExchange(exchange, identity)))
    return false;
  return (
    new Set(value.exchanges.map((exchange: ChatToolExchange) => exchange.call.id)).size ===
      value.exchanges.length && validReadGrants(value, identity)
  );
}
export function decodeChatToolTranscript(
  json: string | null,
  identity?: TranscriptIdentity,
): ChatToolTranscript | undefined {
  return decodeChatToolTranscriptForHistory(json, identity).transcript;
}

/** Private history qualification stays beside the public projection, never inside its wire data. */
export function decodeChatToolTranscriptForHistory(
  json: string | null,
  identity?: TranscriptIdentity,
): {
  readonly transcript: ChatToolTranscript | undefined;
  readonly operationBindings: ReadonlyMap<string, JiraOperationBinding>;
  readonly sourceDigests: ReadonlyMap<string, string>;
  readonly nativeArgumentsDigests: ReadonlyMap<string, string>;
} {
  const stored = decodeStoredTranscript(json, identity);
  return {
    transcript: projectStoredTranscript(stored),
    operationBindings: new Map(
      stored?.exchanges.flatMap((exchange) =>
        exchange.operationBinding === undefined
          ? []
          : [[exchange.call.id, exchange.operationBinding] as const],
      ) ?? [],
    ),
    sourceDigests: new Map(
      stored?.exchanges.flatMap((exchange) =>
        exchange.sourceDigest === undefined
          ? []
          : [[exchange.call.id, exchange.sourceDigest] as const],
      ) ?? [],
    ),
    nativeArgumentsDigests: new Map(
      stored?.exchanges.flatMap((exchange) =>
        exchange.nativeArgumentsDigest === undefined
          ? []
          : [[exchange.call.id, exchange.nativeArgumentsDigest] as const],
      ) ?? [],
    ),
  };
}

function projectStoredTranscript(
  stored: StoredTranscript | undefined,
): ChatToolTranscript | undefined {
  return stored === undefined
    ? undefined
    : {
        ...stored,
        exchanges: stored.exchanges.map(
          ({
            call,
            result,
            approval,
            mutationOutcome,
            draftProgress,
            batchProgress,
            humanInput,
          }) => ({
            call: canonicalCall(call),
            ...(result === undefined ? {} : { result }),
            ...(draftProgress === undefined ? {} : { draftProgress }),
            ...(batchProgress === undefined ? {} : { batchProgress }),
            ...(approval === undefined ? {} : { approval }),
            ...(humanInput === undefined ? {} : { humanInput }),
            ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
          }),
        ),
      };
}
// Fingerprints of stored transcripts this process already verified under the same identity. The
// verdict is a pure function of the stored text and its identity, and every read of a message
// decodes its whole transcript: re-verifying each exchange's descriptor and result envelope on every
// read made a turn quadratic in its tool calls (35 reads took 15 s under coverage in CI). A hit
// still parses the text afresh, so no caller shares a decoded object; any byte change misses.
const VERIFIED_TRANSCRIPTS_MAX = 1024;
const verifiedTranscripts = new Set<string>();
function verifiedFingerprint(json: string, identity: TranscriptIdentity | undefined): string {
  return sha256Hex(`${identity?.chatId ?? ""}\u0000${identity?.messageId ?? ""}\u0000${json}`);
}
function rememberVerified(fingerprint: string): void {
  if (verifiedTranscripts.size >= VERIFIED_TRANSCRIPTS_MAX) {
    const oldest = verifiedTranscripts.values().next();
    if (oldest.done !== true) verifiedTranscripts.delete(oldest.value);
  }
  verifiedTranscripts.add(fingerprint);
}
function decodeStoredTranscript(
  json: string | null,
  identity: TranscriptIdentity | undefined,
): StoredTranscript | undefined {
  if (json === null) return undefined;
  try {
    if (Buffer.byteLength(json) > MAX_TRANSCRIPT_BYTES)
      throw new TypeError("Chat tool transcript exceeds its byte limit");
    const fingerprint = verifiedFingerprint(json, identity);
    if (verifiedTranscripts.has(fingerprint)) return JSON.parse(json) as StoredTranscript;
    const parsed: unknown = JSON.parse(json);
    if (validTranscript(parsed, identity)) {
      rememberVerified(fingerprint);
      return parsed;
    }
  } catch {
    // Preserve the body-free failure for the existing store/route error boundary.
    throw invalidTranscript();
  }
  throw invalidTranscript();
}
function invalidTranscript(): TypeError {
  return new TypeError("Stored Chat tool transcript is invalid.");
}
function sameSettlement(
  existing: StoredExchange,
  update: Extract<ChatToolTranscriptUpdate, { kind: "settled" }>,
): boolean {
  return (
    existing.result === undefined ||
    (canonicalise(existing.result) === canonicalise(update.result) &&
      canonicalise(existing.resultBinding ?? null) === canonicalise(update.binding ?? null) &&
      existing.mutationOutcome === update.mutationOutcome &&
      canonicalise(existing.draftProgress ?? null) === canonicalise(update.draftProgress ?? null))
  );
}
function applyExchange(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "started" | "settled" }>,
): StoredTranscript {
  const id = update.kind === "started" ? update.call.id : update.callId;
  const existing = current.exchanges.find((exchange) => exchange.call.id === id);
  if (update.kind === "started") {
    if (existing !== undefined) {
      if (!sameStartedExchange(existing, update))
        throw invalidRequest("Tool call identity conflict.");
      return current;
    }
    return {
      ...current,
      exchanges: [
        ...current.exchanges,
        {
          call: update.call,
          ...(update.operationBinding === undefined
            ? {}
            : { operationBinding: update.operationBinding }),
          ...(update.nativeArgumentsDigest === undefined
            ? {}
            : { nativeArgumentsDigest: update.nativeArgumentsDigest }),
        },
      ],
    };
  }
  if (existing === undefined || !sameSettlement(existing, update))
    throw invalidRequest("Tool result identity conflict.");
  return {
    ...current,
    exchanges: current.exchanges.map((exchange) =>
      exchange.call.id === id
        ? {
            ...exchange,
            result: update.result,
            ...(update.draftProgress === undefined ? {} : { draftProgress: update.draftProgress }),
            ...(update.binding === undefined ? {} : { resultBinding: update.binding }),
            ...(update.mutationOutcome === undefined
              ? {}
              : { mutationOutcome: update.mutationOutcome }),
          }
        : exchange,
    ),
  };
}
function applyProgress(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "progress" }>,
): StoredTranscript {
  const existing = current.exchanges.find((exchange) => exchange.call.id === update.callId);
  // Progress describes a running call; a settled or foreign exchange is a conflict, not a no-op.
  if (
    existing?.call.name !== CHAT_TOOL_BATCH_TOOL_NAME ||
    existing.result !== undefined ||
    !isChatToolBatchProgress(update.batchProgress)
  )
    throw invalidRequest("Tool progress identity conflict.");
  return {
    ...current,
    exchanges: current.exchanges.map((exchange) =>
      exchange === existing ? { ...exchange, batchProgress: update.batchProgress } : exchange,
    ),
  };
}
function applyCaptured(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "captured" }>,
): StoredTranscript {
  const existing = current.exchanges.find((exchange) => exchange.call.id === update.call.id);
  if (existing !== undefined && existing.nativeArgumentsDigest !== update.nativeArgumentsDigest)
    throw invalidRequest("Native tool arguments conflict.");
  const started = applyExchange(current, {
    kind: "started",
    call: update.call,
    ...(update.operationBinding === undefined ? {} : { operationBinding: update.operationBinding }),
    ...(update.nativeArgumentsDigest === undefined
      ? {}
      : { nativeArgumentsDigest: update.nativeArgumentsDigest }),
  });
  const captured = {
    ...started,
    exchanges: started.exchanges.map((exchange) =>
      exchange.call.id === update.call.id && update.nativeArgumentsDigest !== undefined
        ? { ...exchange, nativeArgumentsDigest: update.nativeArgumentsDigest }
        : exchange,
    ),
  };
  return applyExchange(captured, {
    kind: "settled",
    callId: update.call.id,
    result: update.result,
    binding: update.binding,
    ...(update.mutationOutcome === undefined ? {} : { mutationOutcome: update.mutationOutcome }),
  });
}
function applyReadConsent(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "read-consent" }>,
  chatId: string,
): StoredTranscript {
  if (update.grant.chatId !== chatId) throw invalidRequest("Tool consent Chat mismatch.");
  const grants = current.readGrants ?? (current.readGrant === undefined ? [] : [current.readGrant]);
  const readGrants = grants.some((grant) => grant.kind === update.grant.kind)
    ? grants.map((grant) => (grant.kind === update.grant.kind ? update.grant : grant))
    : [...grants, update.grant];
  return { ...current, readGrant: update.grant, readGrants };
}
function applyUpdate(
  current: StoredTranscript,
  update: ChatToolTranscriptUpdate,
  chatId: string,
  messageId: string,
): StoredTranscript {
  if (update.kind === "captured") return applyCaptured(current, update);
  if (update.kind === "human-input") return applyHumanInput(current, update);
  if (update.kind === "write-prepared") return applyPrepared(current, update);
  if (update.kind === "progress") return applyProgress(current, update);
  if (update.kind === "write-approval") return applyApproval(current, update, chatId, messageId);
  if (update.kind !== "read-consent") return applyExchange(current, update);
  return applyReadConsent(current, update, chatId);
}

function validHumanInput(
  value: unknown,
  call: ChatToolExchange["call"],
): value is JiraHumanInputView {
  return isJiraHumanInputView(value) && call.name === `jira_${value.purpose.replaceAll("-", "_")}`;
}

function cancelledOrExpired(state: JiraHumanInputView["state"]): boolean {
  return state === "cancelled" || state === "expired";
}
/** An immutable request can advance once to ready, then only to a terminal state. */
function humanInputTransition(previous: JiraHumanInputView, next: JiraHumanInputView): boolean {
  if (
    previous.requestId !== next.requestId ||
    previous.purpose !== next.purpose ||
    previous.expiresAt !== next.expiresAt
  )
    return false;
  if (canonicalise(previous) === canonicalise(next)) return true;
  if (previous.state === "awaiting-input")
    return next.state === "ready" || cancelledOrExpired(next.state);
  return (
    previous.state === "ready" &&
    previous.revision === next.revision &&
    (next.state === "consumed" || cancelledOrExpired(next.state))
  );
}

function applyHumanInput(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "human-input" }>,
): StoredTranscript {
  const exchange = current.exchanges.find((entry) => entry.call.id === update.callId);
  if (
    exchange === undefined ||
    exchange.result !== undefined ||
    !validHumanInput(update.view, exchange.call)
  )
    throw invalidRequest("Private tool input identity conflict.");
  if (
    exchange.humanInput === undefined
      ? update.view.state !== "awaiting-input"
      : !humanInputTransition(exchange.humanInput, update.view)
  )
    throw invalidRequest("Private tool input state conflict.");
  return {
    ...current,
    exchanges: current.exchanges.map((entry) =>
      entry === exchange ? { ...entry, humanInput: update.view } : entry,
    ),
  };
}

function validSourceDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** The derived source payload is committed before review or effects, and can never be replaced. */
function applyPrepared(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "write-prepared" }>,
): StoredTranscript {
  const exchange = current.exchanges.find((entry) => entry.call.id === update.callId);
  if (exchange?.operationBinding === undefined || !MUTATION_ALIASES.has(exchange.call.name))
    throw invalidRequest("Tool source identity conflict.");
  if (exchange.sourceDigest !== undefined) {
    if (exchange.sourceDigest !== update.sourceDigest)
      throw invalidRequest("Tool source identity conflict.");
    return current;
  }
  if (exchange.approval !== undefined || exchange.result !== undefined)
    throw invalidRequest("Tool source identity conflict.");
  return {
    ...current,
    exchanges: current.exchanges.map((entry) =>
      entry === exchange ? { ...entry, sourceDigest: update.sourceDigest } : entry,
    ),
  };
}

function applyApproval(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "write-approval" }>,
  chatId: string,
  messageId: string,
): StoredTranscript {
  const exchange = current.exchanges.find((entry) => entry.call.id === update.callId);
  const approval = update.approval;
  const operationBinding = update.operationBinding ?? exchange?.operationBinding;
  if (
    exchange === undefined ||
    (exchange.operationBinding !== undefined &&
      canonicalise(exchange.operationBinding) !== canonicalise(operationBinding)) ||
    !matchesApprovalCall(
      approval,
      exchange.call,
      { messageId, chatId },
      operationBinding,
      exchange.sourceDigest,
      exchange.humanInput?.revision,
    )
  )
    throw invalidRequest("Tool approval identity conflict.");
  const admitted =
    exchange.approval === undefined
      ? admitsFirstApproval(approval)
      : admitsApprovalTransition(exchange.approval, approval, exchange.call);
  if (!admitted) throw invalidRequest("Tool approval identity conflict.");
  return {
    ...current,
    exchanges: current.exchanges.map((entry) =>
      entry === exchange
        ? {
            ...entry,
            approval,
            ...(operationBinding === undefined ? {} : { operationBinding: operationBinding }),
          }
        : entry,
    ),
  };
}
function observedMutation(outcome: StoredExchange["mutationOutcome"]): boolean {
  return outcome !== undefined && outcome !== "not-dispatched";
}
type DraftProgressData = Pick<
  StoredExchange,
  "result" | "resultBinding" | "mutationOutcome" | "draftProgress"
>;
/** Payload/schema validation makes no claim about the call that owns this receipt. */
function validateDraftProgressData(exchange: DraftProgressData): void {
  const result = exchange.result;
  const binding = exchange.resultBinding;
  if (
    result?.data !== null ||
    !result.effectStarted ||
    result.toolRef?.canonicalId !== "keiko.jira.draft" ||
    binding === undefined ||
    !observedMutation(exchange.mutationOutcome)
  )
    throw invalidRequest("Invalid draft receipt binding.");
  const data = captureCatalogJson(exchange.draftProgress, binding.descriptor.bounds.maxResultBytes);
  const validated = validateToolResultEnvelope(
    {
      ...result,
      status: "completed",
      reason: "none",
      data,
      metrics: {
        ...result.metrics,
        outputBytes: Buffer.byteLength(JSON.stringify(data)),
        resultCount: 0,
      },
      page: { truncated: false, reason: "none", cursor: null },
    },
    binding,
  );
  if (validated.data === null) throw invalidRequest("Invalid draft receipt data.");
}

/** Ownership is checked against the actual stored call before the transaction commits. */
function validateDraftProgress(exchange: StoredExchange): void {
  if (exchange.call.name !== "jira_draft") throw invalidRequest("Invalid draft receipt binding.");
  validateDraftProgressData(exchange);
}
function redactResult(
  update: Extract<ChatToolTranscriptUpdate, { kind: "settled" | "captured" }>,
  redact: (value: string) => string,
): ToolResultEnvelope {
  const verified = validateToolResultEnvelope(update.result, update.binding);
  const data = deepRedactStrings(verified.data, redact);
  const metrics = {
    ...verified.metrics,
    outputBytes: data === null ? 0 : Buffer.byteLength(JSON.stringify(data)),
  };
  return validateToolResultEnvelope({ ...verified, data, metrics }, update.binding);
}
function redactDraftProgress(
  update: Extract<ChatToolTranscriptUpdate, { kind: "settled" }>,
  redact: (value: string) => string,
): Readonly<Record<string, unknown>> | undefined {
  const redactedProgress =
    update.draftProgress === undefined
      ? undefined
      : deepRedactStrings(update.draftProgress, redact);
  if (redactedProgress !== undefined && !object(redactedProgress))
    throw invalidRequest("Invalid draft receipt data.");
  const draftProgress = redactedProgress;
  if (draftProgress !== undefined)
    validateDraftProgressData({
      result: update.result,
      ...(update.binding === undefined ? {} : { resultBinding: update.binding }),
      ...(update.mutationOutcome === undefined ? {} : { mutationOutcome: update.mutationOutcome }),
      draftProgress,
    });
  return draftProgress;
}
function redactSettlement(
  update: Extract<ChatToolTranscriptUpdate, { kind: "settled" }>,
  redact: (value: string) => string,
): ChatToolTranscriptUpdate {
  const draftProgress = redactDraftProgress(update, redact);
  return {
    ...update,
    result: redactResult(update, redact),
    ...(draftProgress === undefined ? {} : { draftProgress }),
    ...(update.binding === undefined
      ? {}
      : {
          binding: {
            ...update.binding,
            descriptor: verifyToolDescriptor(update.binding.descriptor),
          },
        }),
  };
}
function sameStartedExchange(
  existing: StoredExchange,
  update: Extract<ChatToolTranscriptUpdate, { kind: "started" }>,
): boolean {
  return (
    canonicalise(canonicalCall(existing.call)) === canonicalise(canonicalCall(update.call)) &&
    canonicalise(existing.operationBinding ?? null) ===
      canonicalise(update.operationBinding ?? null) &&
    existing.nativeArgumentsDigest === update.nativeArgumentsDigest
  );
}

function redactCall(
  update: Extract<ChatToolTranscriptUpdate, { kind: "started" | "captured" }>,
  redact: (value: string) => string,
): ChatToolExchange["call"] {
  const call = deepRedactStrings(update.call, redact);
  if (
    !validCall(call) ||
    (update.operationBinding !== undefined &&
      (!isJiraOperationBinding(update.operationBinding) || !MUTATION_ALIASES.has(call.name)))
  )
    throw invalidRequest("Invalid tool call.");
  return canonicalCall(call);
}

function redactStarted(
  update: Extract<ChatToolTranscriptUpdate, { kind: "started" }>,
  redact: (value: string) => string,
): ChatToolTranscriptUpdate {
  if (
    update.nativeArgumentsDigest !== undefined &&
    (!update.call.id.startsWith("mcp-") ||
      update.operationBinding === undefined ||
      update.nativeArgumentsDigest !== sha256Hex(canonicalise(update.call.arguments)))
  )
    throw invalidRequest("Invalid pending native tool identity.");
  return { ...update, call: redactCall(update, redact) };
}
function redactHumanInput(
  update: Extract<ChatToolTranscriptUpdate, { kind: "human-input" }>,
): ChatToolTranscriptUpdate {
  if (!isJiraHumanInputView(update.view)) throw invalidRequest("Invalid private input projection.");
  // Copy only the closed public DTO; no submission value may survive via an extra property.
  return {
    kind: "human-input",
    callId: update.callId,
    view: {
      ...update.view,
      fields: [...update.view.fields],
      optionalFields: [...update.view.optionalFields],
    },
  };
}
function redactStateUpdate(
  update: Exclude<
    ChatToolTranscriptUpdate,
    { kind: "started" | "captured" | "settled" | "human-input" }
  >,
): ChatToolTranscriptUpdate {
  if (update.kind === "write-prepared") {
    if (!validSourceDigest(update.sourceDigest))
      throw invalidRequest("Invalid tool source snapshot.");
    return update;
  }
  if (update.kind === "progress") {
    if (!isChatToolBatchProgress(update.batchProgress))
      throw invalidRequest("Invalid tool progress projection.");
    return { ...update, batchProgress: { ...update.batchProgress } };
  }
  if (update.kind === "write-approval") {
    if (
      !isChatToolWriteApprovalView(update.approval) ||
      (update.operationBinding !== undefined && !isJiraOperationBinding(update.operationBinding))
    )
      throw invalidRequest("Invalid tool approval projection.");
    return update;
  }
  if (!isChatToolReadGrantView(update.grant))
    throw invalidRequest("Invalid tool consent projection.");
  return update;
}
function redactUpdate(
  update: ChatToolTranscriptUpdate,
  redact: (value: string) => string,
): ChatToolTranscriptUpdate {
  if (update.kind === "started") return redactStarted(update, redact);
  if (update.kind === "captured") return redactCaptured(update, redact);
  if (update.kind === "settled") return redactSettlement(update, redact);
  if (update.kind === "human-input") return redactHumanInput(update);
  return redactStateUpdate(update);
}

function redactCaptured(
  update: Extract<ChatToolTranscriptUpdate, { kind: "captured" }>,
  redact: (value: string) => string,
): ChatToolTranscriptUpdate {
  if (
    !validCaptureKind(update) ||
    !update.call.id.startsWith("mcp-") ||
    update.result.invocationId !== update.call.id
  )
    throw invalidRequest("Invalid native tool capture identity.");
  return {
    ...update,
    call: redactCall(update, redact),
    result: redactResult(update, redact),
    binding: { ...update.binding, descriptor: verifyToolDescriptor(update.binding.descriptor) },
  };
}

function readCaptureIdentity(update: {
  readonly result: { readonly effectStarted: unknown };
  readonly nativeArgumentsDigest?: unknown;
  readonly operationBinding?: unknown;
  readonly mutationOutcome?: unknown;
}): boolean {
  return (
    update.result.effectStarted === false &&
    update.nativeArgumentsDigest === undefined &&
    update.operationBinding === undefined &&
    update.mutationOutcome === undefined
  );
}
function validCaptureKind(
  update: Extract<ChatToolTranscriptUpdate, { kind: "captured" }>,
): boolean {
  if (!MUTATION_ALIASES.has(update.call.name))
    return (
      JIRA_MANAGED_READ_TOOLS.some((tool) => tool.replace(/[.-]/gu, "_") === update.call.name) &&
      readCaptureIdentity(update)
    );
  return (
    update.nativeArgumentsDigest === sha256Hex(canonicalise(update.call.arguments)) &&
    update.operationBinding !== undefined &&
    update.mutationOutcome !== undefined
  );
}

function progressLogFields(update: ChatToolTranscriptUpdate): {
  batchPhase?: ChatToolBatchProgress["phase"];
  batchDraftedCount?: number;
  batchPlannedCount?: number;
  batchFailedCount?: number;
} {
  if (update.kind !== "progress") return {};
  const { phase, draftedCount, plannedCount, failedCount } = update.batchProgress;
  return {
    batchPhase: phase,
    batchDraftedCount: draftedCount,
    batchPlannedCount: plannedCount,
    batchFailedCount: failedCount,
  };
}
function draftReceiptLogFields(update: ChatToolTranscriptUpdate): { draftReceiptCount?: number } {
  if (update.kind !== "settled" || update.draftProgress === undefined) return {};
  return {
    draftReceiptCount: Array.isArray(update.draftProgress.items)
      ? update.draftProgress.items.length
      : 0,
  };
}
export function updateChatToolTranscript(
  db: DatabaseSync,
  id: string,
  update: ChatToolTranscriptUpdate,
  redact: (value: string) => string,
  correlationId: string,
): void {
  const count = withImmediateTransaction(db, () => {
    const row = db
      .prepare(
        "SELECT chat_id, tool_transcript_json, client_turn_state FROM chat_messages WHERE id = ? AND role = 'user'",
      )
      .get(id);
    if (row === undefined || typeof row.chat_id !== "string") throw notFound("Message");
    if (row.client_turn_state !== null && row.client_turn_state !== "pending")
      throw invalidRequest("Tool turn is no longer pending.");
    const current = decodeStoredTranscript(row.tool_transcript_json as string | null, {
      messageId: id,
      chatId: row.chat_id,
    }) ?? {
      schemaVersion: 1,
      exchanges: [],
    };
    const redacted = redactUpdate(update, redact);
    const next = applyUpdate(current, redacted, row.chat_id, id);
    const json = encodeTranscript(next);
    decodeChatToolTranscript(json, { messageId: id, chatId: row.chat_id });
    db.prepare("UPDATE chat_messages SET tool_transcript_json = ? WHERE id = ?").run(json, id);
    return next.exchanges.length;
  });
  processServerLogSink().write(
    activityLogEvent(
      UPDATE,
      { correlationId, level: "info" },
      {
        messageDigest: sha256Hex(id),
        phase: update.kind,
        exchangeCount: count,
        ...draftReceiptLogFields(update),
        ...progressLogFields(update),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
