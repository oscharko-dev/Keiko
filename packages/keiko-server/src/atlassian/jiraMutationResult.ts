import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
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
    return REASONS.has(reason) ? { ok: false, reason } : { ok: false, reason: "malformed-payload" };
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

export function jiraMutationToolResult(
  outcome: JiraMutationResultState,
  reason?: AtlassianConnectorWriteFailureReason,
  receipt: JiraMutationReceipt = {},
  replayed = false,
): ManagedMcpToolResult {
  return {
    data: {
      ...receipt,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      ...(replayed ? { replayed: true } : {}),
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
  );
}
