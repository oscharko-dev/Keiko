// Auxiliary fixtures use the very same governed dispatcher, journal and independent readback.
// No fixture helper has an HTTP mutation fallback.
import assert from "node:assert/strict";
import { read, proof } from "./api-qualification-read.mjs";
import { qualificationDigest } from "./api-qualification-evidence.mjs";

export async function fixtureWrite(context, tool, args, readback) {
  assert.equal(typeof context.qualificationFixture, "function");
  return context.qualificationFixture({ tool, arguments: args, readback });
}
export async function createQualificationIssue(
  context,
  f,
  label,
  issueTypeId = f.issueTypeId,
  fields = {},
) {
  const summary = `Synthetic AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create",
    {
      projectId: f.projectId,
      issueTypeId,
      fields: { summary, ...fields },
    },
    async (c, data) => {
      assert.match(data.issueKey, /^KEIKO-[1-9][0-9]*$/u);
      actual = await read(c, `/rest/api/2/issue/${data.issueKey}`);
      assert.equal(actual.key, data.issueKey);
      assert.equal(actual.fields.project.id, f.projectId);
      assert.equal(actual.fields.issuetype.id, issueTypeId);
      assert.equal(actual.fields.summary, summary);
      return proof(4);
    },
  );
  assert.ok(actual);
  return actual;
}
export function issueReview(value) {
  assert.ok(value && value.fields);
  assert.ok(value.fields.project && value.fields.issuetype);
  for (const id of [value.id, value.fields.project.id, value.fields.issuetype.id])
    assert.match(String(id), /^[1-9][0-9]*$/u);
  assert.equal(typeof value.key, "string");
  assert.equal(typeof value.fields.summary, "string");
  assert.ok(value.fields.summary.length > 0);
  return {
    id: String(value.id),
    key: value.key,
    summary: value.fields.summary,
    projectId: String(value.fields.project.id),
    issueTypeId: String(value.fields.issuetype.id),
  };
}
export async function createQualificationVersion(context, f, label) {
  const name = `AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-version",
    {
      expectedActorKey: f.adminActorKey,
      projectId: f.projectId,
      name,
      description: "Synthetic AC7 auxiliary version",
      startDate: "2026-11-08",
      releaseDate: "2026-12-01",
      released: false,
      archived: false,
    },
    async (c, data) => {
      assert.match(data.versionId, /^[1-9][0-9]*$/u);
      actual = await read(c, `/rest/api/2/version/${data.versionId}`);
      assert.equal(String(actual.id), data.versionId);
      assert.equal(String(actual.projectId), f.projectId);
      assert.equal(actual.name, name);
      return proof(3);
    },
  );
  assert.ok(actual);
  return actual;
}
export async function createQualificationField(context, f, label) {
  const name = `AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-custom-field",
    {
      expectedActorKey: f.adminActorKey,
      name,
      description: "Synthetic AC7 auxiliary field",
      type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
      projectIds: [f.projectId],
      issueTypeIds: [f.issueTypeId],
    },
    async (c, data) => {
      assert.match(data.fieldId, /^customfield_[1-9][0-9]*$/u);
      const rows = await read(c, "/rest/api/2/field");
      const found = rows.filter((row) => row.id === data.fieldId);
      assert.equal(found.length, 1);
      [actual] = found;
      assert.equal(actual.name, name);
      assert.equal(actual.custom, true);
      return proof(3);
    },
  );
  assert.ok(actual);
  return actual;
}
export const qualificationProjectKey = (f, label) =>
  `Q${qualificationDigest([f.runId, label]).slice(0, 9).toUpperCase()}`;
export function projectReview(value) {
  assert.match(String(value.id), /^[1-9][0-9]*$/u);
  for (const field of ["key", "name"]) assert.equal(typeof value[field], "string");
  assert.equal(typeof value.archived, "boolean");
  return { id: String(value.id), key: value.key, name: value.name, archived: value.archived };
}
export async function createQualificationProject(context, f, label) {
  const key = qualificationProjectKey(f, label);
  const name = `Synthetic AC7 ${label} ${f.runId}`;
  let actual;
  await fixtureWrite(
    context,
    "jira.create-project",
    { key, name, lead: "keiko-admin", projectTypeKey: "software", assigneeType: "UNASSIGNED" },
    async (c, data) => {
      actual = await read(c, `/rest/api/2/project/${data.projectId}`);
      assert.equal(String(actual.id), data.projectId);
      assert.equal(actual.key, key);
      assert.equal(actual.name, name);
      assert.equal(actual.projectTypeKey, "software");
      return proof(4);
    },
  );
  assert.ok(actual);
  return actual;
}
