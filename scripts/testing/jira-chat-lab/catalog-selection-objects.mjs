// Owned synthetic Jira objects for the catalog selection lane (#4327). Created and removed through
// native Jira REST with lab credentials only; Keiko is never involved, so the truth they provide is
// independent of the product under test. Every created id is recorded at once, so a run that fails
// half-way still removes exactly what it created.
import { createHash } from "node:crypto";
import { actorDetails, basicAuth, checked, labRequest } from "./lab-client.mjs";

const write = (session, actor, method, path, body, expected) =>
  checked(
    session,
    "catalog-selection-fixture",
    method,
    path,
    basicAuth(session, actor),
    body,
    expected,
  );

async function projectObjects(session, fixture, created) {
  const project = fixture.project;
  const component = await write(session, "admin", "POST", "/rest/api/2/component", {
    name: created.componentName,
    project,
  });
  created.componentId = String(component.id);
  const version = await write(session, "admin", "POST", "/rest/api/2/version", {
    name: created.versionName,
    project,
  });
  created.versionId = String(version.id);
}

async function ownedIssue(session, fixture, summary) {
  const issue = await write(session, "admin", "POST", "/rest/api/2/issue", {
    fields: {
      project: { key: fixture.project },
      issuetype: { id: String(fixture.issueTypeId) },
      summary,
      description: "Synthetic Keiko laboratory data. No customer content.",
      // A session that ran qualify-fields.mjs holds a globally required field.
      ...(fixture.requiredFieldId === undefined
        ? {}
        : { [fixture.requiredFieldId]: "Synthetic required value" }),
    },
  });
  if (!/^[A-Z][A-Z0-9]+-\d+$/u.test(String(issue.key)))
    throw new TypeError("Invalid owned selection issue identity");
  return String(issue.key);
}

async function issueObjects(session, created, tag) {
  const issue = `/rest/api/2/issue/${encodeURIComponent(created.issueKey)}`;
  const link = await write(session, "admin", "POST", `${issue}/remotelink`, {
    object: { url: `https://example.invalid/selection/${tag}`, title: created.remoteLinkTitle },
  });
  created.remoteLinkId = String(link.id);
  await write(
    session,
    "admin",
    "PUT",
    `${issue}/properties/${created.propertyKey}`,
    { selection: true },
    [200, 201],
  );
}

const VISIBILITY_ATTEMPTS = 3;
const VISIBILITY_PAUSE_MS = 500;

/** The api actor reads the object; a share can take a moment to apply, so it is retried briefly. */
async function requireApiVisible(session, path) {
  for (let attempt = 1; attempt <= VISIBILITY_ATTEMPTS; attempt += 1) {
    const response = await labRequest(session, "GET", path, basicAuth(session, "api"));
    if (response.status === 200) return;
    if (attempt < VISIBILITY_ATTEMPTS)
      await new Promise((resolve) => globalThis.setTimeout(resolve, VISIBILITY_PAUSE_MS));
  }
  throw new TypeError("An owned agile object is not visible to the api actor");
}

async function agileObjects(session, fixture, created) {
  const project = await write(session, "admin", "GET", `/rest/api/2/project/${fixture.project}`);
  const shared = await write(session, "admin", "POST", "/rest/api/2/filter", {
    name: `${created.boardName} filter`,
    jql: `project = ${fixture.project} ORDER BY Rank ASC`,
  });
  created.sharedFilterId = String(shared.id);
  // Jira Data Center ignores sharePermissions on create; without the share the api actor sees
  // neither the board nor its sprint, and those read cases would measure a visibility gap.
  await write(
    session,
    "admin",
    "POST",
    `/rest/api/2/filter/${created.sharedFilterId}/permission`,
    { type: "project", projectId: String(project.id) },
    [201],
  );
  const board = await write(session, "admin", "POST", "/rest/agile/1.0/board", {
    name: created.boardName,
    type: "scrum",
    filterId: Number(shared.id),
  });
  created.boardId = String(board.id);
  await requireApiVisible(session, `/rest/agile/1.0/board/${created.boardId}`);
  const sprint = await write(session, "admin", "POST", "/rest/agile/1.0/sprint", {
    name: created.sprintName,
    originBoardId: Number(board.id),
  });
  created.sprintId = String(sprint.id);
  await requireApiVisible(session, `/rest/agile/1.0/sprint/${created.sprintId}`);
  const favourite = await write(session, "api", "POST", "/rest/api/2/filter", {
    name: created.filterName,
    jql: `project = ${fixture.project}`,
    favourite: true,
  });
  created.favouriteFilterId = String(favourite.id);
}

