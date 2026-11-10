// Explicit independent oracles; specification documents never become HTTP dispatch authority.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { URLSearchParams } from "node:url";
import { assertSessionServerInfo, basicAuth, labRequest } from "./lab-client.mjs";
import { assertQualificationJson } from "./api-qualification-json.mjs";

async function nativeRead(context, path) {
  return labRequest(context.session, "GET", path, basicAuth(context.session, context.actor));
}
const REPOSITORY = resolve(import.meta.dirname, "..", "..", "..");
const COVERAGE = join(REPOSITORY, "docs/local-knowledge/jira-api-coverage");
const releaseFamily = (version) => version?.split(".").slice(0, 2).join(".");
/** The checked-in source inventories name each release that publishes an identity. */
function inventoryReleases(tool) {
  const ledger = JSON.parse(readFileSync(join(COVERAGE, "operations.json"), "utf8"));
  const identity = ledger.currentCapabilities[tool]?.identity;
  const row = ledger.operations.find((entry) => entry.identity === identity);
  const provenance = JSON.parse(readFileSync(join(COVERAGE, "provenance.json"), "utf8"));
  return {
    published: row?.sources.map((source) => source.release),
    inventoried: provenance.sources.map((source) => source.release),
  };
}
/**
 * A native 404/405 proves a missing capability only when the running release itself, observed
 * again independently, belongs to the inventoried releases that do not publish this identity.
 * A resource-specific refusal never enters this proof.
 */
/** Only route-level 404/405s, or a 400 from a known shadowing sibling route, may enter the proof. */
function absenceStatuses(statuses, shadow) {
  if (statuses.length === 0) return undefined;
  if (statuses.every((status) => status === 404 || status === 405)) return "route";
  return shadow !== undefined && statuses.every((status) => status === 400) ? "shadow" : undefined;
}
export async function missingReleaseCapability(context, tool, statuses, { shadow } = {}) {
  const absence = absenceStatuses(statuses, shadow);
  if (absence === undefined) return undefined;
  const routeLevel = absence === "route";
  const family = releaseFamily(context.session.jiraVersion);
  const { published, inventoried } = inventoryReleases(tool);
  if (!published || !inventoried.includes(family) || published.includes(family)) return undefined;
  if (!routeLevel) {
    // The literal path segment is captured by a sibling wildcard route, which names it as an id.
    const probe = await nativeRead(context, shadow.path);
    assert.equal(probe.status, 400);
    assert.deepEqual(probe.value?.errorMessages, [shadow.message]);
  }
  const observed = await nativeRead(context, "/rest/api/2/serverInfo");
  assert.equal(observed.status, 200);
  assertSessionServerInfo(context.session, observed.value);
  return {
    capabilityAbsent: true,
    ...(routeLevel ? {} : { routeShadowed: true }),
    status: statuses[0],
    release: observed.value.version,
    reason: "absent-in-release-inventory",
    sourceReferences: [
      "docs/local-knowledge/jira-api-coverage/operations.json",
      "docs/local-knowledge/jira-api-coverage/provenance.json",
    ],
  };
}
/** The status the qualification witness observed for this case's own native dispatch. */
export const dispatchedStatuses = (context) =>
  (context.qualificationWitness?.snapshot().responses ?? []).map((response) => response.status);
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
      assert.notEqual(
        value,
        undefined,
        `The oracle requires an actual observed field: ${names[field] ?? field}`,
      );
      return typeof value === "number" ? String(value) : value;
    }),
  );
}
function assertOptionalFields(actual, native, fields, names) {
  for (const [index, row] of native.slice(0, 100).entries()) {
    for (const field of fields) {
      const observed = row[names?.[field] ?? field];
      if (observed === undefined || observed === null)
        assert.equal(Object.hasOwn(actual[index], field), false);
      else
        assertQualificationJson(
          rowValues([actual[index]], [field]),
          rowValues([row], [field], names),
        );
    }
  }
}
const membership = (rows) =>
  rows
    .map((row) => JSON.stringify(row))
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((row) => JSON.parse(row));
export function readCase(
  tool,
  path,
  fields,
  {
    args = () => ({}),
    nativeRoot,
    productRoot,
    nativeNames,
    optionalFields = [],
    nonEmpty = false,
    unordered = false,
  } = {},
) {
  return {
    tool,
    arguments: args,
    readback: async (context, data, fixture) => {
      const selectedPath = typeof path === "function" ? path(fixture) : path;
      const response = await nativeRead(context, selectedPath);
      if (response.status === 403) return { permissionDenied: true, status: response.status };
      const absent = await missingReleaseCapability(context, tool, [response.status]);
      if (absent !== undefined) return absent;
      assert.equal(response.status, 200);
      const native = nativeRows(response.value, nativeRoot);
      // A read of a collection this run just populated proves nothing when it is empty: the
      // refused write that should have populated it would pass as a vacuous match.
      if (nonEmpty) assert.ok(native.length > 0, "the owned fixture must be natively present");
      const projected = projectRows(data, productRoot);
      const actual = rowValues(projected, fields);
      const expected = rowValues(native, fields, nativeNames).slice(0, 100);
      // An unordered native collection proves membership; the order Keiko pages it in is its own.
      if (unordered) assert.ok(native.length <= 100, "Membership needs the complete collection");
      assertQualificationJson(
        unordered ? membership(actual) : actual,
        unordered ? membership(expected) : expected,
        "Keiko's observation must equal the independent native read",
      );
      assertOptionalFields(projected, native, optionalFields, nativeNames);
      // Empty collections prove their exact count, not an invented sample row.
      return {
        matched: true,
        assertionCount: 1 + actual.length * (fields.length + optionalFields.length),
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
  readCase("jira.projects", "/rest/api/2/project", ["id", "key", "name"], {
    args: () => ({ maxResults: 100 }),
    unordered: true,
  }),
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
  readCase("jira.screens", "/rest/api/2/screens?startAt=0&maxResults=100", ["id", "name"], {
    args: () => ({ maxResults: 100 }),
    nativeRoot: "screens",
  }),
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
