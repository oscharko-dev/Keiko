// Lab setup for the estimate of the report project (#4174, scenario S10).
// The report journeys can only grade estimate totals when the seeded Tasks carry an estimate. This
// module picks the estimate the instance can really hold on a Task, puts it on the project's issue
// screens, writes the seed's deterministic estimates onto the seeded Tasks and brings the ground
// truth in line with what Jira holds afterwards:
//   1. a story-points field, found by schema (never by id or name): the Jira Software story-points
//      custom type, else the field the project's board estimates with. Used only when Jira offers
//      it on the Task create and edit screens (its context may cover Epic and Story only);
//   2. otherwise Jira's system time tracking (Original Estimate, read back in seconds).
// Every function takes a `jira` port, so the logic is unit-tested without HTTP:
//   jira.call(name, method, path, body?, expected?) -> JSON value, throws on an unexpected status
//   jira.request(method, path, body?)               -> { status, value }, never throws
// Lab-side code may know Jira Software's field schemas; product code may not.

const JSW_STORY_POINTS = "com.pyxis.greenhopper.jira:jsw-story-points";
const PAGE = 100;
const SECONDS_PER_HOUR = 3600;

/** The seed rule of seed-projects.mjs: points `(n % 5) + 1`, every 13th Task left unestimated. */
const pointsFor = (n) => (n % 5) + 1;
const isUnestimated = (n) => n % 13 === 0;

/**
 * What the oracle sums (`fieldId`, in `unit`) and what is written and placed on screens
 * (`writeFieldId`). Time tracking keeps one hour per seeded point.
 */
export const TIME_TRACKING = {
  fieldId: "timeoriginalestimate",
  writeFieldId: "timetracking",
  unit: "seconds",
  label: "Original Estimate",
};

const pointsTarget = (field) => ({
  fieldId: field.id,
  writeFieldId: field.id,
  unit: "points",
  label: field.name ?? "Story Points",
});

const scaleOf = (target) => (target.unit === "seconds" ? SECONDS_PER_HOUR : 1);

function writePayload(target, value) {
  if (target.unit !== "seconds") return { [target.fieldId]: value };
  const originalEstimate = value === null ? "" : `${String(value / SECONDS_PER_HOUR)}h`;
  return { [target.writeFieldId]: { originalEstimate } };
}

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
 * The instance's story-points field: the Jira Software story-points custom type first, otherwise
 * the field the project's board estimates with. `undefined` when the instance has none.
 */
export async function discoverEstimateField(jira, projectKey) {
  const numeric = (await jira.call("fields", "GET", "/rest/api/2/field")).filter(isNumber);
  const board = await boardEstimationField(jira, projectKey);
  const typed = numeric.filter((field) => field.schema.custom === JSW_STORY_POINTS);
  // Several story-points fields: only the one the board estimates with is unambiguous.
  const chosen = typed.length > 1 ? typed.filter((field) => field.id === board) : typed;
  if (typed.length > 1 && chosen.length !== 1)
    throw new TypeError("More than one story-points field; cannot choose");
  if (chosen.length === 1) return { ...chosen[0], source: "custom-type" };
  const viaBoard = numeric.find((field) => field.id === board);
  return viaBoard === undefined ? undefined : { ...viaBoard, source: "board-estimation" };
}

/** Whether the create screen of each issue type and the edit screen of a Task offer the field. */
async function offeredOn(jira, projectKey, taskKey, fieldId) {
  const base = `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`;
  const create = {};
  for (const type of asList(await jira.call("types", "GET", base))) {
    const meta = await jira.call(`create-${type.name}`, "GET", `${base}/${type.id}?maxResults=200`);
    create[type.name] = asList(meta).some((field) => field.fieldId === fieldId);
  }
  const edit = await jira.call("editmeta", "GET", `/rest/api/2/issue/${taskKey}/editmeta`);
  return { create, edit: edit?.fields?.[fieldId] !== undefined };
}

const isOffered = (offered) => offered.create.Task === true && offered.edit;

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

