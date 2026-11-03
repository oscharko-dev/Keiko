import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { emitSecurityLogEvent, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import { correlationIdOrUnknown } from "./correlation.js";

type NativeHandoffPhase = "admission" | "acceptance" | "commit" | "cleanup";
type NativeHandoffOutcome = "completed" | "failed" | "uncertain";

const NATIVE_HANDOFF_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "update.portable.native-control",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "update-native-handoff-activity.emitNativeHandoffState",
  fields: {
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["admission", "acceptance", "commit", "cleanup"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["completed", "failed", "uncertain"],
    },
    nativeAuthorityMayBeLive: { type: "boolean", dataClass: "closed-enum", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["update-runtime"],
  proofIds: ["update.portable.native-control.lifetime"],
  releaseImpact: "patch",
});

export function emitNativeHandoffState(
  sink: SecurityLogSink | undefined,
  correlationId: string,
  phase: NativeHandoffPhase,
  outcome: NativeHandoffOutcome,
  nativeAuthorityMayBeLive: boolean,
): void {
  emitSecurityLogEvent(
    sink,
    activityLogEvent(
      NATIVE_HANDOFF_OPERATION,
      {
        correlationId: correlationIdOrUnknown(correlationId),
        level: outcome === "completed" ? "info" : "warn",
        ...(outcome === "completed" ? {} : { errorKind: "unavailable" }),
      },
      { phase, outcome, nativeAuthorityMayBeLive, completeness: "complete", loss: "none" },
    ),
  );
}
