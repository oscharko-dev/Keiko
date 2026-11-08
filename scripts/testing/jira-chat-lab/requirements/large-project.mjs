// The large seeded project LRG of the progress scenario S10 (epic #4173, #4174, #4181 AC1): a
// report project of about 2,500 issues whose size no product limit may be tuned to. The seed
// (`seed-projects.mjs --only LRG`) and the oracle share one deterministic plan, so the ground truth
// is computed from the generator and never read back from Jira. The oracle reads Jira itself
// through JQL counts (never the issues, so it does not share the paging the report tool is graded
// on) and requires the completed `jira.report` figures and the answer's numbers to equal them.
import { gradeProgress, progressPrompt } from "./progress-report.mjs";
import { completedToolExchange } from "./tool-exchanges.mjs";
import { NO_TURN, sequentially } from "./journey-support.mjs";

export const LARGE_PROJECT = "LRG";
const CATEGORY_NAMES = Object.freeze(["To Do", "In Progress", "Done"]);

/** 45 epics with 30 to 60 tasks and 8 to 12 bugs each: 2,490 issues. */
export const LARGE_SHAPE = Object.freeze({
  epics: 45,
  tasksBase: 30,
  taskSpread: 7,
  taskStep: 5,
  bugsBase: 8,
  bugSpread: 5,
});

// A task or bug is spread over the statuses by its position and its epic, so every epic holds a
// different number of done issues and a figure taken from the wrong epic cannot match by chance.
function taskStatus(position, epic) {
  const slot = (position + 3 * epic) % 20;
  if (slot < 8) return "Done";
  return slot < 13 ? "In Progress" : "To Do";
}
function bugStatus(position, epic) {
  const slot = (position * 3 + epic) % 5;
  if (slot < 2) return "Done";
  return slot === 2 ? "In Progress" : "To Do";
}

function tasksOf(shape, epic) {
  const length = shape.tasksBase + (epic % shape.taskSpread) * shape.taskStep;
  return Array.from({ length }, (_, position) => ({
    type: "Task",
    epic,
    status: taskStatus(position + 7 * epic, epic),
    summary: `Umsetzung Paket ${epic + 1} Schritt ${position + 1}`,
  }));
}
function bugsOf(shape, epic) {
  const length = shape.bugsBase + (epic % shape.bugSpread);
  return Array.from({ length }, (_, position) => ({
    type: "Bug",
    epic,
    status: bugStatus(position + 5 * epic, epic),
    summary: `Abweichung Paket ${epic + 1} Nr. ${position + 1}`,
  }));
}

function withSeededDeviations(items) {
  let taskOrdinal = 0;
  return items.map((item, index) => {
    if (item.type === "Task") taskOrdinal += 1;
    const missingLabel = (index + 1) % 7 === 0;
    const missingParent = item.type === "Task" && taskOrdinal % 11 === 0;
    return {
      ...item,
      epic: missingParent ? undefined : item.epic,
      labels: missingLabel ? [] : ["anforderung"],
      deviations: [
        ...(missingLabel ? ["label:anforderung"] : []),
        ...(missingParent ? ["parent"] : []),
      ],
    };
  });
}

/**
 * The issues of the project in creation order: the epics, then the tasks, then the bugs of every
 * epic. `epic` is the actual parent index, absent for every eleventh task. Every seventh issue
 * lacks the required label. Epics stay "To Do" like those of RPT; all status figures are unchanged.
 */
export function largePlan(shape = LARGE_SHAPE) {
  const indices = Array.from({ length: shape.epics }, (_, epic) => epic);
  return withSeededDeviations([
    ...indices.map((epic) => ({
      type: "Epic",
      epic: undefined,
      status: "To Do",
      summary: `Sammelpaket ${epic + 1}`,
    })),
    ...indices.flatMap((epic) => tasksOf(shape, epic)),
    ...indices.flatMap((epic) => bugsOf(shape, epic)),
  ]);
}

/**
 * The ground truth recorded for the plan once Jira assigned `keys` (one per plan item, in order):
 * issues per type and status and, per epic, its members and its done members.
 */
