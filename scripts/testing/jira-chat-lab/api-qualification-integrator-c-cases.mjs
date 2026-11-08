// AC7 qualification of the native user lifecycle, anonymization, application access, directory,
// worklog change feeds and current-session observation. Every effect acts only on throwaway users
// that the recipe itself creates with deterministic, non-personal names; seeded identities are never
// targeted. Passwords are never supplied, generated or observed here: the native creation response
// withholds the password and nothing in the evidence carries a name, address or display name.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { qualificationDigest } from "./api-qualification-evidence.mjs";
import { fixtureWrite } from "./api-qualification-fixtures.mjs";
import { proof, read } from "./api-qualification-read.mjs";

const APPLICATION = "jira-software";
const SETTLE_MS = 120_000;
const actorArgs = (f) => ({ expectedActorKey: f.adminActorKey });
const users = (f) => (f.ac7Users ??= {});
const identity = (f, label) => {
  const digest = qualificationDigest([f.runId, "ac7-user", label]).slice(0, 12);
  return {
    name: `ac7-${digest}`,
    emailAddress: `ac7-${digest}@example.invalid`,
    displayName: `Synthetic AC7 user ${digest}`,
  };
};
const reference = (user) => ({ key: user.key, name: user.name });
const userPath = (name) => `/rest/api/2/user?username=${encodeURIComponent(name)}`;
function snapshot(value) {
  for (const field of ["key", "name", "displayName"]) assert.equal(typeof value[field], "string");
  assert.equal(typeof value.active, "boolean");
  return {
    key: value.key,
    name: value.name,
    displayName: value.displayName,
    active: value.active,
  };
}
async function nativeStatus(c, path) {
  return labRequest(c.session, "GET", path, basicAuth(c.session, c.actor));
}
async function observedUser(c, f, label) {
  const current = users(f)[label];
  assert.ok(current, "The throwaway user must exist before it is observed");
  const found = snapshot(await read(c, userPath(current.name)));
  assert.equal(found.key, current.key);
  users(f)[label] = found;
  return found;
}
async function observedByKey(c, f, label) {
  const key = users(f)[label].key;
  const found = snapshot(
    await read(c, `/rest/api/2/user?key=${encodeURIComponent(key)}&includeDeleted=true`),
  );
  assert.equal(found.key, key);
  users(f)[label] = found;
  return found;
}
function createdReadback(label) {
  return async (c, data, f) => {
    const expected = identity(f, label);
    assert.equal(data.username, expected.name);
    assert.equal(typeof data.userKey, "string");
    const actual = await read(c, userPath(expected.name));
    assert.equal(actual.key, data.userKey);
    assert.equal(actual.name, expected.name);
    assert.equal(actual.displayName, expected.displayName);
    assert.equal(actual.emailAddress, expected.emailAddress);
    assert.equal(actual.active, true);
    users(f)[label] = snapshot(actual);
    return proof(6);
  };
}
const createArgs = (f, label) => ({
  ...actorArgs(f),
  ...(({ name, emailAddress, displayName }) => ({ name, emailAddress, displayName }))(
    identity(f, label),
  ),
  acceptGeneratedPassword: true,
  acceptUnverifiedAccess: true,
});
async function ensureUser(c, f, label) {
  if (users(f)[label] !== undefined) return;
  await fixtureWrite(c, "jira.create-user", createArgs(f, label), createdReadback(label));
}
async function deactivate(c, f, label) {
  const before = await observedUser(c, f, label);
  if (!before.active) return;
  await fixtureWrite(
    c,
    "jira.update-user",
    { ...actorArgs(f), expectedUser: before, active: false, acceptUnverifiedAccess: true },
    async (context, data) => {
      assert.equal(data.userKey, before.key);
      const actual = await read(context, userPath(before.name));
      assert.equal(actual.key, before.key);
      assert.equal(actual.active, false);
      return proof(2);
    },
  );
  await observedUser(c, f, label);
}
async function absentReadback(c, name) {
  assert.equal((await nativeStatus(c, userPath(name))).status, 404);
  const found = await read(c, `/rest/api/2/user/search?username=${encodeURIComponent(name)}`);
  assert.deepEqual(found, []);
  return proof(2);
}
async function deleteFixture(c, f, label) {
  const before = await observedUser(c, f, label);
  await fixtureWrite(
    c,
    "jira.delete-user",
    { ...actorArgs(f), expectedUser: before, confirmIrreversibleDeletion: true },
    (context) => absentReadback(context, before.name),
  );
}

