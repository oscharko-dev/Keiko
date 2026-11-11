import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray } from "./atlassian-sync-classify.js";
import { jiraPermissionSchemeProjection } from "./jira-managed-access-schemes.js";
import { jiraPermissionAttributeValueProjection } from "./jira-managed-administrative-observations.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import { projectJiraCollection } from "./jira-managed-metadata.js";
import {
  PERMISSION_SCHEME_MALFORMED,
  permissionSchemeMetadata,
  permissionGrantSnapshots,
  permissionSchemeRefusal,
  samePermissionSet,
  type PermissionSchemeObservation,
  type PermissionSchemeSnapshot,
  type PermissionSchemeMetadata,
  type PermissionSchemeFailure,
} from "./jira-permission-scheme-mutation-values.js";

async function readPermissionGrants(
  request: JiraMutationRequest,
  id: string,
): Promise<PermissionSchemeObservation<PermissionSchemeSnapshot["permissions"]>> {
  const response = await request(`permissionscheme/${id}/permission`, "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const rows = asArray(response.body?.permissions);
  if (response.status !== 200 || rows === undefined) return PERMISSION_SCHEME_MALFORMED;
  if (rows.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const permissions = permissionGrantSnapshots(rows);
  return permissions === undefined ? PERMISSION_SCHEME_MALFORMED : { ok: true, value: permissions };
}
/** The native grant endpoint returns ALL grants; an omitted collection is never an empty set.
 * https://docs.atlassian.com/software/jira/docs/api/11.3.3/com/atlassian/jira/rest/v2/admin/permissionscheme/PermissionSchemeResource.html
 */
export async function readPermissionSchemeSnapshot(
  request: JiraMutationRequest,
  id: string,
): Promise<PermissionSchemeObservation<PermissionSchemeSnapshot>> {
  const parent = await request(`permissionscheme/${id}`, "GET", undefined, "json");
  if (!parent.ok) return dispatchFailure(parent);
  const metadata = parent.status === 200 ? permissionSchemeMetadata(parent.body) : undefined;
  if (metadata?.id !== id) return PERMISSION_SCHEME_MALFORMED;
  const grants = await readPermissionGrants(request, id);
  return grants.ok ? { ok: true, value: { ...metadata, permissions: grants.value } } : grants;
}
export function samePermissionSchemeMetadata(
  actual: PermissionSchemeMetadata,
  expected: PermissionSchemeMetadata,
): boolean {
  return (
    actual.id === expected.id &&
    actual.name === expected.name &&
    actual.description === expected.description
  );
}
export function samePermissionSchemeSnapshot(
  actual: PermissionSchemeSnapshot,
  expected: PermissionSchemeSnapshot,
): boolean {
  return (
    samePermissionSchemeMetadata(actual, expected) &&
    samePermissionSet(actual.permissions, expected.permissions, true)
  );
}
export async function readPermissionSchemeIndex(
  request: JiraMutationRequest,
): Promise<PermissionSchemeObservation<readonly { readonly id: string; readonly name: string }[]>> {
  const response = await request("permissionscheme", "GET", undefined, "json");
  if (!response.ok) return dispatchFailure(response);
  const values = asArray(response.body?.permissionSchemes);
  if (response.status !== 200 || values === undefined) return PERMISSION_SCHEME_MALFORMED;
  if (values.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const items = projectJiraCollection(
    values,
    TOOL_CATALOG_LIMITS.maxArrayItems,
    jiraPermissionSchemeProjection,
    "id",
  );
  if (items === undefined) return PERMISSION_SCHEME_MALFORMED;
  const result: { id: string; name: string }[] = [];
  for (const item of items) {
    if (typeof item.id !== "string" || typeof item.name !== "string")
      return PERMISSION_SCHEME_MALFORMED;
    result.push({ id: item.id, name: item.name });
  }
  return { ok: true, value: result };
}
export async function readPermissionSchemeAttribute(
  request: JiraMutationRequest,
  schemeId: string,
  key: string,
): Promise<PermissionSchemeObservation<"true" | "false">> {
  const response = await request(
    `permissionscheme/${schemeId}/attribute/${encodeURIComponent(key)}`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.body?.key !== key) return PERMISSION_SCHEME_MALFORMED;
  const value = jiraPermissionAttributeValueProjection(response.body.value);
  return value?.valueState === "observed" &&
    (value.textValue === "true" || value.textValue === "false")
    ? { ok: true, value: value.textValue }
    : permissionSchemeRefusal(
        "The current attribute is not an independently observed canonical Boolean string. Unknown, missing, null and selected404 cannot establish a reviewed prior state.",
        "unavailable",
      );
}
export async function admitPermissionSchemeSnapshot(
  request: JiraMutationRequest,
  expected: PermissionSchemeSnapshot,
): Promise<PermissionSchemeFailure | undefined> {
  const read = await readPermissionSchemeSnapshot(request, expected.id);
  if (!read.ok) return read;
  return samePermissionSchemeSnapshot(read.value, expected)
    ? undefined
    : permissionSchemeRefusal(
        "The scheme identity, metadata or complete permission grants changed. Review the current native scheme and every holder before approving the change.",
        "conflict",
      );
}
