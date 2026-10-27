import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { basicAuth, checked } from "./lab-client.mjs";

/** Independent Jira reads only; never retries or repairs a mutation. */
export function remoteRead(session, path) {
  return checked(
    session,
    "catalog-independent-observation",
    "GET",
    path,
    basicAuth(session, "api"),
  );
}

export async function projectState(session) {
  const result = await remoteRead(
    session,
    "/rest/api/2/search?jql=project%20%3D%20KEIKO%20ORDER%20BY%20key&fields=summary,updated,status,assignee&maxResults=100",
  );
  assert.ok(Number.isSafeInteger(result.total) && result.total <= 100);
  assert.equal(result.issues.length, result.total);
  return {
    count: result.total,
    digest: createHash("sha256").update(JSON.stringify(result.issues)).digest("hex"),
    issues: result.issues,
  };
}

export async function issueState(session, key, fieldId) {
  const issue = await remoteRead(
    session,
    `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,${fieldId}&expand=changelog`,
  );
  assert.ok(Number.isSafeInteger(issue.changelog.total));
  return { fields: issue.fields, historyCount: issue.changelog.total };
}

export function readCases(fixture, assignee) {
  const issueKey = fixture.issueKeys[0];
  const paged = { maxResults: 100 };
  return [
    ["jira.projects", paged, fixture.project],
    ["jira.issue-types", { projectKey: fixture.project, ...paged }, fixture.issueTypeId],
    [
      "jira.create-fields",
      { projectKey: fixture.project, issueTypeId: fixture.issueTypeId, ...paged },
      fixture.requiredFieldId,
    ],
    ["jira.edit-fields", { issueKey, ...paged }, fixture.requiredFieldId],
    ["jira.search", { jql: `key = ${issueKey}`, ...paged }, issueKey],
    ["jira.issue", { issueKey, fields: [fixture.requiredFieldId] }, issueKey],
    ["jira.comments", { issueKey: fixture.hostileIssueKey, ...paged }],
    ["jira.transitions", { issueKey, ...paged }, fixture.requiredFieldId],
    ["jira.assignable-users", { issueKey, query: assignee, ...paged }, assignee],
  ];
}

export function verifyRead(exchange, expected) {
  const data = exchange.result.data;
  assert.equal(data.outcome, "succeeded");
  if (expected !== undefined) assert.ok(JSON.stringify(data).includes(expected));
  else assert.ok(Array.isArray(data.items) && data.items.length > 0);
}