/**
 * The names of one run's owned objects; each carries the run tag. The lane works on an issue it
 * creates itself, so no other lane's watcher, link or property on a shared fixture issue is touched.
 */
export function selectionNames(_fixture, tag) {
  return {
    componentName: `Auswahl Komponente ${tag}`,
    versionName: `Auswahl Version ${tag}`,
    remoteLinkTitle: `Auswahl Link ${tag}`,
    propertyKey: `keiko.selection.owned.${tag}`,
    filterName: `Auswahl Favorit ${tag}`,
    boardName: `Auswahl Board ${tag}`,
    sprintName: `Auswahl Sprint ${tag}`,
    issueSummary: `Auswahl Vorgang ${tag}`,
    linkTargetSummary: `Auswahl Ziel ${tag}`,
    // jira.watch only adds the connected user (the api actor); it cannot select another user.
    watcherName: actorDetails("api").name,
  };
}

/** Creates every owned object into `created` (from `selectionNames`), recording ids as it goes. */
export async function createSelectionObjects(session, fixture, tag, created) {
  created.issueKey = await ownedIssue(session, fixture, created.issueSummary);
  created.linkTargetKey = await ownedIssue(session, fixture, created.linkTargetSummary);
  await projectObjects(session, fixture, created);
  await issueObjects(session, created, tag);
  await agileObjects(session, fixture, created);
}

const REMOVED = new Set([200, 204, 404]);
/** The resource kind of a lab path without its ids, keys or query. */
const pathShape = (path) =>
  path
    .split("?")[0]
    .replaceAll(/\/[A-Z][A-Z0-9]+-\d+/gu, "/{key}")
    .replaceAll(/\/\d+/gu, "/{id}");

// Jira Data Center 10 has no DELETE for a version; it removes one through removeAndSwap.
const VERSION_PATH = /^\/rest\/api\/2\/version\/\d+$/u;
const removal = (session, path, auth) =>
  VERSION_PATH.test(path)
    ? labRequest(session, "POST", `${path}/removeAndSwap`, auth, {})
    : labRequest(session, "DELETE", path, auth);

/** The snapshot key of a removal: a path, or the `key` of a `{ key, path, actor }` removal. */
const removalKey = (entry) => (typeof entry === "string" ? entry : (entry.key ?? entry.path));

/**
 * Removes native objects by exact path; an already absent object is not an error. An entry is a
 * path (removed as `actor`) or `{ path, actor }` for an object only its own actor can remove, such
 * as a vote. Every entry is attempted even when an earlier one fails, so one refusal never leaks
 * the remaining objects.
 */
export async function removeNative(session, entries, actor = "admin") {
  const failed = [];
  for (const entry of entries) {
    const path = typeof entry === "string" ? entry : entry.path;
    const owner = typeof entry === "string" ? actor : entry.actor;
    try {
      const response = await removal(session, path, basicAuth(session, owner));
      if (!REMOVED.has(response.status)) failed.push(`${response.status} ${pathShape(path)}`);
    } catch (error) {
      failed.push(`${error instanceof Error ? error.name : "unknown"} ${pathShape(path)}`);
    }
  }
  if (failed.length > 0)
    throw new TypeError(`Native cleanup failed for ${failed.length} paths (${failed.join(", ")})`);
}

const optional = (id, path) => (id === undefined ? [] : [path]);

const read = (session, path) =>
  checked(session, "catalog-selection-scope", "GET", path, basicAuth(session, "admin"));

// Fields an expected write changes as a side effect of its own effect (a worklog's time tracking,
// the update stamp), and the collections the snapshot enumerates as objects instead.
const VOLATILE_FIELDS = new Set([
  "updated",
  "lastViewed",
  "watches",
  "votes",
  "issuelinks",
  "worklog",
  "comment",
  "timespent",
  "aggregatetimespent",
  "timeestimate",
  "aggregatetimeestimate",
  "timetracking",
  "progress",
  "aggregateprogress",
  "workratio",
]);

