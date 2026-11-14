// Seeds the requirements-lab projects through Jira's admin REST API (#4174).
//   REQ: empty Scrum project the creation journeys write into (S05, S07–S09, S19).
//   RPT: Scrum project with a known ground truth for the report journeys (S10–S13).
//   LRG: Scrum project of about 2,500 issues for the large-project step of S10 (large-project.mjs).
// Usage: node seed-projects.mjs <private-session-directory> [--only LRG]
// The ground truth is computed from the generator, never read back from Jira, and written to
// <session>/requirements-truth.json. `--only LRG` adds the large project to a laboratory that is
// already seeded: it leaves the file's other entries and the issues of REQ and RPT untouched.
// Lab-side code may know Jira Software's field schemas; product code may not.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { basicAuth, checked, labRequest, loadSession } from "../lab-client.mjs";
import { privateJson } from "../private-json.mjs";
import { recoverFixtureFieldRequirement, withFixtureFieldOptional } from "../seed-fields.mjs";
import { STRUCTURE_RULES, buildCorpus } from "./corpus.mjs";
import { LARGE_PROJECT, largePlan, largeTruth } from "./large-project.mjs";

const SCRUM = "com.pyxis.greenhopper.jira:gh-scrum-template";
const EPIC_NAME = "com.pyxis.greenhopper.jira:gh-epic-label";
const EPIC_LINK = "com.pyxis.greenhopper.jira:gh-epic-link";
const STORY_POINTS = "com.atlassian.jira.plugin.system.customfieldtypes:float";
const BULK = 50;

export async function ensureProject({ session, auth }, key, name) {
  const existing = await labRequest(session, "GET", `/rest/api/2/project/${key}`, auth);
  if (existing.status === 200) return existing.value;
  await checked(session, `project-${key}`, "POST", "/rest/api/2/project", auth, {
    key,
    name,
    projectTypeKey: "software",
    projectTemplateKey: SCRUM,
    lead: "keiko-admin",
    assigneeType: "UNASSIGNED",
  });
  await inBatches(["10002", "10001", "10000"], 1, (id) =>
    labRequest(session, "POST", `/rest/api/2/project/${key}/role/${id}`, auth, {
      user: ["keiko-api"],
    }),
  );
  return checked(session, `project-${key}-read`, "GET", `/rest/api/2/project/${key}`, auth);
}

/** Reads the selected project's native field metadata without owning its session or CLI lifetime. */
export async function fieldIds({ session, auth }, projectKey) {
  const types = await checked(
    session,
    "types",
    "GET",
    `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`,
    auth,
  );
  const task = types.values.find((type) => type.name === "Task");
  const page = await checked(
    session,
    "fields",
    "GET",
    `/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${task.id}?maxResults=200`,
    auth,
  );
  const all = await checked(session, "all-fields", "GET", "/rest/api/2/field", auth);
  const byCustom = (custom) => all.find((field) => field.schema?.custom === custom)?.id;
  const points = page.values.find(
    (field) => field.schema?.custom === STORY_POINTS && /story points/i.test(field.name),
  );
  return {
    epicName: byCustom(EPIC_NAME),
    epicLink: byCustom(EPIC_LINK),
    storyPoints: points?.fieldId,
  };
}

const wiki = (sections) =>
  sections.map((name) => `h3. ${name}\nSynthetischer Inhalt.`).join("\n\n");

export async function bulkCreate({ session, auth }, project, items) {
  const keys = [];
  const slices = Array.from({ length: Math.ceil(items.length / BULK) }, (_, index) =>
    items.slice(index * BULK, (index + 1) * BULK),
  );
  await inBatches(slices, 1, async (slice) => {
    const result = await checked(session, "bulk", "POST", "/rest/api/2/issue/bulk", auth, {
      issueUpdates: slice.map((item) => ({
        fields: { project: { key: project }, issuetype: { name: item.type }, ...item.fields },
      })),
    });
    if (result.errors?.length) {
      const first = result.errors[0].elementErrors;
      throw new TypeError(`Bulk create rejected: ${JSON.stringify(first?.errors ?? first)}`);
    }
    keys.push(...result.issues.map((issue) => issue.key));
  });
  return keys;
}

