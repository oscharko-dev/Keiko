// Oracle of the progress journey S10 (epic #4173, #4174, #4181). The ground truth is computed from
// the issues Jira holds after the turn (counts per type and status, members and done members per
// epic, estimate totals), never from the model's answer or from the report tool it may have used.
// The answer has to follow a strict line format the prompt itself asks for:
//   ANZAHL;<type>;<status>;<count>        one line per type/status combination
//   EPIC;<key>;<members>;<done members>   one line per epic
//   SCHÄTZUNG;<total>;<done>;<remaining>  one line (only when the instance has an estimate field;
//                                         a time-tracking estimate is asked for in hours)

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
