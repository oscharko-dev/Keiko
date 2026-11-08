import type { DatabaseSync } from "node:sqlite";
import { jiraMutationToolId } from "../atlassian/jiraMutationToolId.js";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_MUTATION_OPERATIONS, type JiraMutationOperation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ChatToolReadGrant, ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import {
  jiraOperationActionDigest,
  type JiraOperationBinding,
} from "../atlassian/jiraOperationRegistry.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { ChatMessage } from "./types.js";
import type { ChatToolMutationRecord } from "./chatToolMutationTypes.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { observedChatToolMutationOutcome, mutationIntentError } from "./chatToolMutationState.js";
import { readChatToolMutationTurn, readCodingJiraMutationMessage } from "./chatToolMutations.js";
import { readChatReadGrant } from "./chatToolReadGrants.js";
import {
  projectChatReadGrant,
  recordReadGrant,
  snapshotReadGrant,
  type ChatReadGrantEntry,
} from "../atlassian/chatReadGrantState.js";

const PROJECTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-mutation.projected",
  category: "process",
  owner: "keiko-server",
  emitter: "store.chatToolMutationProjection.projectChatToolMutationHistory",
  fields: {
    messageDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    observationCount: { type: "number", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-mutation.projected.line"],
  releaseImpact: "minor",
});

function matchesCall(
  message: ChatMessage,
  call: ChatToolExchange,
  record: ChatToolMutationRecord,
  operationBinding: JiraOperationBinding | undefined,
  sourceDigest: string | undefined,
): boolean {
  const expected = sha256Hex(canonicalise({ messageId: message.id, callId: call.call.id }));
  const argumentsDigest = sha256Hex(canonicalise(call.call.arguments));
  const action =
    record.sourceKind === "configured-mcp"
      ? sha256Hex(canonicalise({ operation: record.operation, argumentsDigest }))
      : jiraOperationActionDigest(
          record.operation,
          argumentsDigest,
          operationBinding,
          sourceDigest,
          call.humanInput?.revision,
        );
  return (
    (record.sourceKind !== "configured-mcp" ||
      (operationBinding === undefined && sourceDigest === undefined)) &&
    record.invocationId === expected &&
    record.userMessageId === message.id &&
    record.chatId === message.chatId &&
    record.turnRef === message.canonicalTurnRef &&
    call.call.name === record.operation.replace(/[.-]/gu, "_") &&
    record.actionDigest === action
  );
}
function observationAvailable(
  message: ChatMessage,
  call: ChatToolExchange,
  record: ChatToolMutationRecord,
): boolean {
  return (
    call.result !== undefined ||
    message.turnState !== "pending" ||
    record.phase === "acknowledged" ||
    record.phase === "settled"
  );
}
function validObservation(
  message: ChatMessage,
  call: ChatToolExchange,
  record: ChatToolMutationRecord,
  operationBinding: JiraOperationBinding | undefined,
  sourceDigest: string | undefined,
  nativeArgumentsDigest: string | undefined,
): boolean {
  if (record.consumer?.kind === "coding")
    return validCodingObservation(message, call, record, operationBinding, nativeArgumentsDigest);
  if (
    !matchesCall(message, call, record, operationBinding, sourceDigest) ||
    !observationAvailable(message, call, record)
  )
    return false;
  const canonicalId =
    record.sourceKind === "configured-mcp"
      ? `keiko.mcp.t${sha256Hex(canonicalise({ server: record.serverName, tool: record.toolName }))}`
      : jiraMutationToolId(record.operation);
  if (call.result !== undefined && call.result.toolRef?.canonicalId !== canonicalId) return false;
  return mutationIntentError({ ...record, userMessageId: message.id }) === undefined;
}

