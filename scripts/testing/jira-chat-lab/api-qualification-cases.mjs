// Explicit independent oracles; specification documents never become HTTP dispatch authority.
import assert from "node:assert/strict";
import { URLSearchParams } from "node:url";
import { basicAuth, labRequest } from "./lab-client.mjs";

async function nativeRead(context, path) {
  return labRequest(context.session, "GET", path, basicAuth(context.session, context.actor));
}
function nativeRows(value, root) {
  if (typeof root === "function") return root(value);
  if (root === "single") return [value];
  if (root === "keys") return Object.keys(value).map((name) => ({ name }));
  if (root === "permissions")
    return Object.entries(value.permissions).map(([key, entry]) => ({ ...entry, key }));
  return root === undefined ? value : value[root];
}
function projectRows(data, root) {
  if (typeof root === "function") return root(data);
  return root === "single" ? [data] : data[root ?? "items"];
}
function rowValues(rows, fields, names = {}) {
  assert.ok(Array.isArray(rows));
  return rows.map((row) =>
    fields.map((field) => {
      const value = row[names[field] ?? field];
      assert.notEqual(value, undefined, "The oracle requires an actual observed field");
      return typeof value === "number" ? String(value) : value;
    }),
  );
}
export function readCase(
  tool,
  path,
  fields,
  { args = () => ({}), nativeRoot, productRoot, nativeNames } = {},
) {
  return {
    tool,
    arguments: args,
    readback: async (context, data, fixture) => {
      const response = await nativeRead(context, typeof path === "function" ? path(fixture) : path);
      if (response.status === 403) return { permissionDenied: true, status: response.status };
      assert.equal(response.status, 200);
      const native = nativeRows(response.value, nativeRoot);
      const projected = projectRows(data, productRoot);
      const actual = rowValues(projected, fields);
      const expected = rowValues(native, fields, nativeNames).slice(0, 100);
      assert.deepEqual(
        actual,
        expected,
        "Keiko's observation must equal the independent native read",
      );
      // Empty collections prove their exact count, not an invented sample row.
      return {
        matched: true,
        assertionCount: 1 + actual.length * fields.length,
        nativeCount: native.length,
        projectedCount: projected.length,
      };
    },
  };
}
const single = { nativeRoot: "single", productRoot: "single" };
const project = () => ({ projectIdOrKey: "KEIKO" });
const issue = (fixture) => ({ issueKey: fixture.issueKeys[0] });
const pathId = (prefix, key) => (fixture) => `${prefix}/${encodeURIComponent(fixture[key])}`;
const argId = (key) => (fixture) => ({ [key]: String(fixture[key]) });
const collection = (tool, path, fields = ["id", "name"]) =>
  readCase(tool, path, fields, { args: () => ({ maxResults: 100 }) });
const nativePage = (tool, path, fields = ["id", "name"]) =>
  readCase(tool, `${path}?startAt=0&maxResults=100`, fields, {
    args: () => ({ maxResults: 100 }),
    nativeRoot: "values",
  });

const JQL = "project = KEIKO ORDER BY key ASC";
const SEARCH_READBACK = `/rest/api/2/search?${new URLSearchParams({ jql: JQL, fields: "summary", maxResults: "100" })}`;
const issueRows = (rows) =>
  rows.map((row) => ({ id: row.id, key: row.key, summary: row.fields.summary }));

