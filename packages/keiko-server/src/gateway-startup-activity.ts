import {
  activityLogAutomaticCatalogFields,
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
  fields: activityLogAutomaticCatalogFields(),
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  diagnosticWhen: [
    { field: "outcome", values: ["failed"] },
    { field: "retryDisposition", values: ["exhausted"] },
  ],
  failureClasses: ["gateway-setup-metadata"],
  proofIds: ["gateway.catalog.automatic.completed.line"],
  releaseImpact: "patch",
});

export interface CatalogBackgroundAttempt {
  readonly backgroundAttempt: number;
  readonly configurationGeneration: number;
}

type StartupRetryDisposition =
  "scheduled" | "exhausted" | "coalesced" | "in-flight" | "backoff" | "conclusive" | "complete";

export function logStartupRetryDecision(
  deps: UiHandlerDeps,
  input: CatalogBackgroundAttempt & {
    readonly correlationId: string;
    readonly configuredModelCount: number;
    readonly retryDisposition: StartupRetryDisposition;
    readonly retryDelayMs?: number;
    readonly retryDeadlineMs?: number;
  },
): void {
  const startedAt = Date.now();
  logAutomaticCatalog(deps, {
    ...input,
    phase: "retry-decision",
    outcome: "retry-decision",
    updatedModelCount: 0,
    addedModelCount: 0,
    removedModelCount: 0,
    deploymentChangedModelCount: 0,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    retryable:
      input.retryDisposition !== "exhausted" &&
      input.retryDisposition !== "conclusive" &&
      input.retryDisposition !== "complete",
  });
}

export function logAutomaticCatalog(
  deps: UiHandlerDeps,
  input: {
    readonly correlationId: string;
    readonly outcome: "applied" | "unchanged" | "stale" | "cancelled" | "failed" | "retry-decision";
    readonly phase?: "catalog" | "retry-decision";
    readonly backgroundAttempt?: number;
    readonly configurationGeneration?: number;
    readonly retryDisposition?: StartupRetryDisposition;
    readonly retryDelayMs?: number;
    readonly retryDeadlineMs?: number;
    readonly configuredModelCount: number;
    readonly updatedModelCount: number;
    readonly addedModelCount: number;
    readonly removedModelCount: number;
    readonly deploymentChangedModelCount: number;
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
