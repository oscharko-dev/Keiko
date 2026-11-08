// Application-role recipes add a governed, independently observed empty synthetic group.
import assert from "node:assert/strict";
import { URLSearchParams } from "node:url";
import {
  adminMutationCase,
  observeAdminActor,
  nativeSnapshot,
} from "./api-qualification-admin-cases.mjs";
import { fixtureWrite } from "./api-qualification-fixtures.mjs";
import { proof, read } from "./api-qualification-read.mjs";

function roleSnapshot(value) {
  const snapshot = nativeSnapshot(value, ["key", "groups", "defaultGroups"]);
  for (const key of ["groups", "defaultGroups"]) {
    assert.ok(Array.isArray(snapshot[key]));
    assert.ok(snapshot[key].every((name) => typeof name === "string" && name.length > 0));
    assert.equal(new Set(snapshot[key]).size, snapshot[key].length);
    snapshot[key] = [...snapshot[key]].sort();
  }
  assert.ok(snapshot.defaultGroups.every((name) => snapshot.groups.includes(name)));
  return snapshot;
}
async function prepareRole(c, f, bulk) {
  await observeAdminActor(c, f);
  const roles = await read(c, "/rest/api/2/applicationrole");
  assert.ok(Array.isArray(roles) && roles.length > 0);
  f.applicationRoleBefore = roles.map(roleSnapshot);
  assert.equal(new Set(roles.map((role) => role.key)).size, roles.length);
  const selected = roles.filter((role) => role.key === "jira-software");
  assert.equal(
    selected.length,
    1,
    "The lab must expose the exact native Jira Software application role",
  );
  const expected = roleSnapshot(selected[0]);
  const groupName = `keiko-ac7-role-${bulk ? "bulk" : "single"}-${f.runId}`;
  assert.equal(expected.groups.includes(groupName), false);
  await fixtureWrite(
    c,
    "jira.create-group",
    {
      expectedActorKey: f.adminActorKey,
      groupName,
    },
    async (context) => {
      const query = new URLSearchParams({
        groupname: groupName,
        startAt: "0",
        maxResults: "50",
        includeInactiveUsers: "true",
      });
      const group = await read(context, `/rest/api/2/group/member?${query}`);
      assert.equal(group.startAt, 0);
      assert.equal(group.total, 0);
      assert.equal(group.isLast, true);
      assert.deepEqual(group.values, []);
      return proof(4);
    },
  );
  f.applicationRoleChange = {
    expected,
    value: { ...expected, groups: [...expected.groups, groupName].sort() },
  };
}
async function roleReadback(c, _data, f) {
  const roles = await read(c, "/rest/api/2/applicationrole");
  assert.ok(Array.isArray(roles));
  assert.equal(roles.length, f.applicationRoleBefore.length);
  assert.equal(new Set(roles.map((role) => role.key)).size, roles.length);
  for (const before of f.applicationRoleBefore) {
    const found = roles.filter((role) => role.key === before.key);
    assert.equal(found.length, 1);
    const expected =
      before.key === f.applicationRoleChange.value.key ? f.applicationRoleChange.value : before;
    assert.deepEqual(roleSnapshot(found[0]), expected);
  }
  const direct = await read(
    c,
    `/rest/api/2/applicationrole/${encodeURIComponent(f.applicationRoleChange.value.key)}`,
  );
  assert.deepEqual(roleSnapshot(direct), f.applicationRoleChange.value);
  assert.notDeepEqual(f.applicationRoleChange.expected, f.applicationRoleChange.value);
  // Configuration readback does not confirm every user's inherited/effective permissions.
  return { ...proof(5 + roles.length * 2), effectiveAccessConfirmed: false };
}
export const API_QUALIFICATION_APPLICATION_ROLE_CASES = [true, false].map((bulk) =>
  adminMutationCase(
    bulk ? "jira.set-application-roles" : "jira.set-application-role",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      acceptGlobalPermissionChange: true,
      ...(bulk ? { roles: [f.applicationRoleChange] } : { role: f.applicationRoleChange }),
    }),
    roleReadback,
    (c, f) => prepareRole(c, f, bulk),
  ),
);
