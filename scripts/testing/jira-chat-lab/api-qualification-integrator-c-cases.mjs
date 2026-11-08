// AC7 qualification of the native user lifecycle, anonymization, application access, directory,
// worklog change feeds, current-session observation, administrator password change, anonymization
// unlock and the private session and user-avatar operations. Every data effect acts only on
// throwaway users that the recipe itself creates with deterministic, non-personal names; seeded
// identities are never a target. The session operations (login, logout, websudo release) act only
// on the administrator Chat's own private session, which is ended with the case. A protected value
// reaches Jira only through the product's human-input custody: it is generated at runtime or read
// from the lab credential file, and never appears in arguments, evidence, logs or repository files.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { projectJiraAnonymizationTaskSnapshot } from "../../../packages/keiko-connectors/dist/jira-managed-anonymization-reads.js";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { qualificationDigest } from "./api-qualification-evidence.mjs";
import {
  adminLoginInput,
  fixtureWrite,
  generatedSecret,
  protectedInputPublisher,
  releaseQualificationFile,
} from "./api-qualification-fixtures.mjs";
import { AVATAR_RECIPES as AV } from "./api-qualification-integrator-a-cases.mjs";
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
// ---- protected input and the private session ---------------------------------------------------
// Secrets live only here, keyed by the run's fixture object; they are never serialized.
const SECRETS = new WeakMap();
function rememberSecret(f, label) {
  const secret = generatedSecret();
  SECRETS.set(f, { ...SECRETS.get(f), [label]: secret });
  return secret;
}
const secretOf = (f, label) => {
  const secret = SECRETS.get(f)?.[label];
  assert.ok(secret, "The generated secret is known only after its protected submission");
  return secret;
};
const userAuth = (name, secret) => `Basic ${Buffer.from(`${name}:${secret}`).toString("base64")}`;

async function privatePrepare(c, f) {
  await observeAdminActor(c, f);
  await ensureUser(c, f, "private");
  await observedUser(c, f, "private");
}
const privateUserArgs = (f) => ({ ...actorArgs(f), user: reference(users(f).private) });
const updatePasswordCase = {
  ...adminMutationCase(
    "jira.update-user-password",
    privateUserArgs,
    async (c, data, f) => {
      const target = users(f).private;
      assert.equal(data.userKey, target.key);
      assert.equal(data.username, target.name);
      // The acknowledgement proves nothing about credentials: the new password must authenticate
      // exactly this throwaway user natively.
      const response = await labRequest(
        c.session,
        "GET",
        "/rest/api/2/myself",
        userAuth(target.name, secretOf(f, "private")),
      );
      assert.equal(response.status, 200);
      assert.equal(response.value.key, target.key);
      assert.equal(response.value.active, true);
      return proof(5);
    },
    privatePrepare,
  ),
  publishHumanInput: protectedInputPublisher((_c, f) => ({
    password: rememberSecret(f, "private"),
  })),
  cleanup: (c, f) => deleteFixture(c, f, "private"),
};

async function adminSessionReadback(c, data, f, established) {
  assert.equal(data.actorUserKey, f.adminActorKey);
  assert.equal(data.userKey, f.adminActorKey);
  assert.equal(data.username, "keiko-admin");
  if (established) assert.equal(data.sessionEstablished, true);
  // The administrator's token credential is independent of the cookie session; it is unaffected.
  const me = await read(c, "/rest/api/2/myself");
  assert.equal(me.key, f.adminActorKey);
  assert.equal(me.active, true);
  return proof(established ? 5 : 4);
}
const loginInput = protectedInputPublisher(adminLoginInput, "login");
function loginFixture(c, f) {
  return fixtureWrite(
    c,
    "jira.login",
    actorArgs(f),
    (context, data) => adminSessionReadback(context, data, f, true),
    loginInput,
  );
}
/**
 * A case that needs the administrator's private session holds one turn (see `dispatchQualification`)
 * that logs in first, then runs `held` with the auxiliaries declared in `tools`.
 */
const sessionCase = (entry, tools = [], held = async () => undefined) => ({
  ...entry,
  prerequisiteTools: ["jira.login", ...tools],
  prepareInvocation: async (c, f) => {
    await loginFixture(c, f);
    await held(c, f, c.qualificationChat);
  },
});
const loginCase = {
  ...adminMutationCase(
    "jira.login",
    actorArgs,
    (c, data, f) => adminSessionReadback(c, data, f, true),
    observeAdminActor,
  ),
  publishHumanInput: loginInput,
};
const sessionActionCase = (tool) =>
  sessionCase(
    adminMutationCase(
      tool,
      actorArgs,
      (c, data, f) => adminSessionReadback(c, data, f, false),
      observeAdminActor,
    ),
  );

const taskSnapshot = async (c) => {
  const response = await nativeStatus(c, PROGRESS);
  assert.equal(response.status, 200, "An anonymization task must exist to be unlocked");
  const snapshot = projectJiraAnonymizationTaskSnapshot(response.value);
  assert.ok(snapshot, "The native task is not the complete reviewable snapshot");
  return snapshot;
};
async function unlockPrepare(c, f) {
  await observeAdminActor(c, f);
  if ((await nativeStatus(c, PROGRESS)).status === 404) {
    await anonymizationPrepare(c, f);
    await fixtureWrite(
      c,
      "jira.schedule-user-anonymization",
      anonymizationArgs(f),
      (context, data) => scheduledReadback(context, data, f, false),
    );
  }
  f.ac7Task = await taskSnapshot(c);
}
const unlockCase = {
  ...adminMutationCase(
    "jira.unlock-user-anonymization",
    (f) => ({ ...actorArgs(f), expectedTask: f.ac7Task }),
    async (c, data, f) => {
      assert.equal(data.userKey, f.ac7Task.userKey);
      assert.equal(data.executingNode, f.ac7Task.executingNode);
      assert.equal(data.anonymizationSubmittedTime, f.ac7Task.submittedTime);
      // The native unlock is global and unconfirmed; the completed task must be unchanged.
      const after = await taskSnapshot(c);
      assert.equal(after.userKey, f.ac7Task.userKey);
      assert.equal(after.status, f.ac7Task.status);
      return proof(5);
    },
    unlockPrepare,
  ),
  // A scripted human statement for a single-node lab whose anonymization has long completed.
  publishHumanInput: protectedInputPublisher(() => ({
    ownerShutdownConfirmation: "Synthetic lab: no anonymization owner process is running.",
  })),
};

