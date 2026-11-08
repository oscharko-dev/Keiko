// Model-free, single-attempt preparation. The caller owns private durable group persistence.
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  actorDetails,
  basicAuth,
  checked,
  labRequest,
  labNativeId as nativeId,
} from "./lab-client.mjs";
import { ensureFixtureIdentity } from "./seed-identities.mjs";
import { seedBrowserRolePermissions, verifyBrowserRolePermissions } from "./seed-permissions.mjs";
import { discoverEstimateField, ensureOnScreens } from "./requirements/estimate-field.mjs";
import { assertDistinctBrowserRoleActors } from "./browser-roles-bindings.mjs";
export { verifyBrowserRoleBindings } from "./browser-roles-bindings.mjs";

const ROLES = ["projectLead", "developer", "techLead"];
const SCRUM = "com.pyxis.greenhopper.jira:gh-scrum-template";
const EPIC_NAME = "com.pyxis.greenhopper.jira:gh-epic-label";
const EPIC_LINK = "com.pyxis.greenhopper.jira:gh-epic-link";
const WRITE_NAMES = new Set([
  "create-user",
  "create-pat",
  "roles-create-project",
  "roles-create-permission-scheme",
  "roles-associate-permission-scheme",
  "roles-private-default",
  "roles-create-filter",
  "roles-create-board",
  "screen-add",
  "add-to-default",
  "roles-create-issue",
]);

function actorIdentity(value, tokenRequired) {
  for (const key of ["key", "name"])
    if (typeof value?.[key] !== "string" || value[key].length === 0 || /\p{Cc}/u.test(value[key]))
      throw new TypeError("Native actor identity is unavailable");
  if (tokenRequired && (typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile)))
    throw new TypeError("A role needs its own private PAT file");
  return {
    key: value.key,
    name: value.name,
    ...(tokenRequired ? { tokenFile: value.tokenFile } : {}),
  };
}

function defaultPorts(session) {
  const auth = new Map([["admin", basicAuth(session, "admin")]]);
  return {
    async ensureActor(role, lifecycle) {
      if (role !== "admin") auth.set(role, await ensureFixtureIdentity(session, role, lifecycle));
      const value = await checked(
        session,
        "roles-native-actor",
        "GET",
        "/rest/api/2/myself",
        auth.get(role),
      );
      if (value.active !== true || value.name !== actorDetails(role).name)
        throw new TypeError("The role PAT does not belong to its seeded actor");
      return { ...value, tokenFile: join(session.directory, "secrets", `${role}-token`) };
    },
    forActor(role) {
      const authorization = auth.get(role);
      if (authorization === undefined) throw new TypeError("Role identity has not been prepared");
      return {
        call: (name, method, path, body, expected) =>
          checked(session, name, method, path, authorization, body, expected),
        request: (method, path, body) => labRequest(session, method, path, authorization, body),
      };
    },
  };
}

export function rolesProjectIdentity(group) {
  if (typeof group.id !== "string" || !/^[a-f\d-]{36}$/iu.test(group.id))
    throw new TypeError("A role setup requires its reserved group identity");
  const suffix = createHash("sha256").update(group.id).digest("hex").slice(0, 8).toUpperCase();
  return { key: `ZR${suffix}`, name: `Synthetic browser roles ${suffix}` };
}

function beginSetup(group, now) {
  if (group.rolesSetup !== undefined)
    throw new TypeError("Role setup already started; reconcile the retained intent without replay");
  const project = rolesProjectIdentity(group);
  const startDate = new Date(now).toISOString();
  group.rolesSetup = {
    phase: "reserved",
    project,
    dates: {
      startDate,
      endDate: new Date(now + 14 * 86400000).toISOString(),
      releaseDate: new Date(now + 30 * 86400000).toISOString().slice(0, 10),
    },
    actors: {},
    epics: [],
    stories: [],
    acknowledgements: 0,
  };
  return group.rolesSetup;
}

function lifecycleFor(state, persist) {
  return {
    async beforeWrite(intent) {
      if (state.currentIntent !== undefined)
        throw new TypeError("A prior setup write is unresolved");
      if (
        !new Set(["admin", ...ROLES]).has(intent.actor) ||
        !WRITE_NAMES.has(intent.name) ||
        !new Set(["POST", "PUT"]).has(intent.method) ||
        typeof intent.path !== "string" ||
        !/^\/rest\/(?:api\/2|agile\/1\.0|pat\/latest)\/[A-Za-z\d_/-]+$/u.test(intent.path)
      )
        throw new TypeError("Unexpected role setup write intent");
      state.currentIntent = {
        actor: intent.actor,
        name: intent.name,
        method: intent.method,
        path: intent.path,
      };
      state.phase = "write-reserved";
      await persist();
    },
    async afterWrite() {
      state.acknowledgements += 1;
      state.lastAcknowledged = state.currentIntent;
      delete state.currentIntent;
      state.phase = "acknowledged";
      await persist();
    },
  };
}

