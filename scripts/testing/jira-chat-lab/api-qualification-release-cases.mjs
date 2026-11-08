// Synthetic project-scoped resources; every effect goes through Keiko, every oracle is separate.
import assert from "node:assert/strict";
import { readCase } from "./api-qualification-cases.mjs";
import { basicAuth, labRequest } from "./lab-client.mjs";

const single = { nativeRoot: "single", productRoot: "single" };
const proof = (assertionCount) => ({ matched: true, assertionCount });
async function read(context, path) {
  const response = await labRequest(
    context.session,
    "GET",
    path,
    basicAuth(context.session, context.actor),
  );
  assert.equal(response.status, 200);
  return response.value;
}
const componentPath = (f) => `/rest/api/2/component/${f.componentId}`;
const versionPath = (f) => `/rest/api/2/version/${f.versionId}`;
const componentName = (f) => `Synthetic AC7 component ${f.runId}`;
const versionName = (f) => `Synthetic AC7 version ${f.runId}`;
const linkId = (f, suffix) => `keiko-ac7-${f.runId}-${suffix}`;
const linkValue = (f, suffix) => ({ globalId: linkId(f, suffix), flag: true });
const linkNodes = (f, suffix) => [
  { path: "", kind: "object", childCount: 2 },
  { path: "/globalId", kind: "string", textValue: linkId(f, suffix) },
  { path: "/flag", kind: "boolean", booleanValue: true },
];
function observedLinkNodes(value) {
  assert.deepEqual(Object.keys(value).toSorted(), ["flag", "globalId"]);
  assert.equal(typeof value.globalId, "string");
  assert.equal(value.flag, true);
  return [
    { path: "", kind: "object", childCount: 2 },
    ...Object.entries(value).map(([key, field]) =>
      typeof field === "string"
        ? { path: `/${key}`, kind: "string", textValue: field }
        : { path: `/${key}`, kind: "boolean", booleanValue: field },
    ),
  ];
}
const versionSnapshot = (value) => ({
  name: value.name,
  description: value.description ?? null,
  startDate: value.startDate == null ? null : value.startDate.slice(0, 10),
  releaseDate: value.releaseDate == null ? null : value.releaseDate.slice(0, 10),
  released: value.released ?? null,
  archived: value.archived ?? null,
});
async function actor(context, fixture) {
  const observed = await read(context, "/rest/api/2/myself");
  assert.equal(observed.name, "keiko-admin");
  fixture.releaseActorKey = observed.key;
}
const mutation = (tool, args, readback, prepare) => ({
  tool,
  mutation: true,
  arguments: args,
  readback,
  prepare,
});

async function versionContext(context, f) {
  await actor(context, f);
  const version = await read(context, versionPath(f));
  assert.equal(String(version.id), f.versionId);
  assert.equal(String(version.projectId), f.projectId);
  f.versionSnapshot = versionSnapshot(version);
}
async function links(context, f) {
  const observed = await read(context, `${versionPath(f)}/remotelink`);
  assert.ok(Array.isArray(observed.links));
  const values = observed.links.map((row) => JSON.parse(row.link));
  const ordered = (rows) => rows.toSorted((a, b) => a.globalId.localeCompare(b.globalId));
  assert.deepEqual(ordered(values), ordered(f.linkSuffixes.map((suffix) => linkValue(f, suffix))));
  f.linkSnapshots = values.map((value) => ({
    globalId: value.globalId,
    valueNodes: observedLinkNodes(value),
  }));
  return observed.links;
}
async function linkContext(context, f) {
  await versionContext(context, f);
  await links(context, f);
}
const linkArguments = (f) => ({
  versionId: f.versionId,
  expectedProjectId: f.projectId,
  expectedActorKey: f.releaseActorKey,
  expectedVersionSnapshot: f.versionSnapshot,
  expectedLinks: f.linkSnapshots,
});
function createLink(tool, suffix) {
  return mutation(
    tool,
    (f) => ({ ...linkArguments(f), globalId: linkId(f, suffix), valueNodes: linkNodes(f, suffix) }),
    async (context, data, f) => {
      f.linkSuffixes.push(suffix);
      const actual = await links(context, f);
      assert.equal(actual.length, f.linkSuffixes.length);
      assert.equal(data.globalId, linkId(f, suffix));
      assert.equal(data.linkPresent, true);
      return proof(4);
    },
    linkContext,
  );
}
function linkReadback(path) {
  return async (context, data, f) => {
    const observed = await read(context, path(f));
    const rows = Array.isArray(observed.links) ? observed.links : [observed];
    assert.equal(data.items.length, rows.length);
    for (const [index, row] of rows.entries()) {
      const value = JSON.parse(row.link);
      const suffix = f.linkSuffixes.find((entry) => linkId(f, entry) === value.globalId);
      assert.notEqual(suffix, undefined);
      assert.deepEqual(value, linkValue(f, suffix));
      assert.deepEqual(data.items[index].valueNodes, observedLinkNodes(value));
      assert.equal(data.items[index].globalId, value.globalId);
    }
    return proof(1 + rows.length * 4);
  };
}