export function largeTruth(plan, keys, fieldIds) {
  if (keys.length !== plan.length) throw new TypeError("One key per planned issue is required");
  const epicKeys = plan.flatMap((item, index) => (item.type === "Epic" ? [keys[index]] : []));
  const combinations = new Map();
  for (const { type, status } of plan) {
    combinations.set(`${type};${status}`, (combinations.get(`${type};${status}`) ?? 0) + 1);
  }
  const counts = [...combinations]
    .map(([key, count]) => ({ type: key.split(";")[0], status: key.split(";")[1], count }))
    .sort((a, b) => `${a.type};${a.status}`.localeCompare(`${b.type};${b.status}`));
  const membersOf = (epic) => plan.filter((item) => item.epic === epic);
  return {
    seedVersion: 2,
    project: LARGE_PROJECT,
    fieldIds,
    issueCount: plan.length,
    counts,
    issues: plan.map((item, index) => ({
      key: keys[index],
      type: item.type,
      status: item.status,
      labels: [...item.labels],
      ...(item.epic === undefined ? {} : { epic: epicKeys[item.epic] }),
      deviations: [...item.deviations],
    })),
    epics: epicKeys.map((key, epic) => ({
      key,
      members: membersOf(epic).length,
      done: membersOf(epic).filter((item) => item.status === "Done").length,
    })),
  };
}

// ---------- the independent Jira read ----------

const quoted = (value) => `"${value}"`;
const IN_PROJECT = `project = ${LARGE_PROJECT}`;

const countsOfEpic = async (count, key) => {
  const members = `${IN_PROJECT} AND "Epic Link" = ${key}`;
  return [
    key,
    { total: await count(members), done: await count(`${members} AND statusCategory = Done`) },
  ];
};
const countsOfType = async (count, type) => {
  const ofType = `${IN_PROJECT} AND issuetype = ${quoted(type)}`;
  return [
    type,
    { total: await count(ofType), done: await count(`${ofType} AND statusCategory = Done`) },
  ];
};

/**
 * What Jira holds for the project, by JQL counts alone: issues in total, per status category, per
 * type (with its done issues), per type and status, and per epic (members and done members).
 */
export async function largeJiraFigures(count, large) {
  const total = await count(IN_PROJECT);
  const category = Object.fromEntries(
    await sequentially(CATEGORY_NAMES, async (name) => [
      name,
      await count(`${IN_PROJECT} AND statusCategory = ${quoted(name)}`),
    ]),
  );
  const types = [...new Set(large.counts.map((entry) => entry.type))];
  const byType = new Map(await sequentially(types, (type) => countsOfType(count, type)));
  const byStatus = new Map(
    await sequentially(large.counts, async ({ type, status }) => [
      `${type};${status}`,
      await count(`${IN_PROJECT} AND issuetype = ${quoted(type)} AND status = ${quoted(status)}`),
    ]),
  );
  const epics = new Map(await sequentially(large.epics, ({ key }) => countsOfEpic(count, key)));
  return { total, category, byType, byStatus, epics };
}

const sameMap = (left, right, equal) =>
  left.size === right.size && [...left].every(([key, value]) => equal(value, right.get(key)));

/** Whether Jira still holds exactly what the seed recorded (a drifted laboratory proves nothing). */
export function matchesSeededTruth(jira, large) {
  const status = new Map(
    large.counts.map((entry) => [`${entry.type};${entry.status}`, entry.count]),
  );
  const epics = new Map(
    large.epics.map((epic) => [epic.key, { total: epic.members, done: epic.done }]),
  );
  return (
    jira.total === large.issueCount &&
    sameMap(jira.byStatus, status, (a, b) => a === b) &&
    sameMap(jira.epics, epics, (a, b) => a?.total === b?.total && a?.done === b?.done)
  );
}

/** The truth `gradeProgress` takes, from the JQL counts (lower-cased keys, as the answer is read). */
function progressTruthOfJira(jira) {
  return {
    issueCount: jira.total,
    counts: new Map([...jira.byStatus].map(([key, count]) => [key.toLowerCase(), count])),
    epics: jira.epics,
    estimate: undefined,
  };
}

// ---------- what the completed report states ----------

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value) => (Array.isArray(value) ? value.filter((item) => isRecord(item)) : []);
const EPIC_FIGURE = new RegExp(String.raw`^(${LARGE_PROJECT}-\d+);[^;]*;(\d+);(\d+)$`, "u");

const succeeded = (exchanges) =>
  (Array.isArray(exchanges) ? exchanges : [])
    .filter((exchange) => completedToolExchange(exchange, "jira.report"))
    .map((exchange) => exchange.result.data)
    .filter((data) => isRecord(data) && data.outcome === "succeeded" && data.status === "complete");

const totalOf = (rows) => rows.reduce((sum, row) => sum + row.total, 0);

