import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { ATLASSIAN_WRITE_RESPONSE_MAX_BYTES } from "./atlassian-write-http.js";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraDirectoryGroup } from "./jira-directory-values.js";
import { readGroupMutationMembership } from "./jira-group-mutation-observations.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { directoryAccessRefusal, type DirectoryAccessFailure, type DirectoryAccessInput, type DirectoryAccessObservation } from "./jira-directory-access-values.js";

type Actor = { readonly key: string; readonly name: string };
function selfAccessRefusal(): DirectoryAccessFailure {
  return directoryAccessRefusal("This role change removes a group of the connected actor and could revoke this connection's own application or administration access. Use a different authorized Jira administrator connection that is independent of the removed groups. No write was sent.", "conflict");
}
function completeActorGroups(body: Readonly<Record<string, unknown>> | undefined, actor: Actor): readonly CatalogJsonObject[] | undefined {
  if (body?.key !== actor.key || body.name !== actor.name) return undefined;
  const expansion = asRecord(body.groups);
  const items = asArray(expansion?.items);
  if (items === undefined || new TextEncoder().encode(JSON.stringify(items)).byteLength > ATLASSIAN_WRITE_RESPONSE_MAX_BYTES) return undefined;
  const groups = projectJiraCollection(items, items.length, jiraDirectoryGroup, "name");
  return groups !== undefined && expansion?.size === groups.length ? groups : undefined;
}
async function actorGroups(request: JiraMutationRequest, actor: Actor): Promise<DirectoryAccessObservation<readonly CatalogJsonObject[]>> {
  const response = await request(`user?${new URLSearchParams({ key: actor.key, expand: "groups" }).toString()}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const groups = completeActorGroups(response.status === 200 ? response.body : undefined, actor);
  return groups === undefined ? directoryAccessRefusal("The connected actor's complete native group expansion is unavailable. Review its current groups with a different authorized Jira administrator; an omitted or truncated list cannot establish safe removal. No write was sent.", "unavailable")
    : { ok: true, value: groups };
}
/** The user expansion alone does not establish absence from nested groups. For every removed
 * role group, the existing GroupResource reader also requires complete native subgroup membership.
 * An incomplete or denied population never becomes evidence that this connection is independent.
 */
export async function guardJiraDirectorySelfAccess(
  request: JiraMutationRequest,
  input: Extract<DirectoryAccessInput, { kind: "roles" }>,
  actor: Actor,
): Promise<DirectoryAccessFailure | undefined> {
  const removed = new Set(input.roles.flatMap((role) => role.expected.groups.filter((name) => !role.value.groups.includes(name))));
  if (removed.size === 0) return undefined;
  const groups = await actorGroups(request, actor);
  if (!groups.ok) return groups;
  if (groups.value.some((group) => typeof group.name === "string" && removed.has(group.name))) return selfAccessRefusal();
  for (const name of removed) {
    const membership = await readGroupMutationMembership(request, { kind: "membership", actor: input.actor,
      name, user: actor, expected: false, present: false });
    if (!membership.ok) return membership;
    if (membership.value) return selfAccessRefusal();
  }
  return undefined;
}
