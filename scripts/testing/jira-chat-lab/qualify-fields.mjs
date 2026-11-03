import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checked, loadSession, readPrivateFile, requireLicense, basicAuth } from "./lab-client.mjs";
import { ensureFixtureField, prepareTransitionFixtures } from "./seed-fields.mjs";

async function issueCount(session, auth) {
  const result = await checked(session, "fixture-count", "POST", "/rest/api/2/search", auth, {
    jql: "project = KEIKO",
    fields: ["summary"],
    maxResults: 100,
  });
  if (result.total > 100) throw new TypeError("Fixture lookup exceeds bound");
  return result;
}

async function qualifyCreate(session, auth, fixture, fieldId) {
  const before = await issueCount(session, auth);
  const fields = {
    project: { key: "KEIKO" },
    issuetype: { id: fixture.issueTypeId },
    summary: "Synthetic mandatory custom field test",
  };
  const refusal = await checked(
    session,
    "required-create-refusal",
    "POST",
    "/rest/api/2/issue",
    auth,
    { fields },
    [400],
  );
  assert.ok(Object.hasOwn(refusal.errors, fieldId));
  assert.equal((await issueCount(session, auth)).total, before.total);
  const matching = before.issues.filter((issue) => issue.fields.summary === fields.summary);
  assert.ok(matching.length <= 1);
  const issue =
    matching[0] ??
    (await checked(session, "required-create-success", "POST", "/rest/api/2/issue", auth, {
      fields: { ...fields, [fieldId]: "Synthetic required value" },
    }));
  const observed = await checked(
    session,
    "required-create-readback",
    "GET",
    `/rest/api/2/issue/${issue.key}`,
    auth,
  );
  assert.equal(observed.fields[fieldId], "Synthetic required value");
  return issue.key;
}

async function qualifyTransition(session, auth, key, fieldId) {
  const path = `/rest/api/2/issue/${key}`;
  const before = await checked(session, "transition-before", "GET", path, auth);
  const metadata = await checked(
    session,
    "required-transition-metadata",
    "GET",
    `${path}/transitions?expand=transitions.fields`,
    auth,
  );
  const transition = metadata.transitions.find((value) => value.name === "Done");
  assert.equal(transition.fields[fieldId].required, true);
  const refusal = await checked(
    session,
    "required-transition-refusal",
    "POST",
    `${path}/transitions`,
    auth,
    { transition: { id: transition.id } },
    [400],
  );
  assert.ok(Object.hasOwn(refusal.errors, fieldId));
  const unchanged = await checked(session, "transition-refusal-readback", "GET", path, auth);
  assert.equal(unchanged.fields.status.id, before.fields.status.id);
  const resolution = transition.fields.resolution.allowedValues[0].id;
  await checked(
    session,
    "required-transition-success",
    "POST",
    `${path}/transitions`,
    auth,
    {
      transition: { id: transition.id },
      fields: { [fieldId]: "Synthetic transition value", resolution: { id: resolution } },
    },
    [204],
  );
  const observed = await checked(session, "transition-success-readback", "GET", path, auth);
  assert.equal(observed.fields.status.id, transition.to.id);
  assert.equal(observed.fields[fieldId], "Synthetic transition value");
  assert.equal(observed.fields.resolution.id, resolution);
}

async function main() {
  if (!process.argv[2]) throw new TypeError("Usage: qualify-fields.mjs <private-state-directory>");
  const session = loadSession(process.argv[2]);
  await requireLicense(session);
  const path = join(session.directory, "fixture.json");
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const fieldId = await ensureFixtureField(session);
  for (const key of fixture.issueKeys.slice(0, 2))
    await checked(
      session,
      "populate-existing-fixture",
      "PUT",
      `/rest/api/2/issue/${key}`,
      basicAuth(session, "admin"),
      { fields: { [fieldId]: "Synthetic required value" } },
      [204],
    );
  await prepareTransitionFixtures(session, fieldId, [fixture.issueKeys[2]]);
  const auth = `Bearer ${readPrivateFile(join(session.directory, "secrets", "api-token"))}`;
  const requiredIssueKey = await qualifyCreate(session, auth, fixture, fieldId);
  await qualifyTransition(session, auth, fixture.issueKeys[2], fieldId);
  // Leave an unpopulated legacy issue for the next consumer's required-field transition test.
  await prepareTransitionFixtures(session, fieldId, [fixture.issueKeys[2]]);
  writeFileSync(
    path,
    JSON.stringify({ ...fixture, requiredFieldId: fieldId, requiredIssueKey }) + "\n",
    { mode: 0o600 },
  );
  await requireLicense(session);
  console.log(JSON.stringify({ operation: "jira-lab-fields", passed: true }));
}

await main().catch(() => {
  console.error("jira-lab-fields: qualification failed; no failed mutation is retried");
  process.exitCode = 1;
});
