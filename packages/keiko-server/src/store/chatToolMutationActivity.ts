import { UiStoreError } from "./errors.js";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/index.js";
import type {
  ChatToolMutationLinkCounts,
  ChatToolMutationRecord,
} from "./chatToolMutationTypes.js";
const MUTATION_STATE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "chat.tool-mutation",
  category: "process",
  owner: "keiko-server",
  emitter: "store.chatToolMutationActivity.recordChatToolMutation",
  fields: {
    consumer: { type: "string", dataClass: "closed-enum", required: false, values: ["coding"] },
    invocationId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    actionDigest: { type: "string", dataClass: "digest", required: true, maxLength: 64 },
    event: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["prepared", "replayed", "dispatched", "response", "settled"],
    },
    phase: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["prepared", "dispatched", "acknowledged", "settled"],
    },
    outcome: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [
        "none",
        "not-dispatched",
        "rejected",
        "succeeded",
        "succeeded-unconfirmed",
        "unknown",
      ],
    },
    // Set on a settled line only: Jira answered the write with a client error and its own error
    // document, so nothing was applied (#4176). Absent for a refusal before dispatch.
    rejection: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: ["jira-error-document"],
    },
    // Issue links one write asked for, on its `settled` line only (#4176): counts, never keys.
    linkRequestedCount: { type: "integer", dataClass: "count", required: false },
    linkCreatedCount: { type: "integer", dataClass: "count", required: false },
    linkFailedCount: { type: "integer", dataClass: "count", required: false },
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  diagnosticWhen: [{ field: "linkFailedCount", positive: true }],
  failureClasses: ["chat-tool-mutation"],
  proofIds: ["chat.tool-mutation.emitted-line"],
  releaseImpact: "patch",
});
/** A settled rejection that followed a response is Jira's own refusal; a local one has no status. */
function remoteRejection(
  event: string,
  record: ChatToolMutationRecord,
): { readonly rejection?: "jira-error-document" } {
  return event === "settled" && record.outcome === "rejected" && record.httpStatus !== null
    ? { rejection: "jira-error-document" }
    : {};
}
export function recordChatToolMutation(
  log: ServerLogSink,
  record: ChatToolMutationRecord,
  event: "prepared" | "replayed" | "dispatched" | "response" | "settled",
  links?: ChatToolMutationLinkCounts,
): void {
  try {
    log.write(
      activityLogEvent(
        MUTATION_STATE,
        {
          correlationId: record.correlationId,
          level: record.outcome === "unknown" ? "warn" : "info",
        },
        {
          invocationId: record.invocationId,
          ...(record.consumer === undefined ? {} : { consumer: record.consumer.kind }),
          actionDigest: record.actionDigest,
          event,
          phase: record.phase,
          outcome: record.outcome ?? "none",
          ...remoteRejection(event, record),
          ...(links === undefined
            ? {}
            : {
                linkRequestedCount: links.requested,
                linkCreatedCount: links.created,
                linkFailedCount: links.failed,
              }),
          completeness: "complete",
          loss: "none",
        },
      ),
    );
  } catch {
    recordActivityLogLoss("port-sink-failed");
    if (event === "prepared" || event === "dispatched")
      throw new UiStoreError(
        "INTERNAL",
        "The mutation journal activity could not be recorded.",
        500,
      );
  }
}
