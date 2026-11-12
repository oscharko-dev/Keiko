import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = new Map();
const deletions = [];
const failing = new Set();
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
    const status = failing.has(path) ? 500 : method === "GET" ? 200 : 204;
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
  let filters;
  beforeEach(() => {
    reads.clear();
    deletions.length = 0;
    failing.clear();
    filters = [{ id: 10, name: "Auswahl Favorit" }];
    reads.set("/rest/api/2/filter/my", () => filters);
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
    filters = [...filters, { id: 11, name: "Extra" }];
    deletions.length = 0;
    // The removal of the extra filter takes effect in the native collection.
    reads.set("/rest/api/2/filter/my", () => {
      return deletions.includes("/rest/api/2/filter/11") ? [filters[0]] : filters;
    });
    await recoverScope({}, run, entry, turnFor, before);
    expect(deletions).toContain("/rest/api/2/filter/11");
  });

  it("throws, so the run stops with its marker, when the scope stays unclean", async () => {
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    filters = [...filters, { id: 11, name: "Extra" }];
    failing.add("/rest/api/2/filter/11");
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      /Native cleanup failed|not clean/u,
    );
  });

  it("throws when a baseline object changed, although nothing is left to remove", async () => {
    filters = [...filters, { id: 11, name: "Existing" }];
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    // The failed settlement renamed an existing filter: no removal can undo it.
    filters = [filters[0], { id: 11, name: "Renamed by the turn" }];
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      "not clean after recovery",
    );
    expect(deletions).toEqual([]);
  });

  it("throws when the scope still holds an extra object after a removal that reported success", async () => {
    const before = await scopeSnapshot({}, fixture, fixture.selection);
    filters = [...filters, { id: 11, name: "Extra" }];
    await expect(recoverScope({}, run, entry, turnFor, before)).rejects.toThrow(
      "not clean after recovery",
    );
  });
});
