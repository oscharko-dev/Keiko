import type { DatabaseSync } from "node:sqlite";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  isChatToolReadGrantView,
  isChatToolWriteApprovalView,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type {
  ChatToolReadGrantView,
  ChatToolWriteApprovalView,
  ChatToolWriteApprovalState,
} from "@oscharko-dev/keiko-contracts";
import {
  JIRA_MUTATION_OUTCOMES,
  JIRA_MUTATION_OPERATIONS,
  type JiraMutationOutcome,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
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
import { invalidRequest, notFound } from "./errors.js";
import { withImmediateTransaction } from "./transaction.js";

export type ChatToolTranscriptUpdate =
  | { readonly kind: "started"; readonly call: ChatToolExchange["call"] }
  | {
      readonly kind: "settled";
      readonly callId: string;
      readonly result: ToolResultEnvelope;
      readonly binding?: ToolResultValidationBinding;
      readonly mutationOutcome?: JiraMutationOutcome;
    }
  | { readonly kind: "read-consent"; readonly grant: ChatToolReadGrantView }
  | {
      readonly kind: "write-approval";
      readonly callId: string;
      readonly approval: ChatToolWriteApprovalView;
    };
interface StoredExchange extends ChatToolExchange {
  readonly resultBinding?: ToolResultValidationBinding;
}
interface StoredTranscript extends ChatToolTranscript {
  readonly exchanges: readonly StoredExchange[];
}
const MAX_EXCHANGES = 30;
const MAX_TRANSCRIPT_BYTES = 4_194_304;
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
      values: ["started", "settled", "read-consent", "write-approval"],
    },
    exchangeCount: { type: "integer", dataClass: "count", required: true },
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
function validCall(value: unknown): value is ChatToolExchange["call"] {
  return (
    object(value) &&
    exact(value, ["id", "name", "arguments"]) &&
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
    operation.replaceAll(".", "_"),
    `keiko.${operation}`,
  ]),
);
const APPROVAL_STATES: Readonly<
  Record<ChatToolWriteApprovalState, ReadonlySet<ChatToolWriteApprovalState>>
