import type { ClientJiraFieldPresentation } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";

const FIELD_COUNT = { type: "integer", dataClass: "count", required: true } as const;
const CLIENT_JIRA_FIELDS_PRESENTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.jira-fields.presented",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-jira-fields-log.logClientJiraFields",
  fields: {
    fieldCount: FIELD_COUNT,
    localizedCount: FIELD_COUNT,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-jira-fields"],
  proofIds: ["client.jira-fields.presented.line"],
  releaseImpact: "patch",
});

/** Ingest admitted a closed count pair; routine localization never masquerades as a failure. */
export function logClientJiraFields(
  presentation: ClientJiraFieldPresentation | undefined,
  delivery: { readonly correlationId: string; readonly parentCorrelationId?: string },
): boolean {
  if (presentation === undefined) return false;
  getServerLogger().info(
    activityLogEvent(CLIENT_JIRA_FIELDS_PRESENTED_OPERATION, delivery, {
      fieldCount: presentation.fieldCount,
      localizedCount: presentation.localizedCount,
      completeness: "complete",
      loss: "none",
    }),
  );
  return true;
}
