import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import { jiraDirectoryGroup } from "./jira-directory-values.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { directoryAccessRefusal, type DirectoryAccessFailure, type DirectoryAccessInput } from "./jira-directory-access-values.js";

/** Preserve observed dependencies of this connection. An incomplete expansion is unavailable,
 * never evidence that the actor has no groups. This is not an effective-permission engine.
 * Native UserBean.groups is SimpleListWrapperGroupJsonBean: size plus expanded items.
 */
export async function guardJiraDirectorySelfAccess(
  request: JiraMutationRequest,
  input: Extract<DirectoryAccessInput, { kind: "roles" }>,
  actor: { readonly key: string; readonly name: string },
): Promise<DirectoryAccessFailure | undefined> {
  const removed = new Set(input.roles.flatMap((role) => role.expected.groups.filter((name) => !role.value.groups.includes(name))));
  if (removed.size === 0) return undefined;
  const response = await request(`user?${new URLSearchParams({ key: actor.key, expand: "groups" }).toString()}`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const body = response.status === 200 ? response.body : undefined;
  const expansion = asRecord(body?.groups);
  const items = asArray(expansion?.items);
  const groups = items === undefined ? undefined : projectJiraCollection(items, TOOL_CATALOG_LIMITS.maxArrayItems, jiraDirectoryGroup, "name");
  if (body?.key !== actor.key || body.name !== actor.name || groups === undefined || expansion?.size !== groups.length)
    return directoryAccessRefusal("The connected actor's complete native group expansion is unavailable. Review its current groups with a different authorized Jira administrator; an omitted or truncated list cannot establish safe removal. No write was sent.", "unavailable");
  if (groups.some((group) => typeof group.name === "string" && removed.has(group.name)))
    return directoryAccessRefusal("This role change removes a group of the connected actor and could revoke this connection's own application or administration access. Use a different authorized Jira administrator connection that is independent of the removed groups. No write was sent.", "conflict");
  return undefined;
}
