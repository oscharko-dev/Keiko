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
function newIssues(beforeKeys, issues) {
  return issues.filter((issue) => !beforeKeys.has(issue.key));
}

// ---------- reconciled draft items ----------

import { toolExchangeOf } from "./tool-exchanges.mjs";
/** States whose issue key is an issue the draft stands behind; the other states name no issue. */
const CREDITED_DRAFT_STATES = new Set(["created", "existing"]);
const DRAFT_IDENTITY = /^keiko-draft-[0-9a-f]{20}$/;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The issue keys the completed `jira.draft` results of a turn report as `created` or `existing`.
 * `jira.draft` reconciles an item whose deterministic identity label already exists (state
 * `existing`) instead of creating it again: that is the correct product behaviour, so the key counts
 * as the turn's issue. uncertain, failed, skipped and excluded items name no issue and count for
 * nothing.
 */
function draftReportedKeys(exchanges) {
  const draftResults = (Array.isArray(exchanges) ? exchanges : []).filter((exchange) =>
    toolExchangeOf(exchange, "jira.draft"),
  );
  const items = draftResults.flatMap((exchange) => {
    const list = exchange.result.data?.items;
    return Array.isArray(list) ? list : [];
  });
  return new Set(
    items
      .filter((item) => isRecord(item) && CREDITED_DRAFT_STATES.has(item.state))
      .map((item) => item.issueKey)
      .filter((key) => typeof key === "string"),
  );
}

/** The deterministic draft identity label of an issue, or undefined. */
export const draftIdentity = (issue) =>
  (issue.fields?.labels ?? []).find((label) => DRAFT_IDENTITY.test(label));

/**
 * The issues a turn produced, from the search after the turn. Credited are the issues new since the
 * turn began (a draft's `created` items and single creates alike) and the issues the turn's own
 * draft reported; an issue that existed before and that the draft did not report is not credited.
 * `reconciled` are the credited issues that existed before the turn. `duplicates` are the new issues
 * whose draft identity label already belonged to another issue.
 */
export function turnIssues({ before, issues, exchanges }) {
  const reported = draftReportedKeys(exchanges);
  const credited = issues.filter((issue) => !before.keys.has(issue.key) || reported.has(issue.key));
  const seen = new Set(before.identities);
  const duplicates = [];
  for (const issue of newIssues(before.keys, issues)) {
    const identity = draftIdentity(issue);
    if (identity === undefined) continue;
    if (seen.has(identity)) duplicates.push(issue.key);
    seen.add(identity);
  }
  return {
    credited,
    created: credited.filter((issue) => !before.keys.has(issue.key)),
    reconciled: credited.filter((issue) => before.keys.has(issue.key)),
    duplicates,
  };
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
export const claimedRequirement = (issue) => /^\[(LH-\d{3})\]/.exec(issue.fields.summary)?.[1];

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

// ---------- S14-S16: change impact, quality findings, test cases (#4179) ----------

/** The line of the answer that starts with `label` (a regular expression source), if any. */
function lineLabelled(answer, label) {
  return answer
    .split("\n")
    .find((entry) => new RegExp(String.raw`^\W*(?:${label})\b`, "i").test(entry));
}

/** Requirement ids listed after the label on one line of the answer. */
function listedAfter(answer, label) {
  const line = lineLabelled(answer, label);
  return new Set(line === undefined ? [] : line.slice(line.indexOf(":") + 1).match(REQUIREMENT_ID));
}

const sameSet = (left, right) => left.size === right.size && [...left].every((id) => right.has(id));

/**
 * S15: the answer names the requirements with vague wording after `UNKLAR:` and those without
 * acceptance criteria after `OHNE ABNAHMEKRITERIEN:`; both sets must equal the seeded defects.
 */
export function gradeQualityFindings(answer, truth) {
  const vague = new Set(truth.filter((item) => item.vague).map((item) => item.id));
  const missing = new Set(
    truth.filter((item) => item.acceptanceCount === 0).map((item) => item.id),
  );
  const reportedVague = listedAfter(answer, "UNKLAR");
  const reportedMissing = listedAfter(answer, "OHNE ABNAHMEKRITERIEN");
  return {
    vagueOk: sameSet(vague, reportedVague),
    missingOk: sameSet(missing, reportedMissing),
    vague: vague.size,
    missing: missing.size,
    vagueReported: reportedVague.size,
    missingReported: reportedMissing.size,
  };
}

/**
 * S16: one test case per acceptance criterion of the requirement, each carrying the criterion
 * reference `<id>/AC<n>`; a reference beyond the criteria of the requirement is invented.
 */
export function gradeCriterionTestCases(answer, item) {
  const escaped = escapeRegExp(item.id);
  const referenced = new Set(
    [...answer.matchAll(new RegExp(String.raw`${escaped}/AC(\d+)`, "g"))].map((m) => Number(m[1])),
  );
  const expected = Array.from({ length: item.acceptanceCount }, (_, index) => index + 1);
  const missing = expected.filter((number) => !referenced.has(number));
  const invented = [...referenced].filter((number) => number < 1 || number > item.acceptanceCount);
  return { ok: missing.length === 0 && invented.length === 0, missing, invented };
}

/**
 * S14: the answer names exactly the changed, removed and added requirements of the new version
 * (`GEÄNDERT:`, `ENTFERNT:`, `NEU:`) and exactly the issues that trace the changed or removed ones
 * (`BETROFFENE VORGÄNGE:`).
 */
export function gradeChangeImpact(answer, change, affectedKeys) {
  const keys = new Set(
    lineLabelled(answer, "BETROFFENE VORG[ÄA]NGE")?.match(/[A-Z][A-Z0-9]+-\d+/g),
  );
  const changed = sameSet(new Set(change.changed), listedAfter(answer, "GE[ÄA]NDERT"));
  const removed = sameSet(new Set(change.removed), listedAfter(answer, "ENTFERNT"));
  const added = sameSet(new Set(change.added), listedAfter(answer, "NEU"));
  const affected = sameSet(new Set(affectedKeys), keys);
  return { changed, removed, added, affected, ok: changed && removed && added && affected };
}
