// S20 of epic #4173 (#4176 AC4): a value Jira itself rejects reaches the model with Jira's own
// field error, and the model's corrected retry succeeds. The lab plans a task into a sprint of the
// work project. Keiko forwards the Jira Software sprint field as opaque JSON and cannot know the
// value shape Jira accepts: the metadata declares an array of strings, while Jira accepts the sprint
// only as one numeric id and answers every other shape with its own error message. The grader
// credits the turn only when such a Jira rejection reached the model before the task was created
// in the requested sprint. Lab-side code may know Jira Software's schemas; product code may not.
import { basicAuth, labRequest } from "../lab-client.mjs";
import { countsOf, result, snapshotBefore } from "./journey-support.mjs";
import { turnIssues } from "./oracles.mjs";
import { toolExchangeOf } from "./tool-exchanges.mjs";

const JSW_SPRINT = "com.pyxis.greenhopper.jira:gh-sprint";
const LAB_SPRINT_NAME = "REQ Lab Sprint";
const WRITE_OPERATIONS = ["jira.create", "jira.draft", "jira.edit"];
const TASK_SUMMARY = "Sprint-Zuordnung der Schadenmeldung prüfen";

/** The id of the sprint field, found by its Jira Software schema on the work project's Task. */
export function sprintFieldId(createFields) {
  return createFields.find((field) => field.schema?.custom === JSW_SPRINT)?.fieldId;
}

/** The sprint ids an issue's sprint field holds: Jira reads them back as objects or strings. */
export function sprintIdsOf(value) {
  const entries = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return entries
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? entry.id
        : /\bid=(\d+)/.exec(String(entry))?.[1],
    )
    .map(Number)
    .filter(Number.isSafeInteger);
}

function rejectedByJira(node) {
  if (typeof node !== "object" || node === null) return false;
  // Keiko's own validation names its `validation` class; a Jira rejection carries only Jira's text.
  if (node.outcome === "rejected" && node.validation === undefined) {
    const texts = [
      ...(Array.isArray(node.messages) ? node.messages : []),
      ...(Array.isArray(node.fieldErrors) ? node.fieldErrors.map((error) => error?.message) : []),
    ];
    if (texts.some((text) => typeof text === "string" && /sprint/i.test(text))) return true;
  }
  return Object.values(node).some(rejectedByJira);
}

/** The position of the first write whose result carries Jira's own sprint error, or -1. */
export function jiraSprintRejection(exchanges) {
  return exchanges.findIndex(
    (exchange) =>
      WRITE_OPERATIONS.some((operation) => toolExchangeOf(exchange, operation)) &&
      rejectedByJira(exchange.result?.data),
  );
}

/** The position of the last write that completed, or -1. */
function lastCompletedWrite(exchanges) {
  return exchanges.findLastIndex(
    (exchange) =>
      WRITE_OPERATIONS.some((operation) => toolExchangeOf(exchange, operation)) &&
      exchange.result?.status === "completed",
  );
}

/**
 * Grades the turn: Jira's own sprint error reached the model (`rejected`), and afterwards exactly
 * one new task was created and holds the requested sprint (`corrected`). Without a Jira rejection
 * the field-error path was never exercised, so a correct task alone verifies nothing.
 */
export function gradeFieldCorrection({ tasks, exchanges, sprintField, sprintId }) {
  const rejection = jiraSprintRejection(exchanges);
  const [task] = tasks.credited;
  const single = tasks.credited.length === 1 && tasks.duplicates.length === 0;
  const inSprint = single && sprintIdsOf(task.fields[sprintField]).includes(sprintId);
  const rejected = rejection >= 0;
  const corrected = rejected && inSprint && lastCompletedWrite(exchanges) > rejection;
  return { rejected, corrected, inSprint, key: single ? task.key : undefined };
}

/** The lab sprint on the work project's board, created once and reused (lab setup, not product). */
async function ensureLabSprint(session, projectKey) {
  const auth = basicAuth(session, "admin");
  const get = async (path) => {
    const response = await labRequest(session, "GET", path, auth);
    if (response.status !== 200) throw new TypeError(`Laboratory read failed (${response.status})`);
    return response.value;
  };
  const boards = await get(`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&type=scrum`);
  const board = boards.values?.[0];
  if (board === undefined) throw new TypeError(`No scrum board for ${projectKey}`);
  const sprints = await get(`/rest/agile/1.0/board/${board.id}/sprint?state=future,active`);
  const existing = sprints.values?.find((sprint) => sprint.name === LAB_SPRINT_NAME);
  if (existing !== undefined) return existing.id;
  const created = await labRequest(session, "POST", "/rest/agile/1.0/sprint", auth, {
    name: LAB_SPRINT_NAME,
    originBoardId: board.id,
  });
  if (created.status !== 201) throw new TypeError(`Sprint creation failed (${created.status})`);
  return created.value.id;
}

/** The lab sprint's id and the work project's sprint field id, as the S20 journey needs them. */
export async function labSprintSetup(session, projectKey) {
  const auth = basicAuth(session, "admin");
  const types = await labRequest(
    session,
    "GET",
    `/rest/api/2/issue/createmeta/${projectKey}/issuetypes`,
    auth,
  );
  const task = types.value?.values?.find((type) => type.name === "Task");
  if (task === undefined) throw new TypeError(`No Task type in ${projectKey}`);
  const page = await labRequest(
    session,
    "GET",
    `/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${task.id}?maxResults=200`,
    auth,
  );
  const fieldId = sprintFieldId(page.value?.values ?? []);
  if (fieldId === undefined) throw new TypeError(`No sprint field on the ${projectKey} Task`);
  return { sprintId: await ensureLabSprint(session, projectKey), fieldId };
}

const prompt = (sprintId) =>
  `Lege im Jira-Projekt REQ eine Aufgabe (Vorgangstyp Task) mit der Zusammenfassung „${TASK_SUMMARY}“ an und plane sie in den Sprint „${LAB_SPRINT_NAME}“ ein (Sprint-ID ${sprintId}). Melde den Schlüssel oder den genauen Fehler.`;

export async function fieldErrorCorrection(ctx, chat) {
  const { sprintId, fieldId } = await ctx.labSprint();
  const query = "project = REQ AND issuetype = Task";
  const before = await snapshotBefore(ctx, query);
  await ctx.deselectSkill(chat);
  const turn = await ctx.turn(chat, prompt(sprintId));
  const tasks = turnIssues({
    before,
    issues: await ctx.search(query, `summary,labels,${fieldId}`),
    exchanges: turn.toolExchanges,
  });
  const grade = gradeFieldCorrection({
    tasks,
    exchanges: turn.toolExchanges,
    sprintField: fieldId,
    sprintId,
  });
  const status = grade.corrected
    ? "green"
    : grade.rejected || !grade.inSprint
      ? "red"
      : "unverified";
  return result(
    status,
    turn,
    `${countsOf(tasks, "tasks")}; Jira's sprint error reached the model ${grade.rejected}, task in the requested sprint ${grade.inSprint}, corrected retry after the rejection ${grade.corrected}`,
    ["jira-field-error-returned", "corrected-retry-succeeds"],
  );
}
