import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  isSafeAtlassianIdentifier,
  sanitizeJiraMutationFailureDetail,
  sanitizeJiraMutationLinkAccount,
  type AtlassianConnectorWriteFailureReason,
  type JiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationLinkAccount,
  type JiraMutationOperation,
  type JiraMutationOutcome,
  type JiraMutationReceipt,
  type JiraMutationResultState,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";

/**
 * The shared projection of a Jira mutation attempt onto the managed tool result. Ordinary Chat and
 * Coding runs both end a mutation here, so a receipt or a reason can never mean two things.
 */
const REASONS: ReadonlySet<string> = new Set(ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS);
const RULE_IDS: ReadonlySet<string> = new Set(JIRA_TEMPLATE_RULE_IDS);
const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  "issueKey",
  "issueId",
  "commentId",
  "transitionId",
  "attachmentId",
]);
const REQUIRED_RECEIPTS: Readonly<
  Record<JiraMutationOperation, readonly (keyof JiraMutationReceipt)[]>
> = {
  "jira.create": ["issueKey", "issueId"],
  "jira.edit": ["issueKey"],
  "jira.assign": ["issueKey"],
  "jira.comment": ["issueKey", "commentId"],
  "jira.transition": ["issueKey", "transitionId"],
  "jira.attach": ["issueKey", "attachmentId"],
  // A draft is never one attempt: each item is a journaled jira.create with its own receipt.
  "jira.draft": ["issueKey", "issueId"],
};

function confirmed(value: unknown): boolean {
  return value === true;
}

function validIdentities(receipt: JiraMutationReceipt): boolean {
  return Object.entries(receipt).every(
    ([key, id]) => RECEIPT_KEYS.has(key) && isSafeAtlassianIdentifier(id),
  );
}

/**
 * A failed attempt names the issue only when the issue exists although the attempt did not finish
 * (#4176): the partial effect, with the link account saying what is missing. Both are revalidated
 * here, and an identity that does not validate is dropped, never forwarded.
 */
function failedAttempt(
  value: Extract<JiraMutationAttempt, { ok: false }>,
): Extract<JiraMutationAttempt, { ok: false }> {
  if (!REASONS.has(value.reason)) return { ok: false, reason: "malformed-payload" };
  const detail = sanitizeJiraMutationFailureDetail(value.detail);
  const links = sanitizeJiraMutationLinkAccount(value.links);
  // Only an issue-template refusal carries violations; no other reason may smuggle them in.
  const violations =
    value.reason === "field-validation" ? boundedViolations(value.violations) : undefined;
  const receipt =
    value.receipt !== undefined &&
    isSafeAtlassianIdentifier(value.receipt.issueKey) &&
    validIdentities(value.receipt)
      ? Object.freeze({ ...value.receipt })
      : undefined;
  return {
    ok: false,
    reason: value.reason,
    ...(detail === undefined ? {} : { detail }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(links === undefined ? {} : { links }),
    ...(violations === undefined ? {} : { violations }),
  };
}

function boundedViolations(
  value: readonly JiraTemplateViolation[] | undefined,
): readonly JiraTemplateViolation[] | undefined {
  if (value === undefined) return undefined;
  const valid = value
    .filter(
      (item) =>
        RULE_IDS.has(item.ruleId) &&
        typeof item.subject === "string" &&
        typeof item.template === "string",
    )
    .slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX)
    .map(({ ruleId, subject, template }) => ({
      ruleId,
      subject: subject.slice(0, 120),
      template: template.slice(0, 256),
    }));
  return valid.length === 0 ? undefined : valid;
}

/** An attempt is a success only with the validated identities its operation must return. */
export function validJiraMutationAttempt(
  value: JiraMutationAttempt,
  operation: JiraMutationOperation,
): JiraMutationAttempt {
  if (!value.ok) return failedAttempt(value);
  const receipt = Object.freeze({ ...value.receipt });
  const valid =
    confirmed(value.ok) &&
    REQUIRED_RECEIPTS[operation].every((key) => receipt[key] !== undefined) &&
    validIdentities(receipt);
  if (!valid) return { ok: false, reason: "malformed-payload" };
  const links = sanitizeJiraMutationLinkAccount(value.links);
  return { ok: true, receipt, ...(links === undefined ? {} : { links }) };
}

