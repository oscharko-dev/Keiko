import type { ChatToolExchange, GroundedUncertainty } from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { ERROR_CODES, GatewayError } from "@oscharko-dev/keiko-model-gateway";
import { sha256Hex } from "@oscharko-dev/keiko-security";
import type { ServerLogSink } from "./observability/index.js";
import { CatalogDispatchFault } from "./tool-catalog/catalogToolErrors.js";
import { BATCH_DRAFT_SKIP_REASONS, type BatchDraftSkipReason } from "./chat-tool-batch-draft.js";
import {
  chatToolDraftReceipts,
  chatToolIssueKey,
  type ChatToolDraftReceipt,
} from "./chat-tool-receipts.js";

/**
 * How an accepted Chat tool turn ended before the model gave its own answer (#4175). The answer
 * that replaces it is built from the stored tool transcript, never from the model, so it names
 * exactly the writes Jira acknowledged.
 */
export type ChatToolTurnEndReason =
  | "budget-exhausted"
  | "deadline"
  | "authority-invalid"
  | "authentication-failed"
  | "tool-failure"
  | "output-exhausted"
  | "context-overflow"
  | "model-failure";
const REASONS: readonly ChatToolTurnEndReason[] = [
  "budget-exhausted",
  "deadline",
  "authority-invalid",
  "authentication-failed",
  "tool-failure",
  "output-exhausted",
  "context-overflow",
  "model-failure",
];
const REASON_TEXT: Readonly<Record<ChatToolTurnEndReason, string>> = {
  "budget-exhausted": "this turn used up its tool-call budget",
  deadline: "this turn reached its time limit",
  "authority-invalid": "the Chat's mode, sources or connection changed",
  "authentication-failed":
    "Jira authentication failed. The token may have expired or been revoked: open the Knowledge Pods hub, replace the token and verify the connection",
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
/**
 * Undefined when the failure is not one a partial answer may replace (for example a human stop).
 * An attempt refusal is the turn's own budget end only when its envelope refused the attempt; a
 * cap the caller supplied keeps the 403 contract.
 */
export function chatToolTurnEndReason(
  error: unknown,
  turn: { readonly envelopeRefusedAttempt?: boolean } = {},
): ChatToolTurnEndReason | undefined {
  if (error instanceof CatalogDispatchFault) return dispatchReason(error);
  if (!(error instanceof GatewayError)) return undefined;
  if (error.code === ERROR_CODES.ATTEMPT_ADMISSION_DENIED && turn.envelopeRefusedAttempt === true)
    return "budget-exhausted";
  return KEPT_GATEWAY_CODES.has(error.code) ? undefined : gatewayReason(error);
}

interface Tally {
  readonly succeeded: string[];
  readonly unconfirmed: string[];
  /** Started but never settled: the call may have reached Jira before bookkeeping failed. */
  readonly unsettled: string[];
  /** Draft items Jira refused, or that an earlier failed or uncertain item kept from being sent. */
  readonly notDone: string[];
  reads: number;
  refused: number;
}
function receipt(exchange: ChatToolExchange): string {
  const key = chatToolIssueKey(exchange.result?.data);
  return key === undefined ? exchange.call.name : `${exchange.call.name} ${key}`;
}
function countDraftItem(result: Tally, item: ChatToolDraftReceipt, label: string): void {
  if (item.state === "created" || item.state === "existing") result.succeeded.push(label);
  else if (item.state === "uncertain") result.unconfirmed.push(label);
  else if (item.state === "failed") {
    result.refused++;
    result.notDone.push(label);
  }
  // A skipped item was blocked by a failed or uncertain one and a pending item never started
  // before the run's time ended; only an excluded item is deselected.
  else if (item.state === "skipped" || item.state === "pending") result.notDone.push(label);
}
/** A backlog draft reports each item: created or reconciled items completed, uncertain ones sent. */
function countDraft(result: Tally, exchange: ChatToolExchange): boolean {
  const items = chatToolDraftReceipts(exchange);
  if (items === undefined) return false;
  for (const [index, item] of items.entries()) {
    const key = item.issueKey ?? `(item ${String(index + 1)}, no key)`;
    countDraftItem(result, item, `${exchange.call.name} ${key} (${item.state})`);
  }
  return true;
}
function count(result: Tally, exchange: ChatToolExchange): void {
  const outcome = exchange.mutationOutcome;
  if (exchange.result === undefined) result.unsettled.push(exchange.call.name);
  else if (countDraft(result, exchange)) return;
  else if (outcome === "succeeded") result.succeeded.push(receipt(exchange));
  else if (outcome === "succeeded-unconfirmed" || outcome === "unknown")
    result.unconfirmed.push(receipt(exchange));
  else if (outcome === undefined && exchange.result.status === "completed") result.reads++;
  else result.refused++;
}
function tally(exchanges: readonly ChatToolExchange[]): Tally {
  const result: Tally = {
    succeeded: [],
    unconfirmed: [],
    unsettled: [],
    notDone: [],
    reads: 0,
    refused: 0,
  };
  for (const exchange of exchanges) count(result, exchange);
  return result;
}
/** The turn acknowledged a write, or may have: its answer has something to report. */
export function chatToolTurnHoldsWrite(exchanges: readonly ChatToolExchange[]): boolean {
  const { succeeded, unconfirmed } = tally(exchanges);
  return succeeded.length + unconfirmed.length > 0;
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
    ...bullets("Started but not settled — check these in Jira before retrying:", counts.unsettled),
    ...bullets(
      "Not done — refused by Jira, blocked by an earlier item, or not started in time:",
      counts.notDone,
    ),
    `Reads completed: ${String(counts.reads)}. Refused or failed tool calls: ${String(counts.refused)}.`,
    "",
    "The rest of the request was not done. Send a follow-up message to continue from here; completed writes are not repeated unless you ask for them again.",
  ].join("\n");
}

