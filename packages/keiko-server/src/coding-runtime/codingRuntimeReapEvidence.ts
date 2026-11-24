import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { causeChain, keikoStackFrames } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

/** The steps by which the manager ends a run's process tree; each is recorded, none is silent. */
export type RuntimeReapStage =
  | "graceful-timed-out"
  | "graceful-failed"
  | "forced"
  | "force-failed"
  | "recovery-required"
  | "recovery-mark-failed";

export type RuntimeReapOutcome = "escalated" | "reaped" | "unproven" | "failed";

export const CODING_RUNTIME_REAP_STAGE_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.reap.stage",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.codingRuntimeReapEvidence.recordReapStage",
  fields: {
    stage: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "graceful-timed-out",
        "graceful-failed",
        "forced",
        "force-failed",
        "recovery-required",
        "recovery-mark-failed",
      ],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["escalated", "reaped", "unproven", "failed"],
    },
    durationMs: { type: "integer", dataClass: "duration", required: true },
    frames: {
      type: "string-array",
      dataClass: "opaque-id",
      required: false,
      maxLength: 512,
      maxItems: 8,
    },
    causeChain: {
      type: "string-array",
      dataClass: "error-kind",
      required: false,
      maxLength: 128,
      maxItems: 5,
    },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "process-lifecycle",
  diagnosticWhen: [{ field: "outcome", values: ["unproven", "failed"] }],
  failureClasses: ["coding-runtime-reap"],
  proofIds: ["coding-runtime.reap.stage.emitted-line"],
  releaseImpact: "patch",
});

export interface RuntimeReapStageRecord {
  readonly runId: string;
  readonly stage: RuntimeReapStage;
  readonly outcome: RuntimeReapOutcome;
  readonly durationMs: number;
  /** The failure that ended the step, when it threw. */
  readonly error?: unknown;
}

/** Records one step of ending a run's process tree, under the run's correlation id; body-free. */
export function recordReapStage(sink: ServerLogSink, record: RuntimeReapStageRecord): void {
  const failed = record.outcome === "unproven" || record.outcome === "failed";
  sink.write(
    activityLogEvent(
      CODING_RUNTIME_REAP_STAGE_OPERATION,
      failed
        ? { level: "warn", correlationId: record.runId, errorKind: "internal" }
        : { level: "info", correlationId: record.runId },
      {
        stage: record.stage,
        outcome: record.outcome,
        durationMs: Math.max(0, Math.round(record.durationMs)),
        ...(record.error === undefined
          ? {}
          : { frames: keikoStackFrames(record.error), causeChain: causeChain(record.error) }),
      },
    ),
  );
}
