// Oracle of the progress journey S10 (epic #4173, #4174, #4181). The ground truth is computed from
// the issues Jira holds after the turn (counts per type and status, members and done members per
// epic, estimate totals), never from the model's answer or from the report tool it may have used.
// The answer has to follow a strict line format the prompt itself asks for:
//   ANZAHL;<type>;<status>;<count>        one line per type/status combination
//   EPIC;<key>;<members>;<done members>   one line per epic
//   SCHÄTZUNG;<total>;<done>;<remaining>  one line (only when the instance has an estimate field;
//                                         a time-tracking estimate is asked for in hours)

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { JIRA_REPORT_ESTIMATE_UNAVAILABLE_REASONS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { readPrivateFile } from "../lab-client.mjs";
import { toolExchangeOf } from "./tool-exchanges.mjs";
import { NO_TURN } from "./journey-support.mjs";
import { pagedJql } from "./journeys.mjs";
import { gradeLargeDeviationReport, gradeRuntimeDeviationReport } from "./deviation-report.mjs";
import {
  readInstalledTemplateScope,
  progressEvidenceFields,
  projectProgressNativeIssue,
} from "./progress-simulation.mjs";

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
  const estimated = issues.filter((issue) => Number.isFinite(issue.fields[field]));
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

function estimateCoverage(issues, field) {
  if (field === undefined) return {};
  const complete = issues.every(
    ({ fields }) =>
      Object.hasOwn(fields, field) && (fields[field] === null || Number.isFinite(fields[field])),
  );
  if (!complete) return {};
  const estimatedByType = new Map();
  const unestimatedByType = new Map();
  for (const { fields } of issues) {
    const type = fields.issuetype.name.toLowerCase();
    const estimated = fields[field] !== null;
    estimatedByType.set(type, (estimatedByType.get(type) ?? 0) + Number(estimated));
    unestimatedByType.set(type, (unestimatedByType.get(type) ?? 0) + Number(!estimated));
  }
  return { estimatedByType, unestimatedByType };
}

/**
 * The expected figures of a project from its issues. `issues` must carry issuetype, status (with
 * its status category), parent and the Epic Link and estimate fields of `fieldIds`. A figure whose
 * input the instance does not provide is `undefined`, and the journey then does not grade it.
 * `estimate` (the truth's `estimate`) names the unit: seconds are reported in hours.
 */
function observedProgressTotals(issues, epicLink, storyPoints, estimate) {
  const categoriesKnown = issues.every((issue) => typeof categoryOf(issue) === "string");
  if (!categoriesKnown) return { epics: undefined, estimate: undefined };
  return {
    epics: epicLink === undefined ? undefined : epicProgress(issues, epicLink),
    estimate:
      storyPoints === undefined
        ? undefined
        : estimateTotals(issues, storyPoints, estimate?.unit === "seconds" ? SECONDS_PER_HOUR : 1),
  };
}

export function progressTruth(issues, fieldIds = {}, estimate = undefined) {
  const { epicLink } = fieldIds;
  const storyPoints = estimate?.fieldId ?? fieldIds.storyPoints;
  return {
    issueCount: issues.length,
    estimateLabel: estimate?.label,
    counts: typeStatusCounts(issues),
    ...estimateCoverage(issues, storyPoints),
    ...observedProgressTotals(issues, epicLink, storyPoints, estimate),
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

const typeName = (value) =>
  value.trim().toLowerCase() === "stories" ? "story" : value.trim().toLowerCase();
const headerName = (value) => value.toLowerCase().replaceAll(/[\s_-]/gu, "");
const TYPE_HEADERS = new Set(["vorgangstyp", "issuetype", "typ", "type", "arbeitsvorgang"]);
const TOTAL_HEADERS = new Set(["gesamt", "total"]);
const ESTIMATE_HEADERS = new Set(["kennzahl", "metric"]);
const canonicalStatus = (value) =>
  new Map([
    ["todo", "to do"],
    ["inprogress", "in progress"],
  ]).get(headerName(value)) ?? value.trim().toLowerCase();

/** Integer counts reject decimals, including .0; locale thousands remain whole counts. */
function integerCell(value) {
  const text = value.trim();
  if (/^(?:0|[1-9]\d*)$/u.test(text))
    return Number.isSafeInteger(Number(text)) ? Number(text) : undefined;
  if (!/^[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})*$/u.test(text)) return undefined;
  const number = Number(text.replaceAll(/[.,]/gu, ""));
  return Number.isSafeInteger(number) ? number : undefined;
}

function decimalCell(value) {
  const text = value.trim();
  const integer = integerCell(text);
  if (integer !== undefined) return integer;
  const match = /^(\d+|[1-9]\d{0,2}(?:[.,]\d{3})+)([.,])(\d+)$/u.exec(text);
  if (match === null || match[1].includes(match[2])) return undefined;
  const number = Number(match[1].replaceAll(/[.,]/gu, "") + "." + match[3]);
  return Number.isFinite(number) ? number : undefined;
}

function cellsOf(line) {
  const text = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = text.split(/[;\t|]/u).map((cell) => cell.trim().replaceAll(/\*\*|\x60/gu, ""));
  return cells.length > 1 ? cells : undefined;
}

function addRow(state, target, key, value) {
  if (value === undefined) {
    state.conflicts.push(key);
    return;
  }
  const known = target.get(key);
  if (known !== undefined && JSON.stringify(known) !== JSON.stringify(value))
    state.conflicts.push(key);
  target.set(key, value);
}

function addEstimate(state, cells) {
  const values = cells.map((cell) => decimalCell(cell));
  if (values.length !== 3 || values.some((value) => value === undefined)) {
    state.conflicts.push("estimate");
    return;
  }
  if (state.estimate !== undefined && JSON.stringify(state.estimate) !== JSON.stringify(values))
    state.conflicts.push("estimate");
  state.estimate = values;
}

function canonicalRow(state, cells) {
  const token = headerName(cells[0]);
  switch (token) {
    case "anzahl":
    case "count":
      return canonicalCount(state, cells);
    case "epic":
      return canonicalEpic(state, cells);
    case "schätzung":
    case "schaetzung":
    case "estimate":
      if (cells.length !== 4) return false;
      addEstimate(state, cells.slice(1));
      return true;
    default:
      return canonicalEstimateCount(state, cells, token);
  }
}

function canonicalCount(state, cells) {
  if (cells.length === 4)
    addRow(
      state,
      state.counts,
      typeName(cells[1]) + ";" + canonicalStatus(cells[2]),
      integerCell(cells[3]),
    );
  else state.conflicts.push("count");
  return true;
}

function canonicalEpic(state, cells) {
  if (cells.length !== 4) return false;
  const pair = [integerCell(cells[2]), integerCell(cells[3])];
  addRow(state, state.epics, cells[1].toUpperCase(), pair.includes(undefined) ? undefined : pair);
  return true;
}

function canonicalEstimateCount(state, cells, token) {
  const targets = new Map([
    ["geschätzt", state.estimatedByType],
    ["geschaetzt", state.estimatedByType],
    ["estimated", state.estimatedByType],
    ["ungeschätzt", state.unestimatedByType],
    ["ungeschaetzt", state.unestimatedByType],
    ["unestimated", state.unestimatedByType],
  ]);
  const target = targets.get(token);
  if (target === undefined) return false;
  if (cells.length === 3) addRow(state, target, typeName(cells[1]), integerCell(cells[2]));
  else state.conflicts.push(token);
  return true;
}

function estimateTableHeader(headers) {
  const valid =
    headers.length === 4 &&
    TOTAL_HEADERS.has(headers[1]) &&
    new Set(["erledigt", "done"]).has(headers[2]) &&
    new Set(["offen", "remaining"]).has(headers[3]);
  return { kind: valid ? "estimate" : "invalid" };
}

function statusTableHeader(cells, headers) {
  const statuses = cells.slice(1).map((cell) => canonicalStatus(cell));
  const total = TOTAL_HEADERS.has(headers.at(-1));
  const names = total ? statuses.slice(0, -1) : statuses;
  if (new Set(names).size !== names.length || names.length === 0) return { kind: "invalid" };
  return { kind: "statuses", names, total };
}

function tableHeader(cells) {
  const headers = cells.map((cell) => headerName(cell));
  if (ESTIMATE_HEADERS.has(headers[0])) return estimateTableHeader(headers);
  if (!TYPE_HEADERS.has(headers[0])) return undefined;
  if (new Set(["mitschätzung", "mitschaetzung", "estimated"]).has(headers[1])) {
    const valid = new Set(["ohneschätzung", "ohneschaetzung", "unestimated"]).has(headers[2]);
    return { kind: valid && headers.length === 3 ? "coverage" : "invalid" };
  }
  return statusTableHeader(cells, headers);
}

function matrixRow(state, cells, table) {
  const values = cells.slice(1).map((cell) => integerCell(cell));
  const expected = table.names.length + Number(table.total);
  if (values.length !== expected || values.includes(undefined)) {
    state.conflicts.push("status-matrix");
    return;
  }
  const counts = values.slice(0, table.names.length);
  if (table.total && counts.reduce((sum, value) => sum + value, 0) !== values.at(-1))
    state.conflicts.push("status-total");
  for (const [index, status] of table.names.entries()) {
    // Zero matrix cells describe absent combinations, not additional native groups.
    if (counts[index] !== 0)
      addRow(state, state.counts, typeName(cells[0]) + ";" + status, counts[index]);
  }
}

function tableRow(state, cells, table) {
  if (table.kind === "invalid") {
    state.conflicts.push("table-header");
    return;
  }
  if (table.kind === "estimate") {
    state.estimateLabels.push(cells[0]);
    addEstimate(state, cells.slice(1));
    return;
  }
  if (table.kind === "statuses") {
    matrixRow(state, cells, table);
    return;
  }
  if (cells.length !== 3) {
    state.conflicts.push("estimate-coverage");
    return;
  }
  addRow(state, state.estimatedByType, typeName(cells[0]), integerCell(cells[1]));
  addRow(state, state.unestimatedByType, typeName(cells[0]), integerCell(cells[2]));
}

/** One parser for tagged rows and header-bound ordinary Markdown/TAB tables. */
export function parseProgressAnswer(answer) {
  const state = {
    counts: new Map(),
    epics: new Map(),
    estimate: undefined,
    estimatedByType: new Map(),
    unestimatedByType: new Map(),
    estimateLabels: [],
    conflicts: [],
    remainder: [],
  };
  let table;
  for (const line of answer.split(/\r?\n/u)) {
    const cells = cellsOf(line);
    if (cells === undefined) {
      table = undefined;
      state.remainder.push(line);
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/u.test(cell))) continue;
    const header = tableHeader(cells);
    if (header !== undefined) {
      table = header;
      continue;
    }
    if (canonicalRow(state, cells)) continue;
    if (table !== undefined) tableRow(state, cells, table);
    else state.remainder.push(line);
  }
  return state;
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
    sameEstimateLabels(parsed.estimateLabels, truth.estimateLabel) &&
    sameNumber(reported[0], total) &&
    sameNumber(reported[1], done) &&
    sameNumber(reported[2], remaining);
  return { graded: true, ok, expected: truth.estimate, reported };
}

function sameEstimateLabels(labels, expected) {
  if (labels.length === 0) return true; // Explicit SCHÄTZUNG rows already name the metric.
  if (typeof expected !== "string") return false;
  const normalized = (value) => value.trim().toLowerCase().replaceAll(/\s+/gu, " ");
  return labels.every((label) => normalized(label) === normalized(expected));
}

function gradeEstimateCoverage(expected, actual) {
  return expected === undefined
    ? { graded: false, ok: false }
    : gradeRows(expected, actual, (reported, count) => reported === count);
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
    estimated: withClean(gradeEstimateCoverage(truth.estimatedByType, parsed.estimatedByType)),
    unestimated: withClean(
      gradeEstimateCoverage(truth.unestimatedByType, parsed.unestimatedByType),
    ),
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

// ---------- the existing limit-run intent and ordinary UI turn ----------
const REPORT_STEP = "ac3-report";
const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
};
const digestOf = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");

function scopeIdentity(scope) {
  return {
    project: scope.project,
    issueTypes: [...scope.issueTypes].sort(),
    labelsForTypes: [...scope.labelsForTypes].sort(),
    parentForTypes: scope.parentForTypes,
    templates: scope.templates
      .map((item) => ({ ...item }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function readReportIntent(ctx, truthFile) {
  if (typeof truthFile !== "string" || truthFile !== ctx.intent.path)
    throw new TypeError("The report requires the orchestrator truth file");
  const path = realpathSync(truthFile);
  const inside = relative(realpathSync(ctx.sessionDir), path);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith("../"))
    throw new TypeError("The report truth is outside this session");
  return JSON.parse(readPrivateFile(truthFile));
}

function assertReportPopulation(truth) {
  if (
    !Array.isArray(truth.issues) ||
    truth.issues.length !== truth.issueCount ||
    !Array.isArray(truth.native?.issues) ||
    truth.native.issues.length !== truth.issueCount
  )
    throw new TypeError("The report truth population is unavailable");
}

function reportTruth(ctx, truthFile) {
  const persisted = readReportIntent(ctx, truthFile);
  const truth = persisted.data?.["progress-simulation"]?.truth;
  if (
    truth?.source !== "progress-simulation" ||
    truth.seedVersion !== 2 ||
    truth.project !== ctx.projectKey
  )
    throw new TypeError("The report truth binding is unavailable");
  assertReportPopulation(truth);
  return truth;
}

function sameNativeSnapshot(actual, truth) {
  const expected = new Map(truth.native.issues.map((issue) => [issue.key, issue]));
  if (expected.size !== truth.issueCount || actual.issues.length !== truth.issueCount) return false;
  return actual.issues.every((issue) => {
    const projected = projectProgressNativeIssue(issue, truth);
    return digestOf(projected) === digestOf(expected.get(issue.key));
  });
}

async function currentReportEvidence(ctx, truth) {
  ctx.signal.throwIfAborted();
  const fields = progressEvidenceFields(truth).join(",");
  const observed = await pagedJql(
    ctx.session,
    "project = " + ctx.projectKey + " ORDER BY key ASC",
    fields,
  );
  ctx.signal.throwIfAborted();
  const scope = await readInstalledTemplateScope(ctx);
  if (
    digestOf(scopeIdentity(scope)) !== digestOf(scopeIdentity(truth.templateScope)) ||
    !sameNativeSnapshot(observed, truth)
  )
    throw new TypeError("Independent report evidence changed");
  return observed;
}

function limitReportPrompt(truth) {
  return [
    progressPrompt(estimateOf(truth), truth.project),
    "Lies jira.report und alle benötigten Folgeseiten desselben Berichts vollständig.",
    "Ergänze pro nativem Vorgangstyp GESCHÄTZT;<Typ>;<Anzahl> und UNGESCHÄTZT;<Typ>;<Anzahl>, falls beobachtbar.",
    "Die globale Zahl ungeschätzter Vorgänge ist keine typspezifische Zahl. Fehlende Werte sind keine 0.",
    "Bei nicht verfügbarer Schätzung: SCHÄTZUNG;NICHT_VERFÜGBAR;<nativer Grund> und SCOPE-LÜCKE;SCHÄTZUNG;<nativer Grund>.",
    "Beschreibe jede tatsächliche Vorlagenabweichung beim jeweiligen Vorgangsschlüssel; nenne keine korrekten Vorgänge als Abweichung.",
    "Nenne jeden Typ ohne Vorlage exakt als VORLAGENLÜCKE;<nativer Typ>;<Anzahl>. Nimm keine Änderungen vor.",
  ].join("\n");
}

/** Report-only evidence: native summary/description values from other tools are never retained. */
function retainedReportTurn(turn) {
  if (
    turn.failure !== undefined ||
    turn.termination !== undefined ||
    turn.user?.turnState !== "completed" ||
    typeof turn.clientTurnId !== "string"
  )
    throw new TypeError("The UI report turn has no successful terminal observation");
  const exchanges = (turn.exchanges ?? []).filter((item) => toolExchangeOf(item, "jira.report"));
  const safe = JSON.parse(
    JSON.stringify(exchanges, (key, value) =>
      new Set(["summary", "description", "body"]).has(key) && typeof value === "string"
        ? undefined
        : value,
    ),
  );
  return {
    answer: turn.answer,
    exchanges: safe,
    clientTurnId: turn.clientTurnId,
    turnState: "completed",
  };
}

async function settledReportTurn(ctx, truth, binding) {
  const saved = ctx.intent.state[REPORT_STEP];
  if (saved !== undefined) {
    if (
      saved.binding !== binding ||
      saved.phase !== "settled" ||
      saved.turn?.turnState !== "completed"
    )
      throw new TypeError("An unsettled report turn cannot be replayed");
    return saved.turn;
  }
  const scope = await readInstalledTemplateScope(ctx);
  if (digestOf(scopeIdentity(scope)) !== digestOf(scopeIdentity(truth.templateScope)))
    throw new TypeError("The report template binding changed");
  await ctx.intent.record(REPORT_STEP, { binding, phase: "pending" });
  ctx.signal.throwIfAborted();
  const turn = retainedReportTurn(
    await ctx.turn(ctx.reportChat, limitReportPrompt(truth), { operations: [] }),
  );
  if (typeof turn.answer !== "string") throw new TypeError("Report answer is unavailable");
  await ctx.intent.record(REPORT_STEP, { binding, phase: "settled", turn });
  return turn;
}

function reportListPage(page, offset, total) {
  if (!Array.isArray(page?.items) || page.total !== total) return false;
  const end = offset + page.items.length;
  return (
    end <= total &&
    (end === total || page.items.length > 0) &&
    page.nextStartAt === (end < total ? end : undefined)
  );
}

function reportSectionMatches(exchange, summary, name) {
  const args = exchange.call?.arguments;
  return args?.reportId === summary.reportId && args.section === name;
}

function validInitialReportList(first) {
  return (
    Number.isSafeInteger(first?.total) && first.total >= 0 && reportListPage(first, 0, first.total)
  );
}

function continuationReportList(exchange, summary, name, offset, total) {
  const data = exchange.result.data;
  if (
    !validUnavailableContinuation(exchange, summary, summary.reportId) ||
    data.report.completeness?.complete !== true
  )
    return undefined;
  const page = data.section;
  const args = exchange.call.arguments;
  if (
    page?.name !== name ||
    args.startAt !== offset ||
    page.startAt !== offset ||
    !reportListPage(page, offset, total)
  )
    return undefined;
  return page;
}

function reportList(turn, summary, name, first) {
  if (!validInitialReportList(first)) return undefined;
  const items = [...first.items];
  for (const exchange of turn.exchanges) {
    if (!reportSectionMatches(exchange, summary, name)) continue;
    const page = continuationReportList(exchange, summary, name, items.length, first.total);
    if (page === undefined) return undefined;
    items.push(...page.items);
  }
  return items.length === first.total ? items : undefined;
}

function cardTypeCounts(rows, issues) {
  if (!Array.isArray(rows)) return false;
  const expected = new Map();
  for (const issue of issues) {
    const type = issue.fields.issuetype.name;
    const item = expected.get(type) ?? { total: 0, done: 0 };
    item.total += 1;
    item.done += Number(isDone(issue));
    expected.set(type, item);
  }
  if (
    rows.length !== expected.size ||
    new Set(rows.map((row) => row.typeName)).size !== rows.length
  )
    return false;
  return rows.every((row) => {
    const item = expected.get(row.typeName);
    return item !== undefined && row.total === item.total && row.done === item.done;
  });
}

function cardStatuses(rows, expected) {
  if (rows === undefined) return false;
  const actual = new Map();
  for (const row of rows) {
    const key = row.typeName.toLowerCase() + ";" + row.statusName.toLowerCase();
    if (actual.has(key)) return false;
    actual.set(key, row.total);
  }
  return gradeRows(expected, actual, (a, b) => a === b).ok;
}

function cardEpics(rows, expected) {
  if (rows === undefined || expected === undefined || rows.length !== expected.size) return false;
  const keys = new Set();
  return rows.every((row) => {
    const item = expected.get(row.key);
    if (keys.has(row.key)) return false;
    keys.add(row.key);
    return (
      item !== undefined && row.members?.total === item.total && row.members.done === item.done
    );
  });
}

function cardEstimateSelection(scope, estimate) {
  const source = new Set([
    "explicit-field",
    "board-configuration",
    "project-screen",
    "time-tracking",
  ]);
  const unit = estimate.unit === "seconds" ? "seconds" : "custom-field";
  return (
    scope.estimateFieldId === estimate.fieldId &&
    scope.estimateUnit === unit &&
    source.has(scope.estimateSource)
  );
}

function cardEstimateValues(value, oracle, divisor) {
  if (value === null || oracle.estimate === undefined || oracle.unestimatedByType === undefined)
    return false;
  const sums = ["total", "done", "remaining"].every(
    (name) =>
      Number.isFinite(value[name]) && sameNumber(value[name] / divisor, oracle.estimate[name]),
  );
  return (
    sums && value.unestimated === [...oracle.unestimatedByType.values()].reduce((a, b) => a + b, 0)
  );
}

function cardEstimate(report, oracle, truth) {
  if (truth.estimate === undefined)
    return nativeEstimateUnavailable(
      { outcome: "succeeded", status: "complete", report },
      truth.project,
    );
  if (!cardEstimateSelection(report.scope, truth.estimate)) return false;
  const divisor = truth.estimate.unit === "seconds" ? SECONDS_PER_HOUR : 1;
  return cardEstimateValues(report.progress.project.estimate, oracle, divisor);
}

function completeProgressPopulation(report, count) {
  const completeness = report?.completeness;
  if (completeness?.complete !== true) return false;
  return (
    completeness.issuesRead === count &&
    completeness.issuesTotal === count &&
    report.progress?.project?.total === count
  );
}

function completeProgressSummary(summary, count) {
  if (summary?.outcome !== "succeeded" || summary.status !== "complete") return false;
  return completeProgressPopulation(summary.report, count);
}

function reportCardMatches(turn, truth, observed, oracle) {
  const summary = unavailableReport(turn.exchanges, truth.project);
  if (!completeProgressSummary(summary, truth.issueCount)) return false;
  const report = summary.report;
  const statuses = reportList(turn, summary, "statuses", report.progress.byStatus);
  const epics = reportList(turn, summary, "epics", report.epics);
  return (
    cardTypeCounts(report.progress.byType, observed.issues) &&
    cardStatuses(statuses, oracle.counts) &&
    cardEpics(epics, oracle.epics) &&
    cardEstimate(report, oracle, truth)
  );
}

function reportAnswerMatches(turn, oracle, truth) {
  const grade = gradeProgress(turn.answer, oracle);
  const parts = [grade.counts, grade.epics];
  if (truth.estimate === undefined)
    return (
      parts.every((part) => part.ok) &&
      gradeUnavailable(turn.answer, turn.exchanges, { projectKey: truth.project }).ok
    );
  parts.push(grade.estimate, grade.estimated, grade.unestimated);
  return parts.every((part) => part.graded && part.ok);
}

async function gradeLimitReport(turn, observed, truth) {
  const oracle = progressTruth(observed.issues, truth.fieldIds, truth.estimate);
  const answer = parseProgressAnswer(turn.answer).remainder.join("\n");
  const deviations =
    truth.source === "progress-simulation"
      ? await gradeRuntimeDeviationReport(turn.exchanges, observed, truth, answer)
      : gradeLargeDeviationReport(turn.exchanges, observed, truth, answer);
  if (deviations.status !== "green") return deviations;
  const exact =
    reportCardMatches(turn, truth, observed, oracle) && reportAnswerMatches(turn, oracle, truth);
  return {
    status: exact ? "green" : "red",
    detail:
      "Independent native progress, report cards and scoped answer: " +
      (exact ? "matched" : "mismatched") +
      "; per-type estimate card fields unavailable",
    counts: {
      ...deviations.counts,
      typeEstimateCardUnavailable: oracle.estimatedByType?.size ?? 0,
    },
  };
}

/** Fixed orchestrator entrypoint: one UI turn, one intent slot, independently observed readback. */
export async function runProgressReport(ctx, { truthFile } = {}) {
  let phase = "truth";
  try {
    ctx.signal.throwIfAborted();
    const truth = reportTruth(ctx, truthFile);
    const binding = digestOf({
      truth,
      project: ctx.projectKey,
      chatId: ctx.reportChat.id,
      model: ctx.modelId,
      locale: ctx.locale,
    });
    phase = "turn";
    const turn = await settledReportTurn(ctx, truth, binding);
    phase = "independent-evidence";
    const observed = await currentReportEvidence(ctx, truth);
    phase = "grading";
    const grade = await gradeLimitReport(turn, observed, truth);
    ctx.signal.throwIfAborted();
    const result = { step: REPORT_STEP, ...grade, evidenceFile: ctx.intent.path };
    await ctx.intent.record(REPORT_STEP, {
      binding,
      phase: "settled",
      turn,
      result,
      observed: {
        pages: observed.pages,
        issues: observed.issues.map((issue) => projectProgressNativeIssue(issue, truth)),
      },
    });
    return result;
  } catch {
    return {
      step: REPORT_STEP,
      status: "unverified",
      detail: "Independent report evidence or resumable turn unavailable; phase=" + phase,
      counts: {},
    };
  }
}
