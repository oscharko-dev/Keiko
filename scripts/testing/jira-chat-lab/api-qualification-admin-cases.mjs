// Isolated synthetic configuration lifecycles through the existing governed qualifier.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { assertQualificationJson } from "./api-qualification-json.mjs";
const proof = (assertionCount) => ({ matched: true, assertionCount });
async function read(context, path) {
  const response = await labRequest(
    context.session,
    "GET",
    path,
    basicAuth(context.session, context.actor),
  );
  assert.equal(response.status, 200);
  return response.value;
}
async function actor(context, f) {
  const value = await read(context, "/rest/api/2/myself");
  assert.equal(value.name, "keiko-admin");
  f.adminActorKey = value.key;
}
const mutation = (tool, args, readback, prepare = actor) => ({
  tool,
  actor: "admin",
  administration: true,
  mutation: true,
  destructiveAdministration: true,
  arguments: args,
  readback,
  prepare,
});
const name = (f, kind) => `Synthetic AC7 ${kind} ${f.runId}`;
const actorArgs = (f) => ({ expectedActorKey: f.adminActorKey });
const select = (value, fields) =>
  Object.fromEntries(
    fields.map((key) => {
      assert.ok(Object.hasOwn(value, key));
      return [key, key === "id" ? String(value[key]) : value[key]];
    }),
  );
const categoryPath = (f) => `/rest/api/2/projectCategory/${f.categoryId}`;
async function category(context, f) {
  await actor(context, f);
  f.categorySnapshot = select(await read(context, categoryPath(f)), ["id", "name", "description"]);
}
async function categoryReadback(context, data, f, updated = false) {
  f.categoryId ??= data.categoryId;
  assert.match(f.categoryId, /^[1-9][0-9]*$/u);
  const value = await read(context, categoryPath(f));
  assert.equal(String(value.id), f.categoryId);
  assert.equal(value.name, name(f, "category"));
  assert.equal(value.description, updated ? "Synthetic updated category" : "Synthetic category");
  return proof(3);
}
const linkPath = (f) => `/rest/api/2/issueLinkType/${f.adminLinkTypeId}`;
const linkFields = ["id", "name", "inward", "outward"];
async function link(context, f) {
  await actor(context, f);
  f.adminLinkSnapshot = select(await read(context, linkPath(f)), linkFields);
}
async function linkSequence(context, f) {
  await actor(context, f);
  f.adminLinkTypes = (await read(context, "/rest/api/2/issueLinkType")).issueLinkTypes.map((row) =>
    select(row, linkFields),
  );
}
async function linkReadback(context, data, f, updated = false) {
  f.adminLinkTypeId ??= data.linkTypeId;
  assert.match(f.adminLinkTypeId, /^[1-9][0-9]*$/u);
  const value = await read(context, linkPath(f));
  assert.equal(String(value.id), f.adminLinkTypeId);
  assert.equal(value.name, name(f, "link"));
  assert.equal(value.inward, updated ? "synthetic revised inward" : "synthetic inward");
  assert.equal(value.outward, "synthetic outward");
  return proof(4);
}
const schemePath = (f) => `/rest/api/2/permissionscheme/${f.adminPermissionSchemeId}`;
async function permission(context, f) {
  await actor(context, f);
  const value = await read(context, schemePath(f));
  const grants = await read(context, `${schemePath(f)}/permission`);
  assert.ok(Array.isArray(grants.permissions));
  f.adminPermissionSnapshot = {
    ...select(value, ["id", "name", "description"]),
    permissions: grants.permissions.map((grant) => ({
      id: String(grant.id),
      permission: grant.permission,
      holder: {
        type: grant.holder.type,
        ...(grant.holder.parameter === undefined ? {} : { parameter: grant.holder.parameter }),
      },
    })),
  };
}
async function permissionReadback(context, data, f, description) {
  f.adminPermissionSchemeId ??= data.schemeId;
  assert.match(f.adminPermissionSchemeId, /^[1-9][0-9]*$/u);
  const value = await read(context, schemePath(f));
  assert.equal(String(value.id), f.adminPermissionSchemeId);
  assert.equal(value.name, name(f, "permissions"));
  assert.equal(value.description, description);
  return proof(3);
}
const permissionArgs = (f) => ({ ...actorArgs(f), expectedScheme: f.adminPermissionSnapshot });
const rolePath = (f) => `/rest/api/2/role/${f.adminRoleId}`;
const actorProjection = (rows) => rows.map((row) => select(row, ["id", "type", "name"]));
async function role(context, f, project = false, username = "keiko-editor") {
  await actor(context, f);
  f.adminRoleSnapshot = select(await read(context, rolePath(f)), ["id", "name", "description"]);
  const value = await read(
    context,
    project ? `/rest/api/2/project/KEIKO/role/${f.adminRoleId}` : `${rolePath(f)}/actors`,
  );
  assert.ok(Array.isArray(value.actors));
  f.adminRoleActors = actorProjection(value.actors);
  const user = await read(context, `/rest/api/2/user?username=${username}`);
  assert.equal(user.name, username);
  f.adminRoleUser = { key: user.key, name: user.name };
}
const roleArgs = (f) => ({
  ...actorArgs(f),
  expectedRole: f.adminRoleSnapshot,
  expectedActors: f.adminRoleActors,
});
async function roleReadback(context, data, f, description) {
  f.adminRoleId ??= data.roleId;
  assert.match(f.adminRoleId, /^[1-9][0-9]*$/u);
  const value = await read(context, rolePath(f));
  assert.equal(String(value.id), f.adminRoleId);
  assert.equal(value.name, name(f, "role"));
  assert.equal(value.description, description);
  return proof(3);
}
function roleActors(tool, project, present, username = "keiko-editor") {
  return mutation(
    tool,
    (f) => ({
      ...roleArgs(f),
      ...(project ? { projectIdOrKey: "KEIKO" } : {}),
      principals: { users: [f.adminRoleUser], groups: [] },
    }),
    async (context, _data, f) => {
      const value = await read(
        context,
        project ? `/rest/api/2/project/KEIKO/role/${f.adminRoleId}` : `${rolePath(f)}/actors`,
      );
      assert.ok(Array.isArray(value.actors));
      assert.equal(
        value.actors.some(
          (row) => row.name === f.adminRoleUser.name && row.type === "atlassian-user-role-actor",
        ),
        present,
      );
      assert.equal(value.actors.length, present ? 1 : 0);
      return proof(3);
    },
    (context, f) => role(context, f, project, username),
  );
}
const groupName = (f) => `keiko-ac7-${f.runId}`;
const groupPath = (f) =>
  `/rest/api/2/group/member?groupname=${groupName(f)}&includeInactiveUsers=true&startAt=0&maxResults=50`;
