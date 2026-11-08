import assert from "node:assert/strict";
import { read, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import {
  adminMutationCase,
  observeAdminActor,
  nativeSnapshot,
} from "./api-qualification-admin-cases.mjs";
import {
  createQualificationProject,
  fixtureWrite,
  projectReview,
} from "./api-qualification-fixtures.mjs";
import { optionSchemeReview, OPTION_SCHEMES } from "./api-qualification-schema-cases.mjs";

export async function permissionSchemeReview(c, id) {
  const value = await read(c, `/rest/api/2/permissionscheme/${id}`);
  const grants = await read(c, `/rest/api/2/permissionscheme/${id}/permission`);
  assert.ok(Array.isArray(grants.permissions));
  return {
    ...nativeSnapshot(value, ["id", "name", "description"]),
    permissions: grants.permissions.map((row) => ({
      id: String(row.id),
      permission: row.permission,
      holder: {
        type: row.holder.type,
        ...(row.holder.parameter === undefined ? {} : { parameter: row.holder.parameter }),
      },
    })),
  };
}
const projectPath = (f) => `/rest/api/2/project/${f.associationProject.id}`;
const args = (f) => ({
  expectedActorKey: f.adminActorKey,
  expectedProject: f.associationProject,
  confirmUnverifiedConsequences: true,
});
async function priority(c, f) {
  await observeAdminActor(c, f);
  f.associationProject = projectReview(await read(c, projectPath(f)));
  const selected = await read(c, `${projectPath(f)}/priorityscheme`);
  f.associationPriorityBefore = optionSchemeReview(
    await read(c, `/rest/api/2/priorityschemes/${selected.id}`),
    OPTION_SCHEMES[1],
  );
}
async function attributes(c, f) {
  await observeAdminActor(c, f);
  assert.ok(
    typeof f.permissionAttributeSchemeId === "string" &&
      /^(?:0|[1-9]\d*)$/u.test(f.permissionAttributeSchemeId),
    "Permission-scheme attribute qualification requires an operator-supplied native permissionAttributeSchemeId in the owned lab fixture",
  );
  assert.ok(
    typeof f.permissionAttributeKey === "string" && /^[\w.-]+$/u.test(f.permissionAttributeKey),
    "Permission-scheme attribute qualification requires an operator-supplied permissionAttributeKey with an existing native Boolean value",
  );
  f.attributeParent = await permissionSchemeReview(c, f.permissionAttributeSchemeId);
  const value = await read(c, attributePath(f));
  assert.equal(value.key, f.permissionAttributeKey);
  assert.ok(new Set(["true", "false"]).has(value.value));
  f.attributeBefore = value.value;
}
const attributePath = (f) =>
  `/rest/api/2/permissionscheme/${f.permissionAttributeSchemeId}/attribute/${encodeURIComponent(f.permissionAttributeKey)}`;
/** The project's current association (by scheme id) and its own identity, read independently. */
async function assertProjectScheme(c, f, kind, expectedId) {
  assert.equal(String((await read(c, `${projectPath(f)}/${kind}`)).id), expectedId);
  assert.deepEqual(projectReview(await read(c, projectPath(f))), f.associationProject);
}
/** A set operation names the scheme it expects to replace and the one it selects. */
const setSchemeArguments = (kind) => (f) => ({
  ...args(f),
  expectedScheme: f[`association${kind}Before`],
  scheme: f[`association${kind}Target`],
});
export const API_QUALIFICATION_ASSOCIATION_CASES = [
  adminMutationCase(
    "jira.set-project-priority-scheme",
    setSchemeArguments("Priority"),
    async (c, _data, f) => {
      await assertProjectScheme(c, f, "priorityscheme", f.associationPriorityTarget.id);
      assert.deepEqual(
        optionSchemeReview(
          await read(c, `/rest/api/2/priorityschemes/${f.associationPriorityTarget.id}`),
          OPTION_SCHEMES[1],
        ),
        f.associationPriorityTarget,
      );
      return proof(6);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.associationProject = projectReview(
        await createQualificationProject(c, f, "project associations"),
      );
      await priority(c, f);
      f.associationPriorityOriginal = f.associationPriorityBefore;
      f.associationPriorityTarget = optionSchemeReview(
        await read(c, `/rest/api/2/priorityschemes/${f.optionSchemeIds.priority}`),
        OPTION_SCHEMES[1],
      );
      assert.notEqual(f.associationPriorityTarget.id, f.associationPriorityBefore.id);
    },
  ),
  adminMutationCase(
    "jira.remove-project-priority-scheme",
    (f) => ({ ...args(f), expectedScheme: f.associationPriorityBefore }),
    async (c, _data, f) => {
      await assertProjectScheme(c, f, "priorityscheme", f.associationPriorityOriginal.id);
      return proof(5);
    },
    priority,
  ),
  adminMutationCase(
    "jira.set-project-permission-scheme",
    setSchemeArguments("Permission"),
    async (c, _data, f) => {
      await assertProjectScheme(c, f, "permissionscheme", f.associationPermissionTarget.id);
      assert.deepEqual(
        await permissionSchemeReview(c, f.associationPermissionTarget.id),
        f.associationPermissionTarget,
      );
      return proof(6);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const current = await read(c, `${projectPath(f)}/permissionscheme`);
      f.associationPermissionBefore = await permissionSchemeReview(c, String(current.id));
      await fixtureWrite(
        c,
        "jira.create-permission-scheme",
        {
          expectedActorKey: f.adminActorKey,
          name: `AC7 project permission ${f.runId}`,
          description: "Synthetic AC7 unchanged grants",
          permissions: f.associationPermissionBefore.permissions.map(
            ({ id: _id, ...grant }) => grant,
          ),
        },
        async (context, data) => {
          assert.match(data.schemeId, /^[1-9]\d*$/u);
          f.associationPermissionTarget = await permissionSchemeReview(context, data.schemeId);
          assert.deepEqual(
            f.associationPermissionTarget.permissions.map(({ id: _id, ...grant }) => grant),
            f.associationPermissionBefore.permissions.map(({ id: _id, ...grant }) => grant),
          );
          return proof(2);
        },
      );
    },
  ),
  {
    ...readCase("jira.permission-scheme-attribute", attributePath, ["attributeKey", "textValue"], {
      args: (f) => ({
        schemeId: f.permissionAttributeSchemeId,
        attributeKey: f.permissionAttributeKey,
      }),
      nativeRoot: "single",
      productRoot: "single",
      nativeNames: { attributeKey: "key", textValue: "value" },
    }),
    actor: "admin",
    administration: true,
    prepare: attributes,
  },
  adminMutationCase(
    "jira.set-permission-scheme-attribute",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      expectedScheme: f.attributeParent,
      attributeKey: f.permissionAttributeKey,
      expectedValue: f.attributeBefore,
      enabled: f.attributeBefore !== "true",
    }),
    async (c, _data, f) => {
      const after = await read(c, attributePath(f));
      assert.equal(after.key, f.permissionAttributeKey);
      assert.equal(after.value, f.attributeBefore === "true" ? "false" : "true");
      assert.deepEqual(
        await permissionSchemeReview(c, f.permissionAttributeSchemeId),
        f.attributeParent,
      );
      return proof(4);
    },
    attributes,
  ),
];
