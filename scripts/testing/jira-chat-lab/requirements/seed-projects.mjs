// Seeds the two requirements-lab projects through Jira's admin REST API (#4174).
//   REQ: empty Scrum project the creation journeys write into (S05, S07–S09, S19).
//   RPT: Scrum project with a known ground truth for the report journeys (S10–S13).
// Usage: node seed-projects.mjs <private-session-directory>
// The ground truth is computed from the generator, never read back from Jira, and written to
// <session>/requirements-truth.json. Lab-side code may know Jira Software's field schemas;
// product code may not.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { basicAuth, checked, labRequest, loadSession } from "../lab-client.mjs";
import { privateJson } from "../private-json.mjs";
import { STRUCTURE_RULES, buildCorpus } from "./corpus.mjs";

const [directory] = process.argv.slice(2);
if (!directory) throw new TypeError("Usage: seed-projects.mjs <session-directory>");
const session = loadSession(directory);
const auth = basicAuth(session, "admin");
const truthPath = join(session.directory, "requirements-truth.json");
if (existsSync(truthPath)) {
  console.log(JSON.stringify({ operation: "requirements-seed", skipped: "truth exists" }));
  process.exit(0);
}

const SCRUM = "com.pyxis.greenhopper.jira:gh-scrum-template";
const EPIC_NAME = "com.pyxis.greenhopper.jira:gh-epic-label";
const EPIC_LINK = "com.pyxis.greenhopper.jira:gh-epic-link";
const STORY_POINTS = "com.atlassian.jira.plugin.system.customfieldtypes:float";
const BULK = 50;

async function ensureProject(key, name) {
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
  for (const id of ["10002", "10001", "10000"]) {
    await labRequest(session, "POST", `/rest/api/2/project/${key}/role/${id}`, auth, {
      user: ["keiko-api"],
    });
  }
  return checked(session, `project-${key}-read`, "GET", `/rest/api/2/project/${key}`, auth);
}

async function fieldIds(projectKey) {
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

async function bulkCreate(project, items) {
  const keys = [];
  for (let start = 0; start < items.length; start += BULK) {
    const slice = items.slice(start, start + BULK);
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
  }
  return keys;
}

async function moveTo(key, statusName) {
  const path = `/rest/api/2/issue/${key}/transitions`;
  const options = await checked(session, "transitions", "GET", path, auth);
  const match = options.transitions.find((transition) => transition.to.name === statusName);
  if (!match) throw new TypeError(`No transition to ${statusName}`);
  await checked(session, "transition", "POST", path, auth, { transition: { id: match.id } });
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
async function assertEmptyProject(key) {
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
      `Project ${key} already holds ${String(found.total)} issues but no truth file; reset the lab first`,
    );
}

await ensureProject("REQ", "Anforderungen Schadenmeldung");
await ensureProject("RPT", "Auswertung Schadenmeldung");
await assertEmptyProject("RPT");
const fields = await fieldIds("RPT");
const epics = epicPlan(fields);
(await bulkCreate("RPT", epics)).forEach((key, index) => (epics[index].key = key));
const tasks = taskPlan(fields, epics);
(await bulkCreate("RPT", tasks)).forEach((key, index) => (tasks[index].key = key));
const subtasks = tasks
  .filter((_, index) => index % 5 === 0)
  .map((task) => ({
    parent: task.key,
    deviations: [],
    type: "Sub-task",
    fields: { summary: `Teilaufgabe zu ${task.key}`, parent: { key: task.key } },
  }));
(await bulkCreate("RPT", subtasks)).forEach((key, index) => (subtasks[index].key = key));
const bugs = bugPlan(fields, epics);
(await bulkCreate("RPT", bugs)).forEach((key, index) => (bugs[index].key = key));
for (const item of [...tasks, ...bugs]) {
  if (item.status !== "To Do") await moveTo(item.key, item.status);
}

const strip = ({ fields: _fields, type, ...rest }) => ({ type, ...rest });
privateJson(truthPath, {
  schemaVersion: 1,
  projects: { work: "REQ", report: "RPT" },
  fieldIds: fields,
  uncoveredRequirements: buildCorpus(1)
    .truth.filter((_, index) => (index + 1) % 10 === 0)
    .map((item) => item.id),
  issues: [...epics, ...tasks, ...subtasks, ...bugs].map(strip),
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
