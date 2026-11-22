import {
  activityLogEvent,
  defineActivityLogOperation,
  type ActivityLogErrorKind,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitSecurityLogEvent, type SecurityLogSink } from "@oscharko-dev/keiko-security";

export type LifecycleHealthOutcome =
  | "healthy"
  | "process-exited"
  | "health-timeout"
  | "identity-mismatch"
  | "spawn-refused"
  | "state-dir-unavailable"
  // A second start found its tracked UI (#4504): alive and verified but not answering in time, so
  // it was left running; answering with another version; or not answering without a verified
  // launch identity. The two stale outcomes restart it.
  | "busy"
  | "stale-version"
  | "stale-unreachable"
  // The tracked record's process id now names another program: its readable command line carries
  // no launch identity. The record is dropped and Keiko starts; the other program is never touched.
  | "stale-foreign";

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
      values: [
        "healthy",
        "process-exited",
        "health-timeout",
        "identity-mismatch",
        "spawn-refused",
        "state-dir-unavailable",
        "busy",
        "stale-version",
        "stale-unreachable",
        "stale-foreign",
      ],
    },
    // How often a second start asked its tracked UI's health again after the first probe (#4504).
    healthRetries: { type: "integer", dataClass: "count", required: false },
    // How often the starting UI process's sign of life restarted the start window (#4358).
    lifeSigns: { type: "integer", dataClass: "count", required: false },
    // How often a sign-of-life record was present but unreadable (a link, not a regular file).
    unreadableSigns: { type: "integer", dataClass: "count", required: false },
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
  signs?: { readonly lifeSigns: number; readonly unreadableSigns: number },
  healthRetries?: number,
): void {
  let errorKind: ActivityLogErrorKind = "unavailable";
  if (outcome === "health-timeout" || outcome === "busy") errorKind = "timeout";
  if (outcome === "identity-mismatch" || outcome === "stale-version") errorKind = "conflict";
  if (outcome === "state-dir-unavailable") errorKind = "permission-denied";
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      LIFECYCLE_HEALTH_OPERATION,
      {
        level: outcome === "healthy" ? "info" : "warn",
        ...(outcome === "healthy" ? {} : { errorKind }),
      },
      {
        phase,
        outcome,
        launchBound,
        completeness: "complete",
        loss: "none",
        ...(signs === undefined
          ? {}
          : { lifeSigns: signs.lifeSigns, unreadableSigns: signs.unreadableSigns }),
        ...(healthRetries === undefined ? {} : { healthRetries }),
      },
    ),
  );
}
