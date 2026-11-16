import { compareStrings } from "../../lib/compare-strings.mjs";
import { actorDetails, basicAuth, checked, labNativeId } from "./lab-client.mjs";
import assert from "node:assert/strict";
import { URLSearchParams } from "node:url";

const full = [
  "BROWSE_PROJECTS",
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "ASSIGN_ISSUES",
  "ASSIGNABLE_USER",
  "ADD_COMMENTS",
  "EDIT_OWN_COMMENTS",
  "TRANSITION_ISSUES",
  "RESOLVE_ISSUES",
  "CLOSE_ISSUES",
  "CREATE_ATTACHMENTS",
  "LINK_ISSUES",
];
/**
 * What the model-free AC7 write cases need beyond the basic set: worklogs, comment and attachment
 * deletion, sprint scheduling, voters and watchers. Only the two qualification actors hold them;
 * the editor, assignee and restricted actors keep their narrow grants so denials stay provable.
 */
export const QUALIFICATION_EXTRA = [
  "WORK_ON_ISSUES",
  "EDIT_OWN_WORKLOGS",
  "EDIT_ALL_WORKLOGS",
  "DELETE_OWN_WORKLOGS",
  "DELETE_ALL_WORKLOGS",
  "EDIT_ALL_COMMENTS",
  "DELETE_OWN_COMMENTS",
  "DELETE_ALL_COMMENTS",
  "DELETE_OWN_ATTACHMENTS",
  "DELETE_ISSUES",
  "MOVE_ISSUES",
  "SCHEDULE_ISSUES",
  "MANAGE_WATCHERS",
  "VIEW_VOTERS_AND_WATCHERS",
];

/** The extra grants plus Jira's own key for "Manage Sprints", all verified against the inventory. */
export function qualificationGrantKeys(inventory) {
  if (inventory?.permissions === null || typeof inventory?.permissions !== "object")
    throw new TypeError("Native permission inventory is unavailable");
  const offered = Object.entries(inventory.permissions).map(([key, value]) => ({ ...value, key }));
  const sprint = offered.filter(
    (value) =>
      typeof value.name === "string" && value.name.trim().toLowerCase() === "manage sprints",
  );
  if (sprint.length !== 1) throw new TypeError("Manage Sprints is missing or ambiguous");
  const keys = new Set(offered.map((value) => value.key));
  const missing = QUALIFICATION_EXTRA.filter((key) => !keys.has(key));
  if (missing.length > 0)
    throw new TypeError(`Native permissions unavailable for AC7 fixtures: ${missing.join(",")}`);
  return [...full, ...QUALIFICATION_EXTRA, sprint[0].key];
}

function grants(actor, permissions) {
  return permissions.map((permission) => ({
    permission,
    holder: { type: "user", parameter: actorDetails(actor).name },
  }));
}

const grantKey = (value) => `${value.permission}:${value.holder.type}:${value.holder.parameter}`;
const normalizeGrants = (values) =>
  values
    .map((value) => grantKey(value))
    .sort(compareStrings)
    .join("|");

/** A lab seeded by an earlier fixture gains new grants; anything else in its scheme is drift. */
async function reconcileGrants(session, auth, schemeId, actual, permissions) {
  const present = new Set(actual.map((value) => grantKey(value)));
  const missing = permissions.filter((grant) => !present.has(grantKey(grant)));
  await Promise.all(
    missing.map((grant) =>
      checked(
        session,
        "add-permission-grant",
        "POST",
        `/rest/api/2/permissionscheme/${schemeId}/permission`,
        auth,
        grant,
        [201],
      ),
    ),
  );
  if (normalizeGrants([...actual, ...missing]) !== normalizeGrants(permissions))
    throw new TypeError("Synthetic permission scheme drift");
}