// ---- user avatars (administrator private session, throwaway target user) -------------------------
async function userAvatarPrepare(c, f, chat) {
  await observeAdminActor(c, f);
  await ensureUser(c, f, "avatar");
  const user = await observedUser(c, f, "avatar");
  f.avatarOwner = reference(user);
  await AV.avatarFile(c, f, chat);
}
const userSelection = (f, avatarId) => ({
  ...actorArgs(f),
  target: AV.OWNERS.user.target(f.avatarOwner),
  avatarId,
  expectedAvatars: f.avatarBefore,
});
const userAvatarCleanup = async (c, f) => {
  await releaseQualificationFile(c, f, "avatar-a");
  await deleteFixture(c, f, "avatar");
};
const observeUserAvatars = async (c, f) => {
  f.avatarBefore = await AV.observeAvatars(c, "user", f.avatarOwner);
};
async function userCreateHeld(c, f, chat) {
  f.avatarBefore = await AV.stageTemporary(c, f, "user", f.avatarOwner, chat);
}
async function userSelectHeld(c, f) {
  await observeUserAvatars(c, f);
  f.avatarTarget = f.avatarBefore.find((row) => row.category === "system" && !row.selected);
  assert.ok(f.avatarTarget, "A selectable system avatar must exist");
}
async function userDeleteHeld(c, f, chat) {
  await userSelectHeld(c, f);
  await AV.stageTemporary(c, f, "user", f.avatarOwner, chat);
  const known = new Set(f.avatarBefore.map((row) => row.id));
  await fixtureWrite(
    c,
    AV.OWNERS.user.create,
    AV.createArguments(f, "user", f.avatarOwner),
    async (context) => {
      const rows = await AV.observeAvatars(context, "user", f.avatarOwner);
      const created = rows.filter((row) => !known.has(row.id));
      assert.equal(created.length, 1);
      f.avatarDelete = created[0];
      return proof(2);
    },
  );
  await observeUserAvatars(c, f);
  // A created avatar may arrive selected; the deletion recipe needs a custom, unselected one.
  if (AV.selectedOf(f.avatarBefore)?.id === f.avatarDelete.id) {
    await fixtureWrite(
      c,
      "jira.set-user-avatar",
      userSelection(f, f.avatarTarget.id),
      async (context) => {
        const rows = await AV.observeAvatars(context, "user", f.avatarOwner);
        assert.equal(AV.selectedOf(rows)?.id, f.avatarTarget.id);
        return proof(1);
      },
    );
    await observeUserAvatars(c, f);
  }
}
const userAvatarCases = [
  sessionCase(
    adminMutationCase(
      AV.OWNERS.user.create,
      (f) => AV.createArguments(f, "user", f.avatarOwner),
      AV.creationReadback("user"),
      userAvatarPrepare,
    ),
    [AV.OWNERS.user.upload],
    userCreateHeld,
  ),
  sessionCase(
    adminMutationCase(
      "jira.set-user-avatar",
      (f) => userSelection(f, f.avatarTarget.id),
      async (c, _data, f) => {
        const after = await AV.observeAvatars(c, "user", f.avatarOwner);
        assert.deepEqual(
          after.map((row) => [row.id, row.selected]),
          f.avatarBefore.map((row) => [row.id, row.id === f.avatarTarget.id]),
        );
        assert.deepEqual(AV.identities(after), AV.identities(f.avatarBefore));
        return proof(3);
      },
      userAvatarPrepare,
    ),
    [],
    userSelectHeld,
  ),
  sessionCase(
    adminMutationCase(
      AV.OWNERS.user.upload,
      (f) => AV.uploadArguments(f, "user", f.avatarOwner),
      async (c, _data, f) => {
        assert.deepEqual(await AV.observeAvatars(c, "user", f.avatarOwner), f.avatarBefore);
        return proof(2);
      },
      userAvatarPrepare,
    ),
    [],
    observeUserAvatars,
  ),
  sessionCase(
    {
      ...adminMutationCase(
        "jira.delete-user-avatar",
        (f) => userSelection(f, f.avatarDelete.id),
        async (c, _data, f) => {
          const after = await AV.observeAvatars(c, "user", f.avatarOwner);
          assert.equal(
            after.some((row) => row.id === f.avatarDelete.id),
            false,
          );
          assert.deepEqual(
            AV.withoutSelection(after),
            AV.withoutSelection(f.avatarBefore.filter((row) => row.id !== f.avatarDelete.id)),
          );
          return proof(3);
        },
        userAvatarPrepare,
      ),
      cleanup: userAvatarCleanup,
    },
    [AV.OWNERS.user.upload, AV.OWNERS.user.create, "jira.set-user-avatar"],
    userDeleteHeld,
  ),
];

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
  updatePasswordCase,
  unlockCase,
  loginCase,
  sessionActionCase("jira.logout"),
  sessionActionCase("jira.release-websudo"),
  ...userAvatarCases,
];
