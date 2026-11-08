import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { PERMISSION_SCHEME_MUTATION_CASES as permission } from "./jira-permission-scheme-mutation-fixture.js";
import { ROLE_MUTATION_FIXTURE_CASES as role } from "./jira-role-mutation-fixture.js";

type PermissionRoleMutation = (typeof permission)[number]["tool"] | (typeof role)[number]["name"];
const ACTOR = "synthetic-key";
const SCHEME = { userKey: ACTOR, schemeId: "7" };
const ROLE = { userKey: ACTOR, roleId: "7", rolePresent: true };
const PROJECT = { ...ROLE, projectId: "10000", projectKey: "SYN", roleActorsScope: "project-membership" };
/** Independent arguments and expected receipts; never derived from a product result or registry. */
export const PERMISSION_ROLE_ARGUMENTS: Readonly<Record<PermissionRoleMutation, CatalogJsonObject>> = {
  "jira.create-permission-scheme": { ...permission[0].args, expectedActorKey: ACTOR },
  "jira.update-permission-scheme": { ...permission[1].args, expectedActorKey: ACTOR },
  "jira.delete-permission-scheme": { ...permission[2].args, expectedActorKey: ACTOR },
  "jira.add-permission-grant": { ...permission[3].args, expectedActorKey: ACTOR },
  "jira.delete-permission-grant": { ...permission[4].args, expectedActorKey: ACTOR },
  "jira.set-permission-scheme-attribute": { ...permission[5].args, expectedActorKey: ACTOR },
  "jira.create-role": { ...role[0].args, expectedActorKey: ACTOR },
  "jira.update-role": { ...role[1].args, expectedActorKey: ACTOR },
  "jira.replace-role": { ...role[2].args, expectedActorKey: ACTOR },
  "jira.delete-role": { ...role[3].args, expectedActorKey: ACTOR },
  "jira.add-role-default-actors": { ...role[4].args, expectedActorKey: ACTOR },
  "jira.delete-role-default-actor": { ...role[5].args, expectedActorKey: ACTOR },
  "jira.add-project-role-actors": { ...role[6].args, expectedActorKey: ACTOR },
  "jira.set-project-role-actors": { ...role[7].args, expectedActorKey: ACTOR },
  "jira.delete-project-role-actor": { ...role[8].args, expectedActorKey: ACTOR },
};
export const PERMISSION_ROLE_RECEIPTS: Readonly<Record<PermissionRoleMutation, CatalogJsonObject>> = {
  "jira.create-permission-scheme": { userKey: ACTOR, schemeId: "9007199254740993", schemePresent: true },
  "jira.update-permission-scheme": { ...SCHEME, schemePresent: true },
  "jira.delete-permission-scheme": { ...SCHEME, schemePresent: false },
  "jira.add-permission-grant": { ...SCHEME, permissionId: "23", grantPresent: true },
  "jira.delete-permission-grant": { ...SCHEME, permissionId: "21", grantPresent: false },
  "jira.set-permission-scheme-attribute": { ...SCHEME, attributeKey: "ADMINISTER_PROJECTS.extended.enabled", attributeEnabled: false },
  "jira.create-role": { userKey: ACTOR, roleId: "9007199254740993", rolePresent: true },
  "jira.update-role": ROLE,
  "jira.replace-role": ROLE,
  "jira.delete-role": { ...ROLE, rolePresent: false, swapRoleId: "9" },
  "jira.add-role-default-actors": { ...ROLE, roleActorsScope: "role-defaults", actorChange: "add", actorUserKeys: ["next-key"], actorGroupNames: [] },
  "jira.delete-role-default-actor": { ...ROLE, roleActorsScope: "role-defaults", actorChange: "remove", actorUserKeys: [], actorGroupNames: ["current-group"] },
  "jira.add-project-role-actors": { ...PROJECT, actorChange: "add", actorUserKeys: ["next-key"], actorGroupNames: [] },
  "jira.set-project-role-actors": { ...PROJECT, actorChange: "replace", actorUserKeys: [], actorGroupNames: ["next-group"] },
  "jira.delete-project-role-actor": { ...PROJECT, actorChange: "remove", actorUserKeys: ["current-key"], actorGroupNames: [] },
};
const GRANTS = [
  { id: "21", permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "Developers" } },
  { id: "22", permission: "EDIT_ISSUES", holder: { type: "user", parameter: "user-1" } },
];
const ORIGINAL_SCHEME = { id: "7", name: "Delivery permissions", description: "Reviewed scheme", permissions: GRANTS };
const ATTRIBUTES = [["ADMINISTER_PROJECTS.extended.enabled", "true"]];
const ORIGINAL_ROLES = [{ id: "7", name: "Synthetic role" }, { id: "9", name: "Replacement" }];
const DEFAULT_ACTORS = [{ id: "70", type: "atlassian-group-role-actor", name: "current-group" }];
const PROJECT_ACTORS = [{ id: "80", type: "atlassian-user-role-actor", name: "current-user" }];
const NEXT_USER = { id: "100", type: "atlassian-user-role-actor", name: "next-user" };
const NEXT_GROUP = { id: "100", type: "atlassian-group-role-actor", name: "next-group" };
const ROLE_STATE = { roles: ORIGINAL_ROLES, defaultActors: DEFAULT_ACTORS, projectActors: PROJECT_ACTORS };
export const PERMISSION_ROLE_REMOTE_STATE: Readonly<Record<PermissionRoleMutation, object>> = {
  "jira.create-permission-scheme": { lifecycle: {
    schemes: [ORIGINAL_SCHEME, { id: "9007199254740993", name: "Planning permissions", description: "" }],
    grants: [["7", GRANTS], ["9007199254740993", [{ id: "31", permission: "ADD_COMMENTS", holder: { type: "projectRole", parameter: "10002" } }]]],
    attributes: ATTRIBUTES, writes: 1,
  } },
  "jira.update-permission-scheme": { lifecycle: { schemes: [{ ...ORIGINAL_SCHEME, description: "" }], grants: [["7", GRANTS]], attributes: ATTRIBUTES, writes: 1 } },
  "jira.delete-permission-scheme": { lifecycle: { schemes: [], grants: [], attributes: ATTRIBUTES, writes: 1 } },
  "jira.add-permission-grant": { lifecycle: { schemes: [ORIGINAL_SCHEME], grants: [["7", [...GRANTS, { id: "23", permission: "ADD_COMMENTS", holder: { type: "projectRole", parameter: "10002" } }]]], attributes: ATTRIBUTES, writes: 1 } },
  "jira.delete-permission-grant": { lifecycle: { schemes: [ORIGINAL_SCHEME], grants: [["7", [{ id: "22", permission: "EDIT_ISSUES", holder: { type: "user", parameter: "user-1" } }]]], attributes: ATTRIBUTES, writes: 1 } },
  "jira.set-permission-scheme-attribute": { lifecycle: { schemes: [ORIGINAL_SCHEME], grants: [["7", GRANTS]], attributes: [["ADMINISTER_PROJECTS.extended.enabled", "false"]], writes: 1 } },
  "jira.create-role": { lifecycle: { ...ROLE_STATE, roles: [...ORIGINAL_ROLES, { id: "9007199254740993", name: "New role" }] } },
  "jira.update-role": { lifecycle: { ...ROLE_STATE, roles: [{ id: "7", name: "Renamed role" }, { id: "9", name: "Replacement" }] } },
  "jira.replace-role": { lifecycle: { ...ROLE_STATE, roles: [{ id: "7", name: "Renamed role" }, { id: "9", name: "Replacement" }] } },
  "jira.delete-role": { lifecycle: { ...ROLE_STATE, roles: [{ id: "9", name: "Replacement" }], defaultActors: [] } },
  "jira.add-role-default-actors": { lifecycle: { ...ROLE_STATE, defaultActors: [...DEFAULT_ACTORS, NEXT_USER] } },
  "jira.delete-role-default-actor": { lifecycle: { ...ROLE_STATE, defaultActors: [] } },
  "jira.add-project-role-actors": { lifecycle: { ...ROLE_STATE, projectActors: [...PROJECT_ACTORS, NEXT_USER] } },
  "jira.set-project-role-actors": { lifecycle: { ...ROLE_STATE, projectActors: [NEXT_GROUP] } },
  "jira.delete-project-role-actor": { lifecycle: { ...ROLE_STATE, projectActors: [] } },
};
export const PERMISSION_ROLE_EXPECTED_OUTCOMES = {
  "jira.create-permission-scheme": "succeeded",
  "jira.update-permission-scheme": "succeeded",
  "jira.delete-permission-scheme": "succeeded-unconfirmed",
  "jira.add-permission-grant": "succeeded",
  "jira.delete-permission-grant": "succeeded",
  "jira.set-permission-scheme-attribute": "succeeded",
  "jira.create-role": "succeeded",
  "jira.update-role": "succeeded",
  "jira.replace-role": "succeeded",
  "jira.delete-role": "succeeded-unconfirmed",
  "jira.add-role-default-actors": "succeeded-unconfirmed",
  "jira.delete-role-default-actor": "succeeded-unconfirmed",
  "jira.add-project-role-actors": "succeeded-unconfirmed",
  "jira.set-project-role-actors": "succeeded-unconfirmed",
  "jira.delete-project-role-actor": "succeeded-unconfirmed",
} as const satisfies Readonly<Record<PermissionRoleMutation, "succeeded" | "succeeded-unconfirmed">>;
export function expectedPermissionRoleOutcome(operation: string): "succeeded" | "succeeded-unconfirmed" | undefined {
  const outcomes: Readonly<Record<string, "succeeded" | "succeeded-unconfirmed">> = PERMISSION_ROLE_EXPECTED_OUTCOMES;
  return Object.hasOwn(outcomes, operation) ? outcomes[operation] : undefined;
}
