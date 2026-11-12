// Owned synthetic Jira objects for the catalog selection lane (#4327). Created and removed through
// native Jira REST with lab credentials only; Keiko is never involved, so the truth they provide is
// independent of the product under test. Every created id is recorded at once, so a run that fails
// half-way still removes exactly what it created.
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

async function agileObjects(session, fixture, created) {
  const project = await write(session, "admin", "GET", `/rest/api/2/project/${fixture.project}`);
  const shared = await write(session, "admin", "POST", "/rest/api/2/filter", {
    name: `${created.boardName} filter`,
    jql: `project = ${fixture.project} ORDER BY Rank ASC`,
    sharePermissions: [{ type: "project", project: { id: String(project.id) } }],
  });
  created.sharedFilterId = String(shared.id);
  const board = await write(session, "admin", "POST", "/rest/agile/1.0/board", {
    name: created.boardName,
    type: "scrum",
    filterId: Number(shared.id),
  });
  created.boardId = String(board.id);
  const sprint = await write(session, "admin", "POST", "/rest/agile/1.0/sprint", {
    name: created.sprintName,
    originBoardId: Number(board.id),
  });
  created.sprintId = String(sprint.id);
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
    watcherName: actorDetails("assignee").name,
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
export const removalKey = (entry) =>
  typeof entry === "string" ? entry : (entry.key ?? entry.path);

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

const ISSUE_FIELDS = [
  "summary",
  "description",
  "status",
  "assignee",
  "priority",
  "labels",
  "components",
  "fixVersions",
  "comment",
  "attachment",
  "subtasks",
  "duedate",
];
const named = (value) => (Array.isArray(value) ? value.map(named) : (value?.name ?? value));

/** The owned issue's fields that none of the write cases may change. */
function issueState(fields) {
  return JSON.stringify(
    ISSUE_FIELDS.map((field) =>
      field === "comment" ? (fields.comment?.total ?? 0) : named(fields[field] ?? null),
    ),
  );
}

const LAB_ACTORS = ["api", "assignee", "editor", "restricted"];

/** A vote is removed by its own voter, so a lab actor's vote is owned and a foreign one is not. */
function voteRows(issue, votes) {
  const actors = new Map(LAB_ACTORS.map((actor) => [actorDetails(actor).name, actor]));
  return (votes.voters ?? []).map((row) => {
    const actor = actors.get(row.name);
    const value =
      actor === undefined
        ? { owned: false, label: String(row.name ?? "") }
        : { owned: true, label: row.name, removal: { path: `${issue}/votes`, actor } };
    return [`${issue}/votes@${row.name}`, value];
  });
}

/**
 * Every object a write turn could add in the scope, keyed by the native path that removes it, with
 * a label that tells owned objects (carrying the run tag) from foreign ones. Comparing a snapshot
 * before and after the turn finds writes the request did not ask for.
 */
export async function scopeSnapshot(session, fixture, created) {
  const project = `/rest/api/2/project/${encodeURIComponent(fixture.project)}`;
  const issue = `/rest/api/2/issue/${encodeURIComponent(created.issueKey)}`;
  const jql = encodeURIComponent(`project = ${fixture.project} ORDER BY created DESC`);
  const [components, versions, links, worklogs, properties, watchers, votes, state, issues] =
    await Promise.all([
      read(session, `${project}/components`),
      read(session, `${project}/versions`),
      read(session, `${issue}/remotelink`),
      read(session, `${issue}/worklog`),
      read(session, `${issue}/properties`),
      read(session, `${issue}/watchers`),
      read(session, `${issue}/votes`),
      read(session, `${issue}?fields=${ISSUE_FIELDS.join(",")},issuelinks`),
      read(session, `/rest/api/2/search?jql=${jql}&fields=summary&maxResults=100`),
    ]);
  const own = (label) => ({ owned: true, label: String(label ?? "") });
  const projectRow = (label) => ({ owned: false, label: String(label ?? "") });
  return {
    issueState: issueState(state.fields ?? {}),
    objects: new Map([
      ...components.map((row) => [`/rest/api/2/component/${row.id}`, projectRow(row.name)]),
      ...versions.map((row) => [`/rest/api/2/version/${row.id}`, projectRow(row.name)]),
      ...issues.issues.map((row) => [
        `/rest/api/2/issue/${encodeURIComponent(row.key)}`,
        projectRow(row.fields?.summary),
      ]),
      ...links.map((row) => [`${issue}/remotelink/${row.id}`, own(row.object?.title)]),
      ...worklogs.worklogs.map((row) => [`${issue}/worklog/${row.id}`, own(row.comment)]),
      ...(properties.keys ?? []).map((row) => [`${issue}/properties/${row.key}`, own(row.key)]),
      ...watchers.watchers.map((row) => [
        `${issue}/watchers?username=${encodeURIComponent(row.name)}`,
        own(row.name),
      ]),
      ...(state.fields?.issuelinks ?? []).map((row) => [
        `/rest/api/2/issueLink/${row.id}`,
        own(row.type?.name),
      ]),
      ...voteRows(issue, votes),
    ]),
  };
}

/**
 * What a turn wrote beyond `expected` (the case's own verified effect paths): `remove` holds the
 * paths the lane may delete (on its own issue, or carrying `marker`), `foreign` counts the objects
 * the lane does not own and leaves in place, `issueChanged` a change to the owned issue's fields.
 */
export function strayWrites(before, after, expected, marker) {
  const expectedKeys = new Set(expected.map(removalKey));
  const remove = [];
  let foreign = 0;
  for (const [path, row] of after.objects) {
    if (before.objects.has(path) || expectedKeys.has(path)) continue;
    if (row.owned || row.label.includes(marker)) remove.push(row.removal ?? path);
    else foreign += 1;
  }
  const issueChanged = before.issueState === after.issueState ? 0 : 1;
  return { remove, foreign, issueChanged, count: remove.length + foreign + issueChanged };
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
