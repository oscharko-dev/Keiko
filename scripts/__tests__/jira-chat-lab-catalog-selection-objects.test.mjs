import { beforeEach, describe, expect, it, vi } from "vitest";

const requests = [];
const statuses = new Map();
const reads = new Map();
const creations = new Map();
vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  actorDetails: (actor) => ({ name: `keiko-${actor}` }),
  basicAuth: (_session, actor) => `auth:${actor}`,
  checked: vi.fn(async (_session, _name, method, path, _auth, body) => {
    if (method !== "GET") {
      requests.push({ method, path, body });
      return creations.get(path) ?? {};
    }
    const key = [...reads.keys()].find((prefix) => path.startsWith(prefix));
    return structuredClone(reads.get(key) ?? {});
  }),
  labRequest: vi.fn(async (_session, method, path, auth) => {
    requests.push({ method, path, auth });
    return { status: statuses.get(path) ?? (method === "GET" ? 200 : 204), value: { name: path } };
  }),
}));

const {
  createSelectionObjects,
  orphanedIssues,
  removeNative,
  scopeSnapshot,
  selectionNames,
  strayWrites,
} = await import("../testing/jira-chat-lab/catalog-selection-objects.mjs");

describe("removeNative", () => {
  beforeEach(() => {
    requests.length = 0;
    statuses.clear();
  });

  it("removes a path as the given actor and a voter's entry as its own actor", async () => {
    await removeNative({}, [
      "/rest/api/2/issue/K-1/worklog/9",
      {
        key: "/rest/api/2/issue/K-1/votes@keiko-api",
        path: "/rest/api/2/issue/K-1/votes",
        actor: "api",
      },
    ]);
    expect(requests).toEqual([
      { method: "DELETE", path: "/rest/api/2/issue/K-1/worklog/9", auth: "auth:admin" },
      { method: "DELETE", path: "/rest/api/2/issue/K-1/votes", auth: "auth:api" },
    ]);
  });

  it("removes a version through removeAndSwap, which Jira 10 offers instead of DELETE", async () => {
    statuses.set("/rest/api/2/version/7/removeAndSwap", 204);
    await removeNative({}, ["/rest/api/2/version/7"]);
    expect(requests).toEqual([
      { method: "POST", path: "/rest/api/2/version/7/removeAndSwap", auth: "auth:admin" },
    ]);
  });

  it("accepts an already absent object and attempts every entry before it fails", async () => {
    statuses.set("/rest/api/2/component/1", 404);
    statuses.set("/rest/api/2/issue/K-1/comment/3", 403);
    await expect(
      removeNative({}, [
        "/rest/api/2/component/1",
        "/rest/api/2/issue/K-1/comment/3",
        "/rest/api/2/issue/K-1/worklog/9",
      ]),
    ).rejects.toThrow(/^Native cleanup failed for 1 paths \(403 \S*comment/u);
    expect(requests).toHaveLength(3);
  });
});

describe("scopeSnapshot", () => {
  const created = {
    issueKey: "K-1",
    linkTargetKey: "K-2",
    boardId: "7",
    sprintId: "8",
    sharedFilterId: "9",
    favouriteFilterId: "10",
  };
  const issue = (key) => `/rest/api/2/issue/${key}`;
  beforeEach(() => {
    reads.clear();
    requests.length = 0;
    statuses.clear();
    reads.set("/rest/api/2/project/KEIKO/components", []);
    reads.set("/rest/api/2/project/KEIKO/versions", []);
    reads.set("/rest/api/2/search", { total: 2, issues: [{ key: "K-1" }, { key: "K-2" }] });
    for (const key of ["K-1", "K-2"]) {
      reads.set(`${issue(key)}/remotelink`, []);
      reads.set(`${issue(key)}/worklog`, { worklogs: [] });
      reads.set(`${issue(key)}/properties`, { keys: [] });
      reads.set(`${issue(key)}/votes`, { voters: [] });
      reads.set(`${issue(key)}/watchers`, { watchers: [] });
      reads.set(`${issue(key)}/comment`, { comments: [] });
      reads.set(`${issue(key)}?`, { fields: { summary: key, updated: "t1" } });
    }
  });

  it("reads both owned issues, keeps comments removable and skips the actor's autowatch", async () => {
    reads.set(`${issue("K-2")}/comment`, { comments: [{ id: "5", body: "x" }] });
    reads.set(`${issue("K-1")}/watchers`, {
      watchers: [{ name: "keiko-api" }, { name: "keiko-assignee" }],
    });
    const snapshot = await scopeSnapshot({}, { project: "KEIKO" }, created);
    expect(snapshot.objects.get(`${issue("K-2")}/comment/5`)).toMatchObject({ owned: true });
    expect(snapshot.objects.has(`${issue("K-1")}/watchers?username=keiko-api`)).toBe(false);
    expect(snapshot.objects.has(`${issue("K-1")}/watchers?username=keiko-assignee`)).toBe(true);
    expect(snapshot.objects.has("/rest/agile/1.0/board/7")).toBe(true);
    // The favourite filter is private to the api actor, so it is read as that actor.
    expect(requests).toContainEqual({
      method: "GET",
      path: "/rest/api/2/filter/10",
      auth: "auth:api",
    });
  });

  it("ignores the update stamp of an owned issue and refuses a project beyond its bound", async () => {
    const before = await scopeSnapshot({}, { project: "KEIKO" }, created);
    reads.set(`${issue("K-1")}?`, { fields: { summary: "K-1", updated: "t2" } });
    const after = await scopeSnapshot({}, { project: "KEIKO" }, created);
    expect(after.issueState).toBe(before.issueState);
    reads.set("/rest/api/2/search", { total: 101, issues: [{ key: "K-1" }] });
    await expect(scopeSnapshot({}, { project: "KEIKO" }, created)).rejects.toThrow(
      "exceeds the scope snapshot bound",
    );
  });
});

describe("scopeSnapshot content", () => {
  const created = {
    issueKey: "K-1",
    linkTargetKey: "K-2",
    boardId: "7",
    sprintId: "8",
    sharedFilterId: "9",
    favouriteFilterId: "10",
  };
  const issue = (key) => `/rest/api/2/issue/${key}`;
  beforeEach(() => {
    reads.clear();
    requests.length = 0;
    statuses.clear();
    reads.set("/rest/api/2/project/KEIKO/", []);
    reads.set("/rest/api/2/search", { total: 2, issues: [{ key: "K-1" }, { key: "K-2" }] });
    for (const key of ["K-1", "K-2"]) {
      reads.set(`${issue(key)}/worklog`, { worklogs: [] });
      reads.set(`${issue(key)}/properties`, { keys: [] });
      reads.set(`${issue(key)}/votes`, { voters: [] });
      reads.set(`${issue(key)}/watchers`, { watchers: [] });
      reads.set(`${issue(key)}/remotelink`, []);
      reads.set(`${issue(key)}?`, { fields: {} });
    }
    reads.set(`${issue("K-1")}/comment`, { comments: [{ id: "5", body: "first" }] });
    reads.set(`${issue("K-2")}/comment`, { comments: [] });
  });

  it("sees an edited comment and a removed agile object as stray writes", async () => {
    const before = await scopeSnapshot({}, { project: "KEIKO" }, created);
    reads.set(`${issue("K-1")}/comment`, { comments: [{ id: "5", body: "edited" }] });
    statuses.set("/rest/agile/1.0/sprint/8", 404);
    const after = await scopeSnapshot({}, { project: "KEIKO" }, created);
    expect(strayWrites(before, after, [], "Auswahl t")).toMatchObject({ changed: 1, removed: 1 });
  });

  it("fails closed when the search answer carries no total", async () => {
    reads.set("/rest/api/2/search", { issues: [{ key: "K-1" }] });
    await expect(scopeSnapshot({}, { project: "KEIKO" }, created)).rejects.toThrow("bound");
  });

  it("counts issues of an earlier run as orphans, never the current run's own", () => {
    const names = selectionNames({}, "now");
    const row = (label) => ({ owned: false, label });
    const snapshot = {
      objects: new Map([
        ["a", row(names.issueSummary)],
        ["b", row(names.linkTargetSummary)],
        ["c", row("Auswahl Vorgang old")],
        ["d", row("Customer issue")],
      ]),
    };
    expect(orphanedIssues(snapshot, names)).toBe(1);
  });
});

describe("createSelectionObjects", () => {
  beforeEach(() => {
    requests.length = 0;
    statuses.clear();
    creations.clear();
    creations.set("/rest/api/2/issue", { key: "KEIKO-1" });
    creations.set("/rest/api/2/component", { id: 1 });
    creations.set("/rest/api/2/version", { id: 2 });
    creations.set("/rest/api/2/filter", { id: 9 });
    creations.set("/rest/agile/1.0/board", { id: 7 });
    creations.set("/rest/agile/1.0/sprint", { id: 8 });
    creations.set("/rest/api/2/issue/KEIKO-1/remotelink", { id: 3 });
    reads.clear();
    reads.set("/rest/api/2/project/KEIKO", { id: "10000" });
  });
  const fixture = { project: "KEIKO", issueTypeId: "10001" };

  it("shares the board filter with the project after creating it", async () => {
    const created = selectionNames(fixture, "t");
    await createSelectionObjects({}, fixture, "t", created);
    const share = requests.findIndex((entry) => entry.path === "/rest/api/2/filter/9/permission");
    expect(requests[share]).toMatchObject({
      method: "POST",
      body: { type: "project", projectId: "10000" },
    });
    const board = requests.findIndex((entry) => entry.path === "/rest/agile/1.0/board");
    expect(share).toBeLessThan(board);
    expect(created).toMatchObject({ sharedFilterId: "9", boardId: "7", sprintId: "8" });
  });

  it("refuses an invisible board after recording every id it created", async () => {
    statuses.set("/rest/agile/1.0/board/7", 404);
    const created = selectionNames(fixture, "t");
    await expect(createSelectionObjects({}, fixture, "t", created)).rejects.toThrow(
      "not visible to the api actor",
    );
    expect(created).toMatchObject({ sharedFilterId: "9", boardId: "7" });
    expect(created.sprintId).toBeUndefined();
    const reads = requests.filter((entry) => entry.path === "/rest/agile/1.0/board/7");
    expect(reads).toHaveLength(3);
  });

  it("refuses an invisible sprint after recording its id", async () => {
    statuses.set("/rest/agile/1.0/sprint/8", 403);
    const created = selectionNames(fixture, "t");
    await expect(createSelectionObjects({}, fixture, "t", created)).rejects.toThrow(
      "not visible to the api actor",
    );
    expect(created).toMatchObject({ boardId: "7", sprintId: "8" });
    const reads = requests.filter((entry) => entry.path === "/rest/agile/1.0/sprint/8");
    expect(reads).toHaveLength(3);
  });
});
