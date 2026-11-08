import { bindJiraGroupPrincipal as bindMutationGroup } from "./jira-group-principal.js";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraDirectoryUsers } from "./jira-directory-values.js";
import { jiraMetadataPageLast } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { bindRolePrincipals } from "./jira-role-mutation-observations.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  GROUP_MUTATION_MALFORMED,
  groupMutationRefusal,
  type GroupMutationFailure,
  type GroupMutationInput,
  type GroupObservation,
} from "./jira-group-mutation-values.js";

export { bindMutationGroup };
interface MembershipCursor {
  readonly keys: Set<string>;
  readonly names: Set<string>;
  count: number;
  total: number | undefined;
  found: boolean;
}
function collectMembers(
  state: MembershipCursor,
  items: readonly CatalogJsonObject[],
  input: Extract<GroupMutationInput, { kind: "membership" }>,
): boolean {
  for (const item of items) {
    const key = item.key;
    const name = item.name;
    if (
      typeof key !== "string" ||
      typeof name !== "string" ||
      state.keys.has(key) ||
      state.names.has(name.toLowerCase())
    )
      return false;
    // An identical username with another key, or vice versa, cannot establish this principal.
    if ((key === input.user.key) !== (name === input.user.name)) return false;
    state.keys.add(key);
    state.names.add(name.toLowerCase());
    if (key === input.user.key) state.found = true;
  }
  state.count += items.length;
  return true;
}
function sameTotal(state: MembershipCursor, total: unknown): boolean {
  if (total === undefined) return state.count === 0 || state.total === undefined;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) return false;
  return state.count === 0 || state.total === total;
}
function collectPage(
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  state: MembershipCursor,
  input: Extract<GroupMutationInput, { kind: "membership" }>,
): GroupObservation<boolean> {
  const body = response.status === 200 ? response.body : undefined;
  const items = body === undefined ? undefined : jiraDirectoryUsers(body.values, 50);
  if (body === undefined || items === undefined) return GROUP_MUTATION_MALFORMED;
  const last = jiraMetadataPageLast(body, items.length, state.count, 50);
  if (last === undefined || !sameTotal(state, body.total) || !collectMembers(state, items, input))
    return GROUP_MUTATION_MALFORMED;
  state.total = typeof body.total === "number" ? body.total : undefined;
  return { ok: true, value: last };
}
/** Complete native pages share the admitted request's existing deadline/cancellation budget.
 * The 50-row native page size is not a maximum group population. No visible prefix proves absence.
 */
export async function readGroupMutationMembership(
  request: JiraMutationRequest,
  input: Extract<GroupMutationInput, { kind: "membership" }>,
): Promise<GroupObservation<boolean>> {
  const state: MembershipCursor = {
    keys: new Set(),
    names: new Set(),
    count: 0,
    total: undefined,
    found: false,
  };
  for (;;) {
    const query = new URLSearchParams({
      groupname: input.name,
      includeInactiveUsers: "true",
      startAt: String(state.count),
      maxResults: "50",
    });
    const response = await request(`group/member?${query.toString()}`, "GET", undefined, "json");
    if (!response.ok) return dispatchFailure(response);
    const collected = collectPage(response, state, input);
    if (!collected.ok) return collected;
    if (collected.value) return { ok: true, value: state.found };
  }
}
async function membershipAdmission(
  request: JiraMutationRequest,
  input: Extract<GroupMutationInput, { kind: "membership" }>,
): Promise<GroupMutationFailure | undefined> {
  const principal = await bindRolePrincipals(request, { users: [input.user], groups: [] });
  if (principal !== undefined) return principal;
  const member = await readGroupMutationMembership(request, input);
  if (!member.ok) return member;
  if (member.value !== input.expected)
    return groupMutationRefusal(
      "The reviewed target user's group-and-subgroup membership changed. Read the complete current membership and review this exact user again.",
      "conflict",
    );
  if (!member.value && !input.present)
    return {
      ...groupMutationRefusal(
        "The complete native group-and-subgroup list already omits the selected user. No removal was sent; effective permissions are not inferred.",
        "conflict",
      ),
      detail: {
        unchanged: true,
        messages: [
          "The selected user is already absent from the complete observed group-and-subgroup list. No removal was sent.",
        ],
      },
    };
  return undefined;
}
export async function admitGroupMutation(
  request: JiraMutationRequest,
  input: GroupMutationInput,
): Promise<GroupMutationFailure | undefined> {
  const actor = await readSavedActor(request, input.actor);
  if (!actor.ok) return actor;
  if (input.kind === "create") return undefined;
  const group = await bindMutationGroup(request, input.name);
  if (group !== undefined) return group;
  if (input.kind === "membership") {
    if (!input.present && input.user.key === input.actor)
      return groupMutationRefusal(
        "Removing the connected actor from a group could revoke this connection's own access. Use a different authorized Jira administrator connection. No write was sent.",
        "conflict",
      );
    return membershipAdmission(request, input);
  }
  const member = await readGroupMutationMembership(request, {
    kind: "membership",
    actor: input.actor,
    name: input.name,
    user: actor.value,
    expected: false,
    present: false,
  });
  if (!member.ok) return member;
  if (member.value)
    return groupMutationRefusal(
      "Deleting a group containing the connected actor could revoke this connection's own application or administration access. Use a different authorized Jira administrator connection outside this group. No write was sent.",
      "conflict",
    );
  return input.swap === undefined ? undefined : bindMutationGroup(request, input.swap);
}
