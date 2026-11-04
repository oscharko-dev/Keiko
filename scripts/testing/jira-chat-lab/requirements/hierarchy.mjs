// S08 and S09 of epic #4173 (#4176, #4178): a bug with its epic relation and an issue link, and
// sub-tasks under a task. The pure graders compare what Jira holds after the turn (issue links,
// the epic link field, the parent field) with the request; the journeys only send the request.
// `fields-writable` of both scenarios is the field probe's obligation (probes.mjs), not a journey's.
import { STRUCTURE_RULES } from "./corpus.mjs";
import { countsOf, result, snapshotBefore } from "./journey-support.mjs";
import { sectionsPresent, turnIssues } from "./oracles.mjs";

const REQ_EPICS = (requirementId) =>
  `project = REQ AND issuetype = Epic AND summary ~ "${requirementId}"`;

/** The epics of a requirement and the tasks assigned to them, as Jira holds them now. */
async function epicsAndTasks(ctx, requirementId) {
  const link = ctx.truth.fieldIds.epicLink;
  const [epics, tasks] = await Promise.all([
    ctx.search(REQ_EPICS(requirementId), "summary"),
    ctx.search("project = REQ AND issuetype = Task", `summary,${link}`),
  ]);
  const epicKeys = new Set(epics.map((epic) => epic.key));
  const taskKeys = new Set(
    tasks.filter((task) => epicKeys.has(task.fields[link])).map((task) => task.key),
  );
  return { epicKeys, taskKeys };
}

// ---------- S08: bug with epic relation and issue link ----------

/** The issue on the other end of a link of the type "Relates", in either direction. */
function relatedKeys(issue) {
  const links = Array.isArray(issue.fields.issuelinks) ? issue.fields.issuelinks : [];
  return links
    .filter((entry) => /^relates/i.test(entry.type?.name ?? ""))
    .map((entry) => entry.outwardIssue?.key ?? entry.inwardIssue?.key)
    .filter((key) => typeof key === "string");
}

/**
 * Grades the bug a turn produced: exactly one new bug with the priority and the sections of the
 * structure rule (`created`), assigned to the epic of the requirement (`parent`) and linked with
 * the link type "Relates" to a task of that epic (`link`).
 */
export function gradeBug({ bugs, epicKeys, taskKeys, epicLinkField }) {
  const [bug] = bugs.credited;
  const single = bugs.credited.length === 1 && bugs.duplicates.length === 0;
  const created =
    single &&
    Boolean(bug.fields.priority?.name) &&
    sectionsPresent(bug.fields.description, STRUCTURE_RULES.Bug.sections);
  return {
    created,
    parent: single && epicKeys.has(bug.fields[epicLinkField]),
    link: single && relatedKeys(bug).some((key) => taskKeys.has(key)),
    key: single ? bug.key : undefined,
  };
}

const BUG_PROMPT =
  "Lege im Jira-Projekt REQ für die Anforderung LH-002 einen Fehler (Vorgangstyp Bug) nach der Strukturvorgabe an. Ordne den Bug dem Epic von LH-002 zu und verknüpfe ihn über eine Vorgangsverknüpfung vom Typ „Relates“ mit einer Umsetzungsaufgabe (Task) von LH-002. Lege das Epic und die Task an, falls sie fehlen. Melde die Schlüssel oder den genauen Fehler.";

export async function bugWithRelationAndLink(ctx, chat) {
  const query = "project = REQ AND issuetype = Bug";
  const epicLink = ctx.truth.fieldIds.epicLink;
  const before = await snapshotBefore(ctx, query);
  const turn = await ctx.turn(chat, BUG_PROMPT);
  const bugs = turnIssues({
    before,
    issues: await ctx.search(query, `summary,description,labels,priority,issuelinks,${epicLink}`),
    exchanges: turn.toolExchanges,
  });
  const { epicKeys, taskKeys } = await epicsAndTasks(ctx, "LH-002");
  const grade = gradeBug({ bugs, epicKeys, taskKeys, epicLinkField: epicLink });
  return result(
    grade.created && grade.parent && grade.link ? "green" : "red",
    turn,
    `${countsOf(bugs, "bugs")}; priority and sections ${grade.created}, assigned to the LH-002 epic ${grade.parent}, linked (Relates) to a task of that epic ${grade.link}`,
    ["bug-created", "parent-relation", "issue-link"],
  );
}

// ---------- S09: sub-tasks under a task ----------

const SUBTASKS_REQUESTED = 2;

/**
 * Grades the sub-tasks a turn produced: exactly two new sub-tasks with a summary (`created`), each
 * under a task assigned to the epic of the requirement (`parent`).
 */
export function gradeSubtasks({ subtasks, taskKeys }) {
  const clean = subtasks.credited.length === SUBTASKS_REQUESTED && subtasks.duplicates.length === 0;
  const parents = subtasks.credited.map((subtask) => subtask.fields.parent?.key);
  return {
    created: clean && subtasks.credited.every((subtask) => Boolean(subtask.fields.summary)),
    parent: clean && parents.every((key) => taskKeys.has(key)),
    parents: new Set(parents.filter((key) => key !== undefined)).size,
  };
}

const SUBTASK_PROMPT =
  "Lege im Jira-Projekt REQ zur Anforderung LH-003 zwei Sub-Tasks (Vorgangstyp Sub-task) unter einer Umsetzungsaufgabe (Task) an, die dem Epic von LH-003 zugeordnet ist. Lege das Epic und die Task an, falls sie fehlen. Melde die Schlüssel oder den genauen Fehler.";

export async function subtasksUnderTask(ctx, chat) {
  const query = 'project = REQ AND issuetype = "Sub-task"';
  const before = await snapshotBefore(ctx, query);
  const turn = await ctx.turn(chat, SUBTASK_PROMPT);
  const subtasks = turnIssues({
    before,
    issues: await ctx.search(query, "summary,description,labels,parent"),
    exchanges: turn.toolExchanges,
  });
  const { taskKeys } = await epicsAndTasks(ctx, "LH-003");
  const grade = gradeSubtasks({ subtasks, taskKeys });
  return result(
    grade.created && grade.parent ? "green" : "red",
    turn,
    `${countsOf(subtasks, "sub-tasks")}; ${SUBTASKS_REQUESTED} with a summary ${grade.created}, under a task of the LH-003 epic ${grade.parent} (${grade.parents} distinct parents)`,
    ["subtasks-created", "parent-task"],
  );
}
