// The estimate-mix project EST (#4369): a lab project whose issue types differ in their estimate
// field, the fixture the report child (#4356) proves its fix on. A project created through REST from
// the Scrum template offers Story Points on Epic and Story only, and the lab adds time tracking to
// the Bug screen alone, so the three shapes exist side by side in ONE project:
//   Epic, Story        -> Story Points (the field the project's board estimates with)
//   Bug                -> Original Estimate (time tracking)
//   Task, Sub-task     -> no estimate field at all (the estimate is not applicable to the type)
// The truth is the independent native reading of what Jira holds, written to
// <session>/estimate-mix-truth.json: per type the estimate fields it offers, and its estimated,
// unestimated (offered but empty) and not-applicable counts, so a report that stops at the first
// issue of a type without the field, or that counts "not applicable" as unestimated, is graded wrong.
import { isMainModule } from "../../../lib/is-main-module.mjs";
import { runFixtureSeed } from "./fixture-seed-cli.mjs";
import { moveTo, ensureProject, bulkCreate, fieldIds } from "./seed-projects.mjs";

export const ESTIMATE_MIX_PROJECT = "EST";
const STORY_POINTS_SCHEMA = "com.atlassian.jira.plugin.system.customfieldtypes:float";
const TIME_TRACKING = "timetracking";
const SHAPES = Object.freeze({
  Epic: "story-points",
  Story: "story-points",
  Bug: "time-tracking",
  Task: "none",
  "Sub-task": "none",
});

/** The deterministic population: counts per type and which positions stay unestimated. */
export function estimateMixPlan() {
  const epics = Array.from({ length: 2 }, (_, index) => ({
    type: "Epic",
    name: `Schätzung Paket ${index + 1}`,
  }));
  const stories = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1;
    return {
      type: "Story",
      epic: index % 2,
      points: n % 5 === 0 ? null : (n % 5) + 1,
      status: ["To Do", "In Progress", "Done"][n % 3],
    };
  });
  const bugs = Array.from({ length: 6 }, (_, index) => {
    const n = index + 1;
    return {
      type: "Bug",
      epic: index % 2,
      hours: n === 6 ? null : (n % 3) + 1,
      status: n % 2 === 0 ? "In Progress" : "To Do",
    };
  });
  const tasks = Array.from({ length: 6 }, (_, index) => ({ type: "Task", epic: index % 2 }));
  const subtasks = Array.from({ length: 3 }, (_, index) => ({ type: "Sub-task", task: index }));
  return { epics, stories, bugs, tasks, subtasks };
}

/** The values the plan asks Jira to hold, by type, in the unit each shape stores. */
export function expectedByType(plan) {
  const counted = (rows, field) => ({
    issues: rows.length,
    estimated: rows.filter((row) => row[field] !== null && row[field] !== undefined).length,
  });
  const points = counted(plan.stories, "points");
  const hours = counted(plan.bugs, "hours");
  return {
    Epic: { issues: plan.epics.length, estimated: 0 },
    Story: { ...points, total: sum(plan.stories.map((row) => row.points ?? 0)) },
    Bug: { ...hours, totalSeconds: sum(plan.bugs.map((row) => row.hours ?? 0)) * 3600 },
    Task: { issues: plan.tasks.length, estimated: 0 },
    "Sub-task": { issues: plan.subtasks.length, estimated: 0 },
  };
}
const sum = (values) => values.reduce((total, value) => total + value, 0);

const asList = (value) => (Array.isArray(value) ? value : (value?.values ?? []));

/** The estimate fields each issue type offers on its create screen, read from Jira's own metadata. */
export async function offeredEstimateFields(jira, projectKey, storyPointsId) {
  const base = `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`;
  const offered = {};
  for (const type of asList(await jira.call("est-types", "GET", base))) {
    const meta = asList(
      await jira.call("est-create-fields", "GET", `${base}/${type.id}?maxResults=200`),
    );
    const ids = new Set(meta.map((field) => field.fieldId));
    offered[type.name] = [
      ...(ids.has(storyPointsId) ? ["story-points"] : []),
      ...(ids.has(TIME_TRACKING) ? ["time-tracking"] : []),
    ];
  }
  return offered;
}

