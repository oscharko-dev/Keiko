import type { JiraEntityPropertyMutation, JiraMutationReceipt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { bindJiraPropertyEntity, type JiraEntityPropertyPorts } from "./jira-entity-property-bindings.js";
import { decodeJiraPropertyInput } from "./jira-entity-property-input.js";
import {
  jiraPropertyBindingFailure,
  jiraPropertyStatesEqual,
  readJiraPropertyState,
  type BoundJiraProperty,
  type JiraPropertyMutationFailure,
  type JiraPropertyState,
} from "./jira-entity-property-write-admission.js";
import {
  jiraPropertyEntityFields,
  jiraPropertyResourcePath,
  selectJiraPropertyRead,
  type JiraPropertyReadSelection,
} from "./jira-managed-entity-properties.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";

type SingleRead = Exclude<Parameters<typeof selectJiraPropertyRead>[0], `${string}-keys`>;
interface Definition { readonly read: SingleRead; readonly remove: boolean }
const DEFINITIONS = {
  "jira.set-board-property": { read: "jira.board-property", remove: false },
  "jira.delete-board-property": { read: "jira.board-property", remove: true },
  "jira.set-sprint-property": { read: "jira.sprint-property", remove: false },
  "jira.delete-sprint-property": { read: "jira.sprint-property", remove: true },
  "jira.set-comment-property": { read: "jira.comment-property", remove: false },
  "jira.delete-comment-property": { read: "jira.comment-property", remove: true },
  "jira.set-dashboard-item-property": { read: "jira.dashboard-item-property", remove: false },
  "jira.delete-dashboard-item-property": { read: "jira.dashboard-item-property", remove: true },
  "jira.set-issue-property": { read: "jira.issue-property", remove: false },
  "jira.delete-issue-property": { read: "jira.issue-property", remove: true },
  "jira.set-issue-type-property": { read: "jira.issue-type-property", remove: false },
  "jira.delete-issue-type-property": { read: "jira.issue-type-property", remove: true },
  "jira.set-project-property": { read: "jira.project-property", remove: false },
  "jira.delete-project-property": { read: "jira.project-property", remove: true },
  "jira.set-user-property": { read: "jira.user-property", remove: false },
  "jira.delete-user-property": { read: "jira.user-property", remove: true },
} as const satisfies Readonly<Record<JiraEntityPropertyMutation, Definition>>;
type PropertyWrite = keyof typeof DEFINITIONS;
interface PropertyReceipt extends JiraMutationReceipt {
  readonly propertyKey?: string;
  readonly propertyPresent?: boolean;
  readonly dashboardId?: string;
  readonly selectedItemId?: string;
  readonly issueTypeId?: string;
  readonly userKey?: string;
  readonly username?: string;
}
type Failure = Omit<JiraPropertyMutationFailure, "receipt"> & { readonly receipt?: PropertyReceipt };
export type JiraEntityPropertyMutationAttempt = Failure | { readonly ok: true; readonly receipt: PropertyReceipt };
interface Input extends JiraPropertyReadSelection {
  readonly propertyKey: string;
  readonly expected: JiraPropertyState;
  readonly desired: JiraPropertyState;
}
const INVALID: Failure = { ok: false, reason: "field-validation", detail: { validation: "invalid-field", messages: [
  "Review the entity, exact property key and complete typed value first. Set needs valueNodes and either expectedValueNodes or expectAbsent=true. Delete needs expectedValueNodes. Nothing was changed.",
] } };
const CONFLICT: Failure = { ok: false, reason: "conflict" };
const MALFORMED: Failure = { ok: false, reason: "malformed-payload" };
type StateSelection = Failure | { readonly ok: true; readonly state: JiraPropertyState };
type InputSelection = Failure | { readonly ok: true; readonly selected: Input };

function decodedState(value: unknown, fieldId: "expectedValueNodes" | "valueNodes"): StateSelection {
  const decoded = decodeJiraPropertyInput(value);
  if (decoded.ok) return { ok: true, state: { present: true, value: decoded.value } };
  const bounds = decoded.reason === "bounds-exceeded";
  return { ok: false, reason: "field-validation", detail: {
    fieldId, validation: bounds ? "bounds-exceeded" : "invalid-field", messages: [bounds
      ? "A property value must fit 32768 UTF-8 JSON bytes and the existing depth, field and node limits. Shorten or simplify the complete value. Nothing was written."
      : "The typed property value is incomplete or invalid. Read its complete typed nodes, correct the structure and unsupported values, then review it again. Nothing was written."],
  } };
}
function expectedState(definition: Definition, args: CatalogJsonObject): StateSelection {
  if (args.expectAbsent !== undefined) {
    if (definition.remove || args.expectAbsent !== true || args.expectedValueNodes !== undefined) return INVALID;
    return { ok: true, state: { present: false } };
  }
  return decodedState(args.expectedValueNodes, "expectedValueNodes");
}
function desiredState(definition: Definition, args: CatalogJsonObject): StateSelection {
  return definition.remove ? { ok: true, state: { present: false } } : decodedState(args.valueNodes, "valueNodes");
}
function input(definition: Definition, args: CatalogJsonObject): InputSelection {
  const entityFields = jiraPropertyEntityFields(definition.read);
  if (entityFields === undefined) return INVALID;
  const nativeFields = new Set([...entityFields, "propertyKey"]);
  const allowed = new Set([...nativeFields, "expectedValueNodes", ...(definition.remove ? [] : ["valueNodes", "expectAbsent"])]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return INVALID;
  const entityArgs: CatalogJsonObject = Object.fromEntries(Object.entries(args).filter(([key]) => nativeFields.has(key)));
  const selected = selectJiraPropertyRead(definition.read, entityArgs);
  if (selected?.propertyKey === undefined) return INVALID;
  const expected = expectedState(definition, args);
  if (!expected.ok) return expected;
  const desired = desiredState(definition, args);
  if (!desired.ok) return desired;
  return { ok: true, selected: { ...selected, propertyKey: selected.propertyKey, expected: expected.state, desired: desired.state } };
}
function receipt(binding: BoundJiraProperty, selected: Input): PropertyReceipt {
  return { ...binding.context, propertyKey: selected.propertyKey, propertyPresent: selected.desired.present };
}
async function inspect(binding: BoundJiraProperty, selected: Input): Promise<Failure | undefined> {
  const observed = await readJiraPropertyState(binding, selected.propertyKey);
  if (!observed.ok) return observed;
  if (!jiraPropertyStatesEqual(observed.state, selected.expected)) return { ...CONFLICT, detail: { messages: [
    "The property changed or its absence could not be verified after review. Read and review its current complete value before changing it. Nothing was written.",
  ] } };
  return jiraPropertyStatesEqual(observed.state, selected.desired) ? {
    ...CONFLICT, receipt: receipt(binding, selected), detail: { unchanged: true,
      messages: ["The property already has the requested value. Nothing was written."] },
  } : undefined;
}
async function confirm(
  ports: JiraEntityPropertyPorts, binding: BoundJiraProperty, selected: Input, acknowledged: PropertyReceipt,
): Promise<JiraEntityPropertyMutationAttempt> {
  try {
    // Rebind numeric/key identity, never the caller's former alias, before using the same resource.
    const current = await bindJiraPropertyEntity(binding.entity, ports);
    if (!current.ok) return { ...jiraPropertyBindingFailure(current), receipt: acknowledged };
    if (current.path !== binding.path || current.query !== binding.query) return { ...CONFLICT, receipt: acknowledged };
    const observed = await readJiraPropertyState(current, selected.propertyKey);
    if (!observed.ok) return { ...observed, receipt: acknowledged };
    return jiraPropertyStatesEqual(observed.state, selected.desired)
      ? { ok: true, receipt: receipt(current, selected) } : { ...CONFLICT, receipt: acknowledged };
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, acknowledged);
  }
}
export function isJiraEntityPropertyMutation(name: string): name is PropertyWrite {
  return Object.hasOwn(DEFINITIONS, name);
}
/** One fixed native effect at most, inside existing authority, exact approval and durable journal. */
export async function executeJiraEntityPropertyMutation(
  operation: PropertyWrite, args: CatalogJsonObject, ports: JiraEntityPropertyPorts, check = false,
): Promise<JiraEntityPropertyMutationAttempt> {
  const parsed = input(DEFINITIONS[operation], args);
  if (!parsed.ok) return parsed;
  const selected = parsed.selected;
  const bound = await bindJiraPropertyEntity(selected.entity, ports);
  if (!bound.ok) return jiraPropertyBindingFailure(bound);
  const refusal = await inspect(bound, selected);
  if (refusal !== undefined) return refusal;
  if (check) return { ok: true, receipt: {} };
  const known = receipt(bound, selected);
  const body = selected.desired.present ? selected.desired.value : undefined;
  const response = await bound.request(jiraPropertyResourcePath(bound, selected.propertyKey),
    selected.desired.present ? "PUT" : "DELETE", body, "none");
  if (!response.ok) return { ...dispatchFailure(response), receipt: known };
  if (response.status < 200 || response.status >= 300) return { ...MALFORMED, receipt: known };
  return confirm(ports, bound, selected, known);
}
