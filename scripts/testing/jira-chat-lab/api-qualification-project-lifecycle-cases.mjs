import assert from "node:assert/strict";
import { read, proof } from "./api-qualification-read.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { projectReview, qualificationProjectKey } from "./api-qualification-fixtures.mjs";

const projectPath = (f) => `/rest/api/2/project/${f.lifecycleProjectId}`;
// The case runner passes its Chat as a third argument, so the type flag is an explicit option.
async function reviewed(c, f, { includeType = false } = {}) {
  await observeAdminActor(c, f);
  const value = await read(c, projectPath(f));
  f.lifecycleProjectReview = projectReview(value);
  if (includeType) {
    assert.equal(typeof value.projectTypeKey, "string");
    f.lifecycleProjectReview.projectTypeKey = value.projectTypeKey;
  }
}
const reviewArgs = (f) => ({
  expectedActorKey: f.adminActorKey,
  expectedProject: f.lifecycleProjectReview,
  confirmUnverifiedConsequences: true,
});
async function archiveReadback(c, f, archived) {
  assert.deepEqual(projectReview(await read(c, projectPath(f))), {
    ...f.lifecycleProjectReview,
    archived,
  });
  return proof(4);
}
export const API_QUALIFICATION_PROJECT_LIFECYCLE_CASES = [
  adminMutationCase(
    "jira.create-project",
    (f) => ({
      key: qualificationProjectKey(f, "project lifecycle"),
      name: `Synthetic AC7 project ${f.runId}`,
      lead: "keiko-admin",
      projectTypeKey: "software",
      assigneeType: "UNASSIGNED",
    }),
    async (c, data, f) => {
      assert.match(data.projectId, /^[1-9]\d*$/u);
      f.lifecycleProjectId = data.projectId;
      const actual = await read(c, projectPath(f));
      assert.equal(String(actual.id), data.projectId);
      assert.equal(actual.key, qualificationProjectKey(f, "project lifecycle"));
      assert.equal(actual.name, `Synthetic AC7 project ${f.runId}`);
      assert.equal(actual.projectTypeKey, "software");
      return proof(5);
    },
  ),
  adminMutationCase(
    "jira.update-project",
    (f) => ({ projectIdOrKey: f.lifecycleProjectId, description: "Synthetic AC7 revised project" }),
    async (c, _data, f) => {
      const actual = await read(c, projectPath(f));
      assert.deepEqual(projectReview(actual), f.lifecycleProjectReview);
      assert.equal(actual.description, "Synthetic AC7 revised project");
      return proof(5);
    },
    reviewed,
  ),
  adminMutationCase(
    "jira.archive-project",
    reviewArgs,
    (c, _data, f) => archiveReadback(c, f, true),
    reviewed,
  ),
  adminMutationCase(
    "jira.restore-project",
    reviewArgs,
    (c, _data, f) => archiveReadback(c, f, false),
    reviewed,
  ),
  adminMutationCase(
    "jira.update-project-type",
    (f) => ({ ...reviewArgs(f), projectTypeKey: "business" }),
    async (c, _data, f) => {
      const actual = await read(c, projectPath(f));
      assert.equal(actual.projectTypeKey, "business");
      const prior = { ...f.lifecycleProjectReview };
      delete prior.projectTypeKey;
      assert.deepEqual(projectReview(actual), prior);
      return proof(5);
    },
    (c, f) => reviewed(c, f, { includeType: true }),
  ),
  adminMutationCase(
    "jira.delete-project",
    reviewArgs,
    async (c, _data, f) => {
      const actual = await read(c, "/rest/api/2/project");
      assert.ok(Array.isArray(actual));
      assert.equal(
        actual.some((row) => String(row.id) === f.lifecycleProjectReview.id),
        false,
      );
      assert.equal((await read(c, "/rest/api/2/project/KEIKO")).key, "KEIKO");
      return proof(3);
    },
    reviewed,
  ),
  {
    tool: "jira.validate-project-key",
    actor: "admin",
    administration: true,
    arguments: (f) => ({ key: qualificationProjectKey(f, "validation") }),
    readback: async (c, data, f) => {
      const key = qualificationProjectKey(f, "validation");
      const value = await read(c, `/rest/api/2/projectvalidate/key?key=${key}`);
      assert.ok(Array.isArray(value.errorMessages));
      assert.ok(value.errors && typeof value.errors === "object" && !Array.isArray(value.errors));
      assert.equal(data.key, key);
      assert.equal(
        data.valid,
        value.errorMessages.length === 0 && Object.keys(value.errors).length === 0,
      );
      return proof(4);
    },
  },
];