/** Uses this issue's currently offered native transition; no issue creation or transition retry. */
export async function moveTo({ session, auth, signal }, key, statusName) {
  const path = `/rest/api/2/issue/${key}/transitions`;
  const options = await checked(session, "transitions", "GET", path, auth);
  const match = options.transitions.find((transition) => transition.to.name === statusName);
  if (!match) throw new TypeError(`No transition to ${statusName}`);
  signal?.throwIfAborted();
  await checked(session, "transition", "POST", path, auth, { transition: { id: match.id } });
}

/** Reuses the seed's authenticated native port for an explicitly planned, currently editable field. */
export async function updateFields({ session, auth, signal }, key, fields) {
  const path = `/rest/api/2/issue/${encodeURIComponent(key)}`;
  const metadata = await checked(session, "edit-fields", "GET", `${path}/editmeta`, auth);
  for (const id of Object.keys(fields)) {
    if (!metadata.fields?.[id]?.operations?.includes("set"))
      throw new TypeError("Planned field is not currently editable");
  }
  signal?.throwIfAborted();
  await checked(session, "update-fields", "PUT", path, auth, { fields });
}

function epicPlan(fields) {
  const rules = STRUCTURE_RULES.Epic;
  return buildCorpus(1)
    .truth.filter((_, index) => (index + 1) % 10 !== 0)
    .map((requirement, index) => {
      const n = index + 1;
      const deviations = [];
      if (n % 5 === 0) deviations.push("summary");
      if (n % 6 === 0) deviations.push("section:Abgrenzung");
      if (n % 8 === 0) deviations.push("label:anforderung");
      const sections = rules.sections.filter((name) => !deviations.includes(`section:${name}`));
      return {
        requirement: requirement.id,
        deviations,
        type: "Epic",
        fields: {
          summary: deviations.includes("summary")
            ? requirement.title
            : `[${requirement.id}] ${requirement.title}`,
          [fields.epicName]: requirement.id,
          description: wiki(sections),
          labels: deviations.includes("label:anforderung") ? [] : ["anforderung"],
        },
      };
    });
}

function taskPlan(fields, epics) {
  const statuses = ["Done", "In Progress", "To Do"];
  return epics.flatMap((epic, epicIndex) =>
    [0, 1, 2].map((offset) => {
      const n = epicIndex * 3 + offset + 1;
      const deviations = [];
      if (n % 11 === 0) deviations.push("parent");
      if (n % 7 === 0) deviations.push("section:Testhinweise");
      // Only when the instance offers an estimate field on the Task screen; otherwise
      // seed-estimates.mjs adds the field and the estimates afterwards.
      const estimated = fields.storyPoints !== undefined;
      if (estimated && n % 13 === 0) deviations.push("estimate");
      const sections = STRUCTURE_RULES.Task.sections.filter(
        (name) => !deviations.includes(`section:${name}`),
      );
      return {
        epic: epic.key,
        status: statuses[n % statuses.length],
        points: (n % 5) + 1,
        deviations,
        type: "Task",
        fields: {
          summary: `Umsetzung ${epic.requirement} Schritt ${offset + 1}`,
          description: wiki(sections),
          ...(deviations.includes("parent") ? {} : { [fields.epicLink]: epic.key }),
          ...(!estimated || deviations.includes("estimate")
            ? {}
            : { [fields.storyPoints]: (n % 5) + 1 }),
        },
      };
    }),
  );
}

function bugPlan(fields, epics) {
  return epics
    .filter((_, index) => index % 4 === 0)
    .map((epic, index) => {
      const deviations = index % 3 === 2 ? ["parent"] : [];
      return {
        epic: epic.key,
        status: index % 2 === 0 ? "In Progress" : "To Do",
        deviations,
        type: "Bug",
        fields: {
          summary: `Abweichung von ${epic.requirement}`,
          description: wiki(STRUCTURE_RULES.Bug.sections),
          priority: { name: "High" },
          ...(deviations.includes("parent") ? {} : { [fields.epicLink]: epic.key }),
        },
      };
    });
}