function trackedPort(raw, actor, lifecycle) {
  return {
    async call(name, method, path, body, expected) {
      if (method === "GET") return raw.call(name, method, path, body, expected);
      await lifecycle.beforeWrite({ actor, name, method, path });
      const value = await raw.call(name, method, path, body, expected);
      await lifecycle.afterWrite();
      return value;
    },
    request(method, path, body) {
      if (method !== "GET") throw new TypeError("Setup writes require checked acknowledgement");
      return raw.request(method, path, body);
    },
  };
}

async function prepareActors(ports, state, lifecycle, persist) {
  const actors = { admin: actorIdentity(await ports.ensureActor("admin", lifecycle), false) };
  for (const role of ROLES) {
    actors[role] = actorIdentity(await ports.ensureActor(role, lifecycle), true);
    state.actors[role] = actors[role];
    await persist();
  }
  assertDistinctBrowserRoleActors(actors);
  return actors;
}

async function createProject(jira, state, actors, persist) {
  const { key, name } = state.project;
  const path = `/rest/api/2/project/${key}`;
  const previous = await jira.request("GET", path);
  if (previous.status !== 404) throw new TypeError("The group requires a fresh project identity");
  const created = await jira.call("roles-create-project", "POST", "/rest/api/2/project", {
    key,
    name,
    projectTypeKey: "software",
    projectTemplateKey: SCRUM,
    lead: actors.projectLead.name,
    assigneeType: "UNASSIGNED",
  });
  const project = await jira.call("roles-observe-project", "GET", path);
  if (
    created?.key !== key ||
    project.key !== key ||
    project.name !== name ||
    nativeId(created.id) !== nativeId(project.id) ||
    project.projectTypeKey !== "software" ||
    project.lead?.name !== actors.projectLead.name
  )
    throw new TypeError("The new Scrum project did not retain the intended native identity");
  state.project = { id: nativeId(project.id), key, name };
  await persist();
  return state.project;
}

async function privateDefault(jira) {
  const path = "/rest/api/2/filter/defaultShareScope";
  const before = await jira.call("roles-default-sharing", "GET", path);
  if (before.scope === "PRIVATE") return;
  if (before.scope !== "GLOBAL") throw new TypeError("Native default sharing is unavailable");
  await jira.call("roles-private-default", "PUT", path, { scope: "PRIVATE" });
  const after = await jira.call("roles-observe-private-default", "GET", path);
  if (after.scope !== "PRIVATE") throw new TypeError("The role filter would not be private");
}

function privatelyOwnedFilter(filter, actor) {
  return (
    filter.owner?.key === actor.key &&
    filter.owner?.name === actor.name &&
    Array.isArray(filter.sharePermissions) &&
    filter.sharePermissions.length === 0
  );
}

async function createPrivateFilter(jira, project, actor) {
  await privateDefault(jira);
  const name = `${project.key} private roles filter`;
  const jql = `project = ${project.key} ORDER BY Rank ASC`;
  const created = await jira.call("roles-create-filter", "POST", "/rest/api/2/filter", {
    name,
    jql,
    favourite: false,
  });
  const id = nativeId(created?.id);
  const observed = await jira.call("roles-observe-filter", "GET", `/rest/api/2/filter/${id}`);
  if (
    nativeId(observed.id) !== id ||
    observed.name !== name ||
    observed.jql !== jql ||
    !privatelyOwnedFilter(observed, actor)
  )
    throw new TypeError("The selected filter is not privately owned by the project lead");
  return { id, name };
}

async function createBoard(jira, state, filter, persist) {
  const name = `${state.project.key} private roles board`;
  const filterId = Number(filter.id);
  if (!Number.isSafeInteger(filterId) || String(filterId) !== filter.id)
    throw new TypeError("The native board API cannot address this filter exactly");
  const created = await jira.call("roles-create-board", "POST", "/rest/agile/1.0/board", {
    name,
    type: "scrum",
    filterId,
  });
  const id = nativeId(created?.id);
  const board = await jira.call("roles-observe-board", "GET", `/rest/agile/1.0/board/${id}`);
  const config = await jira.call(
    "roles-observe-board-configuration",
    "GET",
    `/rest/agile/1.0/board/${id}/configuration`,
  );
  if (
    nativeId(board.id) !== id ||
    board.name !== name ||
    board.type !== "scrum" ||
    config.type !== "scrum" ||
    nativeId(config.filter?.id) !== filter.id
  )
    throw new TypeError("The new Scrum board is not bound to the private filter");
  state.board = { id, name };
  state.filter = filter;
  await persist();
  return config;
}