/** Counts only: how many links were requested, present afterwards and missing. */
export interface JiraLinkCounts {
  readonly requested: number;
  readonly created: number;
  readonly failed: number;
}
export function jiraLinkCounts(attempt: JiraMutationAttempt): JiraLinkCounts | undefined {
  const links = attempt.links;
  if (links === undefined) return undefined;
  return {
    requested: links.requested,
    created: links.created,
    failed: links.requested - links.created,
  };
}
/** The same counts, read back from a tool result's data (which already passed `linkData`). */
export function jiraLinkCountsOfResult(
  data: Readonly<Record<string, unknown>> | undefined,
): JiraLinkCounts | undefined {
  const requested = data?.linksRequested;
  const created = data?.linksCreated;
  if (typeof requested !== "number" || typeof created !== "number") return undefined;
  return { requested, created, failed: Math.max(0, requested - created) };
}

function linkData(links: JiraMutationLinkAccount | undefined): Record<string, unknown> {
  if (links === undefined) return {};
  return {
    linksRequested: links.requested,
    linksCreated: links.created,
    ...(links.missing.length === 0
      ? {}
      : { linksMissing: links.missing.map((link) => ({ ...link })) }),
    ...(links.unconfirmed ? { linksUnconfirmed: true } : {}),
  };
}

/**
 * Fixed instructions to the model, never derived from remote text. Keiko's users are knowledge
 * workers, not developers: a refused or uncertain change must end the turn with an answer they can
 * act on, never with a stall or a raw error.
 */
export const JIRA_REJECTED_GUIDANCE =
  "Jira refused this change and nothing was changed. Correct the fields named in fieldErrors (fieldId, fieldName, message) or messages, then send the corrected change once. If Jira refuses it again, tell the user in plain language which field is the problem and what Jira said.";
export const JIRA_UNCERTAIN_GUIDANCE =
  "Whether this change reached Jira is uncertain. Do not repeat it and make no further change in this turn. Tell the user in plain language that the change may or may not have been applied and ask them to check the issue in Jira before deciding whether to try again.";

/** The instruction a result carries, or undefined when the outcome needs none. */
export function jiraResultGuidance(
  outcome: JiraMutationResultState,
  reason: AtlassianConnectorWriteFailureReason | undefined,
  detail: JiraMutationFailureDetail | undefined,
): string | undefined {
  if (uncertainOutcome(outcome, reason)) return JIRA_UNCERTAIN_GUIDANCE;
  return outcome === "rejected" && jiraExplained(detail) ? JIRA_REJECTED_GUIDANCE : undefined;
}
function uncertainOutcome(
  outcome: JiraMutationResultState,
  reason: AtlassianConnectorWriteFailureReason | undefined,
): boolean {
  if (outcome === "unknown" || outcome === "succeeded-unconfirmed") return true;
  // A write blocked behind an uncertain one of the same turn is answered like it.
  return outcome === "not-dispatched" && reason === "conflict";
}
function jiraExplained(detail: JiraMutationFailureDetail | undefined): boolean {
  return (detail?.fieldErrors?.length ?? 0) > 0 || (detail?.messages?.length ?? 0) > 0;
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
  links?: JiraMutationLinkAccount,
  violations?: readonly JiraTemplateViolation[],
): ManagedMcpToolResult {
  const guidance = jiraResultGuidance(outcome, reason, detail);
  return {
    data: {
      ...receipt,
      outcome,
      ...(guidance === undefined ? {} : { guidance }),
      ...(reason === undefined ? {} : { reason }),
      ...(replayed ? { replayed: true } : {}),
      ...detailData(detail),
      ...linkData(links),
      ...(violations === undefined ? {} : { violations: violations.map((item) => ({ ...item })) }),
    },
    ...(outcome === "succeeded" ? {} : { isError: true }),
  };
}

/**
 * The receipt is returned on success, and on a failure only when the issue exists (a partial effect
 * of #4176): the model must learn the issue was created and which links are missing, so it repairs
 * the links instead of creating the issue again.
 */
function attemptReceipt(
  outcome: JiraMutationOutcome,
  attempt: JiraMutationAttempt,
): JiraMutationReceipt {
  if (attempt.ok) return outcome === "succeeded" ? attempt.receipt : {};
  return attempt.receipt ?? {};
}
export function jiraAttemptToolResult(
  outcome: JiraMutationOutcome,
  attempt: JiraMutationAttempt,
): ManagedMcpToolResult {
  return jiraMutationToolResult(
    outcome,
    attempt.ok ? undefined : attempt.reason,
    attemptReceipt(outcome, attempt),
    false,
    attempt.ok ? undefined : attempt.detail,
    attempt.links,
    attempt.ok ? undefined : attempt.violations,
  );
}
