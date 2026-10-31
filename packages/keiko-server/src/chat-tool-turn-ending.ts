import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ERROR_CODES, GatewayError } from "@oscharko-dev/keiko-model-gateway";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { ServerLogSink } from "./observability/index.js";
import { CatalogDispatchFault } from "./tool-catalog/catalogToolErrors.js";

/**
 * How an accepted Chat tool turn ended before the model gave its own answer (#4175). The answer
 * that replaces it is built from the stored tool transcript, never from the model, so it names
 * exactly the writes Jira acknowledged.
 */
export type ChatToolTurnEndReason =
  | "budget-exhausted"
  | "deadline"
  | "authority-invalid"
  | "tool-failure"
  | "output-exhausted"
  | "context-overflow"
  | "model-failure";
const REASONS: readonly ChatToolTurnEndReason[] = [
  "budget-exhausted",
  "deadline",
  "authority-invalid",
  "tool-failure",
  "output-exhausted",
  "context-overflow",
  "model-failure",
];
const REASON_TEXT: Readonly<Record<ChatToolTurnEndReason, string>> = {
  "budget-exhausted": "this turn used up its tool-call or prompt budget",
  deadline: "this turn reached its time limit",
  "authority-invalid": "the turn's authority changed (mode, binding or consent)",
  "tool-failure": "a tool call could not be settled",
  "output-exhausted": "the model ran out of output budget",
  "context-overflow": "the conversation no longer fits the model's context window",
  "model-failure": "the model request failed",
};

function dispatchReason(error: CatalogDispatchFault): ChatToolTurnEndReason {
  if (error.status === "timeout") return "deadline";
  if (error.reason === "budget-exhausted") return "budget-exhausted";
  return error.reason === "authority-invalid" ? "authority-invalid" : "tool-failure";
}
function gatewayReason(error: GatewayError): ChatToolTurnEndReason {
  if (error.code === ERROR_CODES.OUTPUT_EXHAUSTED) return "output-exhausted";
  if (error.code === ERROR_CODES.CONTEXT_OVERFLOW) return "context-overflow";
  return error.code === ERROR_CODES.TIMEOUT ? "deadline" : "model-failure";
}
// A human stop stays a cancellation, and a caller attempt/cap refusal keeps its own nonretryable
// 403 contract (AGENTS.md §8): neither is a turn that merely ran out of room.
const KEPT_GATEWAY_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.CANCELLED,
  ERROR_CODES.ATTEMPT_ADMISSION_DENIED,
]);
/** Undefined when the failure is not one a partial answer may replace (for example a human stop). */
export function chatToolTurnEndReason(error: unknown): ChatToolTurnEndReason | undefined {
  if (error instanceof CatalogDispatchFault) return dispatchReason(error);
  if (error instanceof GatewayError && !KEPT_GATEWAY_CODES.has(error.code))
    return gatewayReason(error);
  return undefined;
}

interface Tally {
  readonly succeeded: string[];
  readonly unconfirmed: string[];
  reads: number;
  refused: number;
}
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,17}$/u;
function receipt(exchange: ChatToolExchange): string {
  const data = exchange.result?.data;
  const key =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Readonly<Record<string, unknown>>).issueKey
      : undefined;
  return typeof key === "string" && ISSUE_KEY.test(key)
    ? `${exchange.call.name} ${key}`
    : exchange.call.name;
}
function count(result: Tally, exchange: ChatToolExchange): void {
  const outcome = exchange.mutationOutcome;
  if (outcome === "succeeded") result.succeeded.push(receipt(exchange));
  else if (outcome === "succeeded-unconfirmed" || outcome === "unknown")
    result.unconfirmed.push(receipt(exchange));
  else if (outcome === undefined && exchange.result?.status === "completed") result.reads++;
  else result.refused++;
}
function tally(exchanges: readonly ChatToolExchange[]): Tally {
  const result: Tally = { succeeded: [], unconfirmed: [], reads: 0, refused: 0 };
  for (const exchange of exchanges) count(result, exchange);
  return result;
}
function bullets(title: string, entries: readonly string[]): string[] {
  return entries.length === 0 ? [] : [title, ...entries.map((entry) => `- ${entry}`), ""];
}

