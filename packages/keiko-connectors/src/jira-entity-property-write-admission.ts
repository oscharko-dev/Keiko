import {
  isAtlassianConnectorWriteFailureReason,
  sanitizeJiraMutationFailureDetail,
  type JiraMutationAttempt,
  type JiraMutationFailureDetail,
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
/** A refusal with one fixed sentence that says what the model can do, never what Jira returned. */
function refusal(
  reason: JiraPropertyMutationFailure["reason"],
  message: string,
): JiraPropertyMutationFailure {
  return { ok: false, reason, detail: { messages: [message] } };
}
const UNCERTAIN =
  "Jira's answer about this property is incomplete or inconsistent, so its current state is not certain. Read it again and review the complete current value. Nothing was written.";
const TOO_LARGE =
  "The property's keys or value are larger than Keiko can read completely, so it cannot be changed here. Change it in Jira. Nothing was written.";
const MALFORMED = refusal("malformed-payload", UNCERTAIN);
const CONFLICT = refusal("conflict", UNCERTAIN);
const ENTITY_UNREADABLE =
  "Jira's answer about the entity could not be read completely. Nothing was written.";
const BINDING_MESSAGES: Readonly<Record<string, string>> = {
  "not-found":
    "The entity, or the parent it belongs to, was not found or is not visible to this connection. Check the entity arguments. Nothing was written.",
  "permission-denied":
    "This connection may not read that entity, so its properties cannot be changed. Nothing was written.",
  conflict:
    "The entity changed or does not match the arguments sent. Read it again and send its exact identifying arguments. Nothing was written.",
  "malformed-payload": ENTITY_UNREADABLE,
};
/** A projection refusal of the keys or the value, with the sentence for its cause. */
function readRefusal(
  failure: Extract<ReturnType<typeof projectJiraPropertyKeys>, { readonly ok: false }>,
): JiraPropertyMutationFailure {
  return failure.reason === "bounds-exceeded"
    ? refusal("bounds-exceeded", TOO_LARGE)
    : refusal(failure.reason, UNCERTAIN);
}

function explainedByJira(detail: JiraMutationFailureDetail | undefined): boolean {
  return (detail?.messages?.length ?? 0) > 0 || (detail?.fieldErrors?.length ?? 0) > 0;
}
export function jiraPropertyBindingFailure(
  binding: Extract<JiraPropertyBinding, { readonly ok: false }>,
): JiraPropertyMutationFailure {
  const data = binding.result.data;
  // The subject of a binding failure is the entity, never the property: an unknown reason says so.
  if (!isAtlassianConnectorWriteFailureReason(data.reason))
    return refusal("malformed-payload", ENTITY_UNREADABLE);
  const detail = sanitizeJiraMutationFailureDetail(data);
  // Jira's own explanation stands; without one, the model gets the sentence for the cause.
  const message = explainedByJira(detail) ? undefined : BINDING_MESSAGES[data.reason];
  if (message === undefined)
    return { ok: false, reason: data.reason, ...(detail === undefined ? {} : { detail }) };
  return { ok: false, reason: data.reason, detail: { ...detail, messages: [message] } };
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
  if (!observed.ok) return readRefusal(observed);
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
  if (!keys.ok) return readRefusal(keys);
  const listed = keys.items.some((item) => item.key === propertyKey);
  const value = await binding.request(
    jiraPropertyResourcePath(binding, propertyKey),
    "GET",
    undefined,
    "json",
  );
  return selectedValue(value, listed, propertyKey);
}