async function screenFieldIds(jira, screenId) {
  const tabs = asList(await jira.call("est-tabs", "GET", `/rest/api/2/screens/${screenId}/tabs`));
  const rows = [];
  for (const tab of tabs) {
    const fields = asList(
      await jira.call(
        "est-tab-fields",
        "GET",
        `/rest/api/2/screens/${screenId}/tabs/${tab.id}/fields`,
      ),
    );
    rows.push({ tab: tab.id, ids: fields.map((field) => field.id) });
  }
  return rows;
}

/** Puts a field on the project's screen whose name contains `part`, unless it already holds it. */
export async function ensureOnProjectScreen(jira, projectKey, part, fieldId) {
  const screens = asList(await jira.call("est-screens", "GET", "/rest/api/2/screens"));
  const matches = screens.filter(
    (screen) => screen.name?.startsWith(`${projectKey}:`) && screen.name.includes(part),
  );
  if (matches.length !== 1)
    throw new TypeError(`The ${part} screen of ${projectKey} is not unique`);
  const tabs = await screenFieldIds(jira, matches[0].id);
  if (tabs.some((tab) => tab.ids.includes(fieldId))) return { added: false };
  const path = `/rest/api/2/screens/${matches[0].id}/tabs/${tabs[0].tab}/fields`;
  await jira.call("est-screen-add", "POST", path, { fieldId });
  return { added: true };
}

/** The story-points field Jira Software offers on Epic and Story, found by schema, never by name. */
export async function findStoryPoints(jira) {
  const fields = await jira.call("est-fields", "GET", "/rest/api/2/field");
  const found = fields.filter(
    (field) => field.schema?.custom === STORY_POINTS_SCHEMA && field.name === "Story Points",
  );
  if (found.length !== 1) throw new TypeError("The instance has no unique Story Points field");
  return found[0].id;
}

function issueInputs(plan, ids) {
  const base = (type, summary, extra = {}) => ({
    type,
    fields: { summary, description: "Synthetic estimate-mix fixture.", ...extra },
  });
  const epics = plan.epics.map((epic) => base("Epic", epic.name, { [ids.epicName]: epic.name }));
  return { epics, ids };
}

/** Everything that links to an epic carries its key; the plan only stores the epic position. */
function memberInputs(plan, ids, epicKeys) {
  const link = (epic) => ({ [ids.epicLink]: epicKeys[epic] });
  const row = (type, summary, extra) => ({ type, fields: { summary, ...extra } });
  return [
    ...plan.stories.map((story, index) =>
      row("Story", `Schätzung Story ${index + 1}`, {
        ...link(story.epic),
        ...(story.points === null ? {} : { [ids.storyPoints]: story.points }),
      }),
    ),
    ...plan.bugs.map((bug, index) =>
      row("Bug", `Schätzung Fehler ${index + 1}`, {
        ...link(bug.epic),
        priority: { name: "High" },
        ...(bug.hours === null ? {} : { timetracking: { originalEstimate: `${bug.hours}h` } }),
      }),
    ),
    ...plan.tasks.map((task, index) =>
      row("Task", `Schätzung Aufgabe ${index + 1}`, link(task.epic)),
    ),
  ];
}

/** The independent native reading of what the project holds, per type. */
export async function readMixTruth(jira, projectKey, ids) {
  const counts = {};
  const fields = `issuetype,${ids.storyPoints},timeoriginalestimate`;
  for (let start = 0; ;) {
    const jql = encodeURIComponent(`project = ${projectKey} ORDER BY key ASC`);
    const page = await jira.call(
      "est-read",
      "GET",
      `/rest/api/2/search?jql=${jql}&fields=${fields}&startAt=${start}&maxResults=100`,
    );
    for (const issue of page.issues) {
      const row = (counts[issue.fields.issuetype.name] ??= {
        issues: 0,
        points: 0,
        pointsHeld: 0,
        seconds: 0,
        secondsHeld: 0,
      });
      row.issues += 1;
      const points = issue.fields[ids.storyPoints];
      if (typeof points === "number") {
        row.points += points;
        row.pointsHeld += 1;
      }
      const seconds = issue.fields.timeoriginalestimate;
      if (typeof seconds === "number") {
        row.seconds += seconds;
        row.secondsHeld += 1;
      }
    }
    start += page.issues.length;
    if (page.issues.length === 0 || start >= page.total) return counts;
  }
}

