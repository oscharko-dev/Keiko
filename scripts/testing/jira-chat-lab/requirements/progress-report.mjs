// Oracle of the progress journey S10 (epic #4173, #4174, #4181). The ground truth is computed from
// the issues Jira holds after the turn (counts per type and status, members and done members per
// epic, estimate totals), never from the model's answer or from the report tool it may have used.
// The answer has to follow a strict line format the prompt itself asks for:
//   ANZAHL;<type>;<status>;<count>        one line per type/status combination
//   EPIC;<key>;<members>;<done members>   one line per epic
//   SCHÄTZUNG;<total>;<done>;<remaining>  one line (only when the instance has an estimate field;
//                                         a time-tracking estimate is asked for in hours)

import { JIRA_REPORT_ESTIMATE_UNAVAILABLE_REASONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { toolExchangeOf } from "./tool-exchanges.mjs";
import { NO_TURN } from "./journey-support.mjs";

const DONE_CATEGORY = "done";
const EPSILON = 1e-6;

const categoryOf = (issue) => issue.fields?.status?.statusCategory?.key;
const isDone = (issue) => categoryOf(issue) === DONE_CATEGORY;

function typeStatusCounts(issues) {
  const counts = new Map();
  for (const issue of issues) {
    const key = `${issue.fields.issuetype.name};${issue.fields.status.name}`.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The hierarchical parent key (parent or Epic Link), if the issue has one. */
function parentKeyOf(issue, epicLink) {
  const parent = issue.fields.parent?.key;
  if (typeof parent === "string") return parent;
  const link = issue.fields[epicLink];
  return typeof link === "string" ? link : undefined;
}

/** The top ancestor of an issue; a cycle ends at the issue where it closes. */
function rootOf(issue, byKey, epicLink) {
  const seen = new Set([issue.key]);
  let current = issue;
  for (;;) {
    const parentKey = parentKeyOf(current, epicLink);
    const parent = parentKey === undefined ? undefined : byKey.get(parentKey);
    if (parent === undefined || seen.has(parent.key)) return current;
    seen.add(parent.key);
    current = parent;
  }
}

/** Per epic: every issue that reaches it through parent or Epic Link, directly or through a task. */
function epicProgress(issues, epicLink) {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const epics = new Map(
    issues
      .filter((issue) => issue.fields.issuetype.name.toLowerCase() === "epic")
      .map((issue) => [issue.key, { total: 0, done: 0 }]),
  );
  for (const issue of issues) {
    const root = rootOf(issue, byKey, epicLink);
    const entry = root.key === issue.key ? undefined : epics.get(root.key);
    if (entry === undefined) continue;
    entry.total += 1;
    if (isDone(issue)) entry.done += 1;
  }
  return epics;
}

const round6 = (value) => Math.round(value * 1e6) / 1e6;

const SECONDS_PER_HOUR = 3600;

/** The estimate the lab recorded in the truth: the field summed, its unit and its name. */
export function estimateOf(truth) {
  if (truth.estimate !== undefined) return truth.estimate;
  const id = truth.fieldIds.storyPoints;
  return id === undefined
    ? undefined
    : { fieldId: id, writeFieldId: id, unit: "points", label: "Story Points" };
}

/** The field ids a template and a compliance report name: the estimate by the id it is written with. */
export function complianceFieldIds(truth) {
  const estimate = estimateOf(truth);
  return estimate === undefined
    ? truth.fieldIds
    : { ...truth.fieldIds, storyPoints: estimate.writeFieldId };
}

/** Sums are taken in the field's own unit; seconds convert to hours exactly, once, after summing. */
function estimateTotals(issues, field, divisor) {
  const estimated = issues.filter((issue) => typeof issue.fields[field] === "number");
  if (estimated.length === 0) return undefined;
  const total = estimated.reduce((sum, issue) => sum + issue.fields[field], 0);
  const done = estimated
    .filter((issue) => isDone(issue))
    .reduce((sum, issue) => sum + issue.fields[field], 0);
  return {
    total: round6(total / divisor),
    done: round6(done / divisor),
    remaining: round6((total - done) / divisor),
  };
}

/**
 * The expected figures of a project from its issues. `issues` must carry issuetype, status (with
 * its status category), parent and the Epic Link and estimate fields of `fieldIds`. A figure whose
 * input the instance does not provide is `undefined`, and the journey then does not grade it.
 * `estimate` (the truth's `estimate`) names the unit: seconds are reported in hours.
 */
export function progressTruth(issues, fieldIds = {}, estimate = undefined) {
  const categoriesKnown = issues.every((issue) => typeof categoryOf(issue) === "string");
  const { epicLink, storyPoints } = fieldIds;
  return {
    issueCount: issues.length,
    counts: typeStatusCounts(issues),
    epics: categoriesKnown && epicLink !== undefined ? epicProgress(issues, epicLink) : undefined,
    estimate:
      categoriesKnown && storyPoints !== undefined
        ? estimateTotals(issues, storyPoints, estimate?.unit === "seconds" ? SECONDS_PER_HOUR : 1)
        : undefined,
  };
}

const estimateLine = (estimate) =>
  estimate.unit === "seconds"
    ? `SCHÄTZUNG;<gesamt>;<erledigt>;<offen> - genau eine Zeile: die Summe der ursprünglichen Schätzung (${estimate.label}) in Stunden über alle Vorgänge des Projekts, davon in der Statuskategorie Done, und die Differenz.`
    : `SCHÄTZUNG;<gesamt>;<erledigt>;<offen> - genau eine Zeile: die Summe des Feldes ${estimate.label} über alle Vorgänge des Projekts, davon in der Statuskategorie Done, und die Differenz.`;

/** The S10 prompt; `estimate` names the field the instance estimates with (none: no line asked). */
export const progressPrompt = (estimate, project = "RPT") =>
  [
    `Werte den Fortschritt des Jira-Projekts ${project} aus. Antworte ausschließlich mit Zeilen in genau diesen Formaten, ohne weitere Zeilen:`,
    "ANZAHL;<Vorgangstyp>;<Status>;<Anzahl> - eine Zeile je Kombination aus Vorgangstyp und Status, die im Projekt vorkommt (alle Vorgänge des Projekts, auch Epics).",
    "EPIC;<Epic-Schlüssel>;<Anzahl>;<davon erledigt> - eine Zeile je Epic des Projekts: die Anzahl aller dem Epic zugeordneten Vorgänge (Tasks, Bugs und deren Sub-Tasks, ohne das Epic selbst) und wie viele davon in der Statuskategorie Done sind.",
    ...(estimate === undefined ? [] : [estimateLine(estimate)]),
  ].join("\n");

// ---------- the answer ----------

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
const COUNT_LINE = /^\s*ANZAHL;([^;\n]+);([^;\n]+);\s*(\d+)\s*$/gimu;
const EPIC_LINE = /^\s*EPIC;([^;\n]+);\s*(\d+)\s*;\s*(\d+)\s*$/gimu;
const ESTIMATE_LINE = new RegExp(
  String.raw`^\s*SCH(?:Ä|AE)TZUNG;\s*${NUMBER}\s*;\s*${NUMBER}\s*;\s*${NUMBER}\s*$`,
  "gimu",
);

const decimal = (text) => Number(text.replace(",", "."));

/** Rows by key; a key stated twice with different values is a conflict and graded as wrong. */
function collect(answer, pattern, rowOf) {
  const rows = new Map();
  const conflicts = [];
  for (const match of answer.matchAll(pattern)) {
    const [key, value] = rowOf(match);
    const known = rows.get(key);
    if (known !== undefined && JSON.stringify(known) !== JSON.stringify(value)) conflicts.push(key);
    rows.set(key, value);
  }
  return { rows, conflicts };
}

export function parseProgressAnswer(answer) {
  const counts = collect(answer, COUNT_LINE, (m) => [
    `${m[1].trim()};${m[2].trim()}`.toLowerCase(),
    Number(m[3]),
  ]);
  const epics = collect(answer, EPIC_LINE, (m) => [
    m[1].trim().toUpperCase(),
    [Number(m[2]), Number(m[3])],
  ]);
  const estimates = [...answer.matchAll(ESTIMATE_LINE)].map((m) =>
    m.slice(1, 4).map((text) => decimal(text)),
  );
  const [estimate] = estimates;
  const estimateConflicts = estimates.filter(
    (row) => JSON.stringify(row) !== JSON.stringify(estimate),
  );
  return {
    counts: counts.rows,
    epics: epics.rows,
    estimate,
    conflicts: [...counts.conflicts, ...epics.conflicts, ...estimateConflicts],
  };
}

const sameNumber = (left, right) => Math.abs(left - right) < EPSILON;

/** Every expected row must match and no row may be invented. */
function gradeRows(expected, reported, equal) {
  const matched = [...expected].filter(([key, value]) => equal(reported.get(key), value));
  const extra = [...reported.keys()].filter((key) => !expected.has(key));
  return {
    graded: true,
    ok: matched.length === expected.size && extra.length === 0,
    matched: matched.length,
    expected: expected.size,
    extra: extra.length,
  };
}

function gradeCounts(parsed, truth) {
  return gradeRows(truth.counts, parsed.counts, (row, count) => row === count);
}

function gradeEpics(parsed, truth) {
  if (truth.epics === undefined) return { graded: false, ok: false };
  return gradeRows(
    truth.epics,
    parsed.epics,
    (row, expected) => row !== undefined && row[0] === expected.total && row[1] === expected.done,
  );
}

function gradeEstimate(parsed, truth) {
  if (truth.estimate === undefined) return { graded: false, ok: false };
  const { total, done, remaining } = truth.estimate;
  const reported = parsed.estimate;
  const ok =
    reported !== undefined &&
    sameNumber(reported[0], total) &&
    sameNumber(reported[1], done) &&
    sameNumber(reported[2], remaining);
  return { graded: true, ok, expected: truth.estimate, reported };
}

/** Grades the three parts of a progress answer against the truth; ungradable parts say so. */
export function gradeProgress(answer, truth) {
  const parsed = parseProgressAnswer(answer);
  const clean = parsed.conflicts.length === 0;
  const withClean = (part) => ({ ...part, ok: part.ok && clean });
  return {
    counts: withClean(gradeCounts(parsed, truth)),
    epics: withClean(gradeEpics(parsed, truth)),
    estimate: withClean(gradeEstimate(parsed, truth)),
    conflicts: parsed.conflicts.length,
  };
}

const unavailableReasons = new Set(JIRA_REPORT_ESTIMATE_UNAVAILABLE_REASONS);
const METRIC_ROW = /^(?:SCHÄTZUNG|SCHAETZUNG|ESTIMATE);/iu;
const SCOPE_ROW = /^(?:SCOPE-LÜCKE|SCOPE-LUECKE|SCOPE GAP);/iu;
const METRIC_NAME = /^(?:SCHÄTZUNG|SCHAETZUNG|ESTIMATE)$/iu;
const UNAVAILABLE_CELL = /^(?:NICHT_VERFÜGBAR|NICHT_VERFUEGBAR|UNAVAILABLE)$/iu;

/** The last summary for this project is authoritative; an older unavailable result is no proof. */
function unavailableReport(exchanges, projectKey) {
  let current;
  let reportId;
  for (const exchange of (exchanges ?? []).filter((item) => toolExchangeOf(item, "jira.report"))) {
    const data = exchange.result.data;
    if (targetsUnavailableProject(exchange, projectKey)) {
      current = exchange.result.status === "completed" ? data : undefined;
      reportId = current?.reportId;
    } else if (
      continuationOfUnavailableReport(exchange, reportId) &&
      !validUnavailableContinuation(exchange, current, reportId)
    ) {
      current = undefined;
    }
  }
  return current;
}

function continuationOfUnavailableReport(exchange, reportId) {
  return typeof reportId === "string" && exchange.call?.arguments?.reportId === reportId;
}

function targetsUnavailableProject(exchange, projectKey) {
  return (
    exchange.result.data?.report?.scope?.projectKey === projectKey ||
    exchange.call?.arguments?.projectKey === projectKey
  );
}

function validUnavailableContinuation(exchange, current, reportId) {
  const data = exchange.result.data;
  if (!data || !current?.report) return false;
  return (
    exchange.result.status === "completed" &&
    data.outcome === "succeeded" &&
    data.status === "complete" &&
    data.reportId === reportId &&
    data.report?.digest === current.report.digest
  );
}

function unavailableScope(scope, projectKey) {
  return (
    scope?.estimateUnit === "unavailable" &&
    scope.estimateSource === "unavailable" &&
    unavailableReasons.has(scope.estimateUnavailableReason) &&
    scope.estimateUnavailableReason !== "project-not-specified" &&
    scope.projectKey === projectKey
  );
}

function nativeEstimateUnavailable(data, projectKey) {
  if (data?.outcome !== "succeeded" || data.status !== "complete") return false;
  const report = data.report;
  return (
    report?.completeness?.complete === true &&
    report.progress?.project?.estimate === null &&
    unavailableScope(report.scope, projectKey)
  );
}

function unavailableAnswer(answer, reason) {
  const lines = answer.split(/\r?\n/u).map((line) => line.trim());
  if (
    lines.some((line) => /schätz|schaetz|estimate/iu.test(line) && /\b0(?:[.,]0+)?\b/u.test(line))
  )
    return false;
  const metrics = lines.filter((line) => METRIC_ROW.test(line)).map((line) => line.split(";"));
  const gaps = lines.filter((line) => SCOPE_ROW.test(line)).map((line) => line.split(";"));
  return (
    metrics.length === 1 &&
    metrics[0].length === 3 &&
    UNAVAILABLE_CELL.test(metrics[0][1]) &&
    metrics[0][2] === reason &&
    gaps.length === 1 &&
    gaps[0].length === 3 &&
    METRIC_NAME.test(gaps[0][1]) &&
    gaps[0][2] === reason
  );
}

/**
 * Grade the native unavailable estimate, never an omitted value or a fabricated zero. The report
 * wire represents this state as a null estimate plus its closed source/unit/reason; `metric` is
 * the oracle's explicit normalized verdict, not an additional product DTO. Other issue counts may
 * legitimately be zero. The requested two answer rows name both the metric and its scope gap.
 */
export function gradeUnavailable(answer, exchanges, { projectKey }) {
  const data = unavailableReport(exchanges, projectKey);
  const scope = data?.report?.scope;
  const reason = scope?.estimateUnavailableReason;
  if (!nativeEstimateUnavailable(data, projectKey))
    return {
      ok: false,
      metric: { status: "unverified" },
      reason: "native-unavailable-evidence-missing",
    };
  return { ok: unavailableAnswer(answer, reason), metric: { status: "unavailable", reason } };
}

const unavailablePrompt = (projectKey) =>
  `Erstelle einen Fortschrittsbericht für das Jira-Projekt ${projectKey}. Prüfe die Verfügbarkeit ` +
  "der Schätzung über jira.report. Erfinde keine 0 für eine nicht verfügbare Schätzung. " +
  "Wenn die Schätzung nicht verfügbar ist, antworte mit genau zwei lesbaren Zeilen: " +
  "SCHÄTZUNG;NICHT_VERFÜGBAR;<estimateUnavailableReason des Berichts> und " +
  "SCOPE-LÜCKE;SCHÄTZUNG;<derselbe Grund>. Falls sie verfügbar ist, melde ihre wirklichen Werte.";

function unavailableVerdict(turn, grade, refused) {
  if (turn.termination === "lab-limit" && !refused) return "unverified";
  if (turn.failure !== undefined || refused) return "red";
  if (grade.metric.status === "unverified") return "unverified";
  return grade.ok ? "green" : "red";
}

/** A distinct real-model turn, on the seeded project with no configured estimate field. */
export async function unavailableProgressPart(ctx) {
  const projectKey = ctx.truth.projects?.unavailable ?? ctx.truth.large?.project;
  if (projectKey === undefined || typeof ctx.freshChat !== "function")
    return {
      part: {
        label: "unavailable-estimate",
        status: "unverified",
        covers: [],
        detail: "unavailable-project-or-chat-missing",
      },
      turn: NO_TURN,
    };
  const chat = await ctx.freshChat();
  const before = ctx.refusals?.();
  const turn = await ctx.turn(chat, unavailablePrompt(projectKey));
  const refused = ctx.refusals?.() > before;
  const grade = gradeUnavailable(turn.answer, turn.toolExchanges, { projectKey });
  const status = unavailableVerdict(turn, grade, refused);
  return {
    part: {
      label: "unavailable-estimate",
      status,
      covers: status === "unverified" ? [] : ["unavailable-metrics-labelled"],
      detail: `metric=${grade.metric.status}; reason=${grade.metric.reason ?? grade.reason}`,
    },
    turn,
  };
}
