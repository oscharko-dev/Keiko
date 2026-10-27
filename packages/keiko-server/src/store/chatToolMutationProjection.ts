import type { DatabaseSync } from "node:sqlite";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { processServerLogSink } from "../process-log-sink.js";
import type { ChatMessage } from "./types.js";
import type { ChatToolMutationRecord } from "./chatToolMutationTypes.js";
import {
  observedChatToolMutationOutcome,
  validateMutationIntent,
} from "./chatToolMutationState.js";
import { readChatToolMutationTurn } from "./chatToolMutations.js";

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
  if (call.result !== undefined && call.result.toolRef?.canonicalId !== `keiko.${record.operation}`)
    return false;
  try {
    validateMutationIntent({ ...record, userMessageId: message.id });
    return true;
  } catch {
    return false;
  }
}

/** Historical effects remain visible after authority expires or the connection closes.
 * The journal is authoritative; projection neither grants authority nor executes an action. */
export function projectChatToolMutationHistory(
  db: DatabaseSync,
  message: ChatMessage,
): ChatMessage {
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
