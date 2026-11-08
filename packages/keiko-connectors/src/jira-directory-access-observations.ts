import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { isAtlassianApplicationRoleVersion } from "./atlassian-http-port.js";
import { jiraDirectoryUser } from "./jira-directory-values.js";
import { bindJiraGroupPrincipal } from "./jira-group-principal.js";
import { projectJiraApplicationRole } from "./jira-managed-directory-reads.js";
import { projectJiraFilterColumnState } from "./jira-managed-column-reads.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import { dispatchFailure } from "./jira-mutation-failure.js";
import type {
  JiraApplicationRoleConfiguration,
  JiraDirectoryAccessPorts,
} from "./jira-directory-access-request.js";
import {
  DIRECTORY_ACCESS_MALFORMED,
  directoryAccessRefusal,
  directoryRole,
  sameDirectoryRole,
  type DirectoryAccessFailure,
  type DirectoryAccessInput,
  type DirectoryAccessObservation,
  type DirectoryAccessUser,
} from "./jira-directory-access-values.js";

export function projectDirectoryRoleConfiguration(
  value: unknown,
): JiraApplicationRoleConfiguration | undefined {
  const role = projectJiraApplicationRole(value);
  return role === undefined
    ? undefined
    : directoryRole({ key: role.key, groups: role.groups, defaultGroups: role.defaultGroups });
}
export async function readDirectoryRole(
  request: JiraMutationRequest,
  expected: JiraApplicationRoleConfiguration,
): Promise<DirectoryAccessObservation<JiraApplicationRoleConfiguration>> {
  const response = await request(
    `applicationrole/${encodeURIComponent(expected.key)}`,
    "GET",
    undefined,
    "json",
  );
  if (!response.ok) return dispatchFailure(response);
  const role =
    response.status === 200 ? projectDirectoryRoleConfiguration(response.body) : undefined;
  if (role === undefined) return DIRECTORY_ACCESS_MALFORMED;
  return sameDirectoryRole(role, expected)
    ? { ok: true, value: role }
    : directoryAccessRefusal(
        "The selected application role's exact key or complete group/default-group configuration changed. Read and review its current configuration.",
        "conflict",
      );
}
export interface DirectoryRoleCollection {
  readonly version: string;
  readonly roles: readonly CatalogJsonObject[];
}
export async function readDirectoryRoleCollection(
  ports: JiraDirectoryAccessPorts,
): Promise<DirectoryAccessObservation<DirectoryRoleCollection>> {
  const response = await ports.roles.read();
  if (!response.ok) return dispatchFailure(response);
  if (
    response.status !== 200 ||
    response.items === undefined ||
    !isAtlassianApplicationRoleVersion(response.applicationRoleVersion)
  )
    return directoryAccessRefusal(
      "A complete native application-role collection and its strong version are required. No guessed version, weak ETag or unconditional update is permitted.",
      "unavailable",
    );
  if (response.items.length > TOOL_CATALOG_LIMITS.maxArrayItems)
    return { ok: false, reason: "bounds-exceeded" };
  const roles: CatalogJsonObject[] = [];
  for (const raw of response.items) {
    const role = projectJiraApplicationRole(raw);
    if (role === undefined || roles.some((current) => current.key === role.key))
      return DIRECTORY_ACCESS_MALFORMED;
    roles.push(role);
  }
  return { ok: true, value: { version: response.applicationRoleVersion, roles } };
}
export function admitDirectoryRoles(
  current: DirectoryRoleCollection,
  input: Extract<DirectoryAccessInput, { kind: "roles" }>,
): DirectoryAccessFailure | undefined {
  for (const role of input.roles) {
    const observed = projectDirectoryRoleConfiguration(
      current.roles.find((candidate) => candidate.key === role.expected.key),
    );
    if (observed === undefined || !sameDirectoryRole(observed, role.expected))
      return directoryAccessRefusal(
        "A selected role is missing or its reviewed group/default-group sets changed. Read the role again before a new request; no CAS retry or replacement role is chosen.",
        "conflict",
      );
  }
  return undefined;
}
export async function bindDirectoryRoleGroups(
  request: JiraMutationRequest,
  input: Extract<DirectoryAccessInput, { kind: "roles" }>,
): Promise<DirectoryAccessFailure | undefined> {
  const groups = new Set(input.roles.flatMap((role) => role.value.groups));
  for (const name of groups) {
    const refused = await bindJiraGroupPrincipal(request, name);
    if (refused !== undefined) return refused;
  }
  return undefined;
}
export async function bindDirectoryUser(
  request: JiraMutationRequest,
  expected: DirectoryAccessUser,
): Promise<DirectoryAccessFailure | undefined> {
  for (const [selector, value] of [
    ["username", expected.name],
    ["key", expected.key],
  ] as const) {
    const response = await request(
      `user?${new URLSearchParams({ [selector]: value }).toString()}`,
      "GET",
      undefined,
      "json",
    );
    if (!response.ok) return dispatchFailure(response);
    const user = response.status === 200 ? jiraDirectoryUser(response.body) : undefined;
    if (user === undefined) return DIRECTORY_ACCESS_MALFORMED;
    if (user.key !== expected.key || user.name !== expected.name)
      return directoryAccessRefusal(
        "The reviewed user key and username do not identify the same native user. Read both identities again; neither selector is a fallback for the other.",
        "conflict",
      );
  }
  return undefined;
}
export async function readDirectoryColumns(
  request: JiraMutationRequest,
  username: string,
): Promise<DirectoryAccessObservation<readonly string[]>> {
  const response = await request(
    `user/columns?${new URLSearchParams({ username }).toString()}`,
    "GET",
    undefined,
    "json-array",
  );
  if (!response.ok) return dispatchFailure(response);
  if (response.status !== 200 || response.items === undefined) return DIRECTORY_ACCESS_MALFORMED;
  const current = projectJiraFilterColumnState(response);
  if (!current.ok) return current;
  return current.columns === undefined
    ? directoryAccessRefusal(
        "The complete native ordered user column sequence is unavailable. A partial array or a different user's layout cannot replace it.",
        "unavailable",
      )
    : { ok: true, value: Object.freeze([...current.columns]) };
}
