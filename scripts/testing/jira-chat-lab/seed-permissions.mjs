import { actorDetails, basicAuth, checked } from "./lab-client.mjs";
import assert from "node:assert/strict";

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
];
function grants(actor, permissions) {
  return permissions.map((permission) => ({
    permission,
    holder: { type: "user", parameter: actorDetails(actor).name },
  }));
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
  const normalize = (values) =>
    values
      .map((value) => `${value.permission}:${value.holder.type}:${value.holder.parameter}`)
      .sort()
      .join("|");
  if (normalize(actual.permissions) !== normalize(permissions))
    throw new TypeError("Synthetic permission scheme drift");
  const path = `/rest/api/2/project/${project}/permissionscheme`;
  const current = await checked(session, "current-permission-scheme", "GET", path, auth);
  if (String(current.id) !== String(scheme.id))
    await checked(session, "associate-permission-scheme", "PUT", path, auth, { id: scheme.id });
}

export async function ensureFixturePermissions(session, actors) {
  await associateScheme(session, "KEIKO", [
    ...grants("admin", full),
    ...grants("api", full),
    ...grants("editor", ["BROWSE_PROJECTS", "EDIT_ISSUES", "ADD_COMMENTS"]),
    ...grants("assignee", ["BROWSE_PROJECTS", "ASSIGNABLE_USER"]),
  ]);
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
