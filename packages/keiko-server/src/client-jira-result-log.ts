import {
  CLIENT_JIRA_RESULT_FAILURES,
  type ClientJiraResultPresentation,
} from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { getServerLogger } from "./observability/index.js";

const JIRA_RESULT_COUNT_FIELD = { type: "integer", dataClass: "count", required: true } as const;
const CLIENT_JIRA_RESULT_PRESENTED_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "client.jira-result.presented",
  category: "diagnostic",
  owner: "keiko-server",
  emitter: "client-jira-result-log.logClientJiraResult",
  fields: {
    messageDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    exchangeCount: JIRA_RESULT_COUNT_FIELD,
    itemCount: JIRA_RESULT_COUNT_FIELD,
    shownCount: JIRA_RESULT_COUNT_FIELD,
    returnedCount: JIRA_RESULT_COUNT_FIELD,
    unreadableCount: JIRA_RESULT_COUNT_FIELD,
    problemCount: JIRA_RESULT_COUNT_FIELD,
    ruleCount: JIRA_RESULT_COUNT_FIELD,
    failure: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: CLIENT_JIRA_RESULT_FAILURES,
    },
    restored: { type: "boolean", dataClass: "closed-enum", required: true },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["client-jira-result"],
  proofIds: ["client.jira-result.presented.line"],
  releaseImpact: "patch",
});

/** The parent digest joins chat.tool-transcript.updated; correlation identifies delivery only. */
export function logClientJiraResult(
  presentation: ClientJiraResultPresentation | undefined,
  delivery: { readonly correlationId: string; readonly parentCorrelationId?: string },
): boolean {
  if (presentation === undefined) return false;
  getServerLogger().info(
    activityLogEvent(CLIENT_JIRA_RESULT_PRESENTED_OPERATION, delivery, {
      ...presentation,
      completeness: "complete",
      loss: "none",
    }),
  );
  return true;
}
