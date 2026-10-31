// Pure oracles of the requirements journeys (epic #4173, #4174). They compare an answer or a
// Jira read with the generated ground truth and never ask the model whether it succeeded.
import { STRUCTURE_RULES } from "./corpus.mjs";

const REQUIREMENT_ID = /LH-\d{3}/g;

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// ---------- S04: requirement listing ----------

function titleListed(line, item) {
  const lower = line.toLowerCase();
  if (lower.includes(item.title.toLowerCase())) return true;
  // A table may split "<area>: <topic>" into two columns.
  const topic = item.title
    .slice(item.area.length + 1)
    .trim()
    .toLowerCase();
  return lower.includes(item.area.toLowerCase()) && topic !== "" && lower.includes(topic);
}

const priorityListed = (line, item) => new RegExp(String.raw`\b${item.priority}\b`, "i").test(line);

/** The chapter number as its own token; the digits of the requirement id never count. */
function chapterListed(line, item) {
  const rest = line.replaceAll(REQUIREMENT_ID, " ");
  return new RegExp(String.raw`(?<![\d.])${item.chapter}(?!\d)`).test(rest);
}

/**
 * Grades a requirement listing: every requirement of the truth once with its title, priority and
 * source chapter, none invented. The listing is read line by line; a line belongs to a requirement
 * when it names that requirement id and no other.
 */
export function gradeRequirementListing(answer, truth) {
  const lines = answer
    .split("\n")
    .map((line) => ({ line, ids: new Set(line.match(REQUIREMENT_ID)) }));
  const known = new Set(truth.map((item) => item.id));
  const found = new Set(lines.flatMap(({ ids }) => [...ids]));
  const missing = truth.filter((item) => !found.has(item.id)).map((item) => item.id);
  const invented = [...found].filter((id) => !known.has(id));
  const aspects = { title: titleListed, priority: priorityListed, chapter: chapterListed };
  const incomplete = { title: [], priority: [], chapter: [] };
  for (const item of truth.filter((entry) => found.has(entry.id))) {
    const own = lines.filter(({ ids }) => ids.size === 1 && ids.has(item.id));
    for (const [aspect, listed] of Object.entries(aspects)) {
      if (!own.some(({ line }) => listed(line, item))) incomplete[aspect].push(item.id);
    }
  }
  const complete = Object.values(incomplete).every((ids) => ids.length === 0);
  return {
    ok: missing.length === 0 && invented.length === 0 && complete,
    missing,
    invented,
    incomplete,
  };
}

// S11 (compliance report) lives in deviation-report.mjs: it also reads the tool result.
export { gradeDeviationReport, structuredDeviations } from "./deviation-report.mjs";

// ---------- creation oracles ----------

/** Issues that appeared during this turn: present now, absent from the pre-turn key set. */
export function newIssues(beforeKeys, issues) {
  return issues.filter((issue) => !beforeKeys.has(issue.key));
}

export function sectionsPresent(description, sections) {
  return sections.every((name) =>
    new RegExp(String.raw`(^|\n)\s*(h\d\.|#+)?\s*\**${escapeRegExp(name)}`, "i").test(
      description ?? "",
    ),
  );
}

export function epicConforms(issue, requirementId) {
  const rule = STRUCTURE_RULES.Epic;
  return (
    issue.fields.summary.startsWith(`[${requirementId}]`) &&
    sectionsPresent(issue.fields.description, rule.sections) &&
    rule.labels.every((label) => issue.fields.labels?.includes(label))
  );
}

/** Requirement id an epic summary claims (`[LH-001] ...`), or undefined. */
const claimedRequirement = (issue) => /^\[(LH-\d{3})\]/.exec(issue.fields.summary)?.[1];

/**
 * Grades a long backlog request: the epics created in this turn map one to one onto the requested
 * requirement ids, and the answer names every created key.
 */
export function gradeBacklog({ requested, created, answer }) {
  const claimed = created.map(claimedRequirement);
  const wanted = new Set(requested);
  const mappedOnce = requested.filter((id) => claimed.filter((claim) => claim === id).length === 1);
  const stray = claimed.filter((claim) => claim === undefined || !wanted.has(claim));
  const unnamed = created
    .map((issue) => issue.key)
    .filter((key) => !new RegExp(String.raw`\b${escapeRegExp(key)}(?!\d)`).test(answer));
  return {
    mappingOk: mappedOnce.length === requested.length && created.length === requested.length,
    namesOk: created.length > 0 && unnamed.length === 0,
    mapped: mappedOnce.length,
    stray: stray.length,
    unnamed: unnamed.length,
  };
}
