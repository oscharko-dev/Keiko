import {
  isAtlassianConnectorWriteFailureReason,
  sanitizeJiraMutationFailureDetail,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonValue } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise } from "@oscharko-dev/keiko-security/hashing";
import type { JiraPropertyBinding } from "./jira-entity-property-bindings.js";
import {
  jiraPropertyResourcePath,
  projectJiraPropertyKeys,
  projectJiraPropertyValue,
} from "./jira-managed-entity-properties.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";

export type JiraPropertyMutationFailure = Extract<JiraMutationAttempt, { readonly ok: false }>;
export type BoundJiraProperty = Extract<JiraPropertyBinding, { readonly ok: true }>;
export type JiraPropertyState =
  { readonly present: false } | { readonly present: true; readonly value: CatalogJsonValue };
type Snapshot =
  JiraPropertyMutationFailure | { readonly ok: true; readonly state: JiraPropertyState };
const MALFORMED: JiraPropertyMutationFailure = { ok: false, reason: "malformed-payload" };
const CONFLICT: JiraPropertyMutationFailure = { ok: false, reason: "conflict" };

export function jiraPropertyBindingFailure(
  binding: Extract<JiraPropertyBinding, { readonly ok: false }>,
): JiraPropertyMutationFailure {
  const data = binding.result.data;
  if (!isAtlassianConnectorWriteFailureReason(data.reason)) return MALFORMED;
  const detail = sanitizeJiraMutationFailureDetail(data);
  return { ok: false, reason: data.reason, ...(detail === undefined ? {} : { detail }) };
}
/** Compare JSON objects by their data, without inferring absence from null, false or empty values. */
export function jiraPropertyStatesEqual(
  actual: JiraPropertyState,
  expected: JiraPropertyState,
): boolean {
  if (!actual.present) return !expected.present;
  return expected.present && canonicalise(actual.value) === canonicalise(expected.value);
}
function selectedValue(
  response: AtlassianWriteHttpOutcome,
  listed: boolean,
  propertyKey: string,
): Snapshot {
  if (!response.ok) {
    if (response.httpStatus === 404 && response.reason === "not-found")
      return listed ? CONFLICT : { ok: true, state: { present: false } };
    return dispatchFailure(response);
  }
  if (response.status !== 200 || response.body === undefined) return MALFORMED;
  const observed = projectJiraPropertyValue(response.body, propertyKey);
  if (!observed.ok) return observed;
  // A key-list/value contradiction is a concurrent or incomplete observation, never a write basis.
  return listed ? { ok: true, state: { present: true, value: observed.value } } : CONFLICT;
}
/** Complete native keys AND the exact value/404 on the same bound resource supply each snapshot. */
export async function readJiraPropertyState(
  binding: BoundJiraProperty,
  propertyKey: string,
): Promise<Snapshot> {
  const response = await binding.request(
    jiraPropertyResourcePath(binding),
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.body === undefined) return MALFORMED;
  const keys = projectJiraPropertyKeys(response.body);
  if (!keys.ok) return keys;
  const listed = keys.items.some((item) => item.key === propertyKey);
  const value = await binding.request(
    jiraPropertyResourcePath(binding, propertyKey),
    "GET",
    undefined,
    "json",
  );
  return selectedValue(value, listed, propertyKey);
}