function oneField(fields, custom) {
  const matches = fields.filter((field) => field.schema?.custom === custom);
  if (matches.length !== 1 || !/^customfield_[1-9]\d*$/u.test(matches[0].id))
    throw new TypeError("A required native Epic field is missing or ambiguous");
  return matches[0].id;
}

async function issueTypes(jira, key) {
  const result = await jira.call(
    "roles-issue-types",
    "GET",
    `/rest/api/2/issue/createmeta/${key}/issuetypes?maxResults=100`,
  );
  const values = Array.isArray(result) ? result : result.values;
  if (
    !Array.isArray(values) ||
    result.isLast === false ||
    (result.total !== undefined && result.total > values.length)
  )
    throw new TypeError("The project issue-type inventory is incomplete");
  return Object.fromEntries(
    ["Epic", "Story", "Task"].map((name) => {
      const matching = values.filter((value) => value.name === name && value.subtask !== true);
      if (matching.length !== 1) throw new TypeError("A required native issue type is unavailable");
      return [name, nativeId(matching[0].id)];
    }),
  );
}

async function creationFields(jira, projectKey, typeId) {
  const result = await jira.call(
    "roles-create-fields",
    "GET",
    `/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${typeId}?maxResults=200`,
  );
  const fields = Array.isArray(result) ? result : result.values;
  if (
    !Array.isArray(fields) ||
    result.isLast === false ||
    (result.total !== undefined && result.total > fields.length)
  )
    throw new TypeError("The native create-field inventory is incomplete");
  return fields;
}

function realStoryPoints(estimate, config) {
  return (
    estimate !== undefined &&
    estimate.schema?.type === "number" &&
    /^customfield_[1-9]\d*$/u.test(estimate.id) &&
    config.estimation?.field?.fieldId === estimate.id
  );
}

async function roleFields(jira, state, config, persist) {
  const types = await issueTypes(jira, state.project.key);
  const fields = await jira.call("roles-fields", "GET", "/rest/api/2/field");
  if (!Array.isArray(fields)) throw new TypeError("Native field inventory is unavailable");
  const estimate = await discoverEstimateField(jira, state.project.key);
  if (!realStoryPoints(estimate, config))
    throw new TypeError(
      "The Scrum board requires a real Story Points field; no time-tracking fallback",
    );
  await ensureOnScreens(jira, state.project.key, estimate.id);
  const metadata = {};
  for (const name of ["Epic", "Story", "Task"])
    metadata[name] = await creationFields(jira, state.project.key, types[name]);
  if (
    !metadata.Story.some(
      (field) => field.fieldId === estimate.id && field.schema?.type === "number",
    )
  )
    throw new TypeError("Story Points are not offered on the native Story create screen");
  state.storyPointsField = { id: estimate.id };
  await persist();
  return {
    types,
    metadata,
    points: estimate.id,
    epicName: oneField(fields, EPIC_NAME),
    epicLink: oneField(fields, EPIC_LINK),
  };
}

function requiredFields(metadata, fields) {
  for (const field of metadata) {
    if (
      field.required !== true ||
      field.hasDefaultValue === true ||
      Object.hasOwn(fields, field.fieldId)
    )
      continue;
    if (field.schema?.type !== "string" || !/^customfield_[1-9]\d*$/u.test(field.fieldId))
      throw new TypeError("An additional required native field has no safe synthetic seed value");
    fields[field.fieldId] = "Synthetic browser roles qualification";
  }
  return fields;
}

function createdIssueIdentity(created, projectKey) {
  const id = nativeId(created?.id);
  if (typeof created?.key !== "string" || !created.key.startsWith(`${projectKey}-`))
    throw new TypeError("The issue acknowledgement belongs to another project");
  return { id, key: created.key };
}
function verifyCreatedIssue(native, id, key, summary, projectKey, typeId) {
  if (
    nativeId(native.id) !== id ||
    native.key !== key ||
    native.fields?.summary !== summary ||
    nativeId(native.fields.issuetype?.id) !== typeId ||
    native.fields.project?.key !== projectKey
  )
    throw new TypeError("The created issue did not retain its reviewed native fields");
}

