import assert from "node:assert/strict";
import { URL } from "node:url";
import { basicAuth, labSessionConnection } from "./lab-client.mjs";
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

async function permissionSchemeReview(c, id) {
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
/**
 * Jira's default permission scheme also grants to application roles, a holder the governed
 * create-permission-scheme tool cannot express (its schema refused them with a ToolCatalogError).
 * The auxiliary target scheme therefore copies exactly the grants the tool can name.
 */
const EXPRESSIBLE_HOLDERS = new Set([
  "anyone",
  "reporter",
  "projectLead",
  "assignee",
  "reporterWithCreatePermission",
  "assigneeWithAssignablePermission",
  "group",
  "user",
  "projectRole",
  "userCustomField",
  "groupCustomField",
]);
export function expressibleGrants(review) {
  const grants = review.permissions
    .filter(({ holder }) => EXPRESSIBLE_HOLDERS.has(holder.type))
    .map(({ id: _id, ...grant }) => grant);
  assert.ok(grants.length > 0, "The scheme must hold grants the governed tool can express");
  return grants;
}
const projectPath = (f) => `/rest/api/2/project/${f.associationProject.id}`;
const args = (f) => ({
  expectedActorKey: f.adminActorKey,
  expectedProject: f.associationProject,
  confirmUnverifiedConsequences: true,
});
/** Native fixture call; the project priority-scheme association is an experimental Jira resource. */
async function nativeFixture(c, method, path, body) {
  const response = await globalThis.fetch(new URL(path, labSessionConnection(c.session).origin), {
    method,
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(30_000),
    headers: {
      Authorization: basicAuth(c.session, c.actor),
      "Content-Type": "application/json",
      "X-Atlassian-Token": "no-check",
      "X-ExperimentalApi": "true",
    },
    body: JSON.stringify(body),
  });
  assert.ok(response.status === 200 || response.status === 201, "Jira must accept the fixture");
  return response.json();
}
const customPriorityScheme = (c, f, label) =>
  nativeFixture(c, "POST", "/rest/api/2/priorityschemes", {
    name: `AC7 ${label} ${f.runId}`,
    description: "Synthetic AC7 association fixture",
    optionIds: ["1"],
    defaultOptionId: "1",
  });
/**
 * Jira's global default priority scheme names no default option, so its review is incomplete and the
 * product correctly cannot admit a write against it. The owned project therefore starts on a native
 * custom scheme the operator fixture assigns; the default scheme is where a removal returns it.
 */
async function priority(c, f) {
  await observeAdminActor(c, f);
  f.associationProject = projectReview(await read(c, projectPath(f)));
  let selected = await read(c, `${projectPath(f)}/priorityscheme`);
  const current = await read(c, `/rest/api/2/priorityschemes/${selected.id}`);
  const all = await read(c, "/rest/api/2/priorityschemes");
  const defaults = all.schemes.filter((scheme) => scheme.defaultScheme === true);
  assert.equal(defaults.length, 1);
  f.associationPriorityDefaultId = String(defaults[0].id);
  if (!Object.hasOwn(current, "defaultOptionId")) {
    const baseline = await customPriorityScheme(c, f, "association baseline");
    await nativeFixture(c, "PUT", `${projectPath(f)}/priorityscheme`, { id: baseline.id });
    selected = await read(c, `${projectPath(f)}/priorityscheme`);
    assert.equal(String(selected.id), String(baseline.id));
  }
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
      const target = await customPriorityScheme(c, f, "association target");
      f.associationPriorityTarget = optionSchemeReview(
        await read(c, `/rest/api/2/priorityschemes/${target.id}`),
        OPTION_SCHEMES[1],
      );
      assert.notEqual(f.associationPriorityTarget.id, f.associationPriorityBefore.id);
    },
  ),
  adminMutationCase(
    "jira.remove-project-priority-scheme",
    (f) => ({ ...args(f), expectedScheme: f.associationPriorityBefore }),
    async (c, _data, f) => {
      assert.equal(typeof f.associationPriorityDefaultId, "string");
      await assertProjectScheme(c, f, "priorityscheme", f.associationPriorityDefaultId);
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
          permissions: expressibleGrants(f.associationPermissionBefore),
        },
        async (context, data) => {
          assert.match(data.schemeId, /^[1-9]\d*$/u);
          f.associationPermissionTarget = await permissionSchemeReview(context, data.schemeId);
          assert.deepEqual(
            f.associationPermissionTarget.permissions.map(({ id: _id, ...grant }) => grant),
            expressibleGrants(f.associationPermissionBefore),
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
