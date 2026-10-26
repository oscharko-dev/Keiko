import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  basicAuth,
  checked,
  labRequest,
  loadSession,
  readPrivateFile,
  requireLicense,
} from "./lab-client.mjs";

async function ensureProject(session) {
  const auth = basicAuth(session, "admin");
  const result = await labRequest(session, "GET", "/rest/api/2/project/KEIKO", auth);
  if (result.status === 200) return;
  if (result.status !== 404) throw new TypeError("Unexpected synthetic project state");
  await checked(session, "create-project", "POST", "/rest/api/2/project", auth, {
    key: "KEIKO",
    name: "Keiko synthetic Jira 4081",
    projectTypeKey: "software",
    lead: "keiko-admin",
    assigneeType: "UNASSIGNED",
  });
}

async function ensureApiUser(session) {
  const admin = basicAuth(session, "admin");
  const result = await labRequest(session, "GET", "/rest/api/2/user?username=keiko-api", admin);
  if (result.status === 200) return;
  if (result.status !== 404) throw new TypeError("Unexpected synthetic user state");
  await checked(session, "create-api-user", "POST", "/rest/api/2/user", admin, {
    name: "keiko-api",
    password: readPrivateFile(join(session.directory, "secrets", "api-user-password")),
    emailAddress: "jira-api@example.invalid",
    displayName: "Synthetic API user",
    applicationKeys: ["jira-software"],
    notification: false,
  });
}

async function ensureToken(session) {
  const path = join(session.directory, "secrets", "api-token");
  if (existsSync(path)) return `Bearer ${readPrivateFile(path)}`;
  // A lost PAT response cannot be recovered. Refuse another creation on a repeated invocation.
  writeFileSync(join(session.directory, "secrets", "pat-creation-started"), "1\n", {
    mode: 0o600,
    flag: "wx",
  });
  const token = await checked(
    session,
    "create-pat",
    "POST",
    "/rest/pat/latest/tokens",
    basicAuth(session, "api"),
    { name: "Keiko synthetic 4081 session", expirationDuration: 1 },
  );
  if (typeof token?.rawToken !== "string" || token.rawToken.length === 0)
    throw new TypeError("Missing laboratory PAT");
  writeFileSync(path, token.rawToken, { mode: 0o600, flag: "wx" });
  return `Bearer ${token.rawToken}`;
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
  writeFileSync(
    join(session.directory, "fixture.json"),
    JSON.stringify({ project: "KEIKO", issueKeys: keys, issueTypeId: type.id }) + "\n",
    { mode: 0o600 },
  );
  return keys;
}

async function main() {
  if (!process.argv[2]) throw new TypeError("Usage: seed.mjs <private-state-directory>");
  const session = loadSession(process.argv[2]);
  await requireLicense(session);
  await ensureProject(session);
  await ensureApiUser(session);
  const auth = await ensureToken(session);
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
