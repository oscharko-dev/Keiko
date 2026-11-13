// The selection lane talks to a real Jira Data Center through native REST. Its first merged
// revision read `GET /rest/api/2/filter/my`, a Jira Cloud path that Data Center 10.3.26 answers with
// 404, so the lane stopped before its first turn (#4352). The ordinary unit tests mock `checked`
// by path prefix and accept any path, so they could not see that. This suite answers every request
// from a Data Center double that only knows the operations of the pinned inventory
// (docs/local-knowledge/jira-api-coverage/operations.json) and answers the rest with a 404, as the
// laboratory Jira does.
import { readFileSync } from "node:fs";
import { URL, URLSearchParams } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const inventory = JSON.parse(
  readFileSync(
    new URL("../../docs/local-knowledge/jira-api-coverage/operations.json", import.meta.url),
    "utf8",
  ),
);
// A path parameter that names a numeric identity (`{id}`, `{boardId}`, `{permission-id}`) takes
// digits only. Treating it as any segment would let `/filter/my` pass for `/filter/{id}`, which is
// exactly the mistake this suite exists to catch. Keys and `...IdOrKey` parameters take any segment.
const numericParameter = (name) => /^(?:id|[A-Za-z-]*[Ii]d)$/u.test(name);
const templates = inventory.operations.map((operation) => ({
  method: operation.method,
  regex: new RegExp(
    `^${operation.path.replaceAll(/\{([^}]+)\}/gu, (_match, name) => (numericParameter(name) ? "\\d+" : "[^/]+"))}$`,
    "u",
  ),
}));
const inInventory = (method, path) =>
  templates.some((entry) => entry.method === method && entry.regex.test(path));

// Endpoints the laboratory Jira answers although the pinned inventory does not list them. Each one
// was observed live on 10.3.26 (2026-11-13) before it was admitted here.
const LIVE_VERIFIED_OUTSIDE_INVENTORY = new Set([
  // Jira 10 has no DELETE for a version; the lane's cleanup removes one through removeAndSwap.
  "POST /rest/api/2/version/{id}/removeAndSwap",
]);

const FILTER_SUGGESTION_CAP = 15;
const jira = { requests: [], filters: new Map(), nextFilterId: 100, nextResource: 0 };

const actorOf = (auth) => auth.replace("auth:", "");
const visibleTo = (filter, actor) => filter.owner === actor || filter.shared === true;
const filterRow = (filter) => ({
  id: String(filter.id),
  name: filter.name,
  jql: filter.jql,
  favourite: filter.favourite,
  owner: { name: `keiko-${filter.owner}` },
});

const createFilter = (actor, body) => {
  const filter = {
    id: jira.nextFilterId++,
    name: body.name,
    jql: body.jql,
    favourite: body.favourite === true,
    owner: actor,
  };
  jira.filters.set(String(filter.id), filter);
  return { status: 200, value: filterRow(filter) };
};

const favouriteFilters = (actor) => ({
  status: 200,
  value: [...jira.filters.values()]
    .filter((filter) => filter.owner === actor && filter.favourite)
    .map(filterRow),
});

const filterSuggestions = (actor, query) => {
  const prefix = new URLSearchParams(query).get("fieldValue") ?? "";
  const names = [...jira.filters.values()]
    .filter((filter) => visibleTo(filter, actor) && filter.name.startsWith(prefix))
    .map((filter) => filter.name)
    .slice(0, FILTER_SUGGESTION_CAP);
  const results = names.map((name) => ({ value: JSON.stringify(name), displayName: name }));
  return { status: 200, value: { results } };
};

function singleFilter(method, id, actor) {
  const filter = jira.filters.get(id);
  if (method === "GET")
    return filter !== undefined && visibleTo(filter, actor)
      ? { status: 200, value: filterRow(filter) }
      : { status: 400, value: { errorMessages: ["The selected filter is not available to you"] } };
  if (filter === undefined) return { status: 404, value: {} };
  if (filter.owner !== actor) return { status: 403, value: {} };
  jira.filters.delete(id);
  return { status: 204, value: undefined };
}

