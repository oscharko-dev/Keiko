// AC7 operations 52-65: issue link, issue security, avatars and private account validation.
// Every effect acts on fixtures this recipe creates (issues, a project, an issue type, a PNG it
// generates) or on the dedicated lab actors; no password, license text or image bytes appear in
// arguments or evidence. Protected values come only from the product's human-input custody.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { read, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import {
  adminMutationCase,
  nativeSnapshot,
  observeAdminActor,
} from "./api-qualification-admin-cases.mjs";
import {
  bindQualificationFile,
  createQualificationIssue,
  createQualificationProject,
  adminLoginInput,
  fixtureWrite,
  generatedSecret,
  labActorPassword,
  projectReview,
  protectedInputPublisher,
  qualificationPng,
  releaseQualificationFile,
} from "./api-qualification-fixtures.mjs";

const adminRead = { actor: "admin", administration: true };
const actorArgs = (f) => ({ expectedActorKey: f.adminActorKey });

// ---- 52: issue link detail ---------------------------------------------------------------
const linkFields = ["id", "name", "inward", "outward"];
async function linkFixture(c, f) {
  await observeAdminActor(c, f);
  const [type] = (await read(c, "/rest/api/2/issueLinkType")).issueLinkTypes;
  assert.ok(type);
  const inward = await createQualificationIssue(c, f, "link inward");
  const outward = await createQualificationIssue(c, f, "link outward");
  f.linkType = nativeSnapshot(type, linkFields);
  f.linkInward = inward.key;
  f.linkOutward = outward.key;
  await fixtureWrite(
    c,
    "jira.create-issue-link",
    {
      ...actorArgs(f),
      inwardIssueIdOrKey: inward.key,
      outwardIssueIdOrKey: outward.key,
      linkType: f.linkType,
    },
    async (context, data) => {
      assert.match(data.linkId, /^[1-9][0-9]*$/u);
      const link = await read(context, `/rest/api/2/issueLink/${data.linkId}`);
      assert.equal(link.inwardIssue.key, inward.key);
      assert.equal(link.outwardIssue.key, outward.key);
      f.linkId = data.linkId;
      return proof(3);
    },
  );
}
async function linkCleanup(c, f) {
  await fixtureWrite(
    c,
    "jira.delete-issue-link",
    {
      ...actorArgs(f),
      inwardIssueIdOrKey: f.linkInward,
      outwardIssueIdOrKey: f.linkOutward,
      linkType: f.linkType,
      linkId: f.linkId,
    },
    async (context) => {
      const response = await labRequest(
        context.session,
        "GET",
        `/rest/api/2/issueLink/${f.linkId}`,
        basicAuth(context.session, context.actor),
      );
      assert.equal(response.status, 404);
      const parent = await read(context, `/rest/api/2/issue/${f.linkInward}?fields=issuelinks`);
      assert.equal(
        parent.fields.issuelinks.some((row) => String(row.id) === f.linkId),
        false,
      );
      return proof(2);
    },
  );
}

// ---- 53 / 65: issue security ------------------------------------------------------------
const securityPrecondition =
  "The lab needs one native issue-security scheme associated with the project";
async function securityScheme(c, f) {
  await observeAdminActor(c, f);
  const rows = (await read(c, "/rest/api/2/issuesecurityschemes")).issueSecuritySchemes;
  assert.ok(Array.isArray(rows) && rows.length > 0, securityPrecondition);
  f.securitySchemeId = String(rows[0].id);
}