async function applicationRole(c) {
  const role = await read(c, `/rest/api/2/applicationrole/${APPLICATION}`);
  for (const field of ["groups", "defaultGroups"]) {
    assert.ok(Array.isArray(role[field]));
    assert.ok(role[field].every((entry) => typeof entry === "string"));
  }
  return { key: role.key, groups: role.groups, defaultGroups: role.defaultGroups };
}
async function accessPrepare(c, f) {
  await observeAdminActor(c, f);
  await ensureUser(c, f, "primary");
  await observedUser(c, f, "primary");
  f.ac7Role = await applicationRole(c);
}
const accessArgs = (f) => ({
  ...actorArgs(f),
  user: reference(users(f).primary),
  expectedApplicationRole: f.ac7Role,
  acceptGlobalPermissionChange: true,
});
function accessMutation(tool, present) {
  return adminMutationCase(
    tool,
    accessArgs,
    async (c, data, f) => {
      assert.equal(data.userKey, users(f).primary.key);
      const actual = await read(c, `${userPath(users(f).primary.name)}&expand=applicationRoles`);
      const keys = actual.applicationRoles.items.map((role) => role.key);
      assert.equal(keys.includes(APPLICATION), present);
      return proof(3);
    },
    accessPrepare,
  );
}

async function settled(c, path, accept, deadline) {
  const response = await nativeStatus(c, path);
  // A task that is not yet registered answers 404; every other status must be a native 200.
  if (response.status !== 404) {
    assert.equal(response.status, 200);
    if (accept(response.value)) return response.value;
  }
  assert.ok(Date.now() < deadline, "The native anonymization task did not settle in time");
  await delay(1000);
  return settled(c, path, accept, deadline);
}
const PROGRESS = "/rest/api/2/user/anonymization/progress";
const finished = (key, rerun) => (value) =>
  value.userKey === key && value.status === "COMPLETED" && (value.isRerun === true) === rerun;
async function anonymizationPrepare(c, f) {
  await observeAdminActor(c, f);
  // After scheduling, the target is renamed natively; its setup is never repeated.
  if (users(f).anonymized !== undefined) return;
  await ensureUser(c, f, "anonymized");
  await deactivate(c, f, "anonymized");
  await ensureUser(c, f, "owner");
  const validation = await read(
    c,
    `/rest/api/2/user/anonymization?userKey=${encodeURIComponent(users(f).anonymized.key)}`,
  );
  assert.ok(Array.isArray(validation.operations) && validation.operations.length > 0);
  f.ac7Operations = validation.operations;
}
const anonymizationArgs = (f) => ({
  ...actorArgs(f),
  user: reference(users(f).anonymized),
  newOwner: reference(users(f).owner),
  expectedOperations: f.ac7Operations,
  confirmIrreversibleAnonymization: true,
});
async function scheduledReadback(c, data, f, rerun) {
  assert.equal(data.userKey, users(f).anonymized.key);
  assert.equal(data.newOwnerUserKey, users(f).owner.key);
  const key = users(f).anonymized.key;
  const task = await settled(c, PROGRESS, finished(key, rerun), Date.now() + SETTLE_MS);
  assert.equal(task.userKey, key);
  return proof(4);
}
async function rerunPrepare(c, f) {
  await anonymizationPrepare(c, f);
  await observedByKey(c, f, "anonymized");
  const validation = await read(
    c,
    `/rest/api/2/user/anonymization/rerun?userKey=${encodeURIComponent(users(f).anonymized.key)}`,
  );
  if (Array.isArray(validation.operations) && validation.operations.length > 0)
    f.ac7Operations = validation.operations;
}
const validationCase = (tool, path, scope, args) => ({
  ...readCase(tool, path, ["userKey"], {
    args,
    nativeRoot: "single",
    productRoot: (data) => {
      assert.equal(data.observationScope, scope);
      return [{ userKey: data.userKey, ...data.validation }];
    },
    optionalFields: ["deleted", "success", "businessLogicValidationFailed"],
  }),
  prepare: anonymizationPrepare,
});
const keyQuery = (f) => `userKey=${encodeURIComponent(users(f).anonymized.key)}`;
const worklogFeed = (tool, route) =>
  readCase(tool, `/rest/api/2/worklog/${route}?since=0`, ["worklogId", "changedAt"], {
    args: () => ({ since: "0" }),
    nativeRoot: "values",
    nativeNames: { changedAt: "updatedTime" },
  });
