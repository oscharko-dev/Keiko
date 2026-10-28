import type { DatabaseSync } from "node:sqlite";
import type { ChatToolExchange, ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { ChatToolReadGrant, ChatToolReadGrantView } from "@oscharko-dev/keiko-contracts";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { processServerLogSink } from "../process-log-sink.js";
import type { ChatMessage } from "./types.js";
import type { ChatToolMutationRecord } from "./chatToolMutationTypes.js";
import { observedChatToolMutationOutcome, mutationIntentError } from "./chatToolMutationState.js";
import { readChatToolMutationTurn } from "./chatToolMutations.js";
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
): boolean {
  const expected = sha256Hex(canonicalise({ messageId: message.id, callId: call.call.id }));
  const action = sha256Hex(
    canonicalise({
      operation: record.operation,
      argumentsDigest: sha256Hex(canonicalise(call.call.arguments)),
    }),
  );
  return (
    record.invocationId === expected &&
    record.userMessageId === message.id &&
    record.chatId === message.chatId &&
    record.turnRef === message.canonicalTurnRef &&
    call.call.name === record.operation.replaceAll(".", "_") &&
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
): boolean {
  if (!matchesCall(message, call, record) || !observationAvailable(message, call, record))
    return false;
  const canonicalId =
    record.sourceKind === "configured-mcp"
      ? `keiko.mcp.t${sha256Hex(canonicalise({ server: record.serverName, tool: record.toolName }))}`
      : `keiko.${record.operation}`;
  if (call.result !== undefined && call.result.toolRef?.canonicalId !== canonicalId) return false;
  return mutationIntentError({ ...record, userMessageId: message.id }) === undefined;
}

/** Historical effects remain visible after authority expires or the connection closes.
 * The journal is authoritative; projection neither grants authority nor executes an action. */
export function projectChatToolMutationHistory(db: DatabaseSync, input: ChatMessage): ChatMessage {
  const message = projectChatReadConsentHistory(db, input);
  const transcript = message.toolTranscript;
  if (message.role !== "user" || message.canonicalTurnRef === undefined || transcript === undefined)
    return message;
  const records = readChatToolMutationTurn(db, message.chatId, message.canonicalTurnRef);
  let observationCount = 0;
  let correlationId: string | undefined;
  const exchanges = transcript.exchanges.map((exchange) => {
    const record = records.find((candidate) => validObservation(message, exchange, candidate));
    if (record === undefined) return exchange;
    const mutationOutcome = observedChatToolMutationOutcome(record);
    if (mutationOutcome === undefined || mutationOutcome === exchange.mutationOutcome)
      return exchange;
    observationCount++;
    correlationId ??= record.correlationId;
    return { ...exchange, mutationOutcome };
  });
  if (observationCount === 0) return message;
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

/** Recover only the original human decision; observation does not resume its interrupted turn. */
function projectChatReadConsentHistory(db: DatabaseSync, message: ChatMessage): ChatMessage {
  const candidate = historicalConsent(message);
  if (candidate === undefined) return message;
  const { transcript, view } = candidate;
  const entry = readChatReadGrant(db, view.grantId);
  if (entry === undefined || !matchesReadConsent(message, view, entry)) return message;
  const grant = observedReadGrant(entry.grant, view.state, Date.now());
  if (grant === undefined) return message;
  recordReadGrant(snapshotReadGrant({ ...entry, grant }, sha256Hex(message.id)), 0);
  return { ...message, toolTranscript: { ...transcript, readGrant: projectChatReadGrant(grant) } };
}
