import type { AtlassianConnectorWriteFailureReason } from "./atlassian-connectors.js";

/** Remote effects remain separate from the enclosing MCP/catalog terminal status. */
export const JIRA_MUTATION_OPERATIONS = [
  "jira.create",
  "jira.edit",
  "jira.assign",
  "jira.comment",
  "jira.transition",
  "jira.draft",
] as const;
export type JiraMutationOperation = (typeof JIRA_MUTATION_OPERATIONS)[number];

/**
 * A backlog draft (#4178): related issues proposed together, approved once, created in dependency
 * order. Each item runs as its own journaled `jira.create`; the draft itself is never dispatched.
 */
// Every item is one journaled write, and the Chat journal admits at most 32 writes per turn.
export const JIRA_DRAFT_ITEMS_MAX = 32;
/** A model-chosen local reference that relations between draft items use before keys exist. */
export const JIRA_DRAFT_REF_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,31}$";
const DRAFT_REF = new RegExp(JIRA_DRAFT_REF_PATTERN, "u");
export function isJiraDraftRef(value: unknown): value is string {
  return typeof value === "string" && DRAFT_REF.test(value);
}
/**
 * created: Jira acknowledged this item's create; existing: an issue with this item's draft
 * identity already existed, so nothing was sent; failed: refused before or by Jira; uncertain:
 * sent without an authoritative outcome (never retried automatically); skipped: an item it depends
 * on did not produce a key; excluded: deselected by the human, directly or through a dependency.
 */
export const JIRA_DRAFT_ITEM_STATES = [
  "created",
  "existing",
  "failed",
  "uncertain",
  "skipped",
  "excluded",
] as const;
export type JiraDraftItemState = (typeof JIRA_DRAFT_ITEM_STATES)[number];
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
  /** UTF-8 bytes of one message's JSON encoding, so escapes and non-ASCII text stay bounded. */
  messageBytes: 200,
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
/** Most issue links one create/edit request may ask for (#4176). */
export const JIRA_MUTATION_LINKS_MAX = 20;
/** One requested link, as the caller named it: the link type, the side and the other issue. */
export interface JiraMutationLinkRef {
  readonly type: string;
  readonly direction: "inward" | "outward";
  readonly issueKey: string;
}
/**
 * What happened to the requested links (#4176). Jira takes one `issuelinks` operation per request, so
 * every further link is its own call after the issue exists and can fail on its own. `created` counts
 * the requested links present on the issue afterwards; `missing` names the rest; `unconfirmed` says
 * the issue's links could not be read back, so a missing link may still exist.
 */
export interface JiraMutationLinkAccount {
  readonly requested: number;
  readonly created: number;
  readonly missing: readonly JiraMutationLinkRef[];
  readonly unconfirmed: boolean;
}
export type JiraMutationAttempt =
  | {
      readonly ok: true;
      readonly receipt: JiraMutationReceipt;
      readonly links?: JiraMutationLinkAccount;
    }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      readonly detail?: JiraMutationFailureDetail;
      /** Set only when the issue itself exists although the attempt did not finish (partial effect). */
      readonly receipt?: JiraMutationReceipt;
      readonly links?: JiraMutationLinkAccount;
    };

// eslint-disable-next-line no-control-regex -- remote text is shown to a model, not a terminal.
const DETAIL_CONTROL = /[\u0000-\u001f\u007f-\u009f]+/gu;
const DETAIL_FIELD_ID = /^(?:[a-zA-Z][a-zA-Z0-9]{0,63}|customfield_\d{1,16})$/u;
function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(DETAIL_CONTROL, " ").trim();
  if (text.length === 0) return undefined;
  return boundedDetailText(text);
}
const DETAIL_ENCODER = new TextEncoder();
const DETAIL_ELLIPSIS = "…";
function encodedBytes(text: string): number {
  return DETAIL_ENCODER.encode(JSON.stringify(text)).length - 2;
}
/** Cuts on code-point boundaries until the JSON-encoded text fits its byte bound. */
function boundedDetailText(text: string): string {
  const limit = JIRA_MUTATION_DETAIL_LIMITS.messageBytes;
  if (encodedBytes(text) <= limit) return text;
  const budget = limit - encodedBytes(DETAIL_ELLIPSIS);
  let used = 0;
  let kept = "";
  for (const point of text) {
    used += encodedBytes(point);
    if (used > budget) break;
    kept += point;
  }
  return `${kept}${DETAIL_ELLIPSIS}`;
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

// eslint-disable-next-line no-control-regex -- a link type name is a single-line identifier.
const LINK_TYPE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LINK_ISSUE_KEY = /^[A-Za-z]\w{0,254}-[1-9]\d{0,17}$/u;
function linkTypeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    !LINK_TYPE_CONTROL.test(value)
  );
}
function linkRef(value: unknown): JiraMutationLinkRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const type: unknown = Reflect.get(value, "type");
  const direction: unknown = Reflect.get(value, "direction");
  const issueKey: unknown = Reflect.get(value, "issueKey");
  if (!linkTypeName(type) || (direction !== "inward" && direction !== "outward")) return undefined;
  return typeof issueKey === "string" && LINK_ISSUE_KEY.test(issueKey)
    ? { type, direction, issueKey }
    : undefined;
}
function linkCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= JIRA_MUTATION_LINKS_MAX
  );
}
/** One bounded projection of a link account, applied wherever an account crosses a boundary. */
export function sanitizeJiraMutationLinkAccount(
  value: unknown,
): JiraMutationLinkAccount | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const requested: unknown = Reflect.get(value, "requested");
  const created: unknown = Reflect.get(value, "created");
  const unconfirmed: unknown = Reflect.get(value, "unconfirmed");
  const listed: unknown = Reflect.get(value, "missing");
  if (!linkCount(requested) || !linkCount(created) || created > requested) return undefined;
  if (typeof unconfirmed !== "boolean" || !Array.isArray(listed)) return undefined;
  const missing: (JiraMutationLinkRef | undefined)[] = (listed as unknown[]).map(linkRef);
  if (missing.length > requested) return undefined;
  const refs = missing.filter((link): link is JiraMutationLinkRef => link !== undefined);
  return refs.length === missing.length
    ? { requested, created, missing: refs, unconfirmed }
    : undefined;
}
