// Activity Log evidence of learning from conversation. Closed reasons and counts only: neither the
// person's words nor a learned fact ever enters the line.

import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type {
  FactChangeBasis,
  FactRelationLabel,
  SalienceDropReason,
} from "@oscharko-dev/keiko-memory-capture";

import { getServerLogger } from "./observability/index.js";

const MEMORY_LEARN_OPERATION_BASE = {
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  owner: "keiko-server",
  causal: "none",
  releaseImpact: "patch",
  category: "memory",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["memory-learned-facts"],
} as const;

const MEMORY_LEARN_EXTRACTION_OPERATION = defineActivityLogOperation({
  ...MEMORY_LEARN_OPERATION_BASE,
  op: "memory.learn.extraction",
  emitter: "memory-learned-facts-log.logLearnedExtraction",
  fields: {
    rawItemCount: { type: "integer", dataClass: "count", required: true },
    admittedCount: { type: "integer", dataClass: "count", required: true },
    knownFactCount: { type: "integer", dataClass: "count", required: true },
    sourceMessageCount: { type: "integer", dataClass: "count", required: true },
  },
  proofIds: ["memory.learn.extraction.line"],
});

export function logLearnedExtraction(
  fields: {
    readonly rawItemCount: number;
    readonly admittedCount: number;
    readonly knownFactCount: number;
    readonly sourceMessageCount: number;
  },
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_LEARN_EXTRACTION_OPERATION, { correlationId }, fields),
  );
}

// Written out because the catalog generator reads closed values from this file. The `satisfies`
// clauses and the test keep them equal to what capture can report.
export const MEMORY_LEARN_DROP_REASONS = [
  "no-evidence",
  "evidence-not-verbatim",
  "evidence-too-long",
  "not-clause-boundary",
  "question",
  "request",
  "past-statement",
  "quoted",
  "hypothetical",
  "ironic",
  "negated-context",
  "uncertain",
  "not-self",
  "we-statement",
  "no-first-person",
  "third-party",
  "not-entailed",
  "polarity-changed",
  "personal-identifier",
  "unknown-type",
  "denied-content",
] as const satisfies readonly SalienceDropReason[];

const MEMORY_LEARN_DROPPED_OPERATION = defineActivityLogOperation({
  ...MEMORY_LEARN_OPERATION_BASE,
  op: "memory.learn.dropped",
  emitter: "memory-learned-facts-log.logLearnedDrop",
  fields: {
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_LEARN_DROP_REASONS,
    },
    count: { type: "integer", dataClass: "count", required: true },
    sourceMessageCount: { type: "integer", dataClass: "count", required: true },
  },
  proofIds: ["memory.learn.dropped.line"],
});

export function logLearnedDrop(
  reason: SalienceDropReason,
  count: number,
  sourceMessageCount: number,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(
      MEMORY_LEARN_DROPPED_OPERATION,
      { correlationId },
      { reason, count, sourceMessageCount },
    ),
  );
}

export const LEARNED_RELATION_DECISIONS = [
  "new",
  "confirmed",
  "merged",
  "superseded",
  "supersession-proposed",
  "unconfirmed-dropped",
  "refused",
] as const;

export type LearnedRelationDecision = (typeof LEARNED_RELATION_DECISIONS)[number];

export const MEMORY_LEARN_RELATION_LABELS = [
  "new",
  "same",
  "update",
  "contradiction",
] as const satisfies readonly FactRelationLabel[];

export const MEMORY_LEARN_CHANGE_BASES = [
  "reversed",
  "number-changed",
  "polarity-changed",
  "slot-changed",
  "stated-change",
  "validity-changed",
] as const satisfies readonly FactChangeBasis[];

const MEMORY_LEARN_RELATION_OPERATION = defineActivityLogOperation({
  ...MEMORY_LEARN_OPERATION_BASE,
  op: "memory.learn.relation",
  emitter: "memory-learned-facts-log.logLearnedRelation",
  fields: {
    label: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_LEARN_RELATION_LABELS,
    },
    decision: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: LEARNED_RELATION_DECISIONS,
    },
    basis: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: MEMORY_LEARN_CHANGE_BASES,
    },
    sourceMessageCount: { type: "integer", dataClass: "count", required: true },
  },
  proofIds: ["memory.learn.relation.line"],
});

export function logLearnedRelation(
  fields: {
    readonly label: FactRelationLabel;
    readonly decision: LearnedRelationDecision;
    readonly basis?: FactChangeBasis;
    readonly sourceMessageCount: number;
  },
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_LEARN_RELATION_OPERATION, { correlationId }, fields),
  );
}
