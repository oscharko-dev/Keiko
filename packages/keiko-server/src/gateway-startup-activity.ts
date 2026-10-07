import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ActivityLogErrorKind } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { processServerLogSink } from "./process-log-sink.js";

const AUTOMATIC_CATALOG_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "gateway.catalog.automatic.completed",
  category: "gateway",
  owner: "keiko-server",
  emitter: "gateway-startup-activity.logAutomaticCatalog",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["applied", "unchanged", "stale", "cancelled", "failed"],
    },
    configuredModelCount: { type: "integer", dataClass: "count", required: true },
    updatedModelCount: { type: "integer", dataClass: "count", required: true },
    elapsedMs: { type: "integer", dataClass: "duration", required: true },
    retryable: { type: "boolean", dataClass: "closed-enum", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "outcome", values: ["failed"] }],
  failureClasses: ["gateway-setup-metadata"],
  proofIds: ["gateway.catalog.automatic.completed.line"],
  releaseImpact: "patch",
});

export function logAutomaticCatalog(
  deps: UiHandlerDeps,
  input: {
    readonly correlationId: string;
    readonly outcome: "applied" | "unchanged" | "stale" | "cancelled" | "failed";
    readonly configuredModelCount: number;
    readonly updatedModelCount: number;
    readonly elapsedMs: number;
    readonly retryable: boolean;
    readonly errorKind?: ActivityLogErrorKind;
  },
): void {
  const { correlationId, errorKind, ...fields } = input;
  (deps.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      AUTOMATIC_CATALOG_OPERATION,
      { correlationId, ...(errorKind === undefined ? {} : { errorKind }) },
      fields,
    ),
  );
}