export const API_QUALIFICATION_RELEASE_CASES = [
  mutation(
    "jira.create-component",
    (f) => ({
      projectIdOrKey: "KEIKO",
      name: componentName(f),
      description: "",
      assigneeType: "PROJECT_DEFAULT",
    }),
    async (context, data, f) => {
      assert.match(data.componentId, /^[1-9][0-9]*$/u);
      f.componentId = data.componentId;
      const actual = await read(context, componentPath(f));
      assert.equal(String(actual.id), f.componentId);
      assert.equal(actual.name, componentName(f));
      assert.equal(actual.project, "KEIKO");
      assert.equal(actual.description, "");
      return proof(5);
    },
  ),
  readCase("jira.component", componentPath, ["id", "name", "project"], {
    args: (f) => ({ componentId: f.componentId }),
    nativeRoot: "single",
  }),
  readCase(
    "jira.component-related-issue-counts",
    (f) => `${componentPath(f)}/relatedIssueCounts`,
    ["issueCount"],
    {
      ...single,
      args: (f) => ({ componentId: f.componentId }),
    },
  ),
  mutation(
    "jira.update-component",
    (f) => ({ componentId: f.componentId, description: "Synthetic AC7 component updated" }),
    async (context, _data, f) => {
      const actual = await read(context, componentPath(f));
      assert.equal(String(actual.id), f.componentId);
      assert.equal(actual.name, componentName(f));
      assert.equal(actual.description, "Synthetic AC7 component updated");
      return proof(3);
    },
  ),
  mutation(
    "jira.delete-component",
    (f) => ({
      componentId: f.componentId,
      expectedProjectId: f.projectId,
      expectedActorKey: f.releaseActorKey,
      expectedComponentSnapshot: f.componentSnapshot,
      moveIssuesTo: null,
    }),
    async (context, _data, f) => {
      const project = await read(context, "/rest/api/2/project/KEIKO");
      assert.equal(String(project.id), f.projectId);
      const actual = await read(context, "/rest/api/2/project/KEIKO/components");
      assert.deepEqual(
        actual,
        f.componentsBefore.filter((row) => String(row.id) !== f.componentId),
      );
      return proof(2);
    },
    async (context, f) => {
      await actor(context, f);
      const actual = await read(context, componentPath(f));
      assert.equal(actual.name, componentName(f));
      f.componentSnapshot = {
        name: actual.name,
        description: actual.description ?? null,
        leadUserName: actual.leadUserName ?? actual.lead?.name ?? null,
        assigneeType: actual.assigneeType ?? null,
        archived: actual.archived ?? null,
        deleted: actual.deleted ?? null,
      };
      const counts = await read(context, `${componentPath(f)}/relatedIssueCounts`);
      assert.equal(counts.issueCount, 0);
      f.componentsBefore = await read(context, "/rest/api/2/project/KEIKO/components");
      assert.equal(f.componentsBefore.filter((row) => String(row.id) === f.componentId).length, 1);
    },
  ),
  mutation(
    "jira.create-version",
    (f) => ({
      projectId: f.projectId,
      name: versionName(f),
      description: "Synthetic AC7 release",
      released: false,
      archived: false,
      startDate: "2026-11-08",
      releaseDate: "2026-12-01",
    }),
    async (context, data, f) => {
      assert.match(data.versionId, /^[1-9][0-9]*$/u);
      f.versionId = data.versionId;
      const actual = await read(context, versionPath(f));
      assert.equal(String(actual.id), f.versionId);
      assert.equal(String(actual.projectId), f.projectId);
      assert.equal(actual.name, versionName(f));
      assert.equal(actual.released, false);
      assert.equal(actual.archived, false);
      f.linkSuffixes = [];
      return proof(6);
    },
  ),
  readCase("jira.version", versionPath, ["versionId", "name", "released", "archived"], {
    ...single,
    args: (f) => ({ versionId: f.versionId }),
    nativeNames: { versionId: "id" },
  }),
  readCase(
    "jira.version-related-issue-counts",
    (f) => `${versionPath(f)}/relatedIssueCounts`,
    ["issuesAffectedCount", "issuesFixedCount"],
    {
      ...single,
      args: (f) => ({ versionId: f.versionId }),
    },
  ),
  readCase(
    "jira.version-unresolved-issue-count",
    (f) => `${versionPath(f)}/unresolvedIssueCount`,
    ["issuesUnresolvedCount"],
    {
      ...single,
      args: (f) => ({ versionId: f.versionId }),
    },
  ),
  mutation(
    "jira.update-version",
    (f) => ({ versionId: f.versionId, description: "Synthetic AC7 release updated" }),
    async (context, _data, f) => {
      const actual = await read(context, versionPath(f));
      assert.equal(String(actual.id), f.versionId);
      assert.equal(actual.name, versionName(f));
      assert.equal(actual.description, "Synthetic AC7 release updated");
      return proof(3);
    },
  ),
  createLink("jira.upsert-version-remote-link", "a"),
  createLink("jira.upsert-version-remote-link-by-global-id", "b"),
  {
    tool: "jira.version-remote-links",
    arguments: (f) => ({ versionId: f.versionId, maxResults: 100 }),
    readback: linkReadback((f) => `${versionPath(f)}/remotelink`),
  },
  {
    tool: "jira.version-remote-link",
    arguments: (f) => ({ versionId: f.versionId, globalId: linkId(f, "a") }),
    readback: linkReadback((f) => `${versionPath(f)}/remotelink/${linkId(f, "a")}`),
  },
  {
    tool: "jira.remote-version-links",
    arguments: (f) => ({ globalId: linkId(f, "a"), maxResults: 100 }),
    readback: linkReadback((f) => `/rest/api/2/version/remotelink?globalId=${linkId(f, "a")}`),
  },
  mutation(
    "jira.delete-version-remote-link",
    (f) => ({ ...linkArguments(f), globalId: linkId(f, "a") }),
    async (context, _data, f) => {
      f.linkSuffixes = ["b"];
      await links(context, f);
      return proof(1);
    },
    linkContext,
  ),
  mutation(
    "jira.delete-version-remote-links",
    (f) => ({ ...linkArguments(f), confirmAll: true }),
    async (context, _data, f) => {
      f.linkSuffixes = [];
      await links(context, f);
      return proof(1);
    },
    linkContext,
  ),
].map((entry) => ({
  ...entry,
  actor: "admin",
  administration: true,
  destructiveAdministration: new Set([
    "jira.delete-component",
    "jira.delete-version-remote-link",
    "jira.delete-version-remote-links",
  ]).has(entry.tool),
}));
