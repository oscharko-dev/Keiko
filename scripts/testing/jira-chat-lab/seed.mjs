import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basicAuth, checked, labRequest, loadSession, requireLicense } from "./lab-client.mjs";

import { ensureFixtureIdentity } from "./seed-identities.mjs";
import { ensureFixturePermissions, verifyFixtureRestrictions } from "./seed-permissions.mjs";

async function ensureProject(session, key) {
  const auth = basicAuth(session, "admin");
  const result = await labRequest(session, "GET", `/rest/api/2/project/${key}`, auth);
  if (result.status === 200) return;
  if (result.status !== 404) throw new TypeError("Unexpected synthetic project state");
  await checked(session, "create-project", "POST", "/rest/api/2/project", auth, {
    key,
    name: `Keiko synthetic ${key}`,
    projectTypeKey: "software",
    lead: "keiko-admin",
    assigneeType: "UNASSIGNED",
  });
}

async function ensureIssues(session, auth) {
  const project = await checked(session, "project-read", "GET", "/rest/api/2/project/KEIKO", auth);
  const type = project.issueTypes.find((value) => value.name === "Task" && !value.subtask);
  if (!type) throw new TypeError("Synthetic project has no Task issue type");
  const found = await checked(session, "find-fixtures", "POST", "/rest/api/2/search", auth, {
    jql: "project = KEIKO",
    fields: ["summary"],
    maxResults: 100,
  });
  const keys = [];
  for (const title of [
    "Synthetic connector read test",
    "Synthetic connector update test",
    "Synthetic workflow transition test",
  ]) {
    const existing = found.issues.filter((issue) => issue.fields.summary === title);
    if (existing.length > 1) throw new TypeError("Ambiguous synthetic fixture identity");
    const issue =
      existing[0] ??
      (await checked(session, "create-issue", "POST", "/rest/api/2/issue", auth, {
        fields: {
          project: { key: "KEIKO" },
          issuetype: { id: type.id },
          summary: title,
          description: "Synthetic Keiko laboratory data. No customer content.",
        },
      }));
    if (!/^KEIKO-\d+$/.test(issue.key)) throw new TypeError("Invalid synthetic issue identity");
    keys.push(issue.key);
  }
  const manifestPath = join(session.directory, "fixture.json");
  const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  if (previous === null || typeof previous !== "object" || Array.isArray(previous))
    throw new TypeError("Invalid synthetic fixture manifest");
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...previous, project: "KEIKO", issueKeys: keys, issueTypeId: type.id }) + "\n",
    { mode: 0o600 },
  );
  return keys;
}

async function main() {
  if (!process.argv[2]) throw new TypeError("Usage: seed.mjs <private-state-directory>");
  const session = loadSession(process.argv[2]);
  await requireLicense(session);
  await ensureProject(session, "KEIKO");
  await ensureProject(session, "ISOLATED");
  const actors = {};
  for (const actor of ["api", "restricted", "editor", "assignee"])
    actors[actor] = await ensureFixtureIdentity(session, actor);
  await ensureFixturePermissions(session, actors);
  const auth = actors.api;
  const identity = await checked(session, "pat-identity", "GET", "/rest/api/2/myself", auth);
  if (identity.name !== "keiko-api" || identity.active !== true)
    throw new TypeError("Unexpected synthetic identity");
  const permissions = await checked(
    session,
    "non-admin-identity",
    "GET",
    "/rest/api/2/mypermissions?permissions=ADMINISTER",
    auth,
  );
  if (permissions.permissions.ADMINISTER.havePermission !== false)
    throw new TypeError("API actor is unexpectedly privileged");
  const keys = await ensureIssues(session, auth);
  await verifyFixtureRestrictions(session, actors, keys[1]);
  for (const key of keys)
    await checked(session, "verify-created-issue", "GET", `/rest/api/2/issue/${key}`, auth);
  await requireLicense(session);
  console.log(
    JSON.stringify({ operation: "jira-lab-seed", passed: true, issueCount: keys.length }),
  );
}

await main().catch(() => {
  console.error("jira-lab-seed: fixture setup failed; no failed mutation is retried");
  process.exitCode = 1;
});
