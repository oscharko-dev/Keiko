import {
  sanitizeJiraMutationFailureDetail,
  type JiraFieldMetadata,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";

export type JiraMutationFailure = Extract<JiraMutationAttempt, { ok: false }>;
export type JiraHttpFailure = Extract<AtlassianWriteHttpOutcome, { ok: false }>;

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

/** The dispatch's own refusal, with Jira's explanation when it gave one. */
export function dispatchFailure(
  response: JiraHttpFailure,
  metadata: readonly JiraFieldMetadata[] = [],
): JiraMutationFailure {
  const detail = nameJiraFieldErrors(response.remote, metadata);
  return {
    ok: false,
    reason: response.reason,
    ...(detail === undefined ? {} : { detail }),
  };
}