export const API_QUALIFICATION_CASES = [
  collection("jira.projects", "/rest/api/2/project", ["id", "key", "name"]),
  readCase(
    "jira.server-info",
    "/rest/api/2/serverInfo",
    ["version", "versionNumbers", "deploymentType"],
    single,
  ),
  readCase(
    "jira.instance-configuration",
    "/rest/api/2/configuration",
    [
      "attachmentsEnabled",
      "issueLinkingEnabled",
      "subTasksEnabled",
      "votingEnabled",
      "watchingEnabled",
    ],
    single,
  ),
  readCase("jira.myself", "/rest/api/2/myself", ["key", "name", "active"], single),
  collection("jira.global-issue-types", "/rest/api/2/issuetype"),
  collection("jira.priorities", "/rest/api/2/priority"),
  collection("jira.resolutions", "/rest/api/2/resolution"),
  collection("jira.statuses", "/rest/api/2/status"),
  collection("jira.status-categories", "/rest/api/2/statuscategory", ["id", "key", "name"]),
  collection("jira.project-categories", "/rest/api/2/projectCategory"),
  collection("jira.project-types", "/rest/api/2/project/type", ["key"]),
  collection("jira.roles", "/rest/api/2/role"),
  readCase(
    "jira.issue",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}?fields=summary`,
    ["id", "key", "summary"],
    { args: issue, nativeRoot: (row) => issueRows([row]) },
  ),
  readCase("jira.search", SEARCH_READBACK, ["id", "key", "summary"], {
    args: () => ({ jql: JQL, maxResults: 100 }),
    nativeRoot: (value) => issueRows(value.issues),
  }),
  readCase("jira.search-post", SEARCH_READBACK, ["id", "key", "summary"], {
    args: () => ({ jql: JQL, maxResults: 100 }),
    nativeRoot: (value) => issueRows(value.issues),
  }),
  readCase(
    "jira.worklogs",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}/worklog?maxResults=100`,
    ["id", "timeSpentSeconds"],
    { args: (f) => ({ ...issue(f), maxResults: 100 }), nativeRoot: "worklogs" },
  ),
  readCase(
    "jira.watchers",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}/watchers`,
    ["watchCount", "isWatching"],
    { ...single, args: issue },
  ),
  readCase(
    "jira.votes",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}/votes`,
    ["votes", "hasVoted"],
    { ...single, args: issue },
  ),
  readCase("jira.dashboards", "/rest/api/2/dashboard?startAt=0&maxResults=100", ["id", "name"], {
    args: () => ({ maxResults: 100 }),
    nativeRoot: "dashboards",
  }),
  readCase("jira.filter-share-scope", "/rest/api/2/filter/defaultShareScope", ["scope"], single),
  readCase(
    "jira.attachment-settings",
    "/rest/api/2/attachment/meta",
    ["enabled", "uploadLimit"],
    single,
  ),
  readCase("jira.jql-autocomplete", "/rest/api/2/jql/autocompletedata", ["value"], {
    args: () => ({ category: "reserved-words", maxResults: 100 }),
    nativeRoot: (value) => value.jqlReservedWords.map((word) => ({ value: word })),
  }),
  readCase(
    "jira.jql-suggestions",
    "/rest/api/2/jql/autocompletedata/suggestions?fieldName=project",
    ["value"],
    {
      args: () => ({ fieldName: "project", maxResults: 100 }),
      nativeRoot: "results",
    },
  ),
  nativePage("jira.issue-type-page", "/rest/api/2/issuetype/page"),
  nativePage("jira.priority-page", "/rest/api/2/priority/page"),
  nativePage("jira.resolution-page", "/rest/api/2/resolution/page"),
  nativePage("jira.status-page", "/rest/api/2/status/page"),
  nativePage("jira.screens", "/rest/api/2/screens"),
  collection("jira.workflows", "/rest/api/2/workflow", ["name"]),
  collection("jira.terminology", "/rest/api/2/terminology/entries", ["originalName"]),
  readCase("jira.terminology-entry", "/rest/api/2/terminology/entries/epic", ["originalName"], {
    ...single,
    args: () => ({ originalName: "epic" }),
  }),
  readCase("jira.read-only-mode", "/rest/api/2/readonly-mode", ["enabled"], single),
  readCase("jira.user", "/rest/api/2/user?username=keiko-api", ["key", "name", "active"], {
    ...single,
    args: () => ({ username: "keiko-api" }),
  }),
  readCase(
    "jira.users",
    "/rest/api/2/user/search?username=keiko&startAt=0&maxResults=100",
    ["key", "name", "active"],
    { args: () => ({ query: "keiko", maxResults: 100 }) },
  ),
  readCase(
    "jira.user-picker",
    "/rest/api/2/user/picker?query=keiko&maxResults=100",
    ["key", "name"],
    { args: () => ({ query: "keiko", maxResults: 100 }), nativeRoot: "users" },
  ),
  readCase("jira.groups", "/rest/api/2/groups/picker?maxResults=100", ["name"], {
    args: () => ({ maxResults: 100 }),
    nativeRoot: "groups",
  }),
  readCase(
    "jira.group-members",
    "/rest/api/2/group/member?groupname=jira-software-users&startAt=0&maxResults=50",
    ["key", "name", "active"],
    { args: () => ({ groupName: "jira-software-users", maxResults: 50 }), nativeRoot: "values" },
  ),
  collection("jira.application-roles", "/rest/api/2/applicationrole", ["key", "name"]),
  readCase("jira.application-role", "/rest/api/2/applicationrole/jira-software", ["key", "name"], {
    ...single,
    args: () => ({ applicationRoleKey: "jira-software" }),
  }),
  readCase("jira.link-types", "/rest/api/2/issueLinkType", ["id", "name", "inward", "outward"], {
    nativeRoot: "issueLinkTypes",
  }),
  readCase("jira.permission-definitions", "/rest/api/2/permissions", ["key", "name"], {
    nativeRoot: "permissions",
    args: () => ({ maxResults: 100 }),
  }),
  readCase(
    "jira.project",
    "/rest/api/2/project/KEIKO",
    ["projectId", "projectKey", "projectName"],
    {
      ...single,
      args: project,
      nativeNames: { projectId: "id", projectKey: "key", projectName: "name" },
    },
  ),
  readCase("jira.components", "/rest/api/2/project/KEIKO/components", ["id", "name"], {
    args: () => ({ ...project(), maxResults: 100 }),
  }),
  readCase(
    "jira.versions",
    "/rest/api/2/project/KEIKO/versions",
    ["versionId", "name", "released", "archived"],
    { args: () => ({ ...project(), maxResults: 100 }), nativeNames: { versionId: "id" } },
  ),
  readCase("jira.project-roles", "/rest/api/2/project/KEIKO/role", ["name"], {
    args: project,
    nativeRoot: "keys",
  }),
  readCase("jira.issue-type", pathId("/rest/api/2/issuetype", "issueTypeId"), ["id", "name"], {
    ...single,
    args: argId("issueTypeId"),
  }),
  readCase("jira.priority", pathId("/rest/api/2/priority", "priorityId"), ["id", "name"], {
    ...single,
    args: argId("priorityId"),
  }),
  readCase("jira.resolution", pathId("/rest/api/2/resolution", "resolutionId"), ["id", "name"], {
    ...single,
    args: argId("resolutionId"),
  }),
  readCase("jira.status", pathId("/rest/api/2/status", "statusIdOrName"), ["id", "name"], {
    ...single,
    args: argId("statusIdOrName"),
  }),
  readCase(
    "jira.status-category",
    pathId("/rest/api/2/statuscategory", "statusCategoryIdOrKey"),
    ["id", "key", "name"],
    { ...single, args: argId("statusCategoryIdOrKey") },
  ),
  readCase("jira.project-type-definition", "/rest/api/2/project/type/software", ["key"], {
    ...single,
    args: () => ({ projectTypeKey: "software" }),
  }),
  readCase("jira.role", pathId("/rest/api/2/role", "roleId"), ["id", "name"], {
    ...single,
    args: argId("roleId"),
  }),
  readCase(
    "jira.project-role",
    (f) => `/rest/api/2/project/KEIKO/role/${f.roleId}`,
    ["id", "name"],
    { ...single, args: (f) => ({ ...project(), roleId: String(f.roleId) }) },
  ),
  readCase(
    "jira.comments",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}/comment?maxResults=100`,
    ["id", "body"],
    { args: issue, nativeRoot: "comments" },
  ),
  readCase(
    "jira.transitions",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}/transitions?expand=transitions.fields`,
    ["id", "name"],
    { args: issue, nativeRoot: "transitions" },
  ),
].map((entry) => ({ ...entry, actor: "admin", administration: true }));

