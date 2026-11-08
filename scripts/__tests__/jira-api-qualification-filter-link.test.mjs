import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { API_QUALIFICATION_ALL_CASES } from "../testing/jira-chat-lab/api-qualification-case-list.mjs";
import {
  API_QUALIFICATION_FILTER_CASES,
  filterColumnReview,
  filterPermissionReview,
} from "../testing/jira-chat-lab/api-qualification-filter-cases.mjs";
import {
  API_QUALIFICATION_LINK_CASES,
  remoteLinkReview,
} from "../testing/jira-chat-lab/api-qualification-link-cases.mjs";
import {
  API_QUALIFICATION_INDEX_CASES,
  indexSummaryReview,
  issuePickerReview,
} from "../testing/jira-chat-lab/api-qualification-index-cases.mjs";
import {
  DEFAULT_LAB_CONNECTION,
  labSessionConnection,
} from "../testing/jira-chat-lab/lab-client.mjs";

const cases = [
  ...API_QUALIFICATION_FILTER_CASES,
  ...API_QUALIFICATION_LINK_CASES,
  ...API_QUALIFICATION_INDEX_CASES,
];
const specification = (tool) => cases.find((entry) => entry.tool === tool);
const directories = [];
const actor = { name: "keiko-admin", key: "synthetic-admin" };
const issue = (id, key, summary = "Synthetic AC7 source") => ({
  id,
  key,
  fields: { project: { id: "10000" }, issuetype: { id: "10001" }, summary, issuelinks: [] },
});
const source = issue("10100", "KEIKO-100");
const target = issue("10101", "KEIKO-101");
const linkType = {
  id: "10002",
  name: "Synthetic relates",
  inward: "related by",
  outward: "relates to",
};
const remoteValue = () =>
  Object.fromEntries(Object.entries(remoteLinkReview(remoteRow())).filter(([key]) => key !== "id"));