const COUNT_FIELD = {
  type: "integer",
  dataClass: "count",
  required: true,
} as const;

const TURN_ENDED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-turn.ended",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-tool-turn-ending.recordChatToolTurnEnded",
  fields: {
    messageDigest: {
      type: "string",
      dataClass: "digest",
      required: true,
      maxLength: 64,
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: REASONS,
    },
    exchangeCount: COUNT_FIELD,
    succeededWriteCount: COUNT_FIELD,
    unconfirmedWriteCount: COUNT_FIELD,
    unsettledCount: COUNT_FIELD,
    readCount: COUNT_FIELD,
    refusedCount: COUNT_FIELD,
    maxToolCalls: COUNT_FIELD,
    maxRuntimeMs: { type: "integer", dataClass: "duration", required: true },
    completeness: {
      type: "string",
      dataClass: "completeness-state",
      required: true,
    },
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
    readonly budget: {
      readonly maxToolCalls: number;
      readonly maxRuntimeMs: number;
    };
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
          unsettledCount: counts.unsettled.length,
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

const RESULT_CONDENSED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-turn.result-condensed",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-tool-turn-ending.recordChatToolTurnResultCondensed",
  fields: {
    messageDigest: {
      type: "string",
      dataClass: "digest",
      required: true,
      maxLength: 64,
    },
    rowCount: { type: "integer", dataClass: "count", required: true },
    keptRowCount: { type: "integer", dataClass: "count", required: true },
    completeness: {
      type: "string",
      dataClass: "completeness-state",
      required: true,
    },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-turn.result-condensed.line"],
  releaseImpact: "minor",
});

/**
 * Recorded when the model read a Jira draft result condensed, as key ranges and groups of alike
 * rows: how many rows the stored result holds and how many entries the model read (#4292).
 */