/** The filter resources Jira Data Center 10.3.26 offers, as observed on the laboratory. */
function filterAnswer(method, path, actor, body) {
  const [route, query = ""] = path.split("?");
  const handlers = {
    "POST /rest/api/2/filter": () => createFilter(actor, body),
    "GET /rest/api/2/filter/favourite": () => favouriteFilters(actor),
    "GET /rest/api/2/jql/autocompletedata/suggestions": () => filterSuggestions(actor, query),
  };
  const handler = handlers[`${method} ${route}`];
  if (handler !== undefined) return handler();
  const single = /^\/rest\/api\/2\/filter\/(\d+)$/u.exec(route);
  const supported = method === "GET" || method === "DELETE";
  return single !== null && supported ? singleFilter(method, single[1], actor) : undefined;
}

const empty = (value) => ({ status: 200, value });
const READS = [
  [/\/remotelink$/u, []],
  [/\/worklog$/u, { worklogs: [] }],
  [/\/properties$/u, { keys: [] }],
  [/\/watchers$/u, { watchers: [] }],
  [/\/votes$/u, { voters: [] }],
  [/\/comment$/u, { comments: [] }],
  [/\/components$/u, []],
  [/\/versions$/u, []],
  [/^\/rest\/api\/2\/search$/u, { total: 0, issues: [] }],
  [/^\/rest\/api\/2\/issue\/[^/]+$/u, { fields: {} }],
  [/^\/rest\/api\/2\/project\/[^/]+$/u, { id: "10000" }],
];

function answer(method, path, auth, body) {
  const route = path.split("?")[0];
  const shape = route.replaceAll(/\/\d+/gu, "/{id}");
  const known =
    inInventory(method, route) || LIVE_VERIFIED_OUTSIDE_INVENTORY.has(`${method} ${shape}`);
  jira.requests.push({ method, route, known });
  if (!known) return { status: 404, value: { message: "Not Found" } };
  const filter = filterAnswer(method, path, actorOf(auth), body);
  if (filter !== undefined) return filter;
  if (method !== "GET") {
    jira.nextResource += 1;
    const value = { id: String(jira.nextResource), key: `KEIKO-${jira.nextResource}` };
    const removal = route.endsWith("/removeAndSwap");
    const status = removal ? 204 : ({ POST: 201, PUT: 200, DELETE: 204 }[method] ?? 200);
    return { status, value };
  }
  const read = READS.find(([pattern]) => pattern.test(route));
  return empty(read === undefined ? { name: route, values: [] } : read[1]);
}

vi.mock("../testing/jira-chat-lab/lab-client.mjs", () => ({
  actorDetails: (actor) => ({ name: `keiko-${actor}` }),
  basicAuth: (_session, actor) => `auth:${actor}`,
  labRequest: vi.fn(async (_session, method, path, auth, body) => answer(method, path, auth, body)),
  checked: vi.fn(async (_session, _name, method, path, auth, body, expected = [200, 201, 204]) => {
    const result = answer(method, path, auth, body);
    if (!expected.includes(result.status))
      throw new TypeError(`Laboratory API rejected ${method} ${path} (${result.status})`);
    return result.value;
  }),
}));

const {
  createSelectionObjects,
  removeNative,
  removeSelectionObjects,
  scopeSnapshot,
  selectionNames,
  strayWrites,
} = await import("../testing/jira-chat-lab/catalog-selection-objects.mjs");
const { SELECTION_CASES } = await import("../testing/jira-chat-lab/catalog-selection-cases.mjs");

const fixture = { project: "KEIKO", issueTypeId: "10001" };
const unknownRequests = () =>
  jira.requests.filter((entry) => !entry.known).map((entry) => `${entry.method} ${entry.route}`);

beforeEach(() => {
  jira.requests.length = 0;
  jira.filters.clear();
  jira.nextFilterId = 100;
  jira.nextResource = 0;
});

async function preparedRun() {
  const created = selectionNames(fixture, "t");
  await createSelectionObjects({}, fixture, "t", created);
  return created;
}

const apiCreates = (name, favourite = false) =>
  answer("POST", "/rest/api/2/filter", "auth:api", { name, jql: "project = KEIKO", favourite });

