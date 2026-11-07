// Activity Log evidence of a learning pass (#4213). Closed values, counts and durations only:
// neither the person's words nor a learned fact ever enters the line.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { correlationIdOrUnknown } from "./correlation.js";
import { getServerLogger } from "./observability/index.js";

// Written out because the catalog generator reads closed values from this file.
export const MEMORY_LEARNING_TRIGGERS = [
  "inactivity",
  "chat-change",
  "startup",
  "retry",
  "continuation",
] as const;
export type MemoryLearningTrigger = (typeof MEMORY_LEARNING_TRIGGERS)[number];

export const MEMORY_LEARNING_PASS_OUTCOMES = [
  "completed",
  "cancelled",
  "unavailable",
  "failed",
] as const;
export type MemoryLearningPassOutcome = (typeof MEMORY_LEARNING_PASS_OUTCOMES)[number];

const MEMORY_LEARN_PASS_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  owner: "keiko-server",
  causal: "parent-correlation",
  releaseImpact: "patch",
  category: "memory",
  analyzerProjection: "timeline",
  failureClasses: ["memory-learning-pass"],
} as const;

const TRIGGER_FIELD = {
  type: "string",
  dataClass: "closed-enum",
  required: true,
  values: MEMORY_LEARNING_TRIGGERS,
} as const;

const MEMORY_LEARN_PASS_STARTED_OPERATION = defineActivityLogOperation({
  ...MEMORY_LEARN_PASS_BASE,
  op: "memory.learn.pass.started",
  emitter: "memory-learning-log.logLearningPassStarted",
  lifecycle: "start",
  fields: {
    trigger: TRIGGER_FIELD,
    chatCount: { type: "integer", dataClass: "count", required: true },
  },
  proofIds: ["memory.learn.pass.started.line"],
});

const MEMORY_LEARN_PASS_SETTLED_OPERATION = defineActivityLogOperation({
  ...MEMORY_LEARN_PASS_BASE,
  op: "memory.learn.pass.settled",
  emitter: "memory-learning-log.logLearningPassSettled",
  lifecycle: "end",
  fields: {
    trigger: TRIGGER_FIELD,
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_LEARNING_PASS_OUTCOMES,
    },
    chatCount: { type: "integer", dataClass: "count", required: true },
    turnCount: { type: "integer", dataClass: "count", required: true },
    learnedTurnCount: { type: "integer", dataClass: "count", required: true },
    skippedTurnCount: { type: "integer", dataClass: "count", required: true },
    memoryOffTurnCount: { type: "integer", dataClass: "count", required: true },
    forgottenPendingCount: { type: "integer", dataClass: "count", required: true },
    actionCount: { type: "integer", dataClass: "count", required: true },
    failedTurnCount: { type: "integer", dataClass: "count", required: true },
    pendingChatCount: { type: "integer", dataClass: "count", required: true },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    cancelLatencyMs: { type: "integer", dataClass: "duration", required: false },
  },
  proofIds: ["memory.learn.pass.settled.line"],
});

export interface LearningPassIds {
  readonly passId: string;
  readonly parentCorrelationId?: string | undefined;
}

function passHeader(ids: LearningPassIds): {
  readonly correlationId: string;
  readonly parentCorrelationId: string;
} {
  return {
    correlationId: ids.passId,
    parentCorrelationId: correlationIdOrUnknown(ids.parentCorrelationId),
  };
}

export function logLearningPassStarted(
  ids: LearningPassIds,
  fields: { readonly trigger: MemoryLearningTrigger; readonly chatCount: number },
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_LEARN_PASS_STARTED_OPERATION, passHeader(ids), fields),
  );
}

export interface LearningPassTally {
  chatCount: number;
  turnCount: number;
  learnedTurnCount: number;
  skippedTurnCount: number;
  memoryOffTurnCount: number;
  forgottenPendingCount: number;
  actionCount: number;
  failedTurnCount: number;
}

export function emptyLearningPassTally(): LearningPassTally {
  return {
    chatCount: 0,
    turnCount: 0,
    learnedTurnCount: 0,
    skippedTurnCount: 0,
    memoryOffTurnCount: 0,
    forgottenPendingCount: 0,
    actionCount: 0,
    failedTurnCount: 0,
  };
}

export function logLearningPassSettled(
  ids: LearningPassIds,
  settled: {
    readonly trigger: MemoryLearningTrigger;
    readonly outcome: MemoryLearningPassOutcome;
    readonly tally: LearningPassTally;
    readonly pendingChatCount: number;
    readonly durationMs: number;
    readonly cancelLatencyMs?: number | undefined;
  },
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_LEARN_PASS_SETTLED_OPERATION, passHeader(ids), {
      trigger: settled.trigger,
      outcome: settled.outcome,
      ...settled.tally,
      pendingChatCount: settled.pendingChatCount,
      durationMs: Math.max(0, Math.round(settled.durationMs)),
      ...(settled.cancelLatencyMs === undefined
        ? {}
        : { cancelLatencyMs: Math.max(0, Math.round(settled.cancelLatencyMs)) }),
    }),
  );
}
