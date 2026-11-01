// Lab setup for the estimate field of the report project (#4174, scenario S10).
// A Jira Software instance only offers Story Points on a project's screens when the lab puts it
// there; without it the report journeys cannot grade estimate totals and S10 stays partial. This
// module finds the instance's estimate field by schema (never by id or name), puts it on the
// project's issue screens, writes the seed's deterministic estimates onto the seeded Tasks and
// brings the ground truth in line with what Jira holds afterwards. Every function takes a `jira`
// port, so the logic is unit-tested without HTTP:
//   jira.call(name, method, path, body?, expected?) -> JSON value, throws on an unexpected status
//   jira.request(method, path, body?)               -> { status, value }, never throws
// Lab-side code may know Jira Software's field schemas; product code may not.

const JSW_STORY_POINTS = "com.pyxis.greenhopper.jira:jsw-story-points";
const PAGE = 100;

/** The seed rule of seed-projects.mjs: points `(n % 5) + 1`, every 13th Task left unestimated. */
export const pointsFor = (n) => (n % 5) + 1;
export const isUnestimated = (n) => n % 13 === 0;

const isNumber = (field) => field?.schema?.type === "number";
const asList = (value) => (Array.isArray(value) ? value : (value?.values ?? []));

async function boardEstimationField(jira, projectKey) {
  const path = `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`;
  const boards = await jira.request("GET", path);
  if (boards.status !== 200) return undefined;
  for (const board of asList(boards.value)) {
    const config = await jira.request(
      "GET",
      `/rest/agile/1.0/board/${String(board.id)}/configuration`,
    );
    const id = config.status === 200 ? config.value?.estimation?.field?.fieldId : undefined;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * The instance's estimate field: the Jira Software story-points custom type first, otherwise the
 * field the project's board estimates with. `undefined` when the instance has none.
 */
export async function discoverEstimateField(jira, projectKey) {
  const numeric = (await jira.call("fields", "GET", "/rest/api/2/field")).filter(isNumber);
  const board = await boardEstimationField(jira, projectKey);
  const typed = numeric.filter((field) => field.schema.custom === JSW_STORY_POINTS);
  // Several story-points fields: only the one the board estimates with is unambiguous.
  const chosen = typed.length > 1 ? typed.filter((field) => field.id === board) : typed;
  if (typed.length > 1 && chosen.length !== 1)
    throw new TypeError("More than one story-points field; cannot choose");
  if (chosen.length === 1) return { id: chosen[0].id, source: "custom-type" };
  const viaBoard = numeric.find((field) => field.id === board);
  return viaBoard === undefined ? undefined : { id: viaBoard.id, source: "board-estimation" };
}

/** Whether the create screen of each issue type and the edit screen of a Task offer the field. */
export async function offeredOn(jira, projectKey, taskKey, fieldId) {
  const base = `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`;
  const create = {};
  for (const type of asList(await jira.call("types", "GET", base))) {
    const meta = await jira.call(`create-${type.name}`, "GET", `${base}/${type.id}?maxResults=200`);
    create[type.name] = asList(meta).some((field) => field.fieldId === fieldId);
  }
  const edit = await jira.call("editmeta", "GET", `/rest/api/2/issue/${taskKey}/editmeta`);
  return { create, edit: edit?.fields?.[fieldId] !== undefined };
}

export const isOffered = (offered) => offered.create.Task === true && offered.edit;

async function tabsOf(jira, screenId) {
  const tabs = asList(await jira.call("tabs", "GET", `/rest/api/2/screens/${screenId}/tabs`));
  const result = [];
  for (const tab of tabs) {
    const path = `/rest/api/2/screens/${screenId}/tabs/${tab.id}/fields`;
    const fields = asList(await jira.call("tab-fields", "GET", path));
    result.push({ id: tab.id, fieldIds: fields.map((field) => field.id) });
  }
  return result;
}

/**
 * Puts the field on every issue screen of the project: a screen whose name starts with the
 * project key and that carries Summary. A screen that already holds it is left alone. An instance
 * that cannot list screens gets the field on the default screen instead; the caller verifies.
 */
export async function ensureOnScreens(jira, projectKey, fieldId) {
  const listed = await jira.request("GET", "/rest/api/2/screens");
  if (listed.status !== 200) {
    await jira.call("add-to-default", "POST", `/rest/api/2/screens/addToDefault/${fieldId}`);
    return { added: 0, present: 0, viaDefault: true };
  }
  const outcome = { added: 0, present: 0, viaDefault: false };
  const screens = asList(listed.value).filter((s) => s.name?.startsWith(`${projectKey}:`));
  for (const screen of screens) {
    const tabs = await tabsOf(jira, screen.id);
    if (!tabs.some((tab) => tab.fieldIds.includes("summary"))) continue;
    if (tabs.some((tab) => tab.fieldIds.includes(fieldId))) {
      outcome.present += 1;
      continue;
    }
    const path = `/rest/api/2/screens/${screen.id}/tabs/${tabs[0].id}/fields`;
    await jira.call("screen-add", "POST", path, { fieldId });
    outcome.added += 1;
  }
  return outcome;
}

/** Per Task of the truth, the estimate the seed rule assigns (`null`: left unestimated). */
export function expectedEstimates(truth) {
  const tasks = truth.issues.filter((issue) => issue.type === "Task");
  return new Map(
    tasks.map((task, index) => {
      const n = index + 1;
      if (task.points !== pointsFor(n))
        throw new TypeError(`Truth Task ${task.key} does not follow the seed estimate rule`);
      return [task.key, isUnestimated(n) ? null : task.points];
    }),
  );
}

/** The estimate of every Task of the project as Jira holds it (`null`: no value). */
export async function readEstimates(jira, projectKey, fieldId) {
  const values = new Map();
  const jql = encodeURIComponent(`project = ${projectKey} AND issuetype = Task`);
  for (let start = 0; ; start += PAGE) {
    const query = `jql=${jql}&fields=${fieldId}&startAt=${String(start)}&maxResults=${String(PAGE)}`;
    const page = await jira.call("estimates", "GET", `/rest/api/2/search?${query}`);
    for (const issue of page.issues) values.set(issue.key, issue.fields[fieldId] ?? null);
    if (page.issues.length === 0 || start + page.issues.length >= page.total) return values;
  }
}

/** Writes the expected estimates that differ from what Jira holds; returns how many it wrote. */
export async function writeEstimates(jira, fieldId, expected, current) {
  let written = 0;
  for (const [key, value] of expected) {
    if (!current.has(key)) throw new TypeError(`Seeded Task ${key} is missing in Jira`);
    if (current.get(key) === value) continue;
    const result = await jira.request("PUT", `/rest/api/2/issue/${key}`, {
      fields: { [fieldId]: value },
    });
    if (result.status !== 204)
      throw new TypeError(`Estimate write for ${key} rejected: status ${String(result.status)}`);
    written += 1;
  }
  return written;
}

/**
 * The truth file after the estimates exist: `fieldIds.storyPoints` is recorded and each Task's
 * "estimate" deviation (the S11 compliance truth) follows what Jira holds, appended last as the
 * seed does. Nothing else changes.
 */
export function syncTruth(truth, fieldId, actual) {
  const issues = truth.issues.map((issue) => {
    if (issue.type !== "Task") return issue;
    const deviations = issue.deviations.filter((code) => code !== "estimate");
    if (actual.get(issue.key) === null) deviations.push("estimate");
    return { ...issue, deviations };
  });
  return { ...truth, fieldIds: { ...truth.fieldIds, storyPoints: fieldId }, issues };
}

async function findField(jira, truth) {
  const found = await discoverEstimateField(jira, truth.projects.report);
  if (found === undefined)
    throw new TypeError(
      "This Jira instance has no estimate field: no Jira Software story-points field and no board estimation field. Create Story Points first.",
    );
  const recorded = truth.fieldIds.storyPoints;
  if (recorded !== undefined && recorded !== found.id)
    throw new TypeError("The truth file records a different estimate field than the instance has");
  return found;
}

async function makeOffered(jira, project, taskKey, fieldId) {
  let offered = await offeredOn(jira, project, taskKey, fieldId);
  let screens = { added: 0, present: 0, viaDefault: false };
  if (!isOffered(offered)) {
    screens = await ensureOnScreens(jira, project, fieldId);
    offered = await offeredOn(jira, project, taskKey, fieldId);
  }
  if (!isOffered(offered))
    throw new TypeError(
      "The estimate field is not offered on the Task create and edit screens; check the field context and the project's screen scheme",
    );
  return { offered, screens };
}

/** The whole setup step; returns a body-free summary. `save` persists the new truth. */
export async function seedEstimates(jira, truth, save) {
  const project = truth.projects.report;
  const expected = expectedEstimates(truth);
  const found = await findField(jira, truth);
  const placement = await makeOffered(jira, project, expected.keys().next().value, found.id);
  const current = await readEstimates(jira, project, found.id);
  const written = await writeEstimates(jira, found.id, expected, current);
  const actual = await readEstimates(jira, project, found.id);
  for (const [key, value] of expected)
    if (actual.get(key) !== value)
      throw new TypeError(`Jira does not hold the expected estimate for ${key}`);
  save(syncTruth(truth, found.id, actual));
  const unestimated = [...actual.values()].filter((value) => value === null).length;
  return { source: found.source, ...placement, written, tasks: actual.size, unestimated };
}