async function associateScheme(session, project, permissions) {
  const auth = basicAuth(session, "admin");
  const name = `Keiko synthetic ${project} permissions`;
  const schemes = await checked(
    session,
    "find-permission-scheme",
    "GET",
    "/rest/api/2/permissionscheme?expand=permissions",
    auth,
  );
  const found = schemes.permissionSchemes.filter((scheme) => scheme.name === name);
  if (found.length > 1) throw new TypeError("Ambiguous synthetic permission scheme");
  const scheme =
    found[0] ??
    (await checked(
      session,
      "create-permission-scheme",
      "POST",
      "/rest/api/2/permissionscheme",
      auth,
      { name, description: "Synthetic isolated permission fixture", permissions },
    ));
  const actual = await checked(
    session,
    "read-permission-scheme",
    "GET",
    `/rest/api/2/permissionscheme/${scheme.id}?expand=permissions`,
    auth,
  );
  await reconcileGrants(session, auth, scheme.id, actual.permissions, permissions);
  const path = `/rest/api/2/project/${project}/permissionscheme`;
  const current = await checked(session, "current-permission-scheme", "GET", path, auth);
  if (String(current.id) !== String(scheme.id))
    await checked(session, "associate-permission-scheme", "PUT", path, auth, { id: scheme.id });
}

/** Native booleans prove the qualification actors hold every extra grant and the others none. */
export async function verifyQualificationSeparation(session, actors, keys) {
  const extra = keys.filter((key) => !full.includes(key));
  const query = `/rest/api/2/mypermissions?projectKey=KEIKO&permissions=${extra.join(",")}`;
  for (const [actor, expected] of [
    ["api", true],
    ["editor", false],
    ["assignee", false],
    ["restricted", false],
  ]) {
    const result = await checked(session, "qualification-separation", "GET", query, actors[actor]);
    if (extra.some((key) => result.permissions[key]?.havePermission !== expected))
      throw new TypeError("Synthetic qualification permissions do not separate capabilities");
  }
}

/**
 * The shared KEIKO scheme: the widened set goes to admin and api only. The editor, assignee and
 * restricted actors keep exactly the narrow grants the denial cases (editor cannot assign or
 * transition, restricted cannot read KEIKO) depend on.
 */
export function keikoGrantPlan(qualification) {
  return [
    ...grants("admin", qualification),
    ...grants("api", qualification),
    ...grants("editor", ["BROWSE_PROJECTS", "EDIT_ISSUES", "ADD_COMMENTS"]),
    ...grants("assignee", ["BROWSE_PROJECTS", "ASSIGNABLE_USER"]),
  ];
}

export async function ensureFixturePermissions(session, actors) {
  const inventory = await checked(
    session,
    "permission-inventory",
    "GET",
    "/rest/api/2/permissions",
    basicAuth(session, "admin"),
  );
  const qualification = qualificationGrantKeys(inventory);
  await associateScheme(session, "KEIKO", keikoGrantPlan(qualification));
  await associateScheme(session, "ISOLATED", [
    ...grants("admin", full),
    ...grants("restricted", ["BROWSE_PROJECTS"]),
  ]);
  for (const [actor, project, expected] of [
    ["api", "KEIKO", [true, true, true, true]],
    ["editor", "KEIKO", [true, true, false, false]],
    ["restricted", "KEIKO", [false, false, false, false]],
    ["restricted", "ISOLATED", [true, false, false, false]],
    ["api", "ISOLATED", [false, false, false, false]],
  ]) {
    const names = ["BROWSE_PROJECTS", "EDIT_ISSUES", "ASSIGN_ISSUES", "TRANSITION_ISSUES"];
    const result = await checked(
      session,
      "permission-separation",
      "GET",
      `/rest/api/2/mypermissions?projectKey=${project}&permissions=${names.join(",")}`,
      actors[actor],
    );
    if (names.some((name, index) => result.permissions[name].havePermission !== expected[index]))
      throw new TypeError("Synthetic permissions do not separate capabilities");
  }
  await verifyQualificationSeparation(session, actors, qualification);
}