async function createIssue(jira, state, fields, type, summary, extra) {
  const payload = requiredFields(fields.metadata[type], {
    project: { id: state.project.id },
    issuetype: { id: fields.types[type] },
    summary,
    description: "Synthetic browser roles qualification.",
    assignee: null,
    ...extra,
  });
  const created = await jira.call("roles-create-issue", "POST", "/rest/api/2/issue", {
    fields: payload,
  });
  const { id, key } = createdIssueIdentity(created, state.project.key);
  const native = await jira.call(
    "roles-observe-issue",
    "GET",
    `/rest/api/2/issue/${id}?fields=*all`,
  );
  verifyCreatedIssue(native, id, key, summary, state.project.key, fields.types[type]);
  return { id, key, summary, issueType: type, native: native.fields };
}

function observedIssue(value) {
  return { id: value.id, key: value.key, summary: value.summary, issueType: value.issueType };
}

async function createEpics(jira, state, fields, persist) {
  for (let index = 0; index < 2; index += 1) {
    const summary = `${state.project.key} Epic ${String(index + 1)}`;
    const issue = await createIssue(jira, state, fields, "Epic", summary, {
      [fields.epicName]: summary,
    });
    if (issue.native[fields.epicName] !== summary || issue.native.assignee !== null)
      throw new TypeError("The native Epic name or unassigned state changed");
    state.epics.push(observedIssue(issue));
    await persist();
  }
}

function observedStory(native, fields, epicKey, index, developer) {
  if (native[fields.epicLink] !== epicKey || native[fields.points] !== index + 1) return false;
  return index === 0 ? native.assignee?.key === developer.key : native.assignee === null;
}

async function createStories(jira, state, fields, actors, persist) {
  for (let index = 0; index < 8; index += 1) {
    const epicKey = state.epics[index < 4 ? 0 : 1].key;
    const assignee = index === 0 ? { name: actors.developer.name } : null;
    const issue = await createIssue(
      jira,
      state,
      fields,
      "Story",
      `${state.project.key} Story ${String(index + 1)}`,
      {
        [fields.epicLink]: epicKey,
        [fields.points]: index + 1,
        assignee,
      },
    );
    if (!observedStory(issue.native, fields, epicKey, index, actors.developer))
      throw new TypeError("The native Story relation, estimate or assignee differs from the seed");
    const edit = await jira.call(
      "roles-observe-story-edit-screen",
      "GET",
      `/rest/api/2/issue/${issue.id}/editmeta`,
    );
    if (edit.fields?.[fields.points] === undefined)
      throw new TypeError("Story Points are not editable on the Story screen");
    state.stories.push({
      ...observedIssue(issue),
      epicKey,
      storyPoints: index + 1,
      ...(index === 0 ? { assigneeKey: actors.developer.key } : {}),
    });
    await persist();
  }
}

/** Inject ports={ensureActor(role,lifecycle),forActor(role):{call,request}} for network-free tests. */
export async function seedBrowserRoles(session, group, persist, options = {}) {
  const state = beginSetup(group, (options.now ?? Date.now)());
  await persist();
  const ports = options.ports ?? defaultPorts(session);
  const lifecycle = lifecycleFor(state, persist);
  const actors = await prepareActors(ports, state, lifecycle, persist);
  const portFor = (role) => trackedPort(ports.forActor(role), role, lifecycle);
  const jira = portFor("admin");
  await createProject(jira, state, actors, persist);
  state.permissions = await seedBrowserRolePermissions(jira, state.project.key, actors);
  await persist();
  await verifyBrowserRolePermissions(portFor, state.project.key, state.permissions);
  const filter = await createPrivateFilter(
    portFor("projectLead"),
    state.project,
    actors.projectLead,
  );
  const config = await createBoard(portFor("projectLead"), state, filter, persist);
  const fields = await roleFields(jira, state, config, persist);
  await createEpics(jira, state, fields, persist);
  await createStories(jira, state, fields, actors, persist);
  const task = await createIssue(
    jira,
    state,
    fields,
    "Task",
    `${state.project.key} Subtask parent`,
    {},
  );
  if (task.native.assignee !== null)
    throw new TypeError("The separate Task must remain unassigned");
  const fixture = {
    project: state.project,
    board: state.board,
    epics: state.epics,
    stories: state.stories,
    task: observedIssue(task),
    storyPointsField: state.storyPointsField,
    actors: state.actors,
    dates: state.dates,
  };
  state.fixture = fixture;
  state.phase = "ready";
  await persist();
  return fixture;
}