/** Native identity is the existing journal's captured run/message/call, not Chat approval identity. */
function validCodingObservation(
  message: ChatMessage,
  exchange: ChatToolExchange,
  record: ChatToolMutationRecord,
  binding: JiraOperationBinding | undefined,
  nativeArgumentsDigest: string | undefined,
): boolean {
  if (record.sourceKind !== "configured-mcp" || record.serverName !== "jira" ||
      record.consumer?.kind !== "coding" || binding === undefined) return false;
  const operation = JIRA_MUTATION_OPERATIONS.find((name) => name === record.toolName);
  return operation !== undefined &&
    codingCallMatches(message, exchange, record, nativeArgumentsDigest) &&
    codingResultMatches(exchange, operation, binding) &&
    mutationIntentError({ ...record, userMessageId: message.id }) === undefined;
}
function codingCallMatches(
  message: ChatMessage,
  exchange: ChatToolExchange,
  record: ChatToolMutationRecord,
  nativeArgumentsDigest: string | undefined,
): boolean {
  return record.chatId === message.chatId && record.userMessageId === message.id &&
    record.invocationId === exchange.call.id &&
    nativeArgumentsDigest !== undefined && nativeArgumentsDigest === record.consumer?.argumentsDigest;
}
function codingResultMatches(
  exchange: ChatToolExchange,
  operation: JiraMutationOperation,
  binding: JiraOperationBinding,
): boolean {
  const result = exchange.result;
  if (result === undefined) return false;
  return exchange.call.name === operation.replace(/[.-]/gu, "_") &&
    result.toolRef?.canonicalId === jiraMutationToolId(operation) &&
    (isResultObject(result.data)
      ? canonicalise(result.data.operationBinding) === canonicalise(binding)
      : result.status === "denied" && result.reason === "effect-denied" && result.data === null);
}
function isResultObject(value: unknown): value is CatalogJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The journal commits before any dispatch, so a reviewed call it never saw cannot have been sent. */
function neverDispatched(
  message: ChatMessage,
  exchange: ChatToolExchange,
  records: readonly ChatToolMutationRecord[],
): boolean {
  const invocationId = exchange.approval?.invocationId;
  return (
    invocationId !== undefined &&
    exchange.result === undefined &&
    message.turnState !== undefined &&
    message.turnState !== "pending" &&
    !records.some((record) => record.invocationId === invocationId)
  );
}

function observedOutcome(
  message: ChatMessage,
  exchange: ChatToolExchange,
  record: ChatToolMutationRecord | undefined,
  records: readonly ChatToolMutationRecord[],
): ChatToolExchange["mutationOutcome"] {
  if (record !== undefined) return observedChatToolMutationOutcome(record);
  return neverDispatched(message, exchange, records) ? "not-dispatched" : undefined;
}

/** Historical effects remain visible after authority expires or the connection closes.
 * The journal is authoritative; projection neither grants authority nor executes an action. */
export function projectChatToolMutationHistory(
  db: DatabaseSync,
  input: ChatMessage,
  operationBindings: ReadonlyMap<string, JiraOperationBinding>,
  sourceDigests: ReadonlyMap<string, string> = new Map(),
  nativeArgumentsDigests: ReadonlyMap<string, string> = new Map(),
): ChatMessage {
  const message = projectChatReadConsentHistory(db, input);
  const transcript = message.toolTranscript;
  if (message.role !== "user" || transcript === undefined)
    return message;
  const chatRecords = message.canonicalTurnRef === undefined ? [] :
    readChatToolMutationTurn(db, message.chatId, message.canonicalTurnRef);
  // This prefix only preselects a lookup; validCodingObservation proves its full stored identity.
  const codingIds = transcript.exchanges.filter((exchange) =>
    exchange.call.id.startsWith("mcp-") && operationBindings.has(exchange.call.id))
    .map((exchange) => exchange.call.id);
  const codingRecords = readCodingJiraMutationMessage(db, message.chatId, message.id, codingIds);
  const records = [...chatRecords, ...codingRecords];
  let observationCount = 0;
  let correlationId: string | undefined;
  const exchanges = transcript.exchanges.map((exchange) => {
    const record = records.find((candidate) =>
      validObservation(
        message,
        exchange,
        candidate,
        operationBindings.get(exchange.call.id),
        sourceDigests.get(exchange.call.id),
        nativeArgumentsDigests.get(exchange.call.id),
      ),
    );
    const mutationOutcome = observedOutcome(message, exchange, record, records);
    if (mutationOutcome === undefined || mutationOutcome === exchange.mutationOutcome)
      return exchange;
    observationCount++;
    correlationId ??= record?.correlationId;
    return { ...exchange, mutationOutcome };
  });
  if (observationCount === 0) return message;
  const observed = exchanges.map((exchange) => exchange.mutationOutcome ?? "").join("\u0000");
  if (firstHistoryObservation(db, `mutation\u0000${message.id}\u0000${observed}`))
    processServerLogSink().write(
      activityLogEvent(
        PROJECTED,
        { correlationId: correlationId ?? sha256Hex(message.id), level: "info" },
        { messageDigest: sha256Hex(message.id), observationCount },
      ),
    );
  return { ...message, toolTranscript: { ...transcript, exchanges } };
}

