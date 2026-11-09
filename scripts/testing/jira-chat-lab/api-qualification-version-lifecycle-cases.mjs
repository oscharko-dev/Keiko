import assert from "node:assert/strict";
import { read, proof } from "./api-qualification-read.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { createQualificationVersion } from "./api-qualification-fixtures.mjs";

function versionReview(value) {
  const snapshot = {};
  for (const key of ["name", "description", "startDate", "releaseDate", "released", "archived"]) {
    assert.ok(Object.hasOwn(value, key));
    snapshot[key] = value[key];
  }
  return snapshot;
}
async function prepare(c, f, label) {
  await observeAdminActor(c, f);
  const source = await createQualificationVersion(c, f, `${label} source`);
  const target = await createQualificationVersion(c, f, `${label} target`);
  f.lifecycleVersionSource = String(source.id);
  f.lifecycleVersionTarget = String(target.id);
  f.lifecycleVersionReview = versionReview(source);
  f.lifecycleTargetReview = versionReview(target);
  const versions = await read(c, "/rest/api/2/project/KEIKO/versions");
  assert.ok(Array.isArray(versions) && versions.length <= 1000);
  f.lifecycleVersionIds = versions.map((row) => String(row.id));
  assert.ok(f.lifecycleVersionIds.includes(f.lifecycleVersionSource));
  assert.ok(f.lifecycleVersionIds.includes(f.lifecycleVersionTarget));
}
const args = (f) => ({
  expectedActorKey: f.adminActorKey,
  expectedProjectId: f.projectId,
  versionId: f.lifecycleVersionSource,
  expectedVersionSnapshot: f.lifecycleVersionReview,
});
async function retained(c, f) {
  const target = await read(c, `/rest/api/2/version/${f.lifecycleVersionTarget}`);
  assert.equal(String(target.projectId), f.projectId);
  assert.deepEqual(versionReview(target), f.lifecycleTargetReview);
  return (await read(c, "/rest/api/2/project/KEIKO/versions")).map((row) => String(row.id));
}
async function removed(c, _data, f) {
  assert.deepEqual(
    await retained(c, f),
    f.lifecycleVersionIds.filter((id) => id !== f.lifecycleVersionSource),
  );
  return proof(4);
}
export const API_QUALIFICATION_VERSION_LIFECYCLE_CASES = [
  adminMutationCase(
    "jira.move-version",
    (f) => ({ ...args(f), expectedVersionIds: f.lifecycleVersionIds, position: "Last" }),
    async (c, _data, f) => {
      assert.notEqual(f.lifecycleVersionIds.at(-1), f.lifecycleVersionSource);
      assert.deepEqual(await retained(c, f), [
        ...f.lifecycleVersionIds.filter((id) => id !== f.lifecycleVersionSource),
        f.lifecycleVersionSource,
      ]);
      assert.deepEqual(
        versionReview(await read(c, `/rest/api/2/version/${f.lifecycleVersionSource}`)),
        f.lifecycleVersionReview,
      );
      return proof(5);
    },
    (c, f) => prepare(c, f, "move"),
  ),
  adminMutationCase(
    "jira.merge-version",
    (f) => ({
      ...args(f),
      moveIssuesTo: f.lifecycleVersionTarget,
      expectedTargetSnapshot: f.lifecycleTargetReview,
    }),
    removed,
    (c, f) => prepare(c, f, "merge"),
  ),
  adminMutationCase(
    "jira.remove-and-swap-version",
    (f) => ({
      ...args(f),
      moveAffectedIssuesTo: f.lifecycleVersionTarget,
      moveFixIssuesTo: f.lifecycleVersionTarget,
      customFieldReplacementList: [],
      expectedReplacementVersions: [
        { versionId: f.lifecycleVersionTarget, expectedVersionSnapshot: f.lifecycleTargetReview },
      ],
    }),
    removed,
    (c, f) => prepare(c, f, "swap"),
  ),
];
