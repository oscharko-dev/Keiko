import type {
  JiraMutationAttempt,
  JiraMutationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { projectJiraFilterPermissions } from "./jira-managed-saved-views.js";
import {
  dispatchFailure,
  jiraFieldValidationFailure,
  jiraConflictFailure as savedConflict,
  type JiraObservationFailure,
} from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeName, jiraNativeText } from "./jira-native-values.js";

export interface JiraSavedConfigurationReceipt extends JiraMutationReceipt {
  readonly filterId?: string;
  readonly permissionId?: string;
  readonly preferenceKey?: string;
  readonly preferencePresent?: boolean;
  readonly defaultSharingAtomic?: false;
  readonly observedShareScope?: "PRIVATE" | "AUTHENTICATED" | "GLOBAL";
}
export type SavedFailure = Omit<Extract<JiraMutationAttempt, { readonly ok: false }>, "receipt"> & {
  readonly receipt?: JiraSavedConfigurationReceipt;
};
export type JiraSavedConfigurationAttempt =
  SavedFailure | { readonly ok: true; readonly receipt: JiraSavedConfigurationReceipt };
export type SavedObservation<T> = JiraObservationFailure | { readonly ok: true; readonly value: T };
export interface SavedActor {
  readonly key: string;
  readonly name: string;
}
export interface SavedFilter {
  readonly id: string;
  readonly ownerKey: string;
  readonly name: string;
  readonly jql: string;
  readonly description: string | null;
}
export const SAVED_MALFORMED: JiraObservationFailure = { ok: false, reason: "malformed-payload" };
export { savedConflict };
export {
  jiraFieldValidationFailure as savedInvalid,
  jiraUnchangedFailure as savedUnchanged,
} from "./jira-mutation-failure.js";
export function savedUnconfirmed(
  message: string,
  receipt: JiraSavedConfigurationReceipt,
): SavedFailure {
  return { ok: false, reason: "unavailable", detail: { messages: [message] }, receipt };
}
export function savedExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}
export function savedText(value: unknown, max: number, empty = false): value is string {
  return jiraNativeText(value, max, empty) && !/\p{Surrogate}/u.test(value);
}
/** Projects a bounded array whose items are pairwise distinct by both identity strings. */
export function savedDistinctList<T>(
  value: unknown,
  project: (raw: unknown) => T | undefined,
  identities: (item: T) => readonly [string, string],
  bounds: { readonly minimum: number; readonly maximum: number },
): T[] | undefined {
  if (!Array.isArray(value) || value.length < bounds.minimum || value.length > bounds.maximum)
    return undefined;
  const output: T[] = [];
  const firsts = new Set<string>();
  const seconds = new Set<string>();
  for (const raw of value) {
    const item = project(raw);
    if (item === undefined) return undefined;
    const [first, second] = identities(item);
    if (firsts.has(first) || seconds.has(second)) return undefined;
    firsts.add(first);
    seconds.add(second);
    output.push(item);
  }
  return output;
}
export function savedName(value: unknown): value is string {
  return jiraNativeName(value, 255) && !/\p{Surrogate}/u.test(value);
}
export async function readSavedActor(
  request: JiraMutationRequest,
  expectedKey: string,
): Promise<SavedObservation<SavedActor>> {
  const response = await request("myself", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const user = response.status === 200 ? jiraDirectoryUser(response.body) : undefined;
  if (user === undefined || !savedText(user.key, 255) || !savedText(user.name, 255))
    return SAVED_MALFORMED;
  if (user.key !== expectedKey)
    return savedConflict(
      "The connected Jira user no longer matches the reviewed user. Review the current identity; an acknowledged operation remains unconfirmed and must not be replayed.",
    );
  return { ok: true, value: { key: user.key, name: user.name } };
}
export function projectSavedFilter(value: unknown): SavedFilter | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const owner = jiraDirectoryUser(raw.owner);
  if (!jiraNativeId(raw.id) || typeof owner?.key !== "string") return undefined;
  if (!savedName(raw.name) || !savedText(raw.jql, 2048)) return undefined;
  const { description = null } = raw;
  if (description !== null && !savedText(description, 32768, true)) return undefined;
  return { id: raw.id, ownerKey: owner.key, name: raw.name, jql: raw.jql, description };
}
export async function readOwnedFilter(
  request: JiraMutationRequest,
  id: string,
  actorKey: string,
): Promise<SavedObservation<SavedFilter>> {
  const response = await request(`filter/${id}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const filter = response.status === 200 ? projectSavedFilter(response.body) : undefined;
  if (filter?.id !== id) return SAVED_MALFORMED;
  if (filter.ownerKey !== actorKey)
    return savedConflict(
      "The filter no longer has the reviewed connected-user owner. Ownership changed or is different; an acknowledged operation remains unconfirmed and must not be replayed.",
    );
  return { ok: true, value: filter };
}
interface SavedFilterSelection {
  readonly filterId: string;
  readonly actorKey: string;
}
type BoundFilter<Selection, Value> =
  | JiraObservationFailure
  | {
      readonly ok: true;
      readonly selected: Selection;
      readonly value: Value;
    };
export function bindSavedFilterOwner<Selection extends SavedFilterSelection>(
  request: JiraMutationRequest,
  selected: Selection,
): Promise<BoundFilter<Selection, true>>;
export function bindSavedFilterOwner<Selection extends SavedFilterSelection, Value>(
  request: JiraMutationRequest,
  selected: Selection | undefined,
  observe: (request: JiraMutationRequest, filterId: string) => Promise<SavedObservation<Value>>,
  invalidMessage: string,
): Promise<BoundFilter<Selection, Value>>;
export async function bindSavedFilterOwner<Selection extends SavedFilterSelection, Value>(
  request: JiraMutationRequest,
  selected: Selection | undefined,
  observe?: (request: JiraMutationRequest, filterId: string) => Promise<SavedObservation<Value>>,
  invalidMessage = "Review the filter and connected owner. Nothing was written.",
): Promise<BoundFilter<Selection, Value | true>> {
  if (selected === undefined) return jiraFieldValidationFailure(invalidMessage);
  const { filterId, actorKey } = selected;
  const actor = await readSavedActor(request, actorKey);
  if (!actor.ok) return actor;
  const filter = await readOwnedFilter(request, filterId, actorKey);
  if (!filter.ok) return filter;
  const current =
    observe === undefined
      ? { ok: true as const, value: true as const }
      : await observe(request, filterId);
  return current.ok ? { ...current, selected } : current;
}
export function sameSavedFilter(actual: SavedFilter, expected: SavedFilter): boolean {
  return (
    actual.id === expected.id &&
    actual.ownerKey === expected.ownerKey &&
    actual.name === expected.name &&
    actual.jql === expected.jql &&
    actual.description === expected.description
  );
}
export type DefaultShareScope = "PRIVATE" | "AUTHENTICATED" | "GLOBAL";
export function savedShareScope(value: unknown): value is DefaultShareScope {
  return value === "PRIVATE" || value === "AUTHENTICATED" || value === "GLOBAL";
}
export async function readSavedShareScope(
  request: JiraMutationRequest,
): Promise<SavedObservation<DefaultShareScope>> {
  const response = await request("filter/defaultShareScope", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  return response.status === 200 && savedShareScope(response.body?.scope)
    ? { ok: true, value: response.body.scope }
    : SAVED_MALFORMED;
}
export async function readSavedPermissions(
  request: JiraMutationRequest,
  filterId: string,
): Promise<SavedObservation<readonly CatalogJsonObject[]>> {
  const response = await request(`filter/${filterId}/permission`, "GET", undefined, "json-array");
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return SAVED_MALFORMED;
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const permissions = projectJiraFilterPermissions(response.items);
  return permissions === undefined ? SAVED_MALFORMED : { ok: true, value: permissions };
}