/** Read fixture identities only. This helper never creates an effect or fabricates a missing ID. */
export async function observeQualificationFixtures(context, fixture) {
  const observed = { ...fixture };
  const project = await nativeRead(context, "/rest/api/2/project/KEIKO");
  assert.equal(project.status, 200);
  assert.equal(project.value.key, "KEIKO");
  observed.projectId = String(project.value.id);
  const actor = await nativeRead(context, "/rest/api/2/myself");
  assert.equal(actor.status, 200);
  assert.equal(actor.value.name, `keiko-${context.actor}`);
  observed.actorKey = actor.value.key;
  for (const [path, key, select] of [
    ["priority", "priorityId", (rows) => rows[0]?.id],
    ["resolution", "resolutionId", (rows) => rows[0]?.id],
    ["status", "statusIdOrName", (rows) => rows[0]?.id],
    ["statuscategory", "statusCategoryIdOrKey", (rows) => rows[0]?.id],
    ["role", "roleId", (rows) => rows[0]?.id],
  ]) {
    const response = await nativeRead({ ...context, actor: "admin" }, `/rest/api/2/${path}`);
    assert.equal(response.status, 200);
    const value = select(response.value);
    assert.notEqual(value, undefined);
    observed[key] = String(value);
  }
  return observed;
}