// ---- avatar fixtures --------------------------------------------------------------------
/** The generated PNG is a connected-file source of the dispatching Chat (shared fixture helper). */
async function avatarFile(c, f, chat) {
  f.avatarFile = await bindQualificationFile(c, f, chat, "avatar-a", () =>
    qualificationPng(96, Number.parseInt(f.runId.slice(0, 2), 16)),
  );
  return f.avatarFile;
}
const OWNERS = {
  project: {
    upload: "jira.upload-project-avatar",
    create: "jira.create-project-avatar",
    path: (owner) => `/rest/api/2/project/${owner.id}/avatars`,
    target: (owner) => ({ kind: "project", id: owner.id, key: owner.key }),
  },
  user: {
    upload: "jira.upload-user-avatar",
    create: "jira.create-user-avatar",
    path: (owner) => `/rest/api/2/user/avatars?username=${encodeURIComponent(owner.name)}`,
    target: (owner) => ({ kind: "user", key: owner.key, name: owner.name }),
  },
  issuetype: {
    upload: "jira.upload-issue-type-avatar",
    create: "jira.create-issue-type-avatar",
    path: (owner) => `/rest/api/2/universal_avatar/type/issuetype/owner/${owner.id}`,
    target: (owner) => ({ kind: "issuetype", id: owner.id }),
  },
};
async function avatarOwner(c, f, kind) {
  await observeAdminActor(c, f);
  if (kind === "project")
    return (f.avatarProject ??= projectReview(
      await createQualificationProject(c, f, "avatar owners"),
    ));
  if (f.avatarIssueType) return f.avatarIssueType;
  const name = `AC7 avatar type ${f.runId}`;
  await fixtureWrite(
    c,
    "jira.create-issue-type",
    { ...actorArgs(f), name, description: "Synthetic AC7 avatar owner", type: "standard" },
    async (context, data) => {
      assert.match(data.issueTypeId, /^[1-9][0-9]*$/u);
      const value = await read(context, `/rest/api/2/issuetype/${data.issueTypeId}`);
      assert.equal(value.name, name);
      f.avatarIssueType = { id: data.issueTypeId };
      return proof(2);
    },
  );
  return f.avatarIssueType;
}
const avatarRows = (value) =>
  [
    ...value.system.map((row) => ({ ...row, category: "system" })),
    ...value.custom.map((row) => ({ ...row, category: "custom" })),
  ].map((row) => ({
    id: String(row.id),
    category: row.category,
    ...(typeof row.owner === "string" && row.owner.length > 0 ? { owner: row.owner } : {}),
    selected: row.isSelected === true,
  }));
const observeAvatars = async (c, kind, owner) =>
  avatarRows(await read(c, OWNERS[kind].path(owner)));
const identities = (rows) => rows.map(({ id, category }) => ({ id, category }));
const withoutSelection = (rows) => identities(rows).sort((a, b) => a.id.localeCompare(b.id));
const uploadArguments = (f, kind, owner) => ({
  ...actorArgs(f),
  target: OWNERS[kind].target(owner),
  source: { kind: "connected-file", path: f.avatarFile.name },
  expectedFile: f.avatarFile,
  acceptTemporaryReplacement: true,
});
/** Uploads through the governed tool; the native temporary slot is consumed by the next effect. */
async function stageTemporary(c, f, kind, owner, chat) {
  f.avatarTemporary = undefined;
  await avatarFile(c, f, chat);
  const before = await observeAvatars(c, kind, owner);
  await fixtureWrite(
    c,
    OWNERS[kind].upload,
    uploadArguments(f, kind, owner),
    async (context, data) => {
      assert.deepEqual(await observeAvatars(context, kind, owner), before);
      f.avatarTemporary = {
        uploadSha256: data.uploadSha256,
        uploadBytes: data.uploadBytes,
        crop: data.temporaryCrop,
        needsCropping: data.temporaryNeedsCropping,
      };
      return proof(2);
    },
  );
  return before;
}
const createArguments = (f, kind, owner) => ({
  ...actorArgs(f),
  target: OWNERS[kind].target(owner),
  expectedTemporary: f.avatarTemporary,
  crop: f.avatarTemporary.crop,
  expectedAvatars: f.avatarBefore,
});
async function creationPrepare(c, f, kind, chat) {
  const owner = await avatarOwner(c, f, kind);
  f.avatarBefore = await stageTemporary(c, f, kind, owner, chat);
  f.avatarOwner = owner;
}
function creationReadback(kind) {
  return async (c, data, f) => {
    const after = await observeAvatars(c, kind, f.avatarOwner);
    const known = new Set(f.avatarBefore.map((row) => row.id));
    const added = after.filter((row) => !known.has(row.id));
    assert.equal(added.length, 1);
    assert.equal(added[0].category, "custom");
    if (data?.avatarId !== undefined) assert.equal(added[0].id, data.avatarId);
    assert.deepEqual(
      withoutSelection(after.filter((row) => known.has(row.id))),
      withoutSelection(f.avatarBefore),
    );
    return proof(4);
  };
}
const uploadCase = (tool, kind) =>
  adminMutationCase(
    tool,
    (f) => uploadArguments(f, kind, f.avatarOwner),
    async (c, _data, f) => {
      assert.deepEqual(await observeAvatars(c, kind, f.avatarOwner), f.avatarBefore);
      return proof(2);
    },
    async (c, f, chat) => {
      f.avatarOwner = await avatarOwner(c, f, kind);
      await avatarFile(c, f, chat);
      f.avatarBefore = await observeAvatars(c, kind, f.avatarOwner);
    },
  );