export function recordChatToolTurnResultCondensed(
  log: ServerLogSink,
  input: {
    readonly correlationId: string;
    readonly messageId: string;
    readonly rowCount: number;
    readonly keptRowCount: number;
  },
): void {
  try {
    log.write(
      activityLogEvent(
        RESULT_CONDENSED,
        { correlationId: input.correlationId, level: "info" },
        {
          messageDigest: sha256Hex(input.messageId),
          rowCount: input.rowCount,
          keptRowCount: input.keptRowCount,
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
    messageDigest: {
      type: "string",
      dataClass: "digest",
      required: true,
      maxLength: 64,
    },
    elidedResultCount: { type: "integer", dataClass: "count", required: true },
    continuationMessageCount: {
      type: "integer",
      dataClass: "count",
      required: true,
    },
    completeness: {
      type: "string",
      dataClass: "completeness-state",
      required: true,
    },
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

const CORRECTED = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-turn.corrected",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-tool-turn-ending.recordChatToolTurnCorrected",
  fields: {
    messageDigest: {
      type: "string",
      dataClass: "digest",
      required: true,
      maxLength: 64,
    },
    settledExchangeCount: {
      type: "integer",
      dataClass: "count",
      required: true,
    },
    correctionKind: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [
        "tool-schema",
        "empty-answer",
        "report-omission",
        "report-coverage",
        "unsupported-issue-key",
        "knowledge-coverage",
        "raw-report-key",
      ],
    },
    omittedFindingCount: {
      type: "integer",
      dataClass: "count",
      required: false,
    },
    mismatchedRequirementCount: {
      type: "integer",
      dataClass: "count",
      required: false,
    },
    unsupportedKeyCount: {
      type: "integer",
      dataClass: "count",
      required: false,
    },
    rawReportKeyCount: {
      type: "integer",
      dataClass: "count",
      required: false,
    },
    pendingKnowledgePageCount: {
      type: "integer",
      dataClass: "count",
      required: false,
    },
    completeness: {
      type: "string",
      dataClass: "completeness-state",
      required: true,
    },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-turn.corrected.line"],
  releaseImpact: "minor",
});

interface ChatToolTurnCorrectionInput {
  readonly correlationId: string;
  readonly messageId: string;
  readonly settledExchangeCount: number;
  readonly correctionKind:
    | "tool-schema"
    | "empty-answer"
    | "report-omission"
    | "report-coverage"
    | "unsupported-issue-key"
    | "knowledge-coverage"
    | "raw-report-key";
  readonly omittedFindingCount?: number;
  readonly mismatchedRequirementCount?: number;
  readonly unsupportedKeyCount?: number;
  readonly rawReportKeyCount?: number;
  readonly pendingKnowledgePageCount?: number;
}

/** The optional body-free counts of one correction line. */
function correctionCounts(
  input: ChatToolTurnCorrectionInput,
): Readonly<
  Partial<
    Record<
      | "omittedFindingCount"
      | "mismatchedRequirementCount"
      | "unsupportedKeyCount"
      | "rawReportKeyCount"
      | "pendingKnowledgePageCount",
      number
    >
  >
> {
  return {
    ...(input.omittedFindingCount === undefined
      ? {}
      : { omittedFindingCount: input.omittedFindingCount }),
    ...(input.mismatchedRequirementCount === undefined
      ? {}
      : { mismatchedRequirementCount: input.mismatchedRequirementCount }),
    ...(input.unsupportedKeyCount === undefined
      ? {}
      : { unsupportedKeyCount: input.unsupportedKeyCount }),
    ...(input.rawReportKeyCount === undefined
      ? {}
      : { rawReportKeyCount: input.rawReportKeyCount }),
    ...(input.pendingKnowledgePageCount === undefined
      ? {}
      : { pendingKnowledgePageCount: input.pendingKnowledgePageCount }),
  };
}

/**
 * Recorded when a turn gets one further round carrying a correction instead of ending: a tool call
 * the gateway rejected again after its own schema correction (`tool-schema`), a round the model
 * completed with nothing at all (`empty-answer`), or an answer that left
 * out findings the turn's report pages list (`report-omission`, with their count; never the keys),
 * an answer that gave requirements other issues than the report's requirement pages state
 * (`report-coverage`, with the requirement count; never the ids or keys), or an answer that named issue keys no tool result showed (`unsupported-issue-key`, with their
 * count; never the keys), or an answer that printed the report's internal result keys (`raw-report-key`, with
 * their count; never the keys), or unfinished Knowledge pages (`knowledge-coverage`, with the pending
 * page count). A combined correction emits one line per kind for the same admitted model round.
 */
export function recordChatToolTurnCorrected(
  log: ServerLogSink,
  input: ChatToolTurnCorrectionInput,
): void {
  try {
    log.write(
      activityLogEvent(
        CORRECTED,
        { correlationId: input.correlationId, level: "warn" },
        {
          messageDigest: sha256Hex(input.messageId),
          settledExchangeCount: input.settledExchangeCount,
          correctionKind: input.correctionKind,
          ...correctionCounts(input),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
  }
}

const DRAFT_OFFER = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-turn.batch-draft-offer",
  category: "process",
  owner: "keiko-server",
  emitter: "chat-tool-turn-ending.recordChatToolBatchDraftOffer",
  fields: {
    messageDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["dispatched", "skipped"],
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...BATCH_DRAFT_SKIP_REASONS],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["chat-tool-transcript"],
  proofIds: ["chat.tool-turn.batch-draft-offer.line"],
  releaseImpact: "minor",
});

/**
 * Recorded once per settled draft batch: Keiko dispatched the `jira.draft` approval itself
 * (`dispatched`), or left it to the human and the model (`skipped`, with the closed reason). The
 * line carries no draft id, digest, count or text.
 */
export function recordChatToolBatchDraftOffer(
  log: ServerLogSink,
  input: {
    readonly correlationId: string;
    readonly messageId: string;
    readonly decision: "dispatched" | BatchDraftSkipReason;
  },
): void {
  try {
    log.write(
      activityLogEvent(
        DRAFT_OFFER,
        { correlationId: input.correlationId, level: "info" },
        {
          messageDigest: sha256Hex(input.messageId),
          outcome: input.decision === "dispatched" ? "dispatched" : "skipped",
          ...(input.decision === "dispatched" ? {} : { reason: input.decision }),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
  }
}

/**
 * An answer built on settled tool results has a visible source: those results. Calling it
 * untraceable would be false, so only that note goes; a marker that cites nothing valid stays.
 */
export function withToolResultsAsSource<
  Answer extends {
    readonly userMessageId: string;
    readonly uncertainty: readonly GroundedUncertainty[];
  },
>(answer: Answer, turn: { readonly hasUsableObservation: () => boolean } | undefined): Answer {
  // The request owns origin custody; persisted legacy-compatible rows cannot authenticate it.
  if (turn?.hasUsableObservation() !== true) return answer;
  return {
    ...answer,
    uncertainty: answer.uncertainty.filter((marker) => marker.kind !== "uncited-answer"),
  };
}