export async function verifyFixtureRestrictions(session, actors, key) {
  const path = `/rest/api/2/issue/${key}`;
  const before = await checked(session, "permission-baseline", "GET", path, actors.api);
  await checked(
    session,
    "restricted-project-hidden",
    "GET",
    path,
    actors.restricted,
    undefined,
    [403],
  );
  const assignable = await checked(
    session,
    "assignable-fixture",
    "GET",
    "/rest/api/2/user/assignable/search?project=KEIKO&username=keiko-assignee",
    actors.api,
  );
  assert.ok(assignable.some((user) => user.name === "keiko-assignee"));
  await checked(
    session,
    "editor-cannot-assign",
    "PUT",
    `${path}/assignee`,
    actors.editor,
    { name: "keiko-assignee" },
    [403],
  );
  await verifyTransitionDenial(session, actors, path);
  const after = await checked(session, "denied-effects-unchanged", "GET", path, actors.api);
  assert.equal(after.fields.status.id, before.fields.status.id);
  assert.equal(after.fields.assignee?.name, before.fields.assignee?.name);
}

async function verifyTransitionDenial(session, actors, path) {
  const transitions = await checked(
    session,
    "valid-transition-fixture",
    "GET",
    `${path}/transitions?expand=transitions.fields`,
    actors.api,
  );
  const transition = transitions.transitions.find((value) =>
    Object.values(value.fields).every((field) => !field.required),
  );
  if (!transition) throw new TypeError("Missing screen-free transition for permission proof");
  await checked(
    session,
    "editor-cannot-transition",
    "POST",
    `${path}/transitions`,
    actors.editor,
    { transition: { id: transition.id } },
    [400, 403],
  );
}

export const ROLE_DEVELOPER_PERMISSIONS = [
  "BROWSE_PROJECTS",
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "ASSIGN_ISSUES",
  "ASSIGNABLE_USER",
  "TRANSITION_ISSUES",
  "WORK_ON_ISSUES",
  "ADD_COMMENTS",
  "EDIT_OWN_COMMENTS",
  "LINK_ISSUES",
  "RESOLVE_ISSUES",
  "CLOSE_ISSUES",
  "VIEW_VOTERS_AND_WATCHERS",
  "MANAGE_WATCHERS",
];
const BROWSER_ROLES = ["projectLead", "developer", "techLead"];

function nativeProjectPermissions(inventory) {
  if (inventory?.permissions === null || typeof inventory?.permissions !== "object")
    throw new TypeError("Native permission inventory is unavailable");
  return Object.entries(inventory.permissions)
    .map(([key, value]) => {
      if (value?.key !== undefined && value.key !== key)
        throw new TypeError("Native permission identity disagrees with its inventory key");
      return { ...value, key };
    })
    .filter((value) => value.type === "PROJECT");
}

/** The plugin's native sprint permission key comes from Jira, never from a guessed constant. */
export function browserRolePermissionPlan(inventory) {
  const native = nativeProjectPermissions(inventory);
  const sprint = native.filter(
    (value) =>
      typeof value.name === "string" && value.name.trim().toLowerCase() === "manage sprints",
  );
  if (sprint.length !== 1) throw new TypeError("Manage Sprints is missing or ambiguous");
  if (
    new Set(["ADMINISTER", "ADMINISTER_PROJECTS", ...ROLE_DEVELOPER_PERMISSIONS]).has(sprint[0].key)
  )
    throw new TypeError("Native sprint and ordinary permission identities overlap");
  const projectLead = [
    ...ROLE_DEVELOPER_PERMISSIONS,
    "SCHEDULE_ISSUES",
    "ADMINISTER_PROJECTS",
    sprint[0].key,
  ];
  const plan = {
    admin: projectLead,
    projectLead,
    developer: [...ROLE_DEVELOPER_PERMISSIONS],
    techLead: [
      "BROWSE_PROJECTS",
      "EDIT_ISSUES",
      "LINK_ISSUES",
      "ADMINISTER_PROJECTS",
      "ASSIGNABLE_USER",
    ],
  };
  const offered = new Set(native.map((value) => value.key));
  for (const values of Object.values(plan)) {
    if (values.some((key) => key === "ADMINISTER" || !offered.has(key)))
      throw new TypeError("A required native project permission is unavailable");
  }
  return { manageSprintsKey: sprint[0].key, byActor: plan };
}