const fixture = () => ({
  runId: "synthetic-run",
  projectId: "10000",
  issueTypeId: "10001",
  issueKeys: ["KEIKO-1"],
  adminActorKey: actor.key,
  linkIssue: structuredClone(source),
  linkTarget: structuredClone(target),
  linkType,
  issueLinkId: "37",
  savedFilterId: "43",
  savedColumns: { columns: ["summary"], columnConfig: "FILTER" },
  savedColumnTarget: ["summary", "status"],
  savedPermissions: [],
  savedShareGroup: "synthetic-group",
  savedPermissionId: "47",
  remoteLinkId: "53",
  remoteDesired: remoteValue(),
  remoteBefore: remoteLinkReview(remoteRow()),
  reciprocalIssue: {
    id: source.id,
    key: source.key,
    summary: source.fields.summary,
    projectId: "10000",
    issueTypeId: "10001",
  },
  reciprocalTarget: { id: target.id, key: target.key },
  reciprocalApplication: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Synthetic peer",
    displayUrl: "https://127.0.0.1:18444",
    rpcUrl: "https://127.0.0.1:18444",
  },
});
function session(peer = false) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-filter-link-"));
  directories.push(directory);
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const value = {
    schemaVersion: 1,
    syntheticOnly: true,
    project: `keiko-jira-4081-${peer ? "peer" : "source"}`,
    ...DEFAULT_LAB_CONNECTION,
    ...(peer ? { httpPort: 18082, httpsPort: 18444 } : {}),
  };
  writeFileSync(join(directory, "session.json"), JSON.stringify(value), { mode: 0o600 });
  return { ...value, directory };
}
function native(handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const value = await handler(new URL(url));
    expect(value, `Unexpected native read ${new URL(url).pathname}`).not.toBeUndefined();
    return new globalThis.Response(JSON.stringify(value), { status: 200 });
  });
}
function remoteRow(title = "Synthetic AC7 primary", id = 53) {
  return {
    id,
    globalId: "keiko-ac7:synthetic-run:primary",
    relationship: "relates to",
    object: {
      url: "https://127.0.0.1:18443/browse/KEIKO-101",
      title,
      summary: "Synthetic relationship",
      status: { resolved: false },
    },
  };
}
function nativeRemote(value, id = 53) {
  return {
    id,
    globalId: value.globalId,
    relationship: value.relationship,
    object: {
      url: value.url,
      title: value.title,
      summary: value.summary,
      status: { resolved: value.resolved },
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("covers exactly the 18 assigned native identities without duplicating existing recipes", () => {
  const expected = [
    "DELETE /rest/api/2/filter/{id}/columns",
    "GET /rest/api/2/filter/{id}/columns",
    "PUT /rest/api/2/filter/{id}/columns",
    "GET /rest/api/2/filter/{id}/permission",
    "POST /rest/api/2/filter/{id}/permission",
    "DELETE /rest/api/2/filter/{id}/permission/{permission-id}",
    "GET /rest/api/2/filter/{id}/permission/{permissionId}",
    "POST /rest/api/2/index-snapshot",
    "GET /rest/api/2/index/summary",
    "GET /rest/api/2/issue/picker",
    "POST /rest/api/2/issue/remotelink/reciprocal",
    "DELETE /rest/api/2/issue/{issueIdOrKey}/remotelink",
    "POST /rest/api/2/issue/{issueIdOrKey}/remotelink",
    "DELETE /rest/api/2/issue/{issueIdOrKey}/remotelink/{linkId}",
    "GET /rest/api/2/issue/{issueIdOrKey}/remotelink/{linkId}",
    "PUT /rest/api/2/issue/{issueIdOrKey}/remotelink/{linkId}",
    "POST /rest/api/2/issueLink",
    "DELETE /rest/api/2/issueLink/{linkId}",
  ];
  const identities = cases.map((entry) => jiraOperationForTool(entry.tool).definition.identity);
  expect(identities.toSorted()).toEqual(expected.toSorted());
  const existing = new Set(
    API_QUALIFICATION_ALL_CASES.filter((entry) => !cases.includes(entry)).map(
      (entry) => jiraOperationForTool(entry.tool).definition.identity,
    ),
  );
  for (const identity of identities) expect(existing.has(identity), identity).toBe(false);
  expect(cases.some((entry) => entry.tool === "jira.issue-link")).toBe(false);
});

it.each(cases)("uses the actual $tool argument contract and effect classification", (entry) => {
  const operation = jiraOperationForTool(entry.tool);
  expect(
    describeCatalogSchemaMismatch(
      operation.declaration.descriptor.inputSchema,
      entry.arguments(fixture()),
    ),
  ).toBeUndefined();
  expect(operation.definition.effects.includes("remote-write")).toBe(entry.mutation === true);
  expect(typeof entry.readback).toBe("function");
});

it.each([false, true])(
  "qualifies the owned filter lifecycle with native layout provenance %s",
  async (legacy) => {
    const c = { actor: "admin", session: session() };
    const f = fixture();
    let columns = ["key", "summary", "assignee"];
    let configuration = "SYSTEM";
    let permissions = [];
    const filter = {
      id: "43",
      name: "",
      jql: "project = KEIKO ORDER BY Rank ASC",
      owner: { key: actor.key },
    };
    c.qualificationFixture = async (entry) => {
      expect(entry.tool).toBe("jira.create-filter");
      filter.name = entry.arguments.name;
      await expect(entry.readback(c, { filterId: filter.id })).resolves.toMatchObject({
        matched: true,
      });
    };
    native((url) => {
      const path = url.pathname;
      if (path.endsWith("/myself")) return actor;
      if (path.endsWith("/defaultShareScope")) return { scope: "private" };
      if (path.endsWith("/columns"))
        return legacy
          ? columns.map((value) => ({ value }))
          : { columnConfig: configuration, columnLayoutItems: columns.map((id) => ({ id })) };
      if (path.endsWith("/permission/47")) return permissions[0];
      if (path.endsWith("/permission")) return permissions;
      if (path.endsWith("/user")) return { groups: { items: [{ name: "synthetic-group" }] } };
      if (path.endsWith("/filter/43")) return filter;
      return undefined;
    });
    for (const entry of API_QUALIFICATION_FILTER_CASES) {
      await entry.prepare?.(c, f);
      const args = entry.arguments(f);
      let data = {};
      switch (entry.tool) {
        case "jira.filter-columns":
          data = { items: columns.map((value) => (legacy ? { value } : { id: value })) };
          break;
        case "jira.set-filter-columns":
          columns = args.columns;
          configuration = "FILTER";
          break;
        case "jira.reset-filter-columns":
          columns = ["key", "summary", "assignee"];
          configuration = "SYSTEM";
          break;
        case "jira.add-filter-permission":
          permissions = [
            {
              id: 47,
              type: "group",
              group: { name: args.permission.groupName },
              view: true,
              edit: false,
            },
          ];
          data = { permissionId: "47" };
          break;
        case "jira.filter-permissions":
        case "jira.filter-permission":
          data = { items: filterPermissionReview(permissions) };
          break;
        case "jira.delete-filter-permission":
          permissions = [];
          break;
        default:
          throw new TypeError("Unexpected filter recipe");
      }
      await expect(entry.readback(c, data, f), entry.tool).resolves.toMatchObject({
        matched: true,
      });
    }
    expect(columns).toEqual(["key", "summary", "assignee"]);
    expect(permissions).toEqual([]);
  },
);

it("refuses unchanged reset layouts and altered filter share recipients or rights", async () => {
  const c = { actor: "admin", session: session() };
  const f = {
    ...fixture(),
    savedInheritedColumns: ["key"],
    savedColumns: { columns: ["summary"], columnConfig: "FILTER" },
  };
  native((url) => {
    if (url.pathname.endsWith("/myself")) return actor;
    if (url.pathname.endsWith("/filter/43")) return { id: "43", owner: { key: actor.key } };
    if (url.pathname.endsWith("/columns")) return [{ value: "summary" }];
    return { id: 47, type: "group", group: { name: "foreign-group" }, view: true, edit: true };
  });
  await expect(specification("jira.reset-filter-columns").readback(c, {}, f)).rejects.toThrow();
  await expect(
    specification("jira.filter-permission").readback(
      c,
      {
        items: [{ id: "47", type: "group", groupName: "synthetic-group", view: true, edit: false }],
      },
      f,
    ),
  ).rejects.toThrow();
});

it("preserves legacy column order and published icon fields in complete native snapshots", () => {
  expect(
    filterColumnReview([{ value: "summary" }, { value: "summary" }, { value: "key" }]).columns,
  ).toEqual(["summary", "summary", "key"]);
  const row = remoteRow();
  row.object.icon = { url16x16: "https://127.0.0.1:18443/icon", title: "Synthetic icon" };
  row.object.status.icon = {
    url16x16: "https://127.0.0.1:18443/status",
    title: "Open",
    link: "https://127.0.0.1:18443/state",
  };
  expect(remoteLinkReview(row)).toMatchObject({
    iconUrl: row.object.icon.url16x16,
    statusIconUrl: row.object.status.icon.url16x16,
  });
});

function applyLinkEffect(tool, args, f, issues, links) {
  switch (tool) {
    case "jira.create-issue-link":
      issues.get(f.linkIssue.key).fields.issuelinks = [
        { id: 37, type: linkType, outwardIssue: { key: f.linkTarget.key } },
      ];
      issues.get(f.linkTarget.key).fields.issuelinks = [
        { id: 37, type: linkType, inwardIssue: { key: f.linkIssue.key } },
      ];
      return {};
    case "jira.delete-issue-link":
      for (const row of issues.values()) row.fields.issuelinks = [];
      return {};
    case "jira.upsert-remote-link":
    case "jira.update-remote-link":
      links.splice(0, links.length, nativeRemote(args.value));
      return {};
    case "jira.remote-link":
      return { reviewSnapshotAvailable: true, reviewSnapshot: remoteLinkReview(links[0]) };
    case "jira.delete-remote-link":
    case "jira.delete-remote-link-by-global-id":
      links.splice(0);
      return {};
    default:
      throw new TypeError("Unexpected link recipe");
  }
}
it("qualifies both core issue-link effects and all five ordinary remote-link operations", async () => {
  const c = { actor: "admin", session: session() };
  const f = fixture();
  const issues = new Map();
  let links = [];
  let nextIssue = 100;
  const auxiliaries = [];
  c.qualificationFixture = async (entry) => {
    auxiliaries.push(entry.tool);
    if (entry.tool === "jira.create") {
      const key = `KEIKO-${nextIssue}`;
      issues.set(key, issue(String(10000 + nextIssue++), key, entry.arguments.fields.summary));
      await entry.readback(c, { issueKey: key });
    } else {
      expect(entry.tool).toBe("jira.upsert-remote-link");
      links = [nativeRemote(entry.arguments.value)];
      await entry.readback(c, {});
    }
  };
  native((url) => {
    const path = url.pathname;
    if (path.endsWith("/myself")) return actor;
    if (path.endsWith("/issueLinkType")) return { issueLinkTypes: [linkType] };
    if (path.endsWith("/issueLink/37")) return { id: 37 };
    if (path.endsWith("/remotelink/53")) return links[0];
    if (path.endsWith("/remotelink")) return links;
    return issues.get(path.split("/").at(-1));
  });
  for (const entry of API_QUALIFICATION_LINK_CASES.filter(
    (row) => row.tool !== "jira.create-reciprocal-remote-link",
  )) {
    await entry.prepare?.(c, f);
    const args = entry.arguments(f);
    const data = applyLinkEffect(entry.tool, args, f, issues, links);
    await expect(entry.readback(c, data, f), entry.tool).resolves.toMatchObject({ matched: true });
  }
  expect(auxiliaries).toEqual(["jira.create", "jira.create", "jira.upsert-remote-link"]);
});

it("rejects a retained remote link and a mismatched native review snapshot", async () => {
  const c = { actor: "admin", session: session() };
  const f = fixture();
  native((url) =>
    url.pathname.endsWith("/remotelink")
      ? [remoteRow()]
      : url.pathname.endsWith("/remotelink/53")
        ? remoteRow()
        : source,
  );
  await expect(specification("jira.delete-remote-link").readback(c, {}, f)).rejects.toThrow();
  await expect(
    specification("jira.remote-link").readback(
      c,
      {
        reviewSnapshotAvailable: true,
        reviewSnapshot: { ...remoteLinkReview(remoteRow()), title: "Wrong title" },
      },
      f,
    ),
  ).rejects.toThrow();
});

it("requires a new native snapshot artifact and rejects a vacuous index summary", async () => {
  const c = { actor: "admin", session: session() };
  const f = fixture();
  const before = { absolutePath: "/synthetic/index.zip", timestamp: 1 };
  let completed = false;
  native((url) => {
    if (url.pathname.endsWith("/myself")) return actor;
    if (url.pathname.endsWith("/isRunning")) return { running: false };
    if (url.pathname.endsWith("/index-snapshot"))
      return [{ ...before, timestamp: completed ? 2 : 1 }];
    return {
      issueIndex: { indexReadable: true, countInDatabase: 7, countInIndex: 7 },
      reportTime: "volatile",
    };
  });
  const snapshot = specification("jira.create-index-snapshot");
  await snapshot.prepare(c, f);
  completed = true;
  await expect(
    snapshot.readback(c, { outcome: "succeeded-unconfirmed" }, f),
  ).resolves.toMatchObject({ matched: true });
  const summary = specification("jira.index-summary");
  await expect(
    summary.readback(
      c,
      { issueIndex: { indexReadable: true, countInDatabase: 7, countInIndex: 7 } },
      f,
    ),
  ).resolves.toMatchObject({ matched: true });
  await expect(
    summary.readback(
      c,
      { issueIndex: { indexReadable: true, countInDatabase: 6, countInIndex: 7 } },
      f,
    ),
  ).rejects.toThrow();
  expect(() => indexSummaryReview({})).toThrow();
});

it("does not mistake idle snapshot status for a completed artifact", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const c = { actor: "admin", session: session() };
  const row = { absolutePath: "/synthetic/index.zip", timestamp: 1 };
  native(() => [row]);
  const attempt = specification("jira.create-index-snapshot").readback(
    c,
    {},
    { indexSnapshotsBefore: [row] },
  );
  const rejected = expect(attempt).rejects.toThrow("new snapshot artifact");
  await vi.runAllTimersAsync();
  await rejected;
});

it("compares concrete issue-picker suggestions and refuses a missing selected issue", async () => {
  const c = { actor: "api", session: session() };
  const f = fixture();
  let value = {
    sections: [
      {
        id: "current",
        label: "Synthetic suggestions",
        issues: [
          { key: "KEIKO-1", summaryText: "Synthetic AC7 picker", summary: "<b>untrusted HTML</b>" },
        ],
      },
    ],
  };
  native(() => value);
  const data = {
    suggestionsScope: "native-suggestions",
    sections: issuePickerReview(value, labSessionConnection(c.session).httpsOrigin),
  };
  await expect(specification("jira.issue-picker").readback(c, data, f)).resolves.toMatchObject({
    matched: true,
  });
  value = { sections: [{ issues: [] }] };
  await expect(specification("jira.issue-picker").readback(c, { sections: [] }, f)).rejects.toThrow(
    "selected owned issue",
  );
});

function configuredPeer(manifest, session, wrongDestination) {
  const origin = labSessionConnection(session).httpsOrigin;
  return {
    list: [
      {
        appLinkState: "OK",
        hasIncomingAuthenticationProviders: true,
        hasOutgoingAuthenticationProviders: true,
        application: {
          ...manifest,
          displayUrl: origin,
          rpcUrl: wrongDestination ? "https://foreign.invalid" : origin,
        },
      },
    ],
  };
}
function reciprocalLinks(side, state, missingBacklink) {
  if (!state.linked || missingBacklink) return [];
  const object = { url: `${side.origin}/browse/${side.issue.id}`, title: side.issue.key };
  if (side.backlink) object.summary = state.created.fields.summary;
  return [
    {
      id: side.id,
      globalId: `appId=${side.manifest.id}&issueId=${side.issue.id}`,
      application: { type: "com.atlassian.jira", name: side.manifest.name },
      relationship: side.relationship,
      object,
    },
  ];
}
function reciprocalFixture({ wrongDestination = false, missingBacklink = false } = {}) {
  const c = { actor: "admin", session: session() };
  const peer = session(true);
  c.qualificationReciprocalPeer = { session: peer, issueKey: target.key };
  const localManifest = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Synthetic source",
    typeId: "jira",
  };
  const peerManifest = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Synthetic peer",
    typeId: "jira",
  };
  const state = { created: undefined, linked: false };
  const sides = new Map([
    [
      c.session.httpPort,
      {
        manifest: peerManifest,
        ownManifest: localManifest,
        origin: labSessionConnection(peer).httpsOrigin,
        issue: target,
        id: 61,
        relationship: "relates to",
        backlink: false,
        peerSession: peer,
      },
    ],
    [
      peer.httpPort,
      {
        manifest: localManifest,
        ownManifest: peerManifest,
        origin: labSessionConnection(c.session).httpsOrigin,
        issue: source,
        id: 62,
        relationship: "related by",
        backlink: true,
        peerSession: c.session,
      },
    ],
  ]);
  c.qualificationFixture = async (entry) => {
    expect(entry.tool).toBe("jira.create");
    state.created = issue(source.id, source.key, entry.arguments.fields.summary);
    await entry.readback(c, { issueKey: source.key });
  };
  native((url) => {
    const side = sides.get(Number(url.port));
    const path = url.pathname;
    if (path.endsWith("/myself")) return actor;
    if (path.endsWith("/serverInfo"))
      return {
        version: DEFAULT_LAB_CONNECTION.jiraVersion,
        versionNumbers: [10, 3, 26],
        deploymentType: "Data Center",
      };
    if (path.endsWith("/manifest")) return side.ownManifest;
    if (path.endsWith("/listApplicationlinks")) {
      return configuredPeer(side.manifest, side.peerSession, wrongDestination);
    }
    if (path.endsWith("/project/KEIKO")) return { id: "10000" };
    if (path.includes("/remotelink")) {
      const rows = reciprocalLinks(side, state, side.backlink && missingBacklink);
      return /\/remotelink\/[0-9]+$/u.test(path) ? rows[0] : rows;
    }
    return side.backlink ? target : state.created;
  });
  return {
    c,
    f: fixture(),
    link: () => {
      state.linked = true;
    },
  };
}

