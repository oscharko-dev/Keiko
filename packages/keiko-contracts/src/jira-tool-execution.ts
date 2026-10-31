import type { AtlassianConnectorWriteFailureReason } from "./atlassian-connectors.js";

/** Remote effects remain separate from the enclosing MCP/catalog terminal status. */
export const JIRA_MUTATION_OPERATIONS = [
  "jira.create",
  "jira.edit",
  "jira.assign",
  "jira.comment",
  "jira.transition",
] as const;
export type JiraMutationOperation = (typeof JIRA_MUTATION_OPERATIONS)[number];
/** Rejected means a known local refusal before dispatch; non-2xx status alone remains unknown. */
export const JIRA_MUTATION_OUTCOMES = [
  "not-dispatched",
  "rejected",
  "succeeded",
  "succeeded-unconfirmed",
  "unknown",
] as const;
export type JiraMutationOutcome = (typeof JIRA_MUTATION_OUTCOMES)[number];

/** Pending means no authoritative final outcome is available, including orphaned records after
 * restart. It neither asserts an active executor nor permits takeover or another dispatch. */
export const JIRA_MUTATION_RESULT_STATES = [...JIRA_MUTATION_OUTCOMES, "pending"] as const;
export type JiraMutationResultState = (typeof JIRA_MUTATION_RESULT_STATES)[number];

/** Validated Jira identities only; remote bodies and headers never become a mutation receipt. */
export interface JiraMutationReceipt {
  readonly issueKey?: string;
  readonly issueId?: string;
  readonly commentId?: string;
  readonly transitionId?: string;
}
/** Why Keiko's own metadata validation refused a field before dispatch (#4176). */
export const JIRA_FIELD_VALIDATION_FAILURES = [
  "required-field",
  "unsupported-field",
  "invalid-field",
  "invalid-operation",
  "bounds-exceeded",
] as const;
export type JiraFieldValidationFailure = (typeof JIRA_FIELD_VALIDATION_FAILURES)[number];
export const JIRA_MUTATION_DETAIL_LIMITS = Object.freeze({
  fieldErrors: 8,
  messages: 3,
  messageChars: 200,
});
export interface JiraMutationFieldError {
  readonly fieldId: string;
  readonly message: string;
}
/**
 * What the caller needs to correct a refused write: the refused field and Keiko's closed reason, or
 * Jira's own bounded field errors and messages. Returned to the model only, never logged (#4176).
 */
export interface JiraMutationFailureDetail {
  readonly fieldId?: string;
  readonly validation?: JiraFieldValidationFailure;
  readonly fieldErrors?: readonly JiraMutationFieldError[];
  readonly messages?: readonly string[];
}
export type JiraMutationAttempt =
  | { readonly ok: true; readonly receipt: JiraMutationReceipt }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly detail?: JiraMutationFailureDetail;
    };

// eslint-disable-next-line no-control-regex -- remote text is shown to a model, not a terminal.
const DETAIL_CONTROL = /[\u0000-\u001f\u007f-\u009f]+/gu;
const DETAIL_FIELD_ID = /^(?:[a-zA-Z][a-zA-Z0-9]{0,63}|customfield_\d{1,16})$/u;
function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(DETAIL_CONTROL, " ").trim();
  if (text.length === 0) return undefined;
  const limit = JIRA_MUTATION_DETAIL_LIMITS.messageChars;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
function detailFieldId(value: unknown): value is string {
  return typeof value === "string" && DETAIL_FIELD_ID.test(value);
}
function detailFieldErrors(value: unknown): readonly JiraMutationFieldError[] {
  if (!Array.isArray(value)) return [];
  const errors: JiraMutationFieldError[] = [];
  for (const entry of value.slice(0, JIRA_MUTATION_DETAIL_LIMITS.fieldErrors) as unknown[]) {
    const record = typeof entry === "object" && entry !== null ? entry : {};
    const fieldId: unknown = Reflect.get(record, "fieldId");
    const message = detailText(Reflect.get(record, "message"));
    if (detailFieldId(fieldId) && message !== undefined) errors.push({ fieldId, message });
  }
  return errors;
}
function detailMessages(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .map(detailText)
    .filter((text): text is string => text !== undefined)
    .slice(0, JIRA_MUTATION_DETAIL_LIMITS.messages);
}
const VALIDATION_FAILURES: ReadonlySet<unknown> = new Set(JIRA_FIELD_VALIDATION_FAILURES);
/** One bounded, control-free projection, applied wherever a detail crosses a boundary. */
export function sanitizeJiraMutationFailureDetail(
  value: unknown,
): JiraMutationFailureDetail | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fieldId: unknown = Reflect.get(value, "fieldId");
  const validation: unknown = Reflect.get(value, "validation");
  const fieldErrors = detailFieldErrors(Reflect.get(value, "fieldErrors"));
  const messages = detailMessages(Reflect.get(value, "messages"));
  const detail: JiraMutationFailureDetail = {
    ...(detailFieldId(fieldId) ? { fieldId } : {}),
    ...(VALIDATION_FAILURES.has(validation)
      ? { validation: validation as JiraFieldValidationFailure }
      : {}),
    ...(fieldErrors.length === 0 ? {} : { fieldErrors }),
    ...(messages.length === 0 ? {} : { messages }),
  };
  return Object.keys(detail).length === 0 ? undefined : detail;
}
