import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  type AtlassianConnectorActivityRecord,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianConnectorCredentialDeps } from "./credentialRoutes.js";
import { processServerLogSink } from "../process-log-sink.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";

const ACTION_OUTCOME = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "atlassian.action.outcome",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.actionOutcomeActivity.recordAtlassianActionOutcome",
  fields: {
    provider: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["jira", "confluence"],
    },
    actionType: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "sync-space",
        "sync-project",
        "search-issues-live",
        "create-issue",
        "update-issue-fields",
        "transition-issue",
        "add-issue-comment",
        "create-page",
        "update-page",
        "add-page-comment",
      ],
    },
    disposition: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["allowed", "review-required", "denied"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["succeeded", "failed", "denied", "cancelled", "pending-review"],
    },
    failureReason: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "auth-failed",
        "permission-denied",
        "not-found",
        "rate-limited",
        "timeout",
        "unavailable",
        "malformed-payload",
        "bounds-exceeded",
        "conflict",
        "invalid-transition",
        "field-validation",
        "other",
        "none",
      ],
    },
    deploymentCeiling: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["governed-assist", "supervised-coding", "autonomous-delivery"],
    },
    durationMs: { type: "integer", dataClass: "count", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "end",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["atlassian.action.outcome.line"],
  releaseImpact: "patch",
});

/** Project the existing action owner's result, excluding targets, credential refs and content. */
export function recordAtlassianActionOutcome(
  deps: Pick<AtlassianConnectorCredentialDeps, "activityLog" | "diagnostics">,
  record: AtlassianConnectorActivityRecord,
  deploymentCeiling: CodingWorkbenchMode,
): void {
  try {
    (deps.activityLog ?? processServerLogSink()).write(
      activityLogEvent(
        ACTION_OUTCOME,
        {
          correlationId: record.correlationId,
          level: record.outcome === "failed" ? "error" : "info",
        },
        {
          provider: record.provider,
          actionType: record.actionType,
          disposition: record.disposition,
          outcome: record.outcome,
          durationMs: record.durationMs,
          deploymentCeiling,
          failureReason:
            record.reasonCode === undefined
              ? "none"
              : (ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS.find(
                  (reason) => reason === record.reasonCode,
                ) ?? "other"),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch (error) {
    recordActivityLogLoss("port-sink-failed");
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: record.correlationId,
        operation: "atlassian.action.log-failed",
        source: "atlassian-action-activity",
        error,
        redact: () => "server-operation-failed",
      }),
    );
  }
}