const selectedOf = (rows) => rows.find((row) => row.selected);
const projectAvatarArguments = (f, avatarId) => ({
  ...actorArgs(f),
  target: OWNERS.project.target(f.avatarOwner),
  avatarId,
  expectedAvatars: f.avatarBefore,
});
async function projectSelectionPrepare(c, f) {
  f.avatarOwner = await avatarOwner(c, f, "project");
  f.avatarBefore = await observeAvatars(c, "project", f.avatarOwner);
  f.avatarOriginal = selectedOf(f.avatarBefore);
  assert.ok(f.avatarOriginal);
  f.avatarTarget = f.avatarBefore.find((row) => row.category === "system" && !row.selected);
  assert.ok(f.avatarTarget);
}
async function restoreProjectSelection(c, f) {
  const current = await observeAvatars(c, "project", f.avatarOwner);
  await fixtureWrite(
    c,
    "jira.set-project-avatar",
    {
      ...actorArgs(f),
      target: OWNERS.project.target(f.avatarOwner),
      avatarId: f.avatarOriginal.id,
      expectedAvatars: current,
    },
    async (context) => {
      assert.equal(
        selectedOf(await observeAvatars(context, "project", f.avatarOwner))?.id,
        f.avatarOriginal.id,
      );
      return proof(1);
    },
  );
}
async function deletionPrepare(c, f, chat) {
  await projectSelectionPrepare(c, f);
  await stageTemporary(c, f, "project", f.avatarOwner, chat);
  const known = new Set(f.avatarBefore.map((row) => row.id));
  await fixtureWrite(
    c,
    OWNERS.project.create,
    createArguments(f, "project", f.avatarOwner),
    async (context) => {
      const rows = await observeAvatars(context, "project", f.avatarOwner);
      const created = rows.filter((row) => !known.has(row.id));
      assert.equal(created.length, 1);
      f.avatarDelete = created[0];
      return proof(2);
    },
  );
  const current = await observeAvatars(c, "project", f.avatarOwner);
  if (selectedOf(current)?.id === f.avatarDelete.id) await restoreProjectSelection(c, f);
  f.avatarBefore = await observeAvatars(c, "project", f.avatarOwner);
}