function matchesReadConsent(
  message: ChatMessage,
  view: ChatToolReadGrantView,
  entry: ChatReadGrantEntry,
): boolean {
  const runId = `chat-${sha256Hex(canonicalise({ chatId: message.chatId, userMessageId: message.id }))}`;
  return (
    entry.authority.runId === runId &&
    view.chatId === message.chatId &&
    canonicalise({ ...projectChatReadGrant(entry.grant), state: view.state }) === canonicalise(view)
  );
}

interface HistoricalReadConsent {
  readonly transcript: ChatToolTranscript;
  readonly view: ChatToolReadGrantView;
}
function historicalConsent(message: ChatMessage): HistoricalReadConsent | undefined {
  const transcript = message.toolTranscript;
  if (message.role !== "user" || message.canonicalTurnRef === undefined || transcript === undefined)
    return undefined;
  const view = transcript.readGrant;
  return view?.state === "pending" || view?.state === "granted" ? { transcript, view } : undefined;
}
function observedReadGrant(
  retained: ChatToolReadGrant,
  previous: ChatToolReadGrantView["state"],
  now: number,
): ChatToolReadGrant | undefined {
  if (retained.requestedAt > now) return undefined;
  const grant = retained.expiresAt <= now ? { ...retained, state: "expired" as const } : retained;
  if (
    grant.state === "pending" ||
    grant.state === previous ||
    (previous === "granted" && grant.state === "rejected")
  )
    return undefined;
  return grant;
}

/** The projections are never persisted, so every history read re-derives the same observation
 * and would log it again (a polling client wrote hundreds of identical lines). The first sight of
 * each observation is recorded; repeats are not. Memory is process-local and per database, not a
 * write from a read path, and bounded by insertion-ordered eviction: at worst an evicted
 * observation is recorded once more, it is never withheld on first sight. */
const RECORDED_HISTORY_OBSERVATIONS_MAX = 1024;
const recordedHistoryObservations = new WeakMap<DatabaseSync, Set<string>>();
function firstHistoryObservation(db: DatabaseSync, key: string): boolean {
  const recorded = recordedHistoryObservations.get(db) ?? new Set<string>();
  recordedHistoryObservations.set(db, recorded);
  if (recorded.has(key)) return false;
  recorded.add(key);
  if (recorded.size > RECORDED_HISTORY_OBSERVATIONS_MAX) {
    const oldest = recorded.values().next();
    if (oldest.done !== true) recorded.delete(oldest.value);
  }
  return true;
}

/** Recover only the original human decision; observation does not resume its interrupted turn. */
function projectChatReadConsentHistory(db: DatabaseSync, message: ChatMessage): ChatMessage {
  const candidate = historicalConsent(message);
  if (candidate === undefined) return message;
  const { transcript, view } = candidate;
  const entry = readChatReadGrant(db, view.grantId);
  if (entry === undefined || !matchesReadConsent(message, view, entry)) return message;
  const grant = observedReadGrant(entry.grant, view.state, Date.now());
  if (grant === undefined) return message;
  if (firstHistoryObservation(db, `read-grant\u0000${grant.grantId}\u0000${grant.state}`))
    recordReadGrant(snapshotReadGrant({ ...entry, grant }, sha256Hex(message.id)), 0);
  return { ...message, toolTranscript: { ...transcript, readGrant: projectChatReadGrant(grant) } };
}
