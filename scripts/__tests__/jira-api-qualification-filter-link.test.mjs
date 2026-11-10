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
});
function session() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-filter-link-"));
  directories.push(directory);
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  writeFileSync(join(directory, "secrets/api-user-password"), "synthetic-api", { mode: 0o600 });
  const value = {
    schemaVersion: 1,
    syntheticOnly: true,
    project: "keiko-jira-4081-source",
    ...DEFAULT_LAB_CONNECTION,
  };
  writeFileSync(join(directory, "session.json"), JSON.stringify(value), { mode: 0o600 });
  return { ...value, directory };
}
function native(handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const seed = options.method === "PUT" && new URL(url).pathname.endsWith("/columns");
    // The recipe's only native write is the explicit layout seed on its own synthetic filter.
    if (!seed) expect(options.method).toBe("GET");
    else expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const value = await handler(new URL(url), options);
    expect(value, `Unexpected native read ${new URL(url).pathname}`).not.toBeUndefined();
    // Jira answers a bare 404 for a filter without its own column layout.
    if (value.bareNotFound) return new globalThis.Response("{}", { status: 404 });
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

it("covers exactly the 17 assigned native identities without duplicating existing recipes", () => {
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

/** The native column layout of one synthetic filter: system default, or an explicit own layout. */
function filterLayout() {
  const state = { columns: ["key", "summary", "assignee"], explicit: false };
  return {
    get columns() {
      return state.columns;
    },
    set(columns) {
      state.columns = columns;
      state.explicit = true;
    },
    reset() {
      state.columns = ["key", "summary", "assignee"];
      state.explicit = false;
    },
    handle(options, legacy) {
      if (options.method === "PUT") {
        // The recipe's explicit layout seed is form-encoded, as Jira reads it.
        this.set(options.body.split("&").map((pair) => decodeURIComponent(pair.split("=")[1])));
        return {};
      }
      if (!state.explicit) return { bareNotFound: true };
      return legacy
        ? state.columns.map((value) => ({ value }))
        : {
            columnConfig: "FILTER",
            columnLayoutItems: state.columns.map((id) => ({ id })),
          };
    },
  };
}
it.each([false, true])(
  "qualifies the owned filter lifecycle with native layout provenance %s",
  async (legacy) => {
    const c = { actor: "admin", session: session() };
    const f = fixture();
    const layout = filterLayout();
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
    native((url, options) => {
      const path = url.pathname;
      if (path.endsWith("/myself")) return actor;
      if (path.endsWith("/defaultShareScope")) return { scope: "private" };
      if (path.endsWith("/columns")) return layout.handle(options, legacy);
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
          data = { items: layout.columns.map((value) => (legacy ? { value } : { id: value })) };
          break;
        case "jira.set-filter-columns":
          layout.set(args.columns);
          break;
        case "jira.reset-filter-columns":
          layout.reset();
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
      const result = await entry.readback(c, data, f);
      expect(result, entry.tool).toMatchObject({ matched: true });
      // Only the reset removes a layout, which its recipe read natively before the DELETE.
      expect(result.priorPresence === true, entry.tool).toBe(
        entry.tool === "jira.reset-filter-columns",
      );
    }
    expect(layout.columns).toEqual(["key", "summary", "assignee"]);
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
  for (const entry of API_QUALIFICATION_LINK_CASES) {
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
