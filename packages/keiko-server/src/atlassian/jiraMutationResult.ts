import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  isSafeAtlassianIdentifier,
  sanitizeJiraMutationFailureDetail,
  type AtlassianConnectorWriteFailureReason,
  type JiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationOperation,
  type JiraMutationOutcome,
  type JiraMutationReceipt,
  type JiraMutationResultState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

/**
 * The shared projection of a Jira mutation attempt onto the managed tool result. Ordinary Chat and
 * Coding runs both end a mutation here, so a receipt or a reason can never mean two things.
 */
const REASONS: ReadonlySet<string> = new Set(ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS);
const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  "issueKey",
  "issueId",
  "commentId",
  "transitionId",
]);
const REQUIRED_RECEIPTS: Readonly<
  Record<JiraMutationOperation, readonly (keyof JiraMutationReceipt)[]>
> = {
  "jira.create": ["issueKey", "issueId"],
  "jira.edit": ["issueKey"],
  "jira.assign": ["issueKey"],
  "jira.comment": ["issueKey", "commentId"],
  "jira.transition": ["issueKey", "transitionId"],
  // A draft is never one attempt: each item is a journaled jira.create with its own receipt.
  "jira.draft": ["issueKey", "issueId"],
};

function confirmed(value: unknown): boolean {
  return value === true;
}

/** An attempt is a success only with the validated identities its operation must return. */
export function validJiraMutationAttempt(
  value: JiraMutationAttempt,
  operation: JiraMutationOperation,
): JiraMutationAttempt {
  if (!value.ok) {
    const reason = value.reason;
    if (!REASONS.has(reason)) return { ok: false, reason: "malformed-payload" };
    const detail = sanitizeJiraMutationFailureDetail(value.detail);
    return { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
  }
  const receipt = Object.freeze({ ...value.receipt });
  const valid =
    confirmed(value.ok) &&
    REQUIRED_RECEIPTS[operation].every((key) => receipt[key] !== undefined) &&
    Object.entries(receipt).every(
      ([key, id]) => RECEIPT_KEYS.has(key) && isSafeAtlassianIdentifier(id),
    );
  return valid ? { ok: true, receipt } : { ok: false, reason: "malformed-payload" };
}

function detailData(detail: JiraMutationFailureDetail | undefined): Record<string, unknown> {
  if (detail === undefined) return {};
  return {
    ...(detail.fieldId === undefined ? {} : { fieldId: detail.fieldId }),
    ...(detail.validation === undefined ? {} : { validation: detail.validation }),
    ...(detail.fieldErrors === undefined
      ? {}
      : { fieldErrors: detail.fieldErrors.map((error) => ({ ...error })) }),
    ...(detail.messages === undefined ? {} : { messages: [...detail.messages] }),
  };
}
export function jiraMutationToolResult(
  outcome: JiraMutationResultState,
  reason?: AtlassianConnectorWriteFailureReason,
  receipt: JiraMutationReceipt = {},
  replayed = false,
  detail?: JiraMutationFailureDetail,
): ManagedMcpToolResult {
  return {
    data: {
      ...receipt,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(replayed ? { replayed: true } : {}),
      ...detailData(detail),
    },
    ...(outcome === "succeeded" ? {} : { isError: true }),
  };
}

export function jiraAttemptToolResult(
  outcome: JiraMutationOutcome,
  attempt: JiraMutationAttempt,
): ManagedMcpToolResult {
  return jiraMutationToolResult(
    outcome,
    attempt.ok ? undefined : attempt.reason,
    outcome === "succeeded" && attempt.ok ? attempt.receipt : {},
    false,
    attempt.ok ? undefined : attempt.detail,
  );
}