/** Every field of an owned issue except the volatile ones, as one comparable value. */
function issueState(fields) {
  const kept = Object.keys(fields)
    .filter((field) => !VOLATILE_FIELDS.has(field))
    .sort();
  return JSON.stringify(kept.map((field) => [field, fields[field] ?? null]));
}

const LAB_ACTORS = ["api", "assignee", "editor", "restricted"];

/** The snapshot key of one voter's vote; the vote case and the snapshot share it. */
export const voteKey = (issue, name) => `${issue}/votes@${name}`;

/** A vote is removed by its own voter, so a lab actor's vote is owned and a foreign one is not. */
export function voteRows(issue, votes) {
  const actors = new Map(LAB_ACTORS.map((actor) => [actorDetails(actor).name, actor]));
  return (votes.voters ?? []).map((row) => {
    const actor = actors.get(row.name);
    const value =
      actor === undefined
        ? { owned: false, label: String(row.name ?? "") }
        : { owned: true, label: row.name, removal: { path: `${issue}/votes`, actor } };
    return [voteKey(issue, row.name), value];
  });
}

const own = (label) => ({ owned: true, label: String(label ?? "") });

/** A short digest of an object's content, so an edit of an existing object is seen as a change. */
const contentDigest = (...parts) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

/**
 * Watchers except the api actor itself: Jira's autowatch adds the acting user when it creates or
 * comments, which is a side effect of that write, not a write of its own.
 */
function watcherRows(issue, watchers) {
  const self = actorDetails("api").name;
  return (watchers.watchers ?? [])
    .filter((row) => row.name !== self)
    .map((row) => [`${issue}/watchers?username=${encodeURIComponent(row.name)}`, own(row.name)]);
}

const PROPERTIES_MAX = 20;

/** Every bounded property by key and a digest of its value, so an overwrite is seen as a change. */
function propertyRows(session, issue, keys) {
  if (keys.length > PROPERTIES_MAX)
    throw new TypeError("An owned issue exceeds the property snapshot bound");
  return Promise.all(
    keys.map(async (row) => {
      const value = await read(session, `${issue}/properties/${encodeURIComponent(row.key)}`);
      return [`${issue}/properties/${row.key}`, own(`${row.key} ${contentDigest(value.value)}`)];
    }),
  );
}

/** The objects and fields of one owned issue a write turn could add or change. */
async function issueScope(session, key) {
  const issue = `/rest/api/2/issue/${encodeURIComponent(key)}`;
  const [links, worklogs, properties, watchers, votes, comments, state] = await Promise.all([
    read(session, `${issue}/remotelink`),
    read(session, `${issue}/worklog`),
    read(session, `${issue}/properties`),
    read(session, `${issue}/watchers`),
    read(session, `${issue}/votes`),
    read(session, `${issue}/comment`),
    read(session, `${issue}?fields=*all`),
  ]);
  const rows = [
    ...links.map((row) => [
      `${issue}/remotelink/${row.id}`,
      own(`${row.object?.title} ${contentDigest(row.object?.url)}`),
    ]),
    ...(worklogs.worklogs ?? []).map((row) => [
      `${issue}/worklog/${row.id}`,
      own(`${row.comment} ${contentDigest(row.timeSpentSeconds, row.started)}`),
    ]),
    ...(await propertyRows(session, issue, properties.keys ?? [])),
    ...watcherRows(issue, watchers),
    ...(state.fields?.issuelinks ?? []).map((row) => [
      `/rest/api/2/issueLink/${row.id}`,
      own(row.type?.name),
    ]),
    ...voteRows(issue, votes),
    ...(comments.comments ?? []).map((row) => [
      `${issue}/comment/${row.id}`,
      own(contentDigest(row.body)),
    ]),
  ];
  return { state: issueState(state.fields ?? {}), rows };
}

