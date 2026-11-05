import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { contentFreeErrorClass, emitServerDiagnostic } from "../diagnostics-log.js";

const TARGET_ADMISSION_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.target.admission",
  category: "setup",
  owner: "keiko-server",
  emitter: "atlassian.targetAdmissionActivity.recordTargetAdmission",
  fields: {
    source: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["saved-data-center", "default-public"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["admitted", "blocked", "failed"],
    },
    addressClass: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["public", "private", "loopback"],
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-credential-custody"],
  proofIds: ["atlassian.target.admission.line"],
  releaseImpact: "patch",
});

export function recordTargetAdmission(
  sink: ServerLogSink | undefined,
  correlationId: string,
  source: "saved-data-center" | "default-public",
  outcome: "admitted" | "blocked" | "failed",
  addressClass?: "public" | "private" | "loopback",
): void {
  try {
    sink?.write(
      activityLogEvent(
        TARGET_ADMISSION_OPERATION,
        { correlationId },
        {
          source,
          outcome,
          ...(addressClass === undefined ? {} : { addressClass }),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    emitServerDiagnostic(undefined, {
      correlationId,
      timestamp: new Date().toISOString(),
      operation: "atlassian.target.admission",
      source: "atlassian-target-admission-activity",
      errorClass: contentFreeErrorClass(error),
      message: "atlassian-target-admission-activity-log-failed",
    });
  }
}