/** One type's truth: refuses a screen or a population that is not what the plan describes. */
function typeTruth({ type, shape, offered, row, expected }) {
  const estimated = shape === "story-points" ? row.pointsHeld : row.secondsHeld;
  if (JSON.stringify(offered) !== JSON.stringify(shape === "none" ? [] : [shape]))
    throw new TypeError(`The ${type} screen does not offer exactly its ${shape} estimate`);
  if (row.issues !== expected.issues || estimated !== expected.estimated)
    throw new TypeError(`Jira does not hold the planned ${type} population`);
  const applicable = shape !== "none";
  return {
    shape,
    issues: row.issues,
    estimated,
    unestimated: applicable ? row.issues - estimated : 0,
    notApplicable: applicable ? 0 : row.issues,
    ...(shape === "story-points" ? { points: row.points } : {}),
    ...(shape === "time-tracking" ? { seconds: row.seconds } : {}),
  };
}

const EMPTY_ROW = { issues: 0, pointsHeld: 0, secondsHeld: 0, points: 0, seconds: 0 };

/** The truth file: offered fields per type beside what Jira holds, graded against the plan. */
export function mixTruth({ plan, offered, held, ids }) {
  const expected = expectedByType(plan);
  const types = Object.fromEntries(
    Object.entries(SHAPES).map(([type, shape]) => [
      type,
      typeTruth({
        type,
        shape,
        offered: offered[type],
        row: held[type] ?? EMPTY_ROW,
        expected: expected[type],
      }),
    ]),
  );
  return {
    schemaVersion: 1,
    project: ESTIMATE_MIX_PROJECT,
    fieldIds: { storyPoints: ids.storyPoints, epicLink: ids.epicLink },
    types,
  };
}

/** The whole seed; returns a body-free summary. Idempotent: a seeded project is only re-read. */
export async function seedEstimateMix(context, jira, save) {
  await ensureProject(context, ESTIMATE_MIX_PROJECT, "Schätzung gemischt");
  const storyPoints = await findStoryPoints(jira);
  // Story Points go on the default screen, where the field's own Jira Software context limits them
  // to Epic and Story; time tracking goes on the Bug screen alone, the one type with its own screen.
  await ensureOnProjectScreen(jira, ESTIMATE_MIX_PROJECT, "Default Issue", storyPoints);
  const placed = await ensureOnProjectScreen(jira, ESTIMATE_MIX_PROJECT, "Bug", TIME_TRACKING);
  const ids = { ...(await fieldIds(context, ESTIMATE_MIX_PROJECT)), storyPoints };
  const plan = estimateMixPlan();
  const existing = await jira.call(
    "est-existing",
    "GET",
    `/rest/api/2/search?jql=${encodeURIComponent(`project = ${ESTIMATE_MIX_PROJECT}`)}&maxResults=0`,
  );
  if (existing.total === 0) await createPopulation(context, plan, ids);
  const offered = await offeredEstimateFields(jira, ESTIMATE_MIX_PROJECT, storyPoints);
  const held = await readMixTruth(jira, ESTIMATE_MIX_PROJECT, ids);
  const truth = mixTruth({ plan, offered, held, ids });
  save(truth);
  return {
    project: ESTIMATE_MIX_PROJECT,
    bugScreenPlaced: placed.added,
    types: Object.fromEntries(Object.entries(truth.types).map(([k, v]) => [k, v.shape])),
    issues: Object.values(truth.types).reduce((total, row) => total + row.issues, 0),
  };
}

async function createPopulation(context, plan, ids) {
  const { epics } = issueInputs(plan, ids);
  const epicKeys = await bulkCreate(context, ESTIMATE_MIX_PROJECT, epics);
  const memberKeys = await bulkCreate(
    context,
    ESTIMATE_MIX_PROJECT,
    memberInputs(plan, ids, epicKeys),
  );
  const keys = [...memberKeys];
  const tasks = keys.slice(plan.stories.length + plan.bugs.length);
  const subtasks = plan.subtasks.map((subtask) => ({
    type: "Sub-task",
    fields: {
      summary: `Schätzung Teilaufgabe ${subtask.task + 1}`,
      parent: { key: tasks[subtask.task] },
    },
  }));
  await bulkCreate(context, ESTIMATE_MIX_PROJECT, subtasks);
  const moving = [...plan.stories, ...plan.bugs]
    .map((row, index) => [keys[index], row.status])
    .filter(([, status]) => status !== "To Do");
  for (const [key, status] of moving) await moveTo(context, key, status);
}

export function main(args) {
  return runFixtureSeed({
    args,
    name: "seed-estimate-mix.mjs",
    receipt: "estimate-mix-truth.json",
    operation: "requirements-estimate-mix",
    seed: seedEstimateMix,
  });
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
