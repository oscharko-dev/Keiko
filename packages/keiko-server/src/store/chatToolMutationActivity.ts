import { UiStoreError } from "./errors.js";
import {
  activityLogEvent,
  defineActivityLogOperation,
  recordActivityLogLoss,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { ServerLogSink } from "../observability/index.js";
import type {
  ChatToolMutationLinkCounts,
  ChatToolMutationLocalRefusal,
  ChatToolMutationRecord,
} from "./chatToolMutationTypes.js";
// Keiko's closed write-failure and field-validation vocabularies. `localRefusal` assigns the
// contract types to them, so a reason the contracts add fails the type check until it is listed.
const REFUSAL_REASONS = [
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
] as const;
const FIELD_VALIDATIONS = [
  "required-field",
  "unsupported-field",
  "invalid-field",
  "invalid-operation",
  "bounds-exceeded",
] as const;
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
    // Set on a settled line only: Keiko refused the write before dispatch, with its own closed
    // reason and, for a field refusal, the closed validation class (#4173). Never a field value.
    refusalReason: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: REFUSAL_REASONS,
    },
    fieldValidation: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: FIELD_VALIDATIONS,
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
/** Keiko's own reason for a local refusal; absent once Jira answered. */
function localRefusal(
  record: ChatToolMutationRecord,
  refusal: ChatToolMutationLocalRefusal | undefined,
): {
  readonly refusalReason?: (typeof REFUSAL_REASONS)[number];
  readonly fieldValidation?: (typeof FIELD_VALIDATIONS)[number];
} {
  if (refusal === undefined || record.outcome !== "rejected" || record.httpStatus !== null)
    return {};
  return {
    refusalReason: refusal.reason,
    ...(refusal.validation === undefined ? {} : { fieldValidation: refusal.validation }),
  };
}
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
  refusal?: ChatToolMutationLocalRefusal,
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
          ...localRefusal(record, refusal),
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