/** Project-wide objects; another issue carries its update stamp so a write on it is seen. */
async function projectScope(session, fixture, created) {
  const project = `/rest/api/2/project/${encodeURIComponent(fixture.project)}`;
  const jql = encodeURIComponent(`project = ${fixture.project} ORDER BY created DESC`);
  const [components, versions, issues] = await Promise.all([
    read(session, `${project}/components`),
    read(session, `${project}/versions`),
    read(session, `/rest/api/2/search?jql=${jql}&fields=summary,updated&maxResults=100`),
  ]);
  // The comparison assumes the lane runs alone on a small project; a larger one is refused rather
  // than half compared, because an issue beyond the page would look removed or added.
  if (!Number.isInteger(issues.total) || issues.total > issues.issues.length)
    throw new TypeError("The selection project exceeds the scope snapshot bound of 100 issues");
  const owned = new Set([created.issueKey, created.linkTargetKey]);
  const projectRow = (label, stamp = "") => ({ owned: false, label: String(label ?? ""), stamp });
  return [
    ...components.map((row) => [`/rest/api/2/component/${row.id}`, projectRow(row.name)]),
    ...versions.map((row) => [`/rest/api/2/version/${row.id}`, projectRow(row.name)]),
    ...issues.issues.map((row) => [
      `/rest/api/2/issue/${encodeURIComponent(row.key)}`,
      projectRow(row.fields?.summary, owned.has(row.key) ? "" : String(row.fields?.updated ?? "")),
    ]),
  ];
}

/**
 * Issues a killed run left behind: owned-issue summaries with another run's tag. They are reported
 * by count, never removed, because their run may still be reconciling; the lane refuses to start.
 */
export function orphanedIssues(snapshot, created) {
  const own = new Set([created.issueSummary, created.linkTargetSummary]);
  return [...snapshot.objects.values()].filter(
    (row) => /^Auswahl (Vorgang|Ziel) /u.test(row.label) && !own.has(row.label),
  ).length;
}

// Jira Data Center cannot list a user's filters. `filter/my` and `filter/search` are Jira Cloud
// paths that 10.3.26 answers with 404 (observed 2026-11-13), and `GET /filter` allows POST only.
// What it does offer: `filter/favourite` (starred filters only), the JQL autocomplete for the
// `filter` field (every filter the actor can see, by name only, capped by Jira at 15 answers) and
// one read per filter identity. The three are combined, so the snapshot sees what the api actor
// creates, starred or not, and fails closed instead of guessing when it cannot prove its view.
const FILTER_SUGGESTION_BOUND = 15;
// Identities are allocated upward by one sequence, so a filter created after the run's own is above
// them; a window past the highest one seen covers filters a model created and removed meanwhile.
const FILTER_ID_WINDOW = 64;
const FILTER_ID_CHUNK = 32;
const FILTER_ID_SPAN_MAX = 4_096;

/** The name in a JQL autocomplete value, which quotes a name that needs it. */
function suggestedName(value) {
  if (typeof value !== "string") throw new TypeError("A filter suggestion carries no value");
  if (!value.startsWith('"')) return value;
  const name = JSON.parse(value);
  if (typeof name !== "string") throw new TypeError("A filter suggestion carries no name");
  return name;
}

/** The names of every filter the api actor can see; complete only below Jira's suggestion cap. */
async function visibleFilterNames(session) {
  const answer = await checked(
    session,
    "catalog-selection-scope",
    "GET",
    "/rest/api/2/jql/autocompletedata/suggestions?fieldName=filter&fieldValue=",
    basicAuth(session, "api"),
  );
  if (!Array.isArray(answer?.results))
    throw new TypeError("The filter suggestions of the api actor are not a list");
  if (answer.results.length >= FILTER_SUGGESTION_BOUND)
    throw new RangeError(
      `The api actor sees ${answer.results.length} filters, which reaches the suggestion bound`,
    );
  return answer.results.map((row) => suggestedName(row.value));
}

/** The filters of a native identity range the api actor can read; an unreadable one is absent. */
async function filtersInRange(session, first, last) {
  if (last - first > FILTER_ID_SPAN_MAX)
    throw new RangeError("The filter identity range exceeds the snapshot bound");
  const rows = [];
  for (let from = first; from <= last; from += FILTER_ID_CHUNK) {
    const ids = Array.from(
      { length: Math.min(FILTER_ID_CHUNK, last - from + 1) },
      (_, i) => from + i,
    );
    const answers = await Promise.all(
      ids.map((id) =>
        labRequest(session, "GET", `/rest/api/2/filter/${id}`, basicAuth(session, "api")),
      ),
    );
    for (const answer of answers) {
      // Jira answers 400 for a filter the actor may not see and 404 for one that does not exist.
      if (answer.status === 200) rows.push(answer.value);
      else if (answer.status !== 400 && answer.status !== 404)
        throw new TypeError(`Selection scope read failed (${answer.status})`);
    }
  }
  return rows;
}

