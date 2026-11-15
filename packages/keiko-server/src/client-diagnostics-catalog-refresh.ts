// #4371: a Knowledge Pod catalog refresh the picker did not wait for, because it kept its last good
// snapshot: a slow answer, a failure, or a request a later refresh superseded. Routine, closed
// outcome and duration bucket only. The registration lives beside its emitter, apart from the
// shared ingest route, which hands over the validated report and its correlation envelope.

import type { ClientKnowledgeCatalogRefresh } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  CLIENT_KNOWLEDGE_CATALOG_REFRESH_DURATIONS,
  CLIENT_KNOWLEDGE_CATALOG_REFRESH_OUTCOMES,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

const CLIENT_KNOWLEDGE_CATALOG_REFRESH_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.knowledge-catalog.refreshed",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-diagnostics-catalog-refresh.knowledgeCatalogRefreshEvent",
  fields: {
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CLIENT_KNOWLEDGE_CATALOG_REFRESH_OUTCOMES,
    },
    duration: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CLIENT_KNOWLEDGE_CATALOG_REFRESH_DURATIONS,
    },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-knowledge-catalog-refresh"],
  proofIds: ["client.knowledge-catalog.refreshed.line"],
  releaseImpact: "patch",
});

// The ingest guard admits exactly the two closed fields, so the report is spread as it is.
export function knowledgeCatalogRefreshEvent(
  report: ClientKnowledgeCatalogRefresh,
  envelope: { readonly correlationId: string; readonly parentCorrelationId?: string },
): ReturnType<typeof activityLogEvent> {
  return activityLogEvent(CLIENT_KNOWLEDGE_CATALOG_REFRESH_OPERATION, envelope, {
    ...report,
    completeness: "complete",
    loss: "none",
  });
}
