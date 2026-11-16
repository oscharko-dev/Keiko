// Activity Log evidence of every memory capture decision the Journal shows (#4206): what Keiko kept,
// accepted, held or refused, and why. Closed values only: neither the person's words, a memory body,
// a memory id nor a scope identity ever enters the line.

import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import type { MemoryScopeKind, MemorySourceKind } from "@oscharko-dev/keiko-contracts/memory";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import type {
  MemoryCaptureDecisionOutcome,
  MemoryCaptureDecisionReason,
} from "./memory-capture-projection.js";
import { getServerLogger } from "./observability/index.js";

// Written out because the catalog generator reads closed values from this file. The `satisfies`
// clauses and the test keep them equal to what a capture decision can carry.
export const MEMORY_CAPTURE_DECISION_LOG_OUTCOMES = [
  "captured",
  "proposed",
  "auto-accepted",
  "rejected",
] as const satisfies readonly MemoryCaptureDecisionOutcome[];

// Every reason a capture decision is written with. `forgotten-by-person` is projected from the
// vault's own forget event and never written as a capture decision.
export const MEMORY_CAPTURE_DECISION_LOG_REASONS = [
  "credential-shape",
  "private-credential-path",
  "provider-base-url",
  "raw-log-content",
  "customer-identifier",
  "denied-category",
  "instruction-override",
  "empty-content",
  "exceeds-length-limit",
  "ambiguous-forget",
  "ambiguous-update",
  "forget-reference-unresolved",
  "restricted-sensitivity",
  "sensitive-memory-requires-approval",
  "suppressed-by-forget",
  "suppressed-by-rejection",
  "scope-not-resolvable",
  "third-party",
  "personal-identifier",
  "denied-content",
  "captured-by-policy",
  "mode-requires-approval",
  "operator-requires-approval",
  "sensitivity-requires-approval",
  "governance-promotion-deferred",
  "governance-auto-accepted",
] as const satisfies readonly MemoryCaptureDecisionReason[];

export const MEMORY_CAPTURE_DECISION_LOG_MODES = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
] as const satisfies readonly CodingWorkbenchMode[];

export const MEMORY_CAPTURE_DECISION_LOG_SURFACES = ["conversation-center", "voice"] as const;

export const MEMORY_CAPTURE_DECISION_LOG_SCOPE_KINDS = [
  "user",
  "workspace",
  "project",
  "workflow",
  "global",
] as const satisfies readonly MemoryScopeKind[];

export const MEMORY_CAPTURE_DECISION_LOG_SOURCE_KINDS = [
  "explicit-user-instruction",
  "accepted-correction",
  "workflow-outcome",
  "consolidation",
  "system-default",
] as const satisfies readonly MemorySourceKind[];

export type MemoryCaptureDecisionLogSurface = (typeof MEMORY_CAPTURE_DECISION_LOG_SURFACES)[number];

const MEMORY_CAPTURE_DECISION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  owner: "keiko-server",
  op: "memory.capture.decision",
  emitter: "memory-capture-decision-log.logMemoryCaptureDecision",
  causal: "none",
  releaseImpact: "patch",
  category: "memory",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["memory-capture-decision"],
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_CAPTURE_DECISION_LOG_OUTCOMES,
    },
    reason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_CAPTURE_DECISION_LOG_REASONS,
    },
    mode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_CAPTURE_DECISION_LOG_MODES,
    },
    surface: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_CAPTURE_DECISION_LOG_SURFACES,
    },
    scopeKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_CAPTURE_DECISION_LOG_SCOPE_KINDS,
    },
    sourceKind: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: MEMORY_CAPTURE_DECISION_LOG_SOURCE_KINDS,
    },
  },
  proofIds: ["memory.capture.decision.line"],
});

export interface MemoryCaptureDecisionLogFields {
  readonly outcome: MemoryCaptureDecisionOutcome;
  readonly reason: Exclude<MemoryCaptureDecisionReason, "forgotten-by-person">;
  readonly mode: CodingWorkbenchMode;
  readonly surface: MemoryCaptureDecisionLogSurface;
  readonly scopeKind: MemoryScopeKind;
  readonly sourceKind: MemorySourceKind;
}

export function logMemoryCaptureDecision(
  fields: MemoryCaptureDecisionLogFields,
  correlationId: string,
): void {
  getServerLogger().info(
    activityLogEvent(MEMORY_CAPTURE_DECISION_OPERATION, { correlationId }, fields),
  );
}
