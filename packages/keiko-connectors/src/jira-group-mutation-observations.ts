import { bindJiraGroupPrincipal as bindMutationGroup } from "./jira-group-principal.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraDirectoryUsers } from "./jira-directory-values.js";
import { jiraMetadataPageLast } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { bindRolePrincipals } from "./jira-role-mutation-observations.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import { GROUP_MUTATION_MALFORMED, groupMutationRefusal, type GroupMutationFailure, type GroupMutationInput, type GroupObservation } from "./jira-group-mutation-values.js";

export { bindMutationGroup };
interface MembershipCursor { readonly keys: Set<string>; readonly names: Set<string>; count: number; total: number | undefined; found: boolean }
function collectMembers(state: MembershipCursor, items: readonly CatalogJsonObject[], input: Extract<GroupMutationInput, { kind: "membership" }>): boolean {
  for (const item of items) {
    const key = item.key; const name = item.name;
    if (typeof key !== "string" || typeof name !== "string" || state.keys.has(key) || state.names.has(name.toLowerCase())) return false;
    // An identical username with another key, or vice versa, cannot establish this principal.
    if ((key === input.user.key) !== (name === input.user.name)) return false;
    state.keys.add(key); state.names.add(name.toLowerCase());
    if (key === input.user.key) state.found = true;
  }
  state.count += items.length;
  return true;
}
function sameTotal(state: MembershipCursor, total: unknown): boolean {
  if (total === undefined) return state.count === 0 || state.total === undefined;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > 1000) return false;
  return state.count === 0 || state.total === total;
}
/** Complete bounded native membership only. No group picker, visible-user prefix or absent-page shortcut. */
export async function readGroupMutationMembership(request: JiraMutationRequest, input: Extract<GroupMutationInput, { kind: "membership" }>): Promise<GroupObservation<boolean>> {
  const state: MembershipCursor = { keys: new Set(), names: new Set(), count: 0, total: undefined, found: false };
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ groupname: input.name, includeInactiveUsers: "true", startAt: String(state.count), maxResults: "50" });
    const response = await request(`group/member?${query.toString()}`, "GET", undefined, "json");
    if (!response.ok) return dispatchFailure(response);
    const body = response.status === 200 ? response.body : undefined;
    const items = body === undefined ? undefined : jiraDirectoryUsers(body.values, 50);
    if (body === undefined || items === undefined) return GROUP_MUTATION_MALFORMED;
    if (typeof body.total === "number" && Number.isSafeInteger(body.total) && body.total > 1000) return { ok: false, reason: "bounds-exceeded" };
    const last = jiraMetadataPageLast(body, items.length, state.count, 50);
    if (last === undefined || !sameTotal(state, body.total) || !collectMembers(state, items, input)) return GROUP_MUTATION_MALFORMED;
    state.total = typeof body.total === "number" ? body.total : undefined;
    if (last) return { ok: true, value: state.found };
  }
  return { ok: false, reason: "bounds-exceeded", detail: { messages: ["The complete group membership exceeds the existing 1000-entry bound. A visible prefix cannot establish absence. No write was sent."] } };
}
async function membershipAdmission(request: JiraMutationRequest, input: Extract<GroupMutationInput, { kind: "membership" }>): Promise<GroupMutationFailure | undefined> {
  const principal = await bindRolePrincipals(request, { users: [input.user], groups: [] });
  if (principal !== undefined) return principal;
  const member = await readGroupMutationMembership(request, input);
  if (!member.ok) return member;
  if (member.value !== input.expected) return groupMutationRefusal("The reviewed target user's group-and-subgroup membership changed. Read the complete current membership and review this exact user again.", "conflict");
  if (!member.value && !input.present) return { ...groupMutationRefusal("The complete native group-and-subgroup list already omits the selected user. No removal was sent; effective permissions are not inferred.", "conflict"), detail: { unchanged: true, messages: ["The selected user is already absent from the complete observed group-and-subgroup list. No removal was sent."] } };
  return undefined;
}
export async function admitGroupMutation(request: JiraMutationRequest, input: GroupMutationInput): Promise<GroupMutationFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  if (input.kind === "create") return undefined;
  const group = await bindMutationGroup(request, input.name);
  if (group !== undefined) return group;
  if (input.kind === "membership") return membershipAdmission(request, input);
  return input.swap === undefined ? undefined : bindMutationGroup(request, input.swap);
}