const filterRow = (row) => {
  const path = `/rest/api/2/filter/${row.id}`;
  const label = contentDigest(row.name, row.jql, row.favourite);
  return row.owner?.name === actorDetails("api").name
    ? [path, { owned: true, label, removal: { path, actor: "api" } }]
    : [path, { owned: false, label }];
};

/** A filter row's identity as a number; a row without a numeric identity cannot be addressed. */
function filterIdentity(row) {
  const id = typeof row?.id === "string" || typeof row?.id === "number" ? String(row.id) : "";
  if (!/^[1-9]\d{0,15}$/u.test(id)) throw new TypeError("A filter row carries no numeric identity");
  return Number(id);
}

/**
 * Visible filters the identities do not explain, by name. Jira lets two owners use one name, so a
 * name is matched occurrence by occurrence: each filter read by identity accounts for one
 * suggestion, and every further one is a filter known by name only. A filter read by identity that
 * no suggestion accounts for means the two views disagree, which the snapshot refuses.
 */
function nameOnlyRows(names, addressed) {
  const explained = new Map();
  for (const row of addressed) explained.set(row.name, (explained.get(row.name) ?? 0) + 1);
  const seen = new Map();
  const rows = [];
  for (const name of names) {
    const left = explained.get(name) ?? 0;
    if (left > 0) explained.set(name, left - 1);
    else {
      const occurrence = (seen.get(name) ?? 0) + 1;
      seen.set(name, occurrence);
      rows.push([
        `filter-name:${name}#${occurrence}`,
        { owned: false, label: contentDigest(name) },
      ]);
    }
  }
  if ([...explained.values()].some((count) => count > 0))
    throw new TypeError("A filter readable by identity is missing from the filter suggestions");
  return rows;
}

/**
 * The filters visible to the api actor beyond the run's own two, which is where a model's mistaken
 * filter creation lands. One this run could address by identity (starred, or within the identities
 * allocated since the run's first filter) is read in full, and an owned one is removed as that
 * actor. A visible filter below that range (the seed's board filters, an earlier run's, another
 * user's) is known by name only: its appearance counts as a foreign object, and its content, a
 * rename or a removal cannot be seen. A filter the api actor cannot see cannot be seen at all.
 */
async function filterScope(session, created) {
  const [names, favourites] = await Promise.all([
    visibleFilterNames(session),
    checked(
      session,
      "catalog-selection-scope",
      "GET",
      "/rest/api/2/filter/favourite",
      basicAuth(session, "api"),
    ),
  ]);
  if (!Array.isArray(favourites))
    throw new TypeError("The api actor's favourite filters are not a list");
  const own = new Set([created.sharedFilterId, created.favouriteFilterId]);
  const known = Math.max(
    Number(created.favouriteFilterId),
    Number(created.filterIdHighWater ?? 0),
    ...favourites.map((row) => filterIdentity(row)),
  );
  const inRange = await filtersInRange(
    session,
    Number(created.sharedFilterId),
    known + FILTER_ID_WINDOW,
  );
  const byId = new Map(
    [...favourites, ...inRange].map((row) => [String(filterIdentity(row)), row]),
  );
  created.filterIdHighWater = Math.max(known, ...[...byId.keys()].map((id) => Number(id)));
  const rows = [...byId].filter(([id]) => !own.has(id)).map(([, row]) => filterRow(row));
  return [...rows, ...nameOnlyRows(names, byId.values())];
}

/**
 * The run's own board, sprint and filters by content. One that disappeared reads as absent, so its
 * removal counts. Agile objects a model created by mistake are not enumerated, so such a stray write
 * escapes this snapshot (filters are, through `filterScope`). The favourite filter is private to
 * the api actor, so it is read as that actor.
 */