function browserRoleGrants(plan, actors) {
  const names = Object.keys(plan.byActor).map((role) => actors[role]?.name);
  if (
    names.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(names).size !== names.length
  )
    throw new TypeError("Role permission holders must be distinct observed native users");
  return Object.entries(plan.byActor).flatMap(([role, values]) =>
    values.map((permission) => ({
      permission,
      holder: { type: "user", parameter: actors[role].name },
    })),
  );
}

/** A fresh project gets one exact direct-user scheme; inherited/public grants are never accepted. */
export async function seedBrowserRolePermissions(jira, projectKey, actors) {
  const inventory = await jira.call("roles-permissions", "GET", "/rest/api/2/permissions");
  const plan = browserRolePermissionPlan(inventory);
  const permissions = browserRoleGrants(plan, actors);
  const scheme = await jira.call(
    "roles-create-permission-scheme",
    "POST",
    "/rest/api/2/permissionscheme",
    {
      name: `${projectKey} browser roles`,
      description: "Synthetic isolated browser roles",
      permissions,
    },
  );
  const schemeId = labNativeId(scheme?.id);
  const selected = { ...plan, schemeId };
  await verifyBrowserRoleGrants(jira, actors, selected);
  const path = `/rest/api/2/project/${encodeURIComponent(projectKey)}/permissionscheme`;
  await jira.call("roles-associate-permission-scheme", "PUT", path, { id: scheme.id });
  await verifyBrowserRoleAssociation(jira, projectKey, selected);
  return selected;
}

async function verifyBrowserRoleGrants(jira, actors, plan) {
  const observed = await jira.call(
    "roles-observe-permission-scheme",
    "GET",
    `/rest/api/2/permissionscheme/${plan.schemeId}?expand=permissions`,
  );
  const permissions = browserRoleGrants(plan, actors);
  if (
    labNativeId(observed.id) !== plan.schemeId ||
    !Array.isArray(observed.permissions) ||
    normalizeGrants(observed.permissions) !== normalizeGrants(permissions)
  )
    throw new TypeError("Native role permission grants differ from the exact requested scheme");
}

async function verifyBrowserRoleAssociation(jira, projectKey, plan) {
  const selected = await jira.call(
    "roles-observe-associated-scheme",
    "GET",
    `/rest/api/2/project/${encodeURIComponent(projectKey)}/permissionscheme`,
  );
  if (labNativeId(selected.id) !== plan.schemeId)
    throw new TypeError("The fresh project did not retain its role permission scheme");
}

/** The project share is bounded by this exact direct-user scheme, including its admin oracle. */
export async function verifyBrowserRoleScheme(jira, projectKey, actors, plan) {
  await verifyBrowserRoleGrants(jira, actors, plan);
  await verifyBrowserRoleAssociation(jira, projectKey, plan);
}

/** Explicit native booleans prove both each role's grants and its withheld administrative rights. */
export async function verifyBrowserRolePermissions(portFor, projectKey, plan) {
  const keys = [...new Set(["ADMINISTER", ...Object.values(plan.byActor).flat()])];
  const query = new URLSearchParams({ projectKey, permissions: keys.join(",") });
  for (const role of BROWSER_ROLES) {
    const value = await portFor(role).call(
      "roles-verify-permissions",
      "GET",
      `/rest/api/2/mypermissions?${query}`,
    );
    const expected = new Set(plan.byActor[role]);
    if (keys.some((key) => value.permissions?.[key]?.havePermission !== expected.has(key)))
      throw new TypeError("Native project permissions do not isolate the requested browser role");
  }
}