/** The truth file describes exactly what was seeded, so a partly seeded project must stop here. */
async function assertEmptyProject({ session, auth }, key) {
  const jql = encodeURIComponent(`project = ${key}`);
  const found = await checked(
    session,
    `project-${key}-empty`,
    "GET",
    `/rest/api/2/search?jql=${jql}&maxResults=0`,
    auth,
  );
  if (found.total !== 0)
    throw new TypeError(
      `Project ${key} already holds ${String(found.total)} issues but the truth file does not record it; reset the lab first`,
    );
}

async function seedBase(context) {
  await ensureProject(context, "REQ", "Anforderungen Schadenmeldung");
  await ensureProject(context, "RPT", "Auswertung Schadenmeldung");
  await assertEmptyProject(context, "RPT");
  const fields = await fieldIds(context, "RPT");
  const epics = epicPlan(fields);
  (await bulkCreate(context, "RPT", epics)).forEach((key, index) => (epics[index].key = key));
  const tasks = taskPlan(fields, epics);
  (await bulkCreate(context, "RPT", tasks)).forEach((key, index) => (tasks[index].key = key));
  const subtasks = tasks
    .filter((_, index) => index % 5 === 0)
    .map((task) => ({
      parent: task.key,
      deviations: [],
      type: "Sub-task",
      fields: { summary: `Teilaufgabe zu ${task.key}`, parent: { key: task.key } },
    }));
  (await bulkCreate(context, "RPT", subtasks)).forEach((key, index) => (subtasks[index].key = key));
  const bugs = bugPlan(fields, epics);
  (await bulkCreate(context, "RPT", bugs)).forEach((key, index) => (bugs[index].key = key));
  const moving = [...tasks, ...bugs].filter((item) => item.status !== "To Do");
  await inBatches(moving, 1, (item) => moveTo(context, item.key, item.status));
  const strip = ({ fields: _fields, type, ...rest }) => ({ type, ...rest });
  privateJson(context.truthPath, {
    schemaVersion: 1,
    projects: { work: "REQ", report: "RPT" },
    fieldIds: fields,
    uncoveredRequirements: buildCorpus(1)
      .truth.filter((_, index) => (index + 1) % 10 === 0)
      .map((item) => item.id),
    issues: [...epics, ...tasks, ...subtasks, ...bugs].map((item) => strip(item)),
  });
  console.log(
    JSON.stringify({
      operation: "requirements-seed",
      epics: epics.length,
      tasks: tasks.length,
      subtasks: subtasks.length,
      bugs: bugs.length,
    }),
  );
}

/** The ids come from a fresh task, whose workflow offers each status the plan moves issues to. */
async function transitionIds({ session, auth }, sampleKey) {
  const path = `/rest/api/2/issue/${sampleKey}/transitions`;
  const options = await checked(session, "large-transitions", "GET", path, auth);
  return new Map(options.transitions.map((transition) => [transition.to.name, transition.id]));
}

export async function inBatches(items, size, step, from = 0) {
  if (from >= items.length) return;
  await Promise.all(items.slice(from, from + size).map((item) => step(item)));
  return inBatches(items, size, step, from + size);
}

async function moveAll(context, plan, keys) {
  const { session, auth } = context;
  const ids = await transitionIds(context, keys[plan.findIndex((item) => item.type === "Task")]);
  const moves = plan.flatMap((item, index) =>
    item.status === "To Do" ? [] : [[keys[index], item.status]],
  );
  await inBatches(moves, 5, async ([key, status]) => {
    const id = ids.get(status);
    if (id === undefined) throw new TypeError(`No transition to ${status}`);
    const path = `/rest/api/2/issue/${key}/transitions`;
    const moved = await labRequest(session, "POST", path, auth, { transition: { id } });
    if (moved.status !== 204) throw new TypeError(`Transition of ${key} answered ${moved.status}`);
  });
  return moves.length;
}