> = {
  pending: new Set(["pending", "approved", "claimed", "rejected", "expired", "revoked"]),
  approved: new Set(["approved", "claimed", "expired", "revoked"]),
  claimed: new Set(["claimed", "expired", "revoked"]),
  rejected: new Set(["rejected"]),
  expired: new Set(["expired"]),
  revoked: new Set(["revoked"]),
};
function matchesApprovalCall(
  approval: ChatToolWriteApprovalView,
  call: ChatToolExchange["call"],
  identity: TranscriptIdentity,
): boolean {
  return (
    approval.chatId === identity.chatId &&
    approval.invocationId ===
      sha256Hex(canonicalise({ messageId: identity.messageId, callId: call.id })) &&
    call.name === approval.operation.replaceAll(".", "_") &&
    approval.actionDigest ===
      sha256Hex(
        canonicalise({
          operation: approval.operation,
          argumentsDigest: sha256Hex(canonicalise(call.arguments)),
        }),
      )
  );
}
function validApproval(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
  identity: TranscriptIdentity | undefined,
): boolean {
  return (
    value.approval === undefined ||
    (isChatToolWriteApprovalView(value.approval) &&
      identity !== undefined &&
      matchesApprovalCall(value.approval, call, identity))
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
    MUTATION_ALIASES.get(call.name) === result.toolRef.canonicalId &&
    JIRA_MUTATION_OUTCOMES.some((outcome) => outcome === value.mutationOutcome)
  );
}
function validEffectProjections(
  value: Record<string, unknown>,
  call: ChatToolExchange["call"],
  identity: TranscriptIdentity | undefined,
): boolean {
  return validApproval(value, call, identity) && validMutationProjection(value, call);
}
function validExchange(
  value: unknown,
  identity: TranscriptIdentity | undefined,
): value is StoredExchange {
  if (
    !object(value) ||
    !exact(value, ["call", "result", "resultBinding", "approval", "mutationOutcome"]) ||
    !validCall(value.call)
  )
    return false;
  if (!validEffectProjections(value, value.call, identity)) return false;
  if (
    value.resultBinding !== undefined &&
    (!object(value.resultBinding) ||
      !exact(value.resultBinding, ["descriptor", "projectionDigest"]))
  )
    return false;
  if (value.result !== undefined)
    validateToolResultEnvelope(
      value.result,
      value.resultBinding as ToolResultValidationBinding | undefined,
    );
  else if (value.resultBinding !== undefined) return false;
  return true;
}
function validTranscript(
  value: unknown,
  identity: TranscriptIdentity | undefined,
): value is StoredTranscript {
  if (!object(value) || !exact(value, ["schemaVersion", "exchanges", "readGrant"])) return false;
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
      value.exchanges.length &&
    (value.readGrant === undefined || isChatToolReadGrantView(value.readGrant))
  );
}
export function decodeChatToolTranscript(
  json: string | null,
  identity?: TranscriptIdentity,
): ChatToolTranscript | undefined {
  const stored = decodeStoredTranscript(json, identity);
  return stored === undefined
    ? undefined
    : {
        ...stored,
        exchanges: stored.exchanges.map(({ call, result, approval, mutationOutcome }) => ({
          call,
          ...(result === undefined ? {} : { result }),
          ...(approval === undefined ? {} : { approval }),
          ...(mutationOutcome === undefined ? {} : { mutationOutcome }),
        })),
      };
}
function decodeStoredTranscript(
  json: string | null,
  identity: TranscriptIdentity | undefined,
): StoredTranscript | undefined {
  if (json === null) return undefined;
  try {
    if (Buffer.byteLength(json) > MAX_TRANSCRIPT_BYTES) throw new TypeError();
    const parsed: unknown = JSON.parse(json);
    if (validTranscript(parsed, identity)) return parsed;
  } catch {
    /* Closed, body-free corruption result below. */
  }
  throw new TypeError("Stored Chat tool transcript is invalid.");
}
function sameSettlement(
  existing: StoredExchange,
  update: Extract<ChatToolTranscriptUpdate, { kind: "settled" }>,
): boolean {
  return (
    existing.result === undefined ||
    (canonicalise(existing.result) === canonicalise(update.result) &&
      canonicalise(existing.resultBinding ?? null) === canonicalise(update.binding ?? null) &&
      existing.mutationOutcome === update.mutationOutcome)
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
      if (canonicalise(existing.call) !== canonicalise(update.call))
        throw invalidRequest("Tool call identity conflict.");
      return current;
    }
    return { ...current, exchanges: [...current.exchanges, { call: update.call }] };
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
            ...(update.binding === undefined ? {} : { resultBinding: update.binding }),
            ...(update.mutationOutcome === undefined
              ? {}
              : { mutationOutcome: update.mutationOutcome }),
          }
        : exchange,
    ),
  };
}
function applyUpdate(
  current: StoredTranscript,
  update: ChatToolTranscriptUpdate,
  chatId: string,
  messageId: string,
): StoredTranscript {
  if (update.kind === "write-approval") return applyApproval(current, update, chatId, messageId);
  if (update.kind !== "read-consent") return applyExchange(current, update);
  if (update.grant.chatId !== chatId) throw invalidRequest("Tool consent Chat mismatch.");
  return { ...current, readGrant: update.grant };
}

function applyApproval(
  current: StoredTranscript,
  update: Extract<ChatToolTranscriptUpdate, { kind: "write-approval" }>,
  chatId: string,
  messageId: string,
): StoredTranscript {
  const exchange = current.exchanges.find((entry) => entry.call.id === update.callId);
  const approval = update.approval;
  if (
    exchange === undefined ||
    !matchesApprovalCall(approval, exchange.call, { messageId, chatId })
  )
    throw invalidRequest("Tool approval identity conflict.");
  if (
    exchange.approval !== undefined &&
    (canonicalise({ ...exchange.approval, state: "pending" }) !==
      canonicalise({ ...approval, state: "pending" }) ||
      !APPROVAL_STATES[exchange.approval.state].has(approval.state))
  )
    throw invalidRequest("Tool approval identity conflict.");
  return {
    ...current,
    exchanges: current.exchanges.map((entry) =>
      entry === exchange ? { ...entry, approval } : entry,
    ),
  };
}
function redactResult(
  update: Extract<ChatToolTranscriptUpdate, { kind: "settled" }>,
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
function redactUpdate(
  update: ChatToolTranscriptUpdate,
  redact: (value: string) => string,
): ChatToolTranscriptUpdate {
  if (update.kind === "started") {
    const call = deepRedactStrings(update.call, redact);
    if (!validCall(call)) throw invalidRequest("Invalid tool call.");
    return { kind: "started", call };
  }
  if (update.kind === "settled")
    return {
      ...update,
      result: redactResult(update, redact),
      ...(update.binding === undefined
        ? {}
        : {
            binding: {
              ...update.binding,
              descriptor: verifyToolDescriptor(update.binding.descriptor),
            },
          }),
    };
  if (update.kind === "write-approval") {
    if (!isChatToolWriteApprovalView(update.approval))
      throw invalidRequest("Invalid tool approval projection.");
    return update;
  }
  if (!isChatToolReadGrantView(update.grant))
    throw invalidRequest("Invalid tool consent projection.");
  return update;
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
    const json = JSON.stringify(next);
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
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
