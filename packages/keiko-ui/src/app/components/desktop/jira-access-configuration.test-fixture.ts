import type { JiraPermissionSchemeMutation, JiraRoleMutation } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";

interface AccessCase {
  readonly operation: JiraPermissionSchemeMutation | JiraRoleMutation;
  readonly args: CatalogJsonObject;
  readonly receipt: CatalogJsonObject;
  readonly unconfirmable?: true;
}
export const ACCESS_SCHEME = { id: "7", name: "Reviewed permissions", description: "", permissions: [
  { id: "21", permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "Developers" } },
  { id: "22", permission: "EDIT_ISSUES", holder: { type: "user", parameter: "reviewed-user" } },
] };
export const ACCESS_ROLE = { id: "7", name: "Reviewed role", description: null };
export const ACCESS_ACTORS = [{ id: "70", type: "atlassian-group-role-actor", name: "current-group" }];
const ACTOR = { expectedActorKey: "actor-key" };
const SCHEME = { ...ACTOR, expectedScheme: ACCESS_SCHEME };
const ROLE = { ...ACTOR, expectedRole: ACCESS_ROLE, expectedActors: ACCESS_ACTORS };
const PROJECT = { ...ROLE, projectIdOrKey: "SYN", expectedActors: [{ id: "80", type: "atlassian-user-role-actor", name: "current-user" }] };
const PRINCIPALS = { users: [{ key: "next-key", name: "next-user" }], groups: [] };
const SCHEME_RECEIPT = { userKey: "actor-key", schemeId: "7", outcome: "succeeded" };
const ROLE_RECEIPT = { userKey: "actor-key", roleId: "7", rolePresent: true, outcome: "succeeded" };
const UNCONFIRMED = { outcome: "succeeded-unconfirmed", reason: "unavailable" };
const ACTOR_RECEIPT = { ...ROLE_RECEIPT, ...UNCONFIRMED, actorUserKeys: ["next-key"], actorGroupNames: [], actorChange: "add" };
const PROJECT_RECEIPT = { ...ACTOR_RECEIPT, roleActorsScope: "project-membership", projectId: "10000", projectKey: "SYN" };
export const ACCESS_CONFIGURATION_CASES: readonly AccessCase[] = [
  { operation: "jira.create-permission-scheme", args: { ...ACTOR, name: "New permissions", description: "", permissions: [] },
    receipt: { ...SCHEME_RECEIPT, schemeId: "9007199254740993", schemePresent: true } },
  { operation: "jira.update-permission-scheme", args: { ...SCHEME, description: "", permissions: [] },
    receipt: { ...SCHEME_RECEIPT, schemePresent: true } },
  { operation: "jira.delete-permission-scheme", args: { ...SCHEME, confirmUnverifiedDeletion: true },
    receipt: { ...SCHEME_RECEIPT, ...UNCONFIRMED, schemePresent: false }, unconfirmable: true },
  { operation: "jira.add-permission-grant", args: { ...SCHEME, grant: { permission: "ADD_COMMENTS", holder: { type: "projectRole", parameter: "10002" } } },
    receipt: { ...SCHEME_RECEIPT, permissionId: "23", grantPresent: true } },
  { operation: "jira.delete-permission-grant", args: { ...SCHEME, permissionId: "21" },
    receipt: { ...SCHEME_RECEIPT, permissionId: "21", grantPresent: false } },
  { operation: "jira.set-permission-scheme-attribute", args: { ...SCHEME, attributeKey: "ADMINISTER_PROJECTS.extended.enabled", expectedValue: "true", enabled: false },
    receipt: { ...SCHEME_RECEIPT, attributeKey: "ADMINISTER_PROJECTS.extended.enabled", attributeEnabled: false } },
  { operation: "jira.create-role", args: { ...ACTOR, name: "New role", description: "" },
    receipt: { ...ROLE_RECEIPT, roleId: "9007199254740993" } },
  { operation: "jira.update-role", args: { ...ROLE, name: "Renamed role" }, receipt: ROLE_RECEIPT },
  { operation: "jira.replace-role", args: { ...ROLE, name: "Renamed role", description: "" }, receipt: ROLE_RECEIPT },
  { operation: "jira.delete-role", args: { ...ROLE, confirmUnverifiedDeletion: true,
    expectedSwapRole: { id: "9", name: "Replacement role", description: "" }, expectedSwapActors: [] },
    receipt: { ...ROLE_RECEIPT, ...UNCONFIRMED, rolePresent: false, swapRoleId: "9" }, unconfirmable: true },
  { operation: "jira.add-role-default-actors", args: { ...ROLE, principals: PRINCIPALS },
    receipt: { ...ACTOR_RECEIPT, roleActorsScope: "role-defaults" }, unconfirmable: true },
  { operation: "jira.delete-role-default-actor", args: { ...ROLE, principals: { users: [], groups: ["current-group"] } },
    receipt: { ...ACTOR_RECEIPT, roleActorsScope: "role-defaults", actorChange: "remove", actorUserKeys: [], actorGroupNames: ["current-group"] }, unconfirmable: true },
  { operation: "jira.add-project-role-actors", args: { ...PROJECT, principals: PRINCIPALS }, receipt: PROJECT_RECEIPT, unconfirmable: true },
  { operation: "jira.set-project-role-actors", args: { ...PROJECT, principals: { users: [], groups: [] } },
    receipt: { ...PROJECT_RECEIPT, actorChange: "replace", actorUserKeys: [], actorGroupNames: [] }, unconfirmable: true },
  { operation: "jira.delete-project-role-actor", args: { ...PROJECT, principals: { users: [{ key: "current-key", name: "current-user" }], groups: [] } },
    receipt: { ...PROJECT_RECEIPT, actorChange: "remove", actorUserKeys: ["current-key"] }, unconfirmable: true },
];
export function accessConfigurationCase(operation: AccessCase["operation"]): AccessCase {
  const selected = ACCESS_CONFIGURATION_CASES.find((item) => item.operation === operation);
  if (selected === undefined) throw new TypeError("Missing access configuration fixture");
  return selected;
}
