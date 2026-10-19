import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitSecurityLogEvent, type SecurityLogSink } from "@oscharko-dev/keiko-security";

export type LifecycleHealthOutcome =
  "healthy" | "process-exited" | "health-timeout" | "identity-mismatch";

const LIFECYCLE_HEALTH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.lifecycle.health",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "lifecycle-health-activity.emitLifecycleHealth",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["start", "tracked"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["healthy", "process-exited", "health-timeout", "identity-mismatch"],
    },
    launchBound: { type: "boolean", dataClass: "closed-enum", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["process-startup"],
  proofIds: ["cli.lifecycle.health.decision"],
  releaseImpact: "patch",
});

export function emitLifecycleHealth(
  sink: SecurityLogSink | undefined,
  phase: "start" | "tracked",
  outcome: LifecycleHealthOutcome,
  launchBound: boolean,
): void {
  let errorKind: ActivityLogErrorKind = "unavailable";
  if (outcome === "health-timeout") errorKind = "timeout";
  if (outcome === "identity-mismatch") errorKind = "conflict";
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      LIFECYCLE_HEALTH_OPERATION,
      {
        level: outcome === "healthy" ? "info" : "warn",
        ...(outcome === "healthy" ? {} : { errorKind }),
      },
      { phase, outcome, launchBound, completeness: "complete", loss: "none" },
    ),
  );
}
