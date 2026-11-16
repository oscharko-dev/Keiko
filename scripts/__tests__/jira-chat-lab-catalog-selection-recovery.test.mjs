import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = new Map();
const deletions = [];
const failing = new Set();
// Paths whose removal reports success without taking effect.
const stuck = new Set();
// The filters the api actor can read by identity. Jira answers 400 for any other identity.
let filters = [];
const FIXTURE_NAMES = { 9: "Gemeinsam" };
const FIXTURE_FILTER_IDS = new Set(["9", "10"]);
const api = { name: "keiko-api" };
// What Jira answers for one filter identity: a removal takes effect unless it is stuck, and an
// identity the api actor cannot read answers 400.
function filterAnswer(method, path, id) {
  const row = filters.find((entry) => String(entry.id) === id);
  if (method === "DELETE") {
    if (!stuck.has(path)) filters = filters.filter((entry) => entry !== row);
    return { status: 204, value: undefined };
  }
  if (row !== undefined) return { status: 200, value: row };
  return FIXTURE_FILTER_IDS.has(id)
    ? { status: 200, value: { id, name: FIXTURE_NAMES[id] ?? "Auswahl Favorit" } }
    : { status: 400, value: {} };
}

vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  actorDetails: (actor) => ({ name: `keiko-${actor}` }),
  basicAuth: (_session, actor) => `auth:${actor}`,
  checked: vi.fn(async (_session, _name, _method, path) => {
    const key = [...reads.keys()]
      .filter((prefix) => path.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    const value = reads.get(key);
    return structuredClone(typeof value === "function" ? value() : (value ?? {}));
  }),
  labRequest: vi.fn(async (_session, method, path) => {
    if (method === "DELETE") deletions.push(path);
    const filter = /^\/rest\/api\/2\/filter\/(\d+)$/u.exec(path);
    const refused = method === "DELETE" && failing.has(path);
    if (filter !== null && !refused) return filterAnswer(method, path, filter[1]);
    const status = refused ? 500 : method === "GET" ? 200 : 204;
    return { status, value: { name: path } };
  }),
}));
vi.mock("../testing/jira-chat-lab/chat-read.mjs", () => ({}));
vi.mock("../testing/jira-chat-lab/chat-write.mjs", () => ({}));

const { recoverScope } = await import("../testing/jira-chat-lab/catalog-selection.mjs");
const { scopeSnapshot } = await import("../testing/jira-chat-lab/catalog-selection-objects.mjs");

const fixture = {
  project: "KEIKO",
  selection: {
    issueKey: "K-1",
    linkTargetKey: "K-2",
    boardId: "7",
    sprintId: "8",
    sharedFilterId: "9",
    favouriteFilterId: "10",
  },
};
const run = { tag: "t" };
const entry = { id: "worklog", verify: async () => ({ effects: 0, cleanup: [] }) };
const turnFor = { fixture, marker: "Auswahl t-1", tag: "t-1" };

describe("recoverScope", () => {
  beforeEach(() => {
    reads.clear();
    deletions.length = 0;
    failing.clear();
    stuck.clear();
    filters = [{ id: 10, name: "Auswahl Favorit", owner: api }];
    reads.set("/rest/api/2/filter/favourite", []);
    reads.set("/rest/api/2/jql/autocompletedata/suggestions", () => ({
      results: [...filters.map((entry) => entry.name), ...Object.values(FIXTURE_NAMES)]
        .filter((name, index, all) => all.indexOf(name) === index)
        .map((name) => ({ value: JSON.stringify(name) })),
    }));
    reads.set("/rest/api/2/project/KEIKO/", []);
    reads.set("/rest/api/2/search", { total: 2, issues: [{ key: "K-1" }, { key: "K-2" }] });
    for (const key of ["K-1", "K-2"]) {
      const path = `/rest/api/2/issue/${key}`;
      reads.set(`${path}/worklog`, { worklogs: [] });
      reads.set(`${path}/properties`, { keys: [] });
      reads.set(`${path}/votes`, { voters: [] });
      reads.set(`${path}/watchers`, { watchers: [] });
      reads.set(`${path}/remotelink`, []);
      reads.set(`${path}/comment`, { comments: [] });
      reads.set(`${path}?`, { fields: {} });
    }
  });

  it("removes an extra object of the run beyond the case's own effect", async () => {
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    filters = [...filters, { id: 11, name: "Extra", owner: api }];
    deletions.length = 0;
    await recoverScope({}, run, entry, turnFor, before);
    expect(deletions).toContain("/rest/api/2/filter/11");
  });

  it("throws, so the run stops with its marker, when the scope stays unclean", async () => {
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    filters = [...filters, { id: 11, name: "Extra", owner: api }];
    failing.add("/rest/api/2/filter/11");
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      /Native cleanup failed|not clean/u,
    );
  });

  it("throws when a baseline object changed, although nothing is left to remove", async () => {
    filters = [...filters, { id: 11, name: "Existing", owner: api }];
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    // The failed settlement renamed an existing filter: no removal can undo it.
    filters = [filters[0], { id: 11, name: "Renamed by the turn", owner: api }];
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      "not clean after recovery",
    );
    expect(deletions).toEqual([]);
  });

  it("throws on a foreign object it may not remove, without deleting anything", async () => {
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    // Another writer added a component without the run marker: recovery must stop, not remove it.
    reads.set("/rest/api/2/project/KEIKO/components", [{ id: 5, name: "Other team" }]);
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      "not clean after recovery",
    );
    expect(deletions).toEqual([]);
  });

  it("throws when the scope still holds an extra object after a removal that reported success", async () => {
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    filters = [...filters, { id: 11, name: "Extra", owner: api }];
    stuck.add("/rest/api/2/filter/11");
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      "not clean after recovery",
    );
  });
});
