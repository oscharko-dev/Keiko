// Oracle of the coverage journey S12 (epic #4173, #4174, #4181). Which requirement is named by which
// issue is read from the issues Jira holds (summary, labels and description, tokenised like the
// product's report so a requirement counts as named only for a whole identifier). A claim counts
// only when two independent facts agree: the answer's line, and the structured requirement
// coverage of a complete `jira.report` result of the turn. The answer format is strict:
//   <requirement id>;ABGEDECKT;<issue keys, comma separated>
//   <requirement id>;OFFEN;
import { completedToolExchange } from "./tool-exchanges.mjs";

const TOKEN = /[A-Za-z0-9][A-Za-z0-9._-]*/gu;
const ISSUE_KEY = /[A-Z][A-Z0-9]+-\d+/g;
const LINE = /^\s*(LH-\d{3})\s*;\s*(ABGEDECKT|OFFEN)\s*;([^\n]*)$/gimu;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sameSet = (left, right) => left.size === right.size && [...left].every((id) => right.has(id));

/** A trailing dot, dash or underscore ends a sentence, not an identifier. */
function trimTrailingSeparators(token) {
  let end = token.length;
  while (end > 0 && ".-_".includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}

function tokensOf(issue) {
  const labels = (issue.fields.labels ?? []).filter((label) => typeof label === "string");
  const description = typeof issue.fields.description === "string" ? issue.fields.description : "";
  const texts = [issue.fields.summary ?? "", ...labels, description];
  return new Set(
    texts.flatMap((text) => [...text.matchAll(TOKEN)].map((m) => trimTrailingSeparators(m[0]))),
  );
}

/** Per requirement id, the keys of the issues that name it (empty set: nothing names it). */
export function requirementCoverageTruth(issues, requirementIds) {
  const tokens = issues.map((issue) => ({ key: issue.key, tokens: tokensOf(issue) }));
  return new Map(
    requirementIds.map((id) => [
      id,
      new Set(tokens.filter((issue) => issue.tokens.has(id)).map((issue) => issue.key)),
    ]),
  );
}

// ---------- structured result of the report tool ----------

const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

function entryOf(item) {
  const total = typeof item.coveredByTotal === "number" ? item.coveredByTotal : undefined;
  const coveredBy = strings(item.coveredBy);
  return {
    covered: item.covered === true,
    coveredBy: new Set(coveredBy),
    complete: total === undefined || total === coveredBy.length,
  };
}

const items = (value) => (Array.isArray(value) ? value.filter((item) => isRecord(item)) : []);

/** Entries of the summary view: covered ids with their issues and the uncovered ids. */
function summaryEntries(requirements) {
  if (!isRecord(requirements)) return [];
  return [
    ...items(requirements.items?.items).map((item) => [
      item.id,
      entryOf({ ...item, covered: true }),
    ]),
    ...strings(requirements.uncovered?.items).map((id) => [id, entryOf({ covered: false })]),
  ];
}

/** Requirement entries of one completed `jira.report` result: the summary view or a section page. */
function entriesOf(data) {
  if (!isRecord(data) || data.outcome !== "succeeded" || data.status !== "complete") return [];
  const page = isRecord(data.section) && data.section.name === "requirements" ? data.section : {};
  return [
    ...summaryEntries(data.report?.coverage?.requirements),
    ...items(page.items).map((item) => [item.id, entryOf(item)]),
  ].filter(([id]) => typeof id === "string");
}

/** Two statements of one requirement disagree on its state or, when both are whole, its issues. */
const disagree = (left, right) =>
  left.covered !== right.covered ||
  (left.complete && right.complete && !sameSet(left.coveredBy, right.coveredBy));

/**
 * The requirement coverage the completed `jira.report` results of the turn state, per id, or
 * undefined when none states any. An id stated twice that disagrees is a conflict.
 */
export function structuredRequirementCoverage(exchanges) {
  const lists = (Array.isArray(exchanges) ? exchanges : [])
    .filter((exchange) => completedToolExchange(exchange, "jira.report"))
    .map((exchange) => entriesOf(exchange.result.data))
    .filter((entries) => entries.length > 0);
  if (lists.length === 0) return undefined;
  const entries = new Map();
  const conflicts = new Set();
  for (const [id, entry] of lists.flat()) {
    const known = entries.get(id);
    if (known !== undefined && disagree(known, entry)) conflicts.add(id);
    entries.set(id, known === undefined || !known.complete ? entry : known);
  }
  return { entries, conflicts };
}

// ---------- the answer ----------

function parseCoverageAnswer(answer) {
  const lines = new Map();
  const conflicts = new Set();
  for (const match of answer.matchAll(LINE)) {
    const row = {
      covered: match[2].toUpperCase() === "ABGEDECKT",
      keys: new Set(match[3].match(ISSUE_KEY) ?? []),
    };
    const known = lines.get(match[1]);
    if (known !== undefined && (known.covered !== row.covered || !sameSet(known.keys, row.keys)))
      conflicts.add(match[1]);
    lines.set(match[1], row);
  }
  return { lines, conflicts };
}

/** Whether a stated line (answer or tool) says exactly what Jira holds for the requirement. */
function states(row, expectedKeys) {
  if (row === undefined) return false;
  if (row.covered !== expectedKeys.size > 0) return false;
  // A tool list cut short cannot vouch for the covering issues.
  return (
    !row.covered || (row.complete !== false && sameSet(row.keys ?? row.coveredBy, expectedKeys))
  );
}

/**
 * Grades a coverage matrix. `truth` is `requirementCoverageTruth(...)`, `structured` the result of
 * `structuredRequirementCoverage(...)` of the turn (must be available). A requirement is right
 * when its line names exactly the covering issues Jira holds (or `OFFEN` when none does) and the
 * tool states the same; the matrix is graded over the covered requirements, the open list over the
 * uncovered ones.
 */
export function gradeCoverageMatrix(answer, truth, structured) {
  const parsed = parseCoverageAnswer(answer);
  const ids = [...truth.keys()];
  const covered = ids.filter((id) => truth.get(id).size > 0);
  const open = ids.filter((id) => truth.get(id).size === 0);
  const right = (id) =>
    !parsed.conflicts.has(id) &&
    !structured.conflicts.has(id) &&
    states(parsed.lines.get(id), truth.get(id)) &&
    states(structured.entries.get(id), truth.get(id));
  const invented = [...parsed.lines.keys()].filter((id) => !truth.has(id));
  const reportedOpen = new Set(
    [...parsed.lines].filter(([, row]) => !row.covered).map(([id]) => id),
  );
  return {
    matrixOk: covered.every((id) => right(id)) && invented.length === 0,
    openOk: open.every((id) => right(id)) && sameSet(reportedOpen, new Set(open)),
    covered: covered.length,
    open: open.length,
    wrong: ids.filter((id) => !right(id)),
    unreported: ids.filter((id) => !structured.entries.has(id)),
    invented,
  };
}