/** What a summary states about the project and its types, from its type and status rows. */
function progressOfRows(rows) {
  const ofCategory = (category) => totalOf(rows.filter((row) => row.category === category));
  const types = [...new Set(rows.map((row) => row.typeName))];
  return {
    project: {
      total: totalOf(rows),
      new: ofCategory("new"),
      indeterminate: ofCategory("indeterminate"),
      done: ofCategory("done"),
    },
    byType: types.map((typeName) => {
      const ofType = rows.filter((row) => row.typeName === typeName);
      const done = totalOf(ofType.filter((row) => row.category === "done"));
      return { typeName, total: totalOf(ofType), done };
    }),
    byStatus: { items: rows },
  };
}

const sectionPages = (results, reportId, name) =>
  results.filter((data) => data.reportId === reportId && data.section?.name === name);

/**
 * The report of a turn that read the project's status and epic sections without its summary. A page
 * names its report by id, and the call that opened the report names the project. Every figure a
 * summary would state is then derived from those rows and graded the same way.
 */
function sectionReportOfTurn(exchanges) {
  const scoped = (Array.isArray(exchanges) ? exchanges : [])
    .filter((exchange) => completedToolExchange(exchange, "jira.report"))
    .filter((exchange) => exchange.call?.arguments?.projectKey === LARGE_PROJECT)
    .map((exchange) => exchange.result.data);
  const results = succeeded(exchanges);
  const latest = (name) => scoped.filter((data) => data.section?.name === name).at(-1)?.reportId;
  const statuses = sectionPages(results, latest("statuses"), "statuses");
  const pages = sectionPages(results, latest("epics"), "epics");
  if (statuses.length === 0 || pages.length === 0) return undefined;
  const rows = statuses.flatMap((page) => records(page.section.items));
  return {
    summary: {
      report: {
        completeness: statuses[0].report?.completeness,
        progress: progressOfRows(rows),
        epics: { total: pages[0].section.total, items: [] },
      },
    },
    pages,
  };
}

/**
 * The last completed summary of the project in the turn, and the epic section pages that belong to
 * that very report (a page names its report by digest, not by scope).
 */
function reportOfTurn(exchanges) {
  const results = succeeded(exchanges);
  const summary = results
    .filter((data) => isRecord(data.report) && data.report.scope?.projectKey === LARGE_PROJECT)
    .at(-1);
  if (summary === undefined) return sectionReportOfTurn(exchanges);
  const pages = results.filter(
    (data) =>
      isRecord(data.section) &&
      data.section.name === "epics" &&
      data.report?.digest === summary.report.digest,
  );
  return { summary, pages };
}

const epicEntry = (epic) => [epic.key, epic.members?.total, epic.members?.done];

/** Every epic the report states: summary items, epic section pages and the plain figure lines. */
function statedEpics({ summary, pages }) {
  return [
    ...records(summary.report.epics?.items).map((item) => epicEntry(item)),
    ...pages.flatMap((page) => records(page.section.items).map((item) => epicEntry(item))),
    ...String(summary.report.figures ?? "")
      .split("\n")
      .flatMap((line) => {
        const match = EPIC_FIGURE.exec(line.trim());
        return match === null ? [] : [[match[1], Number(match[2]), Number(match[3])]];
      }),
  ];
}

function expectEqual(problems, label, actual, expected) {
  if (actual !== expected)
    problems.push(`${label} ${String(actual)} instead of ${String(expected)}`);
}

function projectProblems(data, jira) {
  const problems = [];
  const project = data.report.progress?.project ?? {};
  expectEqual(problems, "issues read", data.report.completeness?.issuesRead, jira.total);
  expectEqual(problems, "issues", project.total, jira.total);
  expectEqual(problems, "to do", project.new, jira.category["To Do"]);
  expectEqual(problems, "in progress", project.indeterminate, jira.category["In Progress"]);
  expectEqual(problems, "done", project.done, jira.category.Done);
  return problems;
}

function typeProblems(data, jira) {
  const problems = [];
  const types = new Map(records(data.report.progress?.byType).map((item) => [item.typeName, item]));
  for (const [type, expected] of jira.byType) {
    expectEqual(problems, `${type} issues`, types.get(type)?.total, expected.total);
    expectEqual(problems, `${type} done`, types.get(type)?.done, expected.done);
  }
  expectEqual(problems, "types", types.size, jira.byType.size);
  return problems;
}

function statusProblems(data, jira) {
  const problems = [];
  const rows = records(data.report.progress?.byStatus?.items);
  const stated = new Map(rows.map((item) => [`${item.typeName};${item.statusName}`, item.total]));
  for (const [key, expected] of jira.byStatus)
    expectEqual(problems, key, stated.get(key), expected);
  expectEqual(problems, "type/status rows", stated.size, jira.byStatus.size);
  return problems;
}