describe("the selection lane against Jira Data Center's own paths", () => {
  it("creates, snapshots and removes its owned objects with operations the pinned inventory lists", async () => {
    const created = await preparedRun();
    await scopeSnapshot({}, fixture, created);
    await removeSelectionObjects({}, created);
    expect(unknownRequests()).toEqual([]);
    expect(jira.filters.size).toBe(0);
  });

  it("reads and verifies every case only through listed operations", async () => {
    const created = await preparedRun();
    const lane = { ...fixture, selection: created };
    for (const entry of SELECTION_CASES) {
      // The answer's shape is not what this proves; a refused shape throws after its request.
      await (entry.truth ?? entry.verify)({}, lane, "Auswahl t", "t").catch(() => undefined);
    }
    expect(unknownRequests()).toEqual([]);
  });

  it("still sees a filter the api actor created outside the owned objects, favourite or not", async () => {
    const created = await preparedRun();
    const before = await scopeSnapshot({}, fixture, created);
    apiCreates("Streuner plain");
    apiCreates("Streuner favourite", true);
    const after = await scopeSnapshot({}, fixture, created);
    const stray = strayWrites(before, after, [], "Auswahl t");
    expect(stray.remove).toHaveLength(2);
    expect(stray.remove.every((entry) => entry.actor === "api")).toBe(true);
    expect(stray.count).toBe(2);
    expect(unknownRequests()).toEqual([]);
  });

  it("removes the stray filters it found and then reads a clean scope", async () => {
    const created = await preparedRun();
    const before = await scopeSnapshot({}, fixture, created);
    apiCreates("Streuner plain");
    const after = await scopeSnapshot({}, fixture, created);
    const stray = strayWrites(before, after, [], "Auswahl t");
    for (const entry of stray.remove) {
      expect(answer("DELETE", entry.path, `auth:${entry.actor}`).status).toBe(204);
    }
    const final = await scopeSnapshot({}, fixture, created);
    expect(strayWrites(before, final, [], "Auswahl t").count).toBe(0);
  });

  it("keeps finding a stray filter while earlier ones keep consuming identities", async () => {
    const created = await preparedRun();
    const before = await scopeSnapshot({}, fixture, created);
    for (let round = 0; round < 40; round += 1) {
      // Filters a model created and removed within one turn leave gaps in the identities.
      jira.nextFilterId += 5;
      apiCreates(`Streuner ${round}`);
      const after = await scopeSnapshot({}, fixture, created);
      const stray = strayWrites(before, after, [], "Auswahl t");
      expect(stray.remove).toHaveLength(1);
      for (const entry of stray.remove) answer("DELETE", entry.path, `auth:${entry.actor}`);
    }
  });

  it("removes every kind of object a case can leave behind through listed operations", async () => {
    const issue = "/rest/api/2/issue/KEIKO-1";
    await removeNative({}, [
      "/rest/api/2/issueLink/5",
      `${issue}/remotelink/5`,
      `${issue}/properties/keiko.selection.t`,
      `${issue}/worklog/5`,
      `${issue}/watchers?username=keiko-api`,
      { key: `${issue}/votes@keiko-api`, path: `${issue}/votes`, actor: "api" },
      "/rest/api/2/version/5",
    ]);
    expect(unknownRequests()).toEqual([]);
  });

  it("refuses a scope it cannot prove complete when the suggestion list reaches Jira's cap", async () => {
    const created = await preparedRun();
    for (let index = 0; index < FILTER_SUGGESTION_CAP; index += 1) apiCreates(`Streuner ${index}`);
    await expect(scopeSnapshot({}, fixture, created)).rejects.toThrow(/suggestion bound/u);
  });

  it("reports a visible filter it cannot resolve to an identity as a foreign object", async () => {
    const created = await preparedRun();
    const before = await scopeSnapshot({}, fixture, created);
    // Another user's shared filter, far outside the identities this run allocated.
    jira.filters.set("999999", {
      id: 999_999,
      name: "Fremd geteilt",
      jql: "project = KEIKO",
      favourite: false,
      owner: "admin",
      shared: true,
    });
    const after = await scopeSnapshot({}, fixture, created);
    const stray = strayWrites(before, after, [], "Auswahl t");
    expect(stray).toMatchObject({ foreign: 1, remove: [] });
  });
});
