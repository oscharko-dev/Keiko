// The four estimate cases of the product's report rule (#4369, #4356), one small project each, so the
// S10 oracle's native derivation can be proven on every case and not only on RPT's fallback:
//   ESF fallback  board estimates with Story Points, every value sits in Original Estimate
//   ESR reverse   board estimates with Original Estimate, every value sits in Story Points
//   ESB both      board estimates with Story Points, Stories hold points and Tasks hold time
//   ESN neither   board estimates with Story Points, no issue holds an estimate
// Each project's case is derived natively from what Jira holds after the seed and refused when it is
// not the intended one, so a fixture that does not show its case never reaches a run. Select a case
// for S10 with KEIKO_JIRA_LAB_ESTIMATE_PROJECT=<ESF|ESR|ESB|ESN> (default RPT). Receipt:
// <session>/estimate-cases-truth.json.
import {
  TIME_FIELD,
  configuredEstimateField,
  deriveEstimate,
  storyPointsFieldId,
} from "./estimate-rule.mjs";
import { runFixtureSeed } from "./fixture-seed-cli.mjs";
import { isMainModule } from "../../../lib/is-main-module.mjs";
import { ensureOnProjectScreen } from "./seed-estimate-mix.mjs";
import { bulkCreate, ensureProject, moveTo } from "./seed-projects.mjs";

/** The intended case per project and the estimate field its board is configured with. */
export const ESTIMATE_CASE_PROJECTS = Object.freeze({
  ESF: { expected: "fallback", board: "points", title: "Schätzung Rückfall" },
  ESR: { expected: "fallback", board: "time", title: "Schätzung umgekehrt" },
  ESB: { expected: "both", board: "points", title: "Schätzung beides" },
  ESN: { expected: "neither", board: "points", title: "Schätzung keine" },
});
const STATUSES = ["Done", "In Progress", "To Do"];

/** The issues of one case: Tasks hold time, Stories hold points, as the case asks. */
export function estimateCasePlan(key, storyPoints) {
  const hours = [3, 2, 1];
  const task = (index, extra = {}) => ({
    type: "Task",
    status: STATUSES[index],
    fields: { summary: `${key} Aufgabe ${index + 1}`, ...extra },
  });
  const story = (index, extra = {}) => ({
    type: "Story",
    status: STATUSES[index],
    fields: { summary: `${key} Story ${index + 1}`, ...extra },
  });
  const time = (index) => ({ timetracking: { originalEstimate: `${hours[index]}h` } });
  const points = (index) => ({ [storyPoints]: hours[index] });
  const plans = {
    ESF: [0, 1, 2].map((index) => task(index, time(index))),
    ESR: [0, 1, 2].map((index) => story(index, points(index))),
    ESB: [story(0, points(0)), story(1, points(1)), task(2, time(2))],
    ESN: [0, 1, 2].map((index) => task(index)),
  };
  return plans[key];
}

/** Sets the board's estimation statistic; refused when Jira does not report the field afterwards. */
/**
 * The body Jira Software's own estimation endpoint takes. Its three properties are `rapidViewId`,
 * `estimateStatisticId` and `trackingStatisticId` (a live 400 named them 2026-11-14: the earlier
 * `estimationStatisticId` is not one of them), and a statistic is `field_<field id>`.
 */
export function boardEstimationBody(boardId, kind, pointsFieldId) {
  const statistic = kind === "time" ? "field_timeoriginalestimate" : `field_${pointsFieldId}`;
  return { rapidViewId: boardId, estimateStatisticId: statistic, trackingStatisticId: statistic };
}

async function configureBoard(jira, project, kind) {
  const boards = await jira.call(
    "esc-boards",
    "GET",
    `/rest/agile/1.0/board?projectKeyOrId=${project}`,
  );
  const board = boards.values?.[0];
  if (board === undefined) throw new TypeError(`The ${project} project has no board`);
  const fields = await jira.call("esc-fields", "GET", "/rest/api/2/field");
  const points = storyPointsFieldId(fields);
  const wanted = kind === "time" ? TIME_FIELD : points;
  if (
    (await configuredEstimateField((path) => jira.call("esc-config", "GET", path), project)) ===
    wanted
  )
    return wanted;
  await jira.call(
    "esc-configure",
    "PUT",
    "/rest/greenhopper/1.0/rapidviewconfig/estimation",
    boardEstimationBody(board.id, kind, points),
    [200, 204],
  );
  const now = await configuredEstimateField(
    (path) => jira.call("esc-config", "GET", path),
    project,
  );
  if (now !== wanted)
    throw new TypeError(`The ${project} board could not be configured for ${kind}`);
  return wanted;
}

async function seedCase(context, jira, key, spec) {
  await ensureProject(context, key, spec.title);
  const fields = await jira.call("esc-all-fields", "GET", "/rest/api/2/field");
  const storyPoints = storyPointsFieldId(fields);
  await ensureOnProjectScreen(jira, key, "Default Issue", storyPoints);
  await ensureOnProjectScreen(jira, key, "Default Issue", "timetracking");
  const existing = await jira.call(
    "esc-existing",
    "GET",
    `/rest/api/2/search?jql=${encodeURIComponent(`project = ${key}`)}&maxResults=0`,
  );
  if (existing.total === 0) {
    const plan = estimateCasePlan(key, storyPoints);
    const created = await bulkCreate(context, key, plan);
    for (const [index, item] of plan.entries())
      if (item.status !== "To Do") await moveTo(context, created[index], item.status);
  }
  const configured = await configureBoard(jira, key, spec.board);
  const page = await jira.call(
    "esc-read",
    "GET",
    `/rest/api/2/search?jql=${encodeURIComponent(`project = ${key}`)}&fields=issuetype,${storyPoints},${TIME_FIELD}&maxResults=100`,
  );
  const derived = deriveEstimate({ issues: page.issues, configured, storyPoints });
  if (derived.case !== spec.expected)
    throw new TypeError(`${key} shows the case ${derived.case}, not ${spec.expected}`);
  return {
    project: key,
    case: derived.case,
    configuredUnused: derived.configuredUnused,
    issues: page.issues.length,
  };
}

async function seedEstimateCases(context, jira, save) {
  const cases = {};
  for (const [key, spec] of Object.entries(ESTIMATE_CASE_PROJECTS))
    cases[key] = await seedCase(context, jira, key, spec);
  save({ schemaVersion: 1, cases });
  return {
    projects: Object.keys(cases).length,
    cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.case])),
  };
}

function main(args) {
  return runFixtureSeed({
    args,
    name: "seed-estimate-cases.mjs",
    receipt: "estimate-cases-truth.json",
    operation: "requirements-estimate-cases",
    seed: seedEstimateCases,
  });
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