const flatSession = (value) => [{ name: value.name, ...value.loginInfo }];

export const API_QUALIFICATION_INTEGRATOR_C_CASES = [
  adminMutationCase(
    "jira.create-user",
    (f) => createArgs(f, "primary"),
    createdReadback("primary"),
  ),
  adminMutationCase(
    "jira.update-user",
    (f) => ({
      ...actorArgs(f),
      expectedUser: users(f).primary,
      displayName: `${users(f).primary.displayName} revised`,
    }),
    async (c, data, f) => {
      const before = users(f).primary;
      assert.equal(data.userKey, before.key);
      const actual = await read(c, userPath(before.name));
      assert.equal(actual.key, before.key);
      assert.equal(actual.displayName, `${before.displayName} revised`);
      assert.equal(actual.active, before.active);
      return proof(3);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      await observedUser(c, f, "primary");
    },
  ),
  {
    ...readCase(
      "jira.user-directory",
      "/rest/api/2/user/list?maxResults=100",
      ["key", "name", "active"],
      {
        args: () => ({ maxResults: 100 }),
        nativeRoot: "values",
      },
    ),
    actor: "admin",
    administration: true,
  },
  accessMutation("jira.add-user-application", true),
  accessMutation("jira.remove-user-application", false),
  adminMutationCase(
    "jira.invalidate-user-session",
    (f) => ({
      ...actorArgs(f),
      user: reference(users(f).primary),
      confirmSessionInvalidation: true,
    }),
    async (c, data, f) => {
      assert.equal(data.userSessionInvalidationRequested, true);
      const actual = await read(c, userPath(users(f).primary.name));
      assert.equal(actual.key, users(f).primary.key);
      return proof(2);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      await observedUser(c, f, "primary");
    },
  ),
  adminMutationCase(
    "jira.delete-user",
    (f) => ({
      ...actorArgs(f),
      expectedUser: users(f).primary,
      confirmIrreversibleDeletion: true,
    }),
    (c, data, f) => {
      assert.equal(data.userPresent, false);
      return absentReadback(c, users(f).primary.name);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      await observedUser(c, f, "primary");
    },
  ),
  { ...worklogFeed("jira.deleted-worklogs", "deleted"), actor: "admin", administration: true },
  { ...worklogFeed("jira.updated-worklogs", "updated"), actor: "admin", administration: true },
  {
    ...readCase("jira.current-session", "/rest/auth/1/session", ["username"], {
      nativeRoot: flatSession,
      nativeNames: { username: "name" },
      productRoot: (data) => {
        assert.equal(data.observationScope, "bound-current-user-session");
        return [{ username: data.username, ...data.loginInfo }];
      },
      optionalFields: [
        "loginCount",
        "failedLoginCount",
        "lastFailedLoginTime",
        "previousLoginTime",
      ],
    }),
    actor: "admin",
    administration: true,
  },
  {
    ...validationCase(
      "jira.anonymization-validation",
      (f) => `/rest/api/2/user/anonymization?${keyQuery(f)}`,
      "validation",
      (f) => ({ userKey: users(f).anonymized.key }),
    ),
    actor: "admin",
    administration: true,
  },
  adminMutationCase(
    "jira.schedule-user-anonymization",
    anonymizationArgs,
    (c, data, f) => scheduledReadback(c, data, f, false),
    anonymizationPrepare,
  ),
  {
    tool: "jira.anonymization-progress",
    actor: "admin",
    administration: true,
    arguments: () => ({}),
    readback: async (c, data, f) => {
      const native = await read(c, PROGRESS);
      assert.equal(data.taskSelection, "active-or-latest");
      assert.equal(data.progress.userKey, native.userKey);
      assert.equal(data.progress.userKey, users(f).anonymized.key);
      assert.equal(data.progress.status, native.status);
      return proof(3);
    },
  },
  {
    ...validationCase(
      "jira.anonymization-rerun-validation",
      (f) => `/rest/api/2/user/anonymization/rerun?${keyQuery(f)}`,
      "rerun-validation",
      (f) => ({ userKey: users(f).anonymized.key }),
    ),
    actor: "admin",
    administration: true,
  },
  {
    ...adminMutationCase(
      "jira.rerun-user-anonymization",
      anonymizationArgs,
      (c, data, f) => scheduledReadback(c, data, f, true),
      rerunPrepare,
    ),
    cleanup: (c, f) => deleteFixture(c, f, "owner"),
  },
];
