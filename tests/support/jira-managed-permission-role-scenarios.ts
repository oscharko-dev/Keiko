import { jiraManagedScenarios, type JiraManagedScenario } from "./jira-managed-scenario.js";
import { PERMISSION_SCHEME_MUTATION_CASES as permission } from "./jira-permission-scheme-mutation-fixture.js";
import { ROLE_MUTATION_FIXTURE_CASES as role } from "./jira-role-mutation-fixture.js";

type PermissionRoleMutation = (typeof permission)[number]["tool"] | (typeof role)[number]["name"];
const ACTOR = "synthetic-key";
const SCHEME = { userKey: ACTOR, schemeId: "7" };
const ROLE = { userKey: ACTOR, roleId: "7", rolePresent: true };
const PROJECT = { ...ROLE, projectId: "10000", projectKey: "SYN", roleActorsScope: "project-membership" };
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
/** Independent arguments, receipts and state; never derived from a product result or registry. */
const SCENARIOS = {
  "jira.create-permission-scheme": {
    args: permission[0].args,
    receipt: { userKey: ACTOR, schemeId: "9007199254740993", schemePresent: true },
    remoteState: { lifecycle: {
      schemes: [ORIGINAL_SCHEME, { id: "9007199254740993", name: "Planning permissions", description: "" }],
      grants: [["7", GRANTS], ["9007199254740993", [{ id: "31", permission: "ADD_COMMENTS", holder: { type: "projectRole", parameter: "10002" } }]]],
      attributes: ATTRIBUTES, writes: 1,
    } },
    outcome: "succeeded",
  },
  "jira.update-permission-scheme": {
    args: permission[1].args,
    receipt: { ...SCHEME, schemePresent: true },
    remoteState: { lifecycle: { schemes: [{ ...ORIGINAL_SCHEME, description: "" }], grants: [["7", GRANTS]], attributes: ATTRIBUTES, writes: 1 } },
    outcome: "succeeded",
  },
  "jira.delete-permission-scheme": {
    args: permission[2].args,
    receipt: { ...SCHEME, schemePresent: false },
    remoteState: { lifecycle: { schemes: [], grants: [], attributes: ATTRIBUTES, writes: 1 } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.add-permission-grant": {
    args: permission[3].args,
    receipt: { ...SCHEME, permissionId: "23", grantPresent: true },
    remoteState: { lifecycle: { schemes: [ORIGINAL_SCHEME], grants: [["7", [...GRANTS, { id: "23", permission: "ADD_COMMENTS", holder: { type: "projectRole", parameter: "10002" } }]]], attributes: ATTRIBUTES, writes: 1 } },
    outcome: "succeeded",
  },
  "jira.delete-permission-grant": {
    args: permission[4].args,
    receipt: { ...SCHEME, permissionId: "21", grantPresent: false },
    remoteState: { lifecycle: { schemes: [ORIGINAL_SCHEME], grants: [["7", [{ id: "22", permission: "EDIT_ISSUES", holder: { type: "user", parameter: "user-1" } }]]], attributes: ATTRIBUTES, writes: 1 } },
    outcome: "succeeded",
  },
  "jira.set-permission-scheme-attribute": {
    args: permission[5].args,
    receipt: { ...SCHEME, attributeKey: "ADMINISTER_PROJECTS.extended.enabled", attributeEnabled: false },
    remoteState: { lifecycle: { schemes: [ORIGINAL_SCHEME], grants: [["7", GRANTS]], attributes: [["ADMINISTER_PROJECTS.extended.enabled", "false"]], writes: 1 } },
    outcome: "succeeded",
  },
  "jira.create-role": {
    args: role[0].args,
    receipt: { userKey: ACTOR, roleId: "9007199254740993", rolePresent: true },
    remoteState: { lifecycle: { ...ROLE_STATE, roles: [...ORIGINAL_ROLES, { id: "9007199254740993", name: "New role" }] } },
    outcome: "succeeded",
  },
  "jira.update-role": {
    args: role[1].args,
    receipt: ROLE,
    remoteState: { lifecycle: { ...ROLE_STATE, roles: [{ id: "7", name: "Renamed role" }, { id: "9", name: "Replacement" }] } },
    outcome: "succeeded",
  },
  "jira.replace-role": {
    args: role[2].args,
    receipt: ROLE,
    remoteState: { lifecycle: { ...ROLE_STATE, roles: [{ id: "7", name: "Renamed role" }, { id: "9", name: "Replacement" }] } },
    outcome: "succeeded",
  },
  "jira.delete-role": {
    args: role[3].args,
    receipt: { ...ROLE, rolePresent: false, swapRoleId: "9" },
    remoteState: { lifecycle: { ...ROLE_STATE, roles: [{ id: "9", name: "Replacement" }], defaultActors: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.add-role-default-actors": {
    args: role[4].args,
    receipt: { ...ROLE, roleActorsScope: "role-defaults", actorChange: "add", actorUserKeys: ["next-key"], actorGroupNames: [] },
    remoteState: { lifecycle: { ...ROLE_STATE, defaultActors: [...DEFAULT_ACTORS, NEXT_USER] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-role-default-actor": {
    args: role[5].args,
    receipt: { ...ROLE, roleActorsScope: "role-defaults", actorChange: "remove", actorUserKeys: [], actorGroupNames: ["current-group"] },
    remoteState: { lifecycle: { ...ROLE_STATE, defaultActors: [] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.add-project-role-actors": {
    args: role[6].args,
    receipt: { ...PROJECT, actorChange: "add", actorUserKeys: ["next-key"], actorGroupNames: [] },
    remoteState: { lifecycle: { ...ROLE_STATE, projectActors: [...PROJECT_ACTORS, NEXT_USER] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.set-project-role-actors": {
    args: role[7].args,
    receipt: { ...PROJECT, actorChange: "replace", actorUserKeys: [], actorGroupNames: ["next-group"] },
    remoteState: { lifecycle: { ...ROLE_STATE, projectActors: [NEXT_GROUP] } },
    outcome: "succeeded-unconfirmed",
  },
  "jira.delete-project-role-actor": {
    args: role[8].args,
    receipt: { ...PROJECT, actorChange: "remove", actorUserKeys: ["current-key"], actorGroupNames: [] },
    remoteState: { lifecycle: { ...ROLE_STATE, projectActors: [] } },
    outcome: "succeeded-unconfirmed",
  },
} satisfies Readonly<Record<PermissionRoleMutation, JiraManagedScenario>>;
export const {
  arguments: PERMISSION_ROLE_ARGUMENTS,
  receipts: PERMISSION_ROLE_RECEIPTS,
  remoteState: PERMISSION_ROLE_REMOTE_STATE,
  outcomes: PERMISSION_ROLE_EXPECTED_OUTCOMES,
  expectedOutcome: expectedPermissionRoleOutcome,
} = jiraManagedScenarios(SCENARIOS, ACTOR);
