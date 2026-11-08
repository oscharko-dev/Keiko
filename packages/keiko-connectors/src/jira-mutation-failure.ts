import {
  sanitizeJiraMutationFailureDetail,
  type JiraFieldMetadata,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
  type JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";

export type JiraMutationFailure = Extract<JiraMutationAttempt, { ok: false }>;
/** Read-only observations and pre-dispatch refusals cannot acknowledge a mutation. */
export type JiraObservationFailure = Omit<JiraMutationFailure, "receipt"> & {
  readonly receipt?: never;
};
export type JiraHttpFailure = Extract<AtlassianWriteHttpOutcome, { ok: false }>;

export function jiraFieldValidationFailure(message: string): JiraObservationFailure {
  return { ok: false, reason: "field-validation", detail: { validation: "invalid-field", messages: [message] } };
}

type ReceiptFailure<Receipt extends JiraMutationReceipt> = Omit<JiraMutationFailure, "receipt"> & {
  readonly receipt?: Receipt;
};
export function jiraConflictFailure(message: string): JiraObservationFailure;
export function jiraConflictFailure<Receipt extends JiraMutationReceipt>(message: string, receipt: Receipt | undefined): ReceiptFailure<Receipt>;
export function jiraConflictFailure(message: string, receipt?: JiraMutationReceipt): JiraMutationFailure {
  return { ok: false, reason: "conflict", detail: { messages: [message] }, ...(receipt === undefined ? {} : { receipt }) };
}

export function jiraUnchangedFailure<Receipt extends JiraMutationReceipt>(message: string, receipt: Receipt): ReceiptFailure<Receipt> {
  return { ok: false, reason: "conflict", detail: { unchanged: true, messages: [message] }, receipt };
}

/** Private executor failure after acknowledgement; composing owners log the original cause. */
export class JiraAcknowledgedMutationError extends Error {
  readonly receipt: JiraMutationReceipt;

  constructor(cause: unknown, receipt: JiraMutationReceipt) {
    super("Jira mutation acknowledgement could not be independently confirmed", { cause });
    this.name = "JiraAcknowledgedMutationError";
    this.receipt = Object.freeze({
      ...receipt,
      ...(receipt.issueKeys === undefined
        ? {}
        : { issueKeys: Object.freeze([...receipt.issueKeys]) }),
    });
  }
}

/** Jira names a refused field by id; the request's metadata adds the name a person would use. */
export function nameJiraFieldErrors(
  detail: JiraMutationFailureDetail | undefined,
  metadata: readonly JiraFieldMetadata[],
): JiraMutationFailureDetail | undefined {
  if (detail?.fieldErrors === undefined || metadata.length === 0) return detail;
  const names = new Map(metadata.map((field) => [field.id, field.name]));
  const fieldErrors = detail.fieldErrors.map((error) => {
    const fieldName = names.get(error.fieldId);
    return fieldName === undefined ? error : { ...error, fieldName };
  });
  return sanitizeJiraMutationFailureDetail({ ...detail, fieldErrors }) ?? detail;
}

/** The dispatch's own refusal, with Jira's explanation when it gave one.
 * This pre-acknowledgement result cannot carry a receipt. The composing owner binds any
 * independently known target after dispatch; a generic receipt must never widen that target.
 */
export function dispatchFailure(
  response: JiraHttpFailure,
  metadata: readonly JiraFieldMetadata[] = [],
): JiraObservationFailure {
  const detail = nameJiraFieldErrors(response.remote, metadata);
  return {
    ok: false,
    reason: response.reason,
    ...(detail === undefined ? {} : { detail }),
  };
}