async function agileScope(session, created) {
  const entries = [
    [`/rest/agile/1.0/board/${created.boardId}`, "admin"],
    [`/rest/agile/1.0/sprint/${created.sprintId}`, "admin"],
    [`/rest/api/2/filter/${created.sharedFilterId}`, "admin"],
    [`/rest/api/2/filter/${created.favouriteFilterId}`, "api"],
  ];
  const rows = await Promise.all(
    entries.map(async ([path, actor]) => {
      const response = await labRequest(session, "GET", path, basicAuth(session, actor));
      if (response.status === 404) return undefined;
      if (response.status !== 200)
        throw new TypeError(`Selection scope read failed (${response.status})`);
      const value = response.value ?? {};
      const label = contentDigest(value.name, value.state, value.goal, value.jql, value.favourite);
      return [path, { owned: false, label }];
    }),
  );
  return rows.filter((row) => row !== undefined);
}

/**
 * Every object a write turn could add, change or remove in the scope, keyed by the native path
 * that removes it, with a label that tells owned objects (carrying the run tag) from foreign ones.
 * Both owned issues are read in full, with the run's own agile objects and filters. Comparing a
 * snapshot before and after the turn finds writes the request did not ask for; it assumes no other
 * lane writes to the project meanwhile. Property values are compared by a content digest.
 */
export async function scopeSnapshot(session, fixture, created) {
  const [main, target, project, agile, filters] = await Promise.all([
    issueScope(session, created.issueKey),
    issueScope(session, created.linkTargetKey),
    projectScope(session, fixture, created),
    agileScope(session, created),
    filterScope(session, created),
  ]);
  return {
    issueState: JSON.stringify([main.state, target.state]),
    objects: new Map([...project, ...filters, ...agile, ...main.rows, ...target.rows]),
  };
}

function changedRow(previous, row) {
  return previous.label !== row.label || previous.stamp !== row.stamp;
}

/**
 * What a turn wrote beyond `expected` (the case's own verified effect removals): `remove` holds the
 * removals the lane may run (owned objects, or objects carrying `marker`), `foreign` counts added
 * objects the lane does not own and leaves in place, `changed` objects whose label or update stamp
 * changed, `removed` objects that disappeared, and `issueChanged` a change to an owned issue's
 * fields. Changes and removals are counted but cannot be undone by the lane.
 */
export function strayWrites(before, after, expected, marker) {
  const expectedKeys = new Set(expected.map(removalKey));
  const remove = [];
  let foreign = 0;
  let changed = 0;
  for (const [path, row] of after.objects) {
    const previous = before.objects.get(path);
    if (previous !== undefined) changed += changedRow(previous, row) ? 1 : 0;
    else if (expectedKeys.has(path)) continue;
    else if (row.owned || row.label.includes(marker)) remove.push(row.removal ?? path);
    else foreign += 1;
  }
  const removed = [...before.objects.keys()].filter((path) => !after.objects.has(path)).length;
  const issueChanged = before.issueState === after.issueState ? 0 : 1;
  const count = remove.length + foreign + changed + removed + issueChanged;
  return { remove, foreign, changed, removed, issueChanged, count };
}

/** Removes the run's owned objects; a partially created set removes what exists. */
export async function removeSelectionObjects(session, created) {
  const errors = [];
  const attempt = async (paths, actor) => {
    try {
      await removeNative(session, paths, actor);
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt([
    ...optional(created.sprintId, `/rest/agile/1.0/sprint/${created.sprintId}`),
    ...optional(created.boardId, `/rest/agile/1.0/board/${created.boardId}`),
    ...optional(created.sharedFilterId, `/rest/api/2/filter/${created.sharedFilterId}`),
    ...optional(created.componentId, `/rest/api/2/component/${created.componentId}`),
    ...optional(created.versionId, `/rest/api/2/version/${created.versionId}`),
    ...optional(
      created.issueKey,
      `/rest/api/2/issue/${encodeURIComponent(created.issueKey)}?deleteSubtasks=true`,
    ),
    ...optional(
      created.linkTargetKey,
      `/rest/api/2/issue/${encodeURIComponent(created.linkTargetKey)}?deleteSubtasks=true`,
    ),
  ]);
  await attempt(
    optional(created.favouriteFilterId, `/rest/api/2/filter/${created.favouriteFilterId}`),
    "api",
  );
  if (errors.length > 0)
    throw new TypeError(
      `Selection cleanup was incomplete: ${errors.map((error) => error.message).join("; ")}`,
    );
}