it("fails closed without an explicitly supplied owned reciprocal peer", async () => {
  await expect(
    specification("jira.create-reciprocal-remote-link").prepare(
      { actor: "admin", session: session() },
      fixture(),
    ),
  ).rejects.toThrow("operator-supplied owned peer session");
});

it("binds mutual configured app links and independently confirms both reciprocal effects", async () => {
  const { c, f, link } = reciprocalFixture();
  const entry = specification("jira.create-reciprocal-remote-link");
  await entry.prepare(c, f);
  expect(entry.arguments(f)).toMatchObject({
    remoteIssueId: target.id,
    expectedApplication: { id: "22222222-2222-4222-8222-222222222222" },
  });
  link();
  await expect(entry.readback(c, { outcome: "succeeded-unconfirmed" }, f)).resolves.toMatchObject({
    matched: true,
  });
});

it("refuses foreign configured destinations before creating a local reciprocal fixture", async () => {
  const { c, f } = reciprocalFixture({ wrongDestination: true });
  const fixtureCall = vi.spyOn(c, "qualificationFixture");
  await expect(specification("jira.create-reciprocal-remote-link").prepare(c, f)).rejects.toThrow();
  expect(fixtureCall).not.toHaveBeenCalled();
});

it("refuses reciprocal success when only the local effect exists", async () => {
  const { c, f, link } = reciprocalFixture({ missingBacklink: true });
  const entry = specification("jira.create-reciprocal-remote-link");
  await entry.prepare(c, f);
  link();
  await expect(entry.readback(c, { outcome: "succeeded-unconfirmed" }, f)).rejects.toThrow(
    "independent matching links on both",
  );
});