/** The deterministic answer of a turn that ended early; it repeats only Keiko's own receipts. */
export function chatToolTurnPartialAnswer(
  exchanges: readonly ChatToolExchange[],
  reason: ChatToolTurnEndReason,
): string {
  const counts = tally(exchanges);
  return [
    `This request was not finished: ${REASON_TEXT[reason]}.`,
    "",
    ...bullets("Completed in this turn:", counts.succeeded),
    ...bullets("Sent but not confirmed — check these in Jira before retrying:", counts.unconfirmed),
    `Reads completed: ${String(counts.reads)}. Refused or failed tool calls: ${String(counts.refused)}.`,
    "",
    "The rest of the request was not done. Send a follow-up message to continue from here; completed writes are not repeated unless you ask for them again.",
  ].join("\n");
}

const TURN_ENDED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-turn.ended",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-tool-turn-ending.recordChatToolTurnEnded",
  fields: {
    messageDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    reason: { type: "string", dataClass: "closed-enum", required: true, values: REASONS },
    exchangeCount: { type: "integer", dataClass: "count", required: true },
    succeededWriteCount: { type: "integer", dataClass: "count", required: true },
    unconfirmedWriteCount: { type: "integer", dataClass: "count", required: true },
    readCount: { type: "integer", dataClass: "count", required: true },
    refusedCount: { type: "integer", dataClass: "count", required: true },
    maxToolCalls: { type: "integer", dataClass: "count", required: true },
    maxRuntimeMs: { type: "integer", dataClass: "duration", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-turn.ended.line"],
  releaseImpact: "minor",
});

/** Body-free: the reason, the counts and the envelope bounds; never a tool name, key or text. */
export function recordChatToolTurnEnded(
  log: ServerLogSink,
  input: {
    readonly correlationId: string;
    readonly messageId: string;
    readonly reason: ChatToolTurnEndReason;
    readonly exchanges: readonly ChatToolExchange[];
    readonly budget: { readonly maxToolCalls: number; readonly maxRuntimeMs: number };
  },
): void {
  const counts = tally(input.exchanges);
  try {
    log.write(
      activityLogEvent(
        TURN_ENDED,
        { correlationId: input.correlationId, level: "warn" },
        {
          messageDigest: sha256Hex(input.messageId),
          reason: input.reason,
          exchangeCount: input.exchanges.length,
          succeededWriteCount: counts.succeeded.length,
          unconfirmedWriteCount: counts.unconfirmed.length,
          readCount: counts.reads,
          refusedCount: counts.refused,
          maxToolCalls: input.budget.maxToolCalls,
          maxRuntimeMs: input.budget.maxRuntimeMs,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
  }
}

const CONTEXT_FITTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-turn.context-fitted",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-tool-turn-ending.recordChatToolTurnContextFitted",
  fields: {
    messageDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    elidedResultCount: { type: "integer", dataClass: "count", required: true },
    continuationMessageCount: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-turn.context-fitted.line"],
  releaseImpact: "minor",
});

/** Recorded when more older tool results were compacted to keep the turn in the window. */
export function recordChatToolTurnContextFitted(
  log: ServerLogSink,
  input: {
    readonly correlationId: string;
    readonly messageId: string;
    readonly elidedResultCount: number;
    readonly continuationMessageCount: number;
  },
): void {
  try {
    log.write(
      activityLogEvent(
        CONTEXT_FITTED,
        { correlationId: input.correlationId, level: "info" },
        {
          messageDigest: sha256Hex(input.messageId),
          elidedResultCount: input.elidedResultCount,
          continuationMessageCount: input.continuationMessageCount,
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
  }
}