function largeEpicInputs(epics, fields) {
  return epics.map((item, index) => ({
    type: item.type,
    fields: {
      summary: item.summary,
      labels: item.labels,
      [fields.epicName]: `Paket ${index + 1}`,
    },
  }));
}

function largeMemberInputs(members, fields, epicKeys) {
  return members.map((item) => ({
    type: item.type,
    fields: {
      summary: item.summary,
      labels: item.labels,
      ...(item.epic === undefined ? {} : { [fields.epicLink]: epicKeys[item.epic] }),
    },
  }));
}

/** Adds LRG to a seeded laboratory; the truth keeps every other entry exactly as it was. */
async function seedLarge(context) {
  const recorded = JSON.parse(readFileSync(context.truthPath, "utf8"));
  if (recorded.large !== undefined) {
    console.log(
      JSON.stringify({ operation: "requirements-seed", skipped: "large project exists" }),
    );
    return;
  }
  await ensureProject(context, LARGE_PROJECT, "Auswertung Großprojekt");
  await assertEmptyProject(context, LARGE_PROJECT);
  const fields = await fieldIds(context, LARGE_PROJECT);
  if (fields.epicLink === undefined || fields.epicName === undefined)
    throw new TypeError(`${LARGE_PROJECT} offers no Epic Link or Epic Name field`);
  const plan = largePlan();
  const epics = plan.filter((item) => item.type === "Epic");
  const epicKeys = await bulkCreate(context, LARGE_PROJECT, largeEpicInputs(epics, fields));
  const members = plan.filter((item) => item.type !== "Epic");
  const memberKeys = await bulkCreate(
    context,
    LARGE_PROJECT,
    largeMemberInputs(members, fields, epicKeys),
  );
  const keys = [...epicKeys, ...memberKeys];
  const moved = await moveAll(context, plan, keys);
  privateJson(context.truthPath, {
    ...recorded,
    projects: { ...recorded.projects, large: LARGE_PROJECT },
    large: largeTruth(plan, keys, { epicLink: fields.epicLink, epicName: fields.epicName }),
  });
  console.log(
    JSON.stringify({
      operation: "requirements-seed",
      project: LARGE_PROJECT,
      issues: plan.length,
      epics: epics.length,
      transitions: moved,
    }),
  );
}

function cliOptions(args) {
  const [directory, ...options] = args;
  if (!directory || (options.length > 0 && !(options.length === 2 && options[0] === "--only")))
    throw new TypeError("Usage: seed-projects.mjs <session-directory> [--only LRG]");
  const only = options[1];
  if (only !== undefined && only !== LARGE_PROJECT)
    throw new TypeError(`--only accepts ${LARGE_PROJECT}`);
  return { directory, only };
}

export async function main(args) {
  const { directory, only } = cliOptions(args);
  const session = loadSession(directory);
  const context = {
    session,
    auth: basicAuth(session, "admin"),
    truthPath: join(session.directory, "requirements-truth.json"),
  };
  // A marker left by a seed whose requirement restore failed must be recovered before any skip.
  await recoverFixtureFieldRequirement(session);
  if (only === undefined && existsSync(context.truthPath)) {
    console.log(JSON.stringify({ operation: "requirements-seed", skipped: "truth exists" }));
    return;
  }
  if (only !== undefined && !existsSync(context.truthPath))
    throw new TypeError("--only adds to a seeded laboratory: run the full seed first");
  const largeSeeded =
    only !== undefined && JSON.parse(readFileSync(context.truthPath, "utf8")).large !== undefined;
  if (largeSeeded) return seedLarge(context);
  // The qualification lab's required field would otherwise reject every bulk create here.
  await withFixtureFieldOptional(session, async () => {
    if (only === undefined) await seedBase(context);
    await seedLarge(context);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