/** Per Task of the truth, the estimate the seed rule assigns, in the target's unit (`null`: none). */
export function expectedEstimates(truth, target) {
  const tasks = truth.issues.filter((issue) => issue.type === "Task");
  return new Map(
    tasks.map((task, index) => {
      const n = index + 1;
      if (task.points !== pointsFor(n))
        throw new TypeError(`Truth Task ${task.key} does not follow the seed estimate rule`);
      return [task.key, isUnestimated(n) ? null : task.points * scaleOf(target)];
    }),
  );
}

/** The estimate of every Task of the project as Jira holds it (`null`: no value). */
async function readEstimates(jira, projectKey, fieldId) {
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
async function writeEstimates(jira, target, expected, current) {
  let written = 0;
  for (const [key, value] of expected) {
    if (!current.has(key)) throw new TypeError(`Seeded Task ${key} is missing in Jira`);
    if (current.get(key) === value) continue;
    const result = await jira.request("PUT", `/rest/api/2/issue/${key}`, {
      fields: writePayload(target, value),
    });
    if (result.status !== 204)
      throw new TypeError(`Estimate write for ${key} rejected: status ${String(result.status)}`);
    written += 1;
  }
  return written;
}

/**
 * The truth file after the estimates exist: `fieldIds.storyPoints` names the field whose numeric
 * value the oracle sums, `estimate` its unit and label, and each Task's "estimate" deviation (the
 * S11 compliance truth) follows what Jira holds, appended last as the seed does. Nothing else
 * changes.
 */
export function syncTruth(truth, target, actual) {
  const issues = truth.issues.map((issue) => {
    if (issue.type !== "Task") return issue;
    const deviations = issue.deviations.filter((code) => code !== "estimate");
    if (actual.get(issue.key) === null) deviations.push("estimate");
    return { ...issue, deviations };
  });
  return {
    ...truth,
    fieldIds: { ...truth.fieldIds, storyPoints: target.fieldId },
    estimate: { ...target },
    issues,
  };
}

/** Puts `fieldId` on the screens unless Jira already offers it; `undefined` if it still does not. */
async function placeField(jira, project, taskKey, fieldId) {
  let offered = await offeredOn(jira, project, taskKey, fieldId);
  let screens = { added: 0, present: 0, viaDefault: false };
  if (!isOffered(offered)) {
    screens = await ensureOnScreens(jira, project, fieldId);
    offered = await offeredOn(jira, project, taskKey, fieldId);
  }
  return isOffered(offered) ? { offered, screens } : undefined;
}

/** Story points where Jira offers them on Task, otherwise time tracking; fails if neither is. */
async function chooseEstimate(jira, project, taskKey) {
  const found = await discoverEstimateField(jira, project);
  if (found !== undefined) {
    const placed = await placeField(jira, project, taskKey, found.id);
    if (placed !== undefined)
      return { target: pointsTarget(found), source: found.source, ...placed };
  }
  const placed = await placeField(jira, project, taskKey, TIME_TRACKING.writeFieldId);
  if (placed === undefined)
    throw new TypeError(
      "Neither a story-points field nor time tracking is offered on the Task create and edit screens; enable time tracking in Jira or widen the story-points field context",
    );
  return { target: TIME_TRACKING, source: "time-tracking", ...placed };
}

/** The whole setup step; returns a body-free summary. `save` persists the new truth. */
export async function seedEstimates(jira, truth, save) {
  const project = truth.projects.report;
  const taskKey = truth.issues.find((issue) => issue.type === "Task")?.key;
  if (taskKey === undefined) throw new TypeError("The truth file holds no Task");
  const { target, ...placement } = await chooseEstimate(jira, project, taskKey);
  const recorded = truth.fieldIds.storyPoints;
  if (recorded !== undefined && recorded !== target.fieldId)
    throw new TypeError("The truth file records a different estimate field than the instance has");
  const expected = expectedEstimates(truth, target);
  const current = await readEstimates(jira, project, target.fieldId);
  const written = await writeEstimates(jira, target, expected, current);
  const actual = await readEstimates(jira, project, target.fieldId);
  for (const [key, value] of expected)
    if (actual.get(key) !== value)
      throw new TypeError(`Jira does not hold the expected estimate for ${key}`);
  save(syncTruth(truth, target, actual));
  const unestimated = [...actual.values()].filter((value) => value === null).length;
  return { ...placement, estimate: target, written, tasks: actual.size, unestimated };
}