// ---- private account validation ---------------------------------------------------------
function validationReadback(scope, extra = async () => 0) {
  return async (c, data, f) => {
    assert.equal(data.validationScope, scope);
    assert.equal(data.actorUserKey, f.adminActorKey);
    assert.equal(typeof data.accepted, "boolean");
    assert.ok(Number.isSafeInteger(data.violationCount) && data.violationCount >= 0);
    assert.equal(data.accepted, data.violationCount === 0);
    return proof(4 + (await extra(c, data, f)));
  };
}
const passwordPolicyIdentity = async (c, f, data) => {
  assert.equal(
    typeof (await read(c, "/rest/api/2/password/policy?hasOldPassword=false")),
    "object",
  );
  if (data.username !== undefined) assert.equal(data.username, f.policyUsername);
  return 2;
};
async function policyUser(c, f) {
  await observeAdminActor(c, f);
  const user = await read(c, "/rest/api/2/user?username=keiko-assignee");
  f.policyUser = { key: user.key, name: user.name };
  assert.equal(user.name, "keiko-assignee");
}
async function myselfPrepare(c, f) {
  await observeAdminActor(c, f);
  const me = await read(c, "/rest/api/2/myself");
  assert.equal(me.name, "keiko-admin");
  f.myselfBefore = nativeSnapshot(me, ["key", "name", "displayName", "active"]);
  f.myselfTarget = `AC7 ${f.runId.slice(0, 8)}`;
  assert.notEqual(f.myselfBefore.displayName, f.myselfTarget);
}
async function myselfCleanup(c, f) {
  const current = nativeSnapshot(await read(c, "/rest/api/2/myself"), [
    "key",
    "name",
    "displayName",
    "active",
  ]);
  await fixtureWrite(
    c,
    "jira.update-myself",
    { ...actorArgs(f), expectedUser: current, displayName: f.myselfBefore.displayName },
    async (context) => {
      assert.equal(
        (await read(context, "/rest/api/2/myself")).displayName,
        f.myselfBefore.displayName,
      );
      return proof(1);
    },
    // The governed update asks a protected input for the account's own login, here as well.
    protectedInputPublisher(adminLoginInput),
  );
}
async function ownPasswordPrepare(c, f) {
  const me = await read(c, "/rest/api/2/myself");
  assert.equal(me.name, "keiko-assignee");
  f.ownAccount = { key: me.key, name: me.name };
}