async function group(context, f) {
  await actor(context, f);
  const user = await read(context, "/rest/api/2/user?username=keiko-editor");
  f.adminGroupUser = { key: user.key, name: user.name };
  const members = await read(context, groupPath(f));
  assert.ok(Array.isArray(members.values));
  assert.equal(members.isLast, true);
  f.groupMembership = members.values.some((row) => row.key === user.key);
}
function groupMember(tool, present) {
  return mutation(
    tool,
    (f) => ({
      ...actorArgs(f),
      groupName: groupName(f),
      user: f.adminGroupUser,
      expectedObservedMembership: f.groupMembership,
      acceptGlobalPermissionChange: true,
    }),
    async (context, _data, f) => {
      const value = await read(context, groupPath(f));
      assert.equal(value.isLast, true);
      assert.equal(
        value.values.some(
          (row) => row.key === f.adminGroupUser.key && row.name === f.adminGroupUser.name,
        ),
        present,
      );
      assert.equal(value.values.length, present ? 1 : 0);
      return proof(3);
    },
    group,
  );
}
export const API_QUALIFICATION_ADMIN_CASES = [
  mutation(
    "jira.create-project-category",
    (f) => ({ ...actorArgs(f), name: name(f, "category"), description: "Synthetic category" }),
    (c, d, f) => categoryReadback(c, d, f),
  ),
  {
    ...readCase("jira.project-category", categoryPath, ["id", "name", "description"], {
      args: (f) => ({ projectCategoryId: f.categoryId }),
      nativeRoot: "single",
      productRoot: "single",
    }),
    actor: "admin",
    administration: true,
  },
  mutation(
    "jira.update-project-category",
    (f) => ({
      ...actorArgs(f),
      expectedCategory: f.categorySnapshot,
      name: name(f, "category"),
      description: "Synthetic updated category",
    }),
    (c, d, f) => categoryReadback(c, d, f, true),
    category,
  ),
  mutation(
    "jira.delete-project-category",
    (f) => ({
      ...actorArgs(f),
      expectedCategory: f.categorySnapshot,
      confirmUnverifiedDeletion: true,
    }),
    async (c, _d, f) => {
      const rows = await read(c, "/rest/api/2/projectCategory");
      assert.equal(
        rows.some((row) => String(row.id) === f.categoryId),
        false,
      );
      return proof(1);
    },
    category,
  ),
  mutation(
    "jira.create-link-type",
    (f) => ({
      ...actorArgs(f),
      name: name(f, "link"),
      inward: "synthetic inward",
      outward: "synthetic outward",
    }),
    (c, d, f) => linkReadback(c, d, f),
  ),
  mutation(
    "jira.update-link-type",
    (f) => ({
      ...actorArgs(f),
      expectedLinkType: f.adminLinkSnapshot,
      name: name(f, "link"),
      inward: "synthetic revised inward",
      outward: "synthetic outward",
    }),
    (c, d, f) => linkReadback(c, d, f, true),
    link,
  ),
  mutation(
    "jira.move-link-type",
    (f) => ({
      ...actorArgs(f),
      expectedLinkTypes: f.adminLinkTypes,
      linkTypeId: f.adminLinkTypeId,
      newPosition: 1,
    }),
    async (c, _d, f) => {
      const rows = (await read(c, "/rest/api/2/issueLinkType")).issueLinkTypes;
      assert.equal(rows.filter((r) => String(r.id) === f.adminLinkTypeId).length, 1);
      assert.equal(rows.length, f.adminLinkTypes.length);
      return proof(2);
    },
    linkSequence,
  ),
  mutation(
    "jira.reset-link-type-order",
    (f) => ({ ...actorArgs(f), expectedLinkTypes: f.adminLinkTypes, direction: "asc" }),
    async (c, _d, f) => {
      const rows = (await read(c, "/rest/api/2/issueLinkType")).issueLinkTypes;
      assertQualificationJson(
        rows.map((r) => select(r, linkFields)).toSorted((a, b) => a.id.localeCompare(b.id)),
        f.adminLinkTypes.toSorted((a, b) => a.id.localeCompare(b.id)),
      );
      return proof(1);
    },
    linkSequence,
  ),
  mutation(
    "jira.delete-link-type",
    (f) => ({
      ...actorArgs(f),
      expectedLinkType: f.adminLinkSnapshot,
      confirmUnverifiedDeletion: true,
    }),
    async (c, _d, f) => {
      const rows = (await read(c, "/rest/api/2/issueLinkType")).issueLinkTypes;
      assert.equal(
        rows.some((r) => String(r.id) === f.adminLinkTypeId),
        false,
      );
      return proof(1);
    },
    link,
  ),
  mutation(
    "jira.create-permission-scheme",
    (f) => ({
      ...actorArgs(f),
      name: name(f, "permissions"),
      description: "Synthetic permissions",
      permissions: [],
    }),
    (c, d, f) => permissionReadback(c, d, f, "Synthetic permissions"),
  ),
  mutation(
    "jira.update-permission-scheme",
    (f) => ({ ...permissionArgs(f), description: "Synthetic permissions revised" }),
    (c, d, f) => permissionReadback(c, d, f, "Synthetic permissions revised"),
    permission,
  ),
  mutation(
    "jira.add-permission-grant",
    (f) => ({
      ...permissionArgs(f),
      grant: { permission: "BROWSE_PROJECTS", holder: { type: "reporter" } },
    }),
    async (c, d, f) => {
      assert.match(d.permissionId, /^[1-9][0-9]*$/u);
      f.adminGrantId = d.permissionId;
      const rows = (await read(c, `${schemePath(f)}/permission`)).permissions;
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].id), f.adminGrantId);
      assert.equal(rows[0].permission, "BROWSE_PROJECTS");
      assert.equal(rows[0].holder.type, "reporter");
      return proof(5);
    },
    permission,
  ),
  mutation(
    "jira.delete-permission-grant",
    (f) => ({ ...permissionArgs(f), permissionId: f.adminGrantId }),
    async (c, _d, f) => {
      assert.deepEqual((await read(c, `${schemePath(f)}/permission`)).permissions, []);
      return proof(1);
    },
    permission,
  ),
  mutation(
    "jira.delete-permission-scheme",
    (f) => ({ ...permissionArgs(f), confirmUnverifiedDeletion: true }),
    async (c, _d, f) => {
      const rows = (await read(c, "/rest/api/2/permissionscheme")).permissionSchemes;
      assert.equal(
        rows.some((r) => String(r.id) === f.adminPermissionSchemeId),
        false,
      );
      return proof(1);
    },
    permission,
  ),
  mutation(
    "jira.create-role",
    (f) => ({ ...actorArgs(f), name: name(f, "role"), description: "Synthetic role" }),
    (c, d, f) => roleReadback(c, d, f, "Synthetic role"),
  ),
  mutation(
    "jira.update-role",
    (f) => ({ ...roleArgs(f), description: "Synthetic role revised" }),
    (c, d, f) => roleReadback(c, d, f, "Synthetic role revised"),
    role,
  ),
  mutation(
    "jira.replace-role",
    (f) => ({ ...roleArgs(f), name: name(f, "role"), description: "Synthetic role replaced" }),
    (c, d, f) => roleReadback(c, d, f, "Synthetic role replaced"),
    role,
  ),
  roleActors("jira.add-role-default-actors", false, true),
  roleActors("jira.delete-role-default-actor", false, false),
  roleActors("jira.add-project-role-actors", true, true),
  roleActors("jira.set-project-role-actors", true, true, "keiko-api"),
  mutation(
    "jira.delete-project-role-actor",
    (f) => ({
      ...roleArgs(f),
      projectIdOrKey: "KEIKO",
      principals: { users: [f.adminRoleUser], groups: [] },
    }),
    async (c, _d, f) => {
      const rows = (await read(c, `/rest/api/2/project/KEIKO/role/${f.adminRoleId}`)).actors;
      assert.equal(
        rows.some((r) => r.name === f.adminRoleUser.name),
        false,
      );
      return proof(1);
    },
    (c, f) => role(c, f, true, "keiko-api"),
  ),
  mutation(
    "jira.delete-role",
    (f) => ({ ...roleArgs(f), confirmUnverifiedDeletion: true }),
    async (c, _d, f) => {
      const rows = await read(c, "/rest/api/2/role");
      assert.equal(
        rows.some((r) => String(r.id) === f.adminRoleId),
        false,
      );
      return proof(1);
    },
    role,
  ),
  mutation(
    "jira.create-group",
    (f) => ({ ...actorArgs(f), groupName: groupName(f) }),
    async (c, _d, f) => {
      const rows = await read(c, groupPath(f));
      assert.deepEqual(rows.values, []);
      assert.equal(rows.isLast, true);
      return proof(2);
    },
  ),
  groupMember("jira.add-group-user", true),
  groupMember("jira.remove-group-user", false),
  mutation(
    "jira.delete-group",
    (f) => ({
      ...actorArgs(f),
      groupName: groupName(f),
      acceptGlobalPermissionChange: true,
      confirmUnverifiedDeletion: true,
    }),
    async (c, _d, f) => {
      const value = await read(c, `/rest/api/2/groups/picker?query=${groupName(f)}&maxResults=100`);
      assert.equal(
        value.groups.some((r) => r.name === groupName(f)),
        false,
      );
      return proof(1);
    },
    group,
  ),
];