/** The epics the results state; one stated twice with other figures is a problem of its own. */
function collectStated(report) {
  const problems = [];
  const stated = new Map();
  for (const [key, total, done] of statedEpics(report)) {
    const known = stated.get(key);
    if (known !== undefined && (known[0] !== total || known[1] !== done))
      problems.push(`${key} stated twice`);
    stated.set(key, [total, done]);
  }
  return { problems, stated };
}

function epicProblems(report, jira) {
  const { problems, stated } = collectStated(report);
  for (const [key, expected] of jira.epics) {
    const actual = stated.get(key);
    if (actual === undefined) problems.push(`${key} not stated`);
    else if (actual[0] !== expected.total || actual[1] !== expected.done)
      problems.push(`${key} ${actual.join("/")} instead of ${expected.total}/${expected.done}`);
  }
  for (const key of stated.keys()) if (!jira.epics.has(key)) problems.push(`${key} invented`);
  return { problems, stated: stated.size };
}

/**
 * Compares the last completed report of the project with what Jira holds, or undefined when the
 * turn holds none. Each problem is a short sentence; none means every figure the report states
 * equals Jira's and the report states all of them (totals, categories, types, type and status
 * rows, the epic count and every epic).
 */
export function gradeReportFigures(exchanges, jira) {
  const report = reportOfTurn(exchanges);
  if (report === undefined) return undefined;
  const data = report.summary;
  const epics = epicProblems(report, jira);
  const problems = [
    ...projectProblems(data, jira),
    ...typeProblems(data, jira),
    ...statusProblems(data, jira),
    ...(data.report.epics?.total === jira.epics.size
      ? []
      : [`epics ${String(data.report.epics?.total)} instead of ${jira.epics.size}`]),
    ...epics.problems,
  ];
  return { problems, epicsStated: epics.stated };
}

// ---------- the journey part ----------

const NOT_CREDITED = (turn, detail) => ({
  turn,
  part: { label: "large project", status: "unverified", covers: [], detail },
});

function gradedPart(turn, jira, report) {
  const answer = gradeProgress(turn.answer, progressTruthOfJira(jira));
  const ok = report.problems.length === 0 && answer.counts.ok && answer.epics.ok;
  const figures =
    report.problems.length === 0
      ? "equal Jira"
      : `differ: ${report.problems.slice(0, 5).join(", ")}`;
  return {
    turn,
    part: {
      label: "large project",
      status: ok ? "green" : "red",
      covers: ["large-project-report"],
      detail: `${jira.total} issues in ${jira.epics.size} epics; report figures ${figures} (${report.epicsStated} epics stated); answer type/status ${answer.counts.matched}/${answer.counts.expected} exact (${answer.counts.extra} extra), epics ${answer.epics.matched}/${answer.epics.expected}, ${answer.conflicts} conflicting lines`,
    },
  };
}

/**
 * The large-project step of S10: a Chat turn asks for the progress of LRG. Green only when the
 * completed `jira.report` figures equal the JQL counts exactly and the answer's lines equal them
 * too; absent evidence (no seeded project, no complete report, a drifted laboratory) credits
 * nothing.
 */
export async function largeProjectPart(ctx) {
  const large = ctx.truth.large;
  if (large === undefined)
    return NOT_CREDITED(
      NO_TURN,
      "the laboratory has no large project; run seed-projects.mjs --only LRG",
    );
  if (ctx.freshChat === undefined || ctx.count === undefined)
    return NOT_CREDITED(
      NO_TURN,
      "the context offers no second Chat or JQL count; nothing is credited",
    );
  const turn = await ctx.turn(
    await ctx.freshChat("autonomous-delivery"),
    progressPrompt(undefined, LARGE_PROJECT),
  );
  const jira = await largeJiraFigures(ctx.count, large);
  if (!matchesSeededTruth(jira, large))
    return NOT_CREDITED(
      turn,
      `Jira holds ${jira.total} issues but the seed recorded ${large.issueCount} with other figures; the laboratory drifted and nothing is credited`,
    );
  const report = gradeReportFigures(turn.toolExchanges, jira);
  if (report === undefined)
    return NOT_CREDITED(
      turn,
      `no complete jira.report result for ${LARGE_PROJECT} in the turn; nothing is credited`,
    );
  return gradedPart(turn, jira, report);
}