export const API_QUALIFICATION_INTEGRATOR_A_CASES = [
  {
    ...readCase(
      "jira.issue-link",
      (f) => `/rest/api/2/issueLink/${f.linkId}`,
      [...linkFields, "inwardIssueKey", "outwardIssueKey"],
      {
        args: (f) => ({ linkId: f.linkId }),
        nativeRoot: (value) => [
          {
            id: value.id,
            name: value.type.name,
            inward: value.type.inward,
            outward: value.type.outward,
            inwardIssueKey: value.inwardIssue.key,
            outwardIssueKey: value.outwardIssue.key,
          },
        ],
        // The product returns the one projected link as the only item of its page.
      },
    ),
    ...adminRead,
    prepare: linkFixture,
    cleanup: linkCleanup,
  },
  {
    ...readCase(
      "jira.issue-security-scheme",
      (f) => `/rest/api/2/issuesecurityschemes/${f.securitySchemeId}`,
      ["id", "name"],
      {
        args: (f) => ({ schemeId: f.securitySchemeId }),
        nativeRoot: "single",
        productRoot: "single",
      },
    ),
    ...adminRead,
    prepare: securityScheme,
  },
  adminMutationCase(
    OWNERS.issuetype.create,
    (f) => createArguments(f, "issuetype", f.avatarOwner),
    creationReadback("issuetype"),
    (c, f, chat) => creationPrepare(c, f, "issuetype", chat),
  ),
  uploadCase(OWNERS.issuetype.upload, "issuetype"),
  {
    tool: "jira.validate-license",
    ...adminRead,
    arguments: actorArgs,
    // Validation only: a runtime-generated text that is no license; nothing is activated.
    publishHumanInput: protectedInputPublisher(() => ({ license: generatedSecret() })),
    prepare: observeAdminActor,
    readback: validationReadback("native-license-validation-only", async (c, _data, f) => {
      assert.equal((await read(c, "/rest/api/2/myself")).key, f.adminActorKey);
      return 1;
    }),
  },
  {
    ...adminMutationCase(
      "jira.update-myself",
      (f) => ({ ...actorArgs(f), expectedUser: f.myselfBefore, displayName: f.myselfTarget }),
      async (c, _data, f) => {
        const me = await read(c, "/rest/api/2/myself");
        assert.equal(me.displayName, f.myselfTarget);
        assert.equal(me.key, f.myselfBefore.key);
        assert.equal(me.active, true);
        return proof(3);
      },
      myselfPrepare,
    ),
    publishHumanInput: protectedInputPublisher(adminLoginInput),
    cleanup: myselfCleanup,
  },
  {
    ...adminMutationCase(
      "jira.update-my-password",
      (f) => ({ expectedActorKey: f.ownAccount.key, user: f.ownAccount }),
      async (c, _data, f) => {
        // The protected input carries the lab credential as both current and new value, so the
        // private credential file stays valid; the oracle proves the account is still usable.
        const me = await read(c, "/rest/api/2/myself");
        assert.equal(me.key, f.ownAccount.key);
        assert.equal(me.active, true);
        return proof(2);
      },
      ownPasswordPrepare,
    ),
    actor: "assignee",
    administration: false,
    destructiveAdministration: false,
    publishHumanInput: protectedInputPublisher((c) => {
      const password = labActorPassword(c, "assignee");
      return { currentPassword: password, password };
    }),
  },
  {
    tool: "jira.validate-create-user-password",
    ...adminRead,
    arguments: (f) => ({
      ...actorArgs(f),
      username: f.policyUsername,
      displayName: "Synthetic AC7 policy candidate",
      emailAddress: "ac7-policy@example.invalid",
    }),
    prepare: async (c, f) => {
      await observeAdminActor(c, f);
      f.policyUsername = `ac7-${f.runId.slice(0, 8)}`;
    },
    publishHumanInput: protectedInputPublisher(() => ({ password: generatedSecret() })),
    readback: validationReadback("native-password-policy-only", (c, data, f) =>
      passwordPolicyIdentity(c, f, data),
    ),
  },
  {
    tool: "jira.validate-update-user-password",
    ...adminRead,
    arguments: (f) => ({ ...actorArgs(f), user: f.policyUser }),
    prepare: policyUser,
    publishHumanInput: protectedInputPublisher(() => ({ newPassword: generatedSecret() })),
    readback: validationReadback("native-password-policy-only", async (c, data, f) => {
      assert.equal(data.userKey, f.policyUser.key);
      assert.equal(data.username, f.policyUser.name);
      assert.equal(
        typeof (await read(c, "/rest/api/2/password/policy?hasOldPassword=true")),
        "object",
      );
      return 3;
    }),
  },
  adminMutationCase(
    OWNERS.project.create,
    (f) => createArguments(f, "project", f.avatarOwner),
    creationReadback("project"),
    (c, f, chat) => creationPrepare(c, f, "project", chat),
  ),
  {
    ...adminMutationCase(
      "jira.set-project-avatar",
      (f) => projectAvatarArguments(f, f.avatarTarget.id),
      async (c, _data, f) => {
        const after = await observeAvatars(c, "project", f.avatarOwner);
        assert.deepEqual(
          after.map((row) => [row.id, row.selected]),
          f.avatarBefore.map((row) => [row.id, row.id === f.avatarTarget.id]),
        );
        assert.deepEqual(identities(after), identities(f.avatarBefore));
        return proof(3);
      },
      projectSelectionPrepare,
    ),
    cleanup: restoreProjectSelection,
  },
  uploadCase(OWNERS.project.upload, "project"),
  {
    ...adminMutationCase(
      "jira.delete-project-avatar",
      (f) => projectAvatarArguments(f, f.avatarDelete.id),
      async (c, _data, f) => {
        const after = await observeAvatars(c, "project", f.avatarOwner);
        assert.equal(
          after.some((row) => row.id === f.avatarDelete.id),
          false,
        );
        assert.deepEqual(
          withoutSelection(after),
          withoutSelection(f.avatarBefore.filter((row) => row.id !== f.avatarDelete.id)),
        );
        return proof(3);
      },
      deletionPrepare,
    ),
    cleanup: (c, f) => releaseQualificationFile(c, f, "avatar-a"),
  },
  {
    ...readCase(
      "jira.project-issue-security-scheme",
      "/rest/api/2/project/KEIKO/issuesecuritylevelscheme",
      ["id", "name"],
      {
        args: () => ({ projectIdOrKey: "KEIKO" }),
        nativeRoot: "single",
        productRoot: "single",
      },
    ),
    ...adminRead,
    prepare: observeAdminActor,
  },
];

/** The avatar machinery, shared with the user-avatar recipes that need a private session. */
export const AVATAR_RECIPES = {
  OWNERS,
  avatarFile,
  observeAvatars,
  stageTemporary,
  createArguments,
  creationReadback,
  uploadArguments,
  identities,
  withoutSelection,
  selectedOf,
};
