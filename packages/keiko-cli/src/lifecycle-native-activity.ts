import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";

const NATIVE_OWNER_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "cli.lifecycle.native-owner",
  category: "diagnostic",
  owner: "keiko-cli",
  emitter: "lifecycle-native-activity.emitNativeUiOwnership",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["reservation", "admission", "commit", "cleanup"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["acknowledged", "refused", "uncertain", "reaped", "held"],
    },
    failureKind: { type: "string", dataClass: "error-kind", required: false, maxLength: 64 },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "process-lifecycle",
  failureClasses: ["process-startup"],
  proofIds: ["cli.lifecycle.native-owner.outcome"],
  releaseImpact: "patch",
});

export function emitNativeUiOwnership(
  sink: SecurityLogSink | undefined,
  phase: "reservation" | "admission" | "commit" | "cleanup",
  outcome: "acknowledged" | "refused" | "uncertain" | "reaped" | "held",
  error?: unknown,
): void {
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      NATIVE_OWNER_OPERATION,
      {
        level: outcome === "acknowledged" || outcome === "reaped" ? "info" : "warn",
        ...(outcome === "acknowledged" || outcome === "reaped" ? {} : { errorKind: "unavailable" }),
      },
      {
        phase,
        outcome,
        ...(error === undefined ? {} : { failureKind: securityErrorKind(error) }),
        completeness: "complete",
        loss: "none",
      },
    ),
  );
}
