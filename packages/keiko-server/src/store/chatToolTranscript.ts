import type { DatabaseSync } from "node:sqlite";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import type { ToolResultEnvelope } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { CHAT_TOOL_READ_DISCLOSURE_VERSION } from "@oscharko-dev/keiko-contracts/runtime/chat-tool-authority";
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
    }
  | { readonly kind: "read-consent"; readonly grant: ChatToolReadGrantView };
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
      values: ["started", "settled", "read-consent"],
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
function validExchange(value: unknown): value is StoredExchange {
  if (
    !object(value) ||
    !exact(value, ["call", "result", "resultBinding"]) ||
    !validCall(value.call)
  )
    return false;
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
const GRANT_STATES = new Set(["pending", "granted", "rejected", "expired", "revoked"]);
function validReadGrant(value: unknown): value is ChatToolReadGrantView {
  if (
    !object(value) ||
    !exact(value, [
      "kind",
      "grantId",
      "chatId",
      "podId",
      "bindingGeneration",
      "authenticationGeneration",
      "state",
      "disclosureVersion",
      "requestedAt",
      "expiresAt",
    ])
  )
    return false;
  return (
    value.kind === "jira-chat-read" &&
    value.disclosureVersion === CHAT_TOOL_READ_DISCLOSURE_VERSION &&
    [value.grantId, value.chatId, value.podId].every(
      (id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id),
    ) &&
    [value.bindingGeneration, value.authenticationGeneration].every(
      (n) => Number.isSafeInteger(n) && Number(n) > 0,
    ) &&
    [value.requestedAt, value.expiresAt].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) &&
    Number(value.expiresAt) > Number(value.requestedAt) &&
    typeof value.state === "string" &&
    GRANT_STATES.has(value.state)
  );
}
function validTranscript(value: unknown): value is StoredTranscript {
  if (!object(value) || !exact(value, ["schemaVersion", "exchanges", "readGrant"])) return false;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.exchanges) ||
    value.exchanges.length > MAX_EXCHANGES
  )
    return false;
  if (!value.exchanges.every(validExchange)) return false;
  return (
    new Set(value.exchanges.map((exchange: ChatToolExchange) => exchange.call.id)).size ===
      value.exchanges.length &&
    (value.readGrant === undefined || validReadGrant(value.readGrant))
  );
}
export function decodeChatToolTranscript(json: string | null): ChatToolTranscript | undefined {
  const stored = decodeStoredTranscript(json);
  return stored === undefined
    ? undefined
    : {
        ...stored,
        exchanges: stored.exchanges.map(({ call, result }) => ({
          call,
          ...(result === undefined ? {} : { result }),
        })),
      };
}
function decodeStoredTranscript(json: string | null): StoredTranscript | undefined {
  if (json === null) return undefined;
  try {
    if (Buffer.byteLength(json) > MAX_TRANSCRIPT_BYTES) throw new TypeError();
    const parsed: unknown = JSON.parse(json);
    if (validTranscript(parsed)) return parsed;
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
      canonicalise(existing.resultBinding ?? null) === canonicalise(update.binding ?? null))
  );
}
function applyExchange(
  current: StoredTranscript,
  update: Exclude<ChatToolTranscriptUpdate, { kind: "read-consent" }>,
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
          }
        : exchange,
    ),
  };
}
function applyUpdate(
  current: StoredTranscript,
  update: ChatToolTranscriptUpdate,
  chatId: string,
): StoredTranscript {
  if (update.kind !== "read-consent") return applyExchange(current, update);
  if (update.grant.chatId !== chatId) throw invalidRequest("Tool consent Chat mismatch.");
  return { ...current, readGrant: update.grant };
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
  if (!validReadGrant(update.grant)) throw invalidRequest("Invalid tool consent projection.");
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
    const current = decodeStoredTranscript(row.tool_transcript_json as string | null) ?? {
      schemaVersion: 1,
      exchanges: [],
    };
    const redacted = redactUpdate(update, redact);
    const next = applyUpdate(current, redacted, row.chat_id);
    const json = JSON.stringify(next);
    decodeChatToolTranscript(json);
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
