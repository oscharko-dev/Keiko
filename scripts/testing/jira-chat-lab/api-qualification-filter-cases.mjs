import assert from "node:assert/strict";
import { read, readRecord, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { createQualificationFilter, fixtureWrite } from "./api-qualification-fixtures.mjs";
import { labRequest, basicAuth } from "./lab-client.mjs";

const path = (f) => `/rest/api/2/filter/${f.savedFilterId}`;
export function filterColumnReview(raw) {
  const rows = Array.isArray(raw) ? raw : raw.columnLayoutItems;
  assert.ok(Array.isArray(rows));
  const columns = rows.map((row) => {
    const id = Array.isArray(raw) ? row.value : row.id;
    assert.equal(typeof id, "string");
    return id;
  });
  return { columns, columnConfig: Array.isArray(raw) ? null : (raw.columnConfig ?? null) };
}
export function filterPermissionReview(rows) {
  assert.ok(Array.isArray(rows));
  return rows.map((row) => {
    assert.match(String(row.id), /^[1-9]\d*$/u);
    assert.equal(typeof row.type, "string");
    const result = { id: String(row.id), type: row.type };
    for (const flag of ["view", "edit"]) if (row[flag] !== undefined) result[flag] = row[flag];
    const details = permissionDetails(row);
    for (const [name, value] of Object.entries(details))
      if (value !== undefined) result[name] = name.endsWith("Id") ? String(value) : value;
    return result;
  });
}
function permissionDetails(row) {
  return {
    groupName: row.group?.name,
    projectId: row.project?.id,
    projectKey: row.project?.key,
    roleId: row.role?.id,
    roleName: row.role?.name,
    userName: row.user?.name,
    userDisplayName: row.user?.displayName,
  };
}
async function owner(c, f) {
  await observeAdminActor(c, f);
  const value = await readRecord(c, f.savedFilterId, path(f));
  assert.equal(value.owner.key, f.adminActorKey);
  assert.equal(String(value.id), f.savedFilterId);
}
async function columns(c, f) {
  await owner(c, f);
  f.savedColumns = filterColumnReview(await read(c, `${path(f)}/columns`));
}
const columnArgs = (f) => ({
  filterId: f.savedFilterId,
  expectedOwnerKey: f.adminActorKey,
  expectedColumns: f.savedColumns.columns,
  expectedColumnConfig: f.savedColumns.columnConfig,
});
async function permissions(c, f) {
  await owner(c, f);
  f.savedPermissions = filterPermissionReview(await read(c, `${path(f)}/permission`));
}
const permissionArgs = (f) => ({
  filterId: f.savedFilterId,
  expectedOwnerKey: f.adminActorKey,
  expectedPermissions: f.savedPermissions,
});
const permissionFields = [
  "groupName",
  "projectId",
  "projectKey",
  "roleId",
  "roleName",
  "userName",
  "userDisplayName",
  "view",
  "edit",
];
const filterColumns = readCase("jira.filter-columns", (f) => `${path(f)}/columns`, ["value"], {
  args: (f) => ({ filterId: f.savedFilterId, maxResults: 100 }),
  nativeRoot: (raw) => filterColumnReview(raw).columns.map((value) => ({ value })),
  productRoot: (data) => data.items.map((row) => ({ value: row.value ?? row.id })),
});
export const API_QUALIFICATION_FILTER_CASES = [
  {
    ...filterColumns,
    actor: "admin",
    administration: true,
    destructiveAdministration: true,
    prepare: async (c, f) => {
      await observeAdminActor(c, f);
      f.savedFilterId = String((await createQualificationFilter(c, f, "saved configuration")).id);
      // Jira answers a bare 404 until the filter owns an explicit layout; the governed write gives
      // this synthetic filter one before the read case observes it.
      const seeded = ["issuekey", "summary"];
      await fixtureWrite(
        c,
        "jira.set-filter-columns",
        {
          filterId: f.savedFilterId,
          expectedOwnerKey: f.adminActorKey,
          expectedColumns: [],
          expectedColumnConfig: null,
          columns: seeded,
        },
        async (cc) => {
          assert.deepEqual(
            filterColumnReview(await read(cc, `${path(f)}/columns`)).columns,
            seeded,
          );
          return proof(1);
        },
      );
      await columns(c, f);
    },
  },
  adminMutationCase(
    "jira.set-filter-columns",
    (f) => ({ ...columnArgs(f), columns: f.savedColumnTarget }),
    async (c, _data, f) => {
      await owner(c, f);
      assert.deepEqual(
        filterColumnReview(await read(c, `${path(f)}/columns`)).columns,
        f.savedColumnTarget,
      );
      return proof(3);
    },
    async (c, f) => {
      await columns(c, f);
      f.savedColumnTarget = ["summary", "status"];
      if (JSON.stringify(f.savedColumns.columns) === JSON.stringify(f.savedColumnTarget))
        f.savedColumnTarget.reverse();
    },
  ),
  adminMutationCase(
    "jira.reset-filter-columns",
    columnArgs,
    async (c, _data, f) => {
      await owner(c, f);
      // Jira reports a filter without its own layout as a bare 404; the prepared 200 layout proves
      // the explicit configuration existed before the reset.
      assert.ok(f.savedColumns.columns.length > 0);
      const after = await labRequest(
        c.session,
        "GET",
        `${path(f)}/columns`,
        basicAuth(c.session, c.actor),
      );
      assert.equal(after.status, 404);
      return proof(4);
    },
    columns,
  ),
  adminMutationCase(
    "jira.add-filter-permission",
    (f) => ({
      ...permissionArgs(f),
      permission: { type: "group", groupName: f.savedShareGroup, view: true, edit: false },
      acceptGlobalReplacement: true,
    }),
    async (c, data, f) => {
      assert.match(data.permissionId, /^[1-9]\d*$/u);
      f.savedPermissionId = data.permissionId;
      const rows = filterPermissionReview(await read(c, `${path(f)}/permission`));
      const added = rows.filter((row) => row.id === data.permissionId);
      assert.equal(added.length, 1);
      assert.equal(added[0].type, "group");
      assert.equal(added[0].groupName, f.savedShareGroup);
      assert.equal(added[0].view, true);
      assert.equal(added[0].edit, false);
      assert.deepEqual(
        rows.filter((row) => row.id !== data.permissionId),
        f.savedPermissions.filter((row) => row.type !== "global"),
      );
      await owner(c, f);
      return proof(6);
    },
    async (c, f) => {
      await permissions(c, f);
      const user = await read(c, "/rest/api/2/user?username=keiko-admin&expand=groups");
      assert.ok(Array.isArray(user.groups?.items) && user.groups.items.length > 0);
      f.savedShareGroup = user.groups.items.find(
        (group) =>
          !f.savedPermissions.some((row) => row.type === "group" && row.groupName === group.name),
      )?.name;
      assert.equal(typeof f.savedShareGroup, "string");
    },
  ),
  {
    ...readCase("jira.filter-permissions", (f) => `${path(f)}/permission`, ["id", "type"], {
      args: (f) => ({ filterId: f.savedFilterId, maxResults: 100 }),
      nativeRoot: filterPermissionReview,
      optionalFields: permissionFields,
    }),
    actor: "admin",
    administration: true,
  },
  {
    ...readCase(
      "jira.filter-permission",
      (f) => `${path(f)}/permission/${f.savedPermissionId}`,
      ["id", "type"],
      {
        args: (f) => ({ filterId: f.savedFilterId, permissionId: f.savedPermissionId }),
        nativeRoot: (raw) => filterPermissionReview([raw]),
        optionalFields: permissionFields,
      },
    ),
    actor: "admin",
    administration: true,
  },
  adminMutationCase(
    "jira.delete-filter-permission",
    (f) => ({ ...permissionArgs(f), permissionId: f.savedPermissionId }),
    async (c, _data, f) => {
      assert.ok(f.savedPermissions.some((row) => row.id === f.savedPermissionId));
      assert.deepEqual(
        filterPermissionReview(await read(c, `${path(f)}/permission`)),
        f.savedPermissions.filter((row) => row.id !== f.savedPermissionId),
      );
      await owner(c, f);
      return proof(4);
    },
    permissions,
  ),
];
