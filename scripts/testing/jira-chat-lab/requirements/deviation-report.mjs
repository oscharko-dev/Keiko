// Oracle of the compliance journey S11 (epic #4173, #4174). A deviation counts as reported only when
// two independent facts agree: the structured result of the `jira.report` tool names the issue with a
// matching rule or field id, and the answer attributes the deviation to that issue without denying
// it. Word occurrence alone proves nothing: "Summary, Parent and Label are correct" contains the
// words of every seeded deviation.
import {
  createJiraReportTemplateChecker,
  resolveJiraTemplateFieldIds,
} from "@oscharko-dev/keiko-connectors";
import { completedToolExchange } from "./tool-exchanges.mjs";
const ISSUE_KEY = /RPT-\d+/g;

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// ---------- structured result of the compliance tool ----------

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

/** Deviation entries a completed `jira.report` result carries: the summary list or a page of it. */
function deviationEntries(data) {
  if (!isRecord(data) || data.outcome !== "succeeded") return undefined;
  const summary = data.report?.compliance?.deviations;
  const section = isRecord(data.section) && data.section.name === "deviations" ? data.section : {};
  const lists = [summary?.items, section.items].filter(Array.isArray);
  return lists.length === 0 ? undefined : lists.flat().filter(isRecord);
}

function merge(byKey, entry) {
  if (typeof entry.key !== "string") return;
  const known = byKey.get(entry.key) ?? { ruleIds: new Set(), fieldIds: new Set() };
  for (const id of strings(entry.ruleIds)) known.ruleIds.add(id);
  for (const id of strings(entry.fieldIds)) known.fieldIds.add(id);
  byKey.set(entry.key, known);
}

const completedReport = (exchange) => completedToolExchange(exchange, "jira.report");

/**
 * Per issue key, the rule ids and field ids every completed `jira.report` call of the turn reported
 * as deviations, or undefined when the turn holds no structured compliance result at all.
 */
export function structuredDeviations(exchanges) {
  const lists = (Array.isArray(exchanges) ? exchanges : [])
    .filter(completedReport)
    .map((exchange) => deviationEntries(exchange.result.data))
    .filter((entries) => entries !== undefined);
  if (lists.length === 0) return undefined;
  const byKey = new Map();
  for (const entry of lists.flat()) merge(byKey, entry);
  return byKey;
}

const normalized = (value) => value.toLowerCase().replaceAll(/[^\p{L}\p{N}]/gu, "");

// Rule ids of a template checker are its own; a deviation counts as reported when an id of the
// issue's entry names the field, or the entry carries the instance's id of that field.
const STRUCTURED_IDS = {
  summary: { pattern: /summary|titel|title|prefix|praefix/, field: "summary" },
  parent: { pattern: /parent|epic|uebergeordnet/, field: "epicLink" },
  estimate: { pattern: /estimate|storypoint|aufwand|schaetzung/, field: "storyPoints" },
  label: { pattern: /label/ },
};

/** Whether a structured entry names the seeded deviation by its rule ids or its field ids. */
function structurallyReported(code, entry, fieldIds, sectionCount) {
  const ids = [...entry.ruleIds, ...entry.fieldIds].map((id) => normalized(id));
  const mentions = (pattern) => ids.some((id) => pattern.test(id));
  const [kind, detail = ""] = code.split(":");
  if (kind === "section") {
    // One flagged description field names a single missing section; with several it names none.
    return (
      mentions(new RegExp(escapeRegExp(normalized(detail)))) ||
      (sectionCount === 1 && mentions(/description|beschreibung/))
    );
  }
  const known = STRUCTURED_IDS[kind];
  if (known === undefined) throw new TypeError(`Unknown seeded deviation ${code}`);
  const id = known.field === undefined ? undefined : fieldIds?.[known.field];
  return mentions(known.pattern) || (id !== undefined && entry.fieldIds.has(id));
}

// ---------- the answer: attribution and denial ----------

const DEVIATION_WORDS = {
  summary: /zusammenfassung|summary|titel|präfix|\[LH-/i,
  parent: /parent|epic|übergeordnet|zuordn|verknüpf/i,
  // Jira's own estimate fields: Story Points, or Time Tracking with its Original Estimate.
  estimate: /sch[aä]tzung|estimate|story ?points?|aufwand|time ?tracking|zeiterfassung/i,
  label: /label/i,
};

function deviationPattern(code) {
  if (code.startsWith("section:")) return new RegExp(escapeRegExp(code.slice(8)), "i");
  if (code.startsWith("label:")) return DEVIATION_WORDS.label;
  const pattern = DEVIATION_WORDS[code];
  if (pattern === undefined) throw new TypeError(`Unknown seeded deviation ${code}`);
  return pattern;
}

const LETTER = String.raw`[\p{L}\p{N}-]`;
/** A whole word or phrase; a hyphen continues a word, so "non-compliant" never contains "compliant". */
const phrase = (source) => String.raw`(?<!${LETTER})(?:${source})(?!${LETTER})`;

// A clause denies a deviation when it states there is none ...
const DEVIATION_NOUN = String.raw`abweichung(?:en)?|fehler|m[äa]ngel|beanstandung(?:en)?|verst[öo]ss?e?|auff[äa]lligkeit(?:en)?|probleme?|deviations?|issues?|errors?|violations?|findings?|problems?|discrepanc(?:y|ies)|differences?`;
const NOTHING_FOUND = phrase(
  String.raw`(?:keine?[nrms]?|ohne|no|without|zero)\s+(?:\p{L}+\s+){0,2}(?:${DEVIATION_NOUN})|(?:${DEVIATION_NOUN})\s*[:=-]?\s*(?:keine?|none|nil|null|0)|nichts\s+(?:zu\s+beanstanden|gefunden|auff[äa]llig)|nothing\s+(?:to\s+report|found|wrong)|none\s+found`,
);
// ... or that the checked fields are fine; a negator just before it ("nicht korrekt") flips it back.
const FINE = phrase(
  String.raw`vollständig\s+und\s+\p{L}+|korrekt|richtig|konform|regelkonform|in\s+ordnung|fehlerfrei|einwandfrei|entspricht\s+(?:der|den|dem)\s+\p{L}+|erfüllt|compliant|conforms?|conformant|correct|valid|ok(?:ay)?|fine|passes|matches\s+the\s+\p{L}+|as\s+expected`,
);
const NEGATOR = phrase(
  String.raw`nicht|kein\p{L}*|nie|not|no|never|n't|isn't|aren't|doesn't|don't|fails?\s+to`,
);
// ... or that a problem word is itself negated: "nicht leer", "is not missing", "fehlt nicht".
const NOT_A_PROBLEM = phrase(
  String.raw`(?:nicht|not|never|nie|kein\p{L}*)\s+(?:\p{L}+\s+)?(?:leer|fehlend|fehlt|missing|empty|ungültig|invalid|falsch|wrong|unset|absent|fehlerhaft|incorrect)|fehl\p{L}*\s+(?:nicht|nirgends)|nichts\s+(?:fehlt|ist\s+falsch)`,
);
const NEGATED_FINE = new RegExp(String.raw`${NEGATOR}(?:\s+\p{L}+){0,2}\s+${FINE}`, "giu");
const NOTHING_FOUND_RE = new RegExp(NOTHING_FOUND, "iu");
const NOT_A_PROBLEM_RE = new RegExp(NOT_A_PROBLEM, "iu");
const FINE_RE = new RegExp(FINE, "iu");

/**
 * Whether a clause denies a deviation instead of describing one. "Nicht korrekt" and "is not
 * compliant" describe a deviation; a fine-claim that no negator in reach flips is a denial.
 */
function deniesDeviation(clause) {
  if (NOTHING_FOUND_RE.test(clause) || NOT_A_PROBLEM_RE.test(clause)) return true;
  return FINE_RE.test(clause.replaceAll(NEGATED_FINE, " "));
}

// A description of a deviation states a violation: a field that is absent, empty, wrong or unlike the
// template. Naming the checked fields ("Geprüft wurden Summary, Parent ...") or calling them present
// states none, so it describes no deviation however many field words it holds.
const VIOLATION = phrase(
  String.raw`fehl\p{L}*|missing|lack\p{L}*|absent|ohne|without|kein\p{L}*|nicht|not|no|n't|never|ungültig\p{L}*|invalid|falsch\p{L}*|wrong|incorrect|leer\p{L}*|empty|unset|verletz\p{L}*|violat\p{L}*|weicht\s+ab|abweich\p{L}*|deviat\p{L}*|mangel\p{L}*|m[äa]ngel\p{L}*|fehlerhaft\p{L}*|unvollständig\p{L}*|incomplete|unzulässig\p{L}*|mismatch\p{L}*|differs?|expected|erwartet|statt`,
);
const VIOLATION_RE = new RegExp(VIOLATION, "iu");
const DEVIATION_SCOPE_RE = new RegExp(phrase(DEVIATION_NOUN), "iu");

const CLAUSE_BREAK = /[.;!?\n]+|\s+(?:aber|jedoch|während|whereas|but|however|although|obwohl)\s+/i;

// A line that names no issue and ends in a colon, or a Markdown heading, introduces what follows.
const LEAD = /^\s*(?:#{1,6}\s+\S.*|.*\S:[*_`\s]*)$/;

/**
 * For each line of a list that a lead introduces, the index of that lead: a lead whose next
 * non-blank line names an issue covers every following line up to the first non-blank line that
 * names none. "**Abschnitt Abgrenzung fehlt:**" over "* RPT-6, RPT-12" attributes it to both.
 */
function listLeads(lines, issueKey) {
  const namesIssue = new RegExp(issueKey.source);
  const leads = new Map();
  let lead;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    if (namesIssue.test(line)) {
      if (lead !== undefined) leads.set(index, lead);
    } else {
      lead = LEAD.test(line) ? index : undefined;
    }
  }
  return leads;
}

const HEADING = /^\s{0,3}(#{1,6})\s+\S/;

/** For each line, the Markdown headings above it that no heading of the same or a higher level closed. */
function enclosingHeadings(lines) {
  const stack = [];
  return lines.map((line) => {
    const level = HEADING.exec(line)?.[1].length;
    if (level !== undefined) {
      while (stack.length > 0 && stack.at(-1).level >= level) stack.pop();
      stack.push({ level, line });
    }
    return stack.map((heading) => heading.line);
  });
}

const clausesOf = (keyLines) =>
  keyLines
    .join("\n")
    .split(CLAUSE_BREAK)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");

/**
 * Per issue key, the clauses of the lines that name it, of the lines that continue them and of the
 * lead that introduces the list naming it, plus the `context` that frames them: the lead and every
 * heading that encloses the issue's lines. A lead that opens a list belongs to that list, never to
 * the issues of the list before it. The context is never credited as a description by itself, but
 * it can deny ("## No deviations found" over a list) or state that what follows are deviations.
 */
function clausesByKey(answer, issueKey = ISSUE_KEY) {
  const lines = answer.split("\n");
  const leads = listLeads(lines, issueKey);
  const headings = enclosingHeadings(lines);
  const opening = new Set(leads.values());
  const segments = new Map();
  const context = new Map();
  let current = [];
  for (const [index, line] of lines.entries()) {
    if (opening.has(index)) continue;
    const keys = line.match(issueKey);
    if (keys) current = [...new Set(keys)];
    const attributed = leads.has(index) ? [lines[leads.get(index)], line] : [line];
    const framing = [...(leads.has(index) ? [lines[leads.get(index)]] : []), ...headings[index]];
    for (const key of current) {
      segments.set(key, [...(segments.get(key) ?? []), ...attributed]);
      context.set(key, [...new Set([...(context.get(key) ?? []), ...framing])]);
    }
  }
  return new Map(
    [...segments].map(([key, keyLines]) => [
      key,
      { clauses: clausesOf(keyLines), context: context.get(key) ?? [] },
    ]),
  );
}

const hasKey = (clause, key) => new RegExp(String.raw`${escapeRegExp(key)}(?!\d)`).test(clause);
const mentionsAnyDeviation = (clause) =>
  [...Object.values(DEVIATION_WORDS), /abnahmekriterien|abgrenzung|testhinweise/i].some((pattern) =>
    pattern.test(clause),
  );

const NO_PART = Object.freeze({ clauses: [], context: [] });
const namesNoField = (text) => !mentionsAnyDeviation(text);

/**
 * An issue is denied as a whole when a clause naming it, or a lead or heading that frames it, states
 * that nothing is wrong without naming any field: "RPT-1: Keine Abweichung", "## No deviations
 * found". What follows cannot undo that statement.
 */
function issueDenied(key, { clauses, context }) {
  return (
    clauses.some(
      (clause) => hasKey(clause, key) && deniesDeviation(clause) && namesNoField(clause),
    ) || context.some((line) => deniesDeviation(line) && namesNoField(line))
  );
}

/**
 * Whether a clause of an issue's part of the answer describes the deviation: it names the field,
 * states a violation (or sits under a lead that says these are deviations), denies nothing itself
 * and no enclosing line denies this very field.
 */
function describedInAnswer(code, { clauses, context }) {
  const pattern = deviationPattern(code);
  if (context.some((line) => pattern.test(line) && deniesDeviation(line))) return false;
  const scoped = context.some((line) => DEVIATION_SCOPE_RE.test(line));
  return clauses.some(
    (clause) =>
      pattern.test(clause) && !deniesDeviation(clause) && (scoped || VIOLATION_RE.test(clause)),
  );
}

/** Deviations of one expected issue that the tool did not report and the answer did not describe. */
function gaps(issue, structured, part, fieldIds) {
  const entry = structured.get(issue.key);
  const sectionCount = issue.deviations.filter((code) => code.startsWith("section:")).length;
  const label = (code) => `${issue.key} ${code}`;
  return {
    unreported: issue.deviations
      .filter(
        (code) => entry === undefined || !structurallyReported(code, entry, fieldIds, sectionCount),
      )
      .map((code) => label(code)),
    undescribed: issue.deviations
      .filter((code) => !describedInAnswer(code, part))
      .map((code) => label(code)),
  };
}

/**
 * Grades a compliance report. `structured` is `structuredDeviations(...)` of the turn and must be
 * available. Exactly the deviating issues are named without denial, and each seeded deviation of
 * each of them is both reported by the tool for that issue and described in that issue's part of the
 * answer without negation.
 */
export function gradeDeviationReport(
  answer,
  issues,
  structured,
  fieldIds = {},
  issueKey = ISSUE_KEY,
) {
  const expected = issues.filter((issue) => issue.deviations.length > 0);
  const expectedKeys = new Set(expected.map((issue) => issue.key));
  const parts = clausesByKey(answer, issueKey);
  const reported = new Set([...parts.keys()].filter((key) => !issueDenied(key, parts.get(key))));
  const found = expected.filter((issue) => reported.has(issue.key) && structured.has(issue.key));
  const falseFindings = [...reported].filter((key) => !expectedKeys.has(key));
  // A denied issue is described by nothing: its clauses do not count.
  const perIssue = expected.map((issue) =>
    gaps(
      issue,
      structured,
      reported.has(issue.key) ? (parts.get(issue.key) ?? NO_PART) : NO_PART,
      fieldIds,
    ),
  );
  const unreported = perIssue.flatMap((item) => item.unreported);
  const undescribed = perIssue.flatMap((item) => item.undescribed);
  return {
    keysOk: found.length === expected.length && falseFindings.length === 0,
    detailOk: undescribed.length === 0 && unreported.length === 0,
    found: found.length,
    expected: expected.length,
    falseFindings,
    unreported,
    undescribed,
    deviationCount: expected.reduce((sum, issue) => sum + issue.deviations.length, 0),
  };
}

// ---------- S11b: a whole large report against independent native pages ----------

const LARGE_ISSUE_KEY = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
const sameStrings = (left, right) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === right.length &&
  new Set(left).size === left.length &&
  left.every((value) => typeof value === "string" && right.includes(value));

function largeTruthFields(truth) {
  return (
    typeof truth.fieldIds?.epicLink === "string" &&
    truth.issues.length === truth.issueCount &&
    sameStrings(truth.templateScope?.issueTypes, ["Epic", "Task", "Bug"])
  );
}

/** The versioned seed is a review snapshot, never evidence that Jira still holds those values. */
export function largeDeviationTruth(value) {
  const truth = value?.large ?? value;
  if (!isRecord(truth) || truth.seedVersion !== 2 || !Array.isArray(truth.issues)) return undefined;
  if (typeof truth.project !== "string" || !/^[A-Z][A-Z0-9_]{0,9}$/u.test(truth.project))
    return undefined;
  return largeTruthFields(truth) ? truth : undefined;
}

function nativePageReceipt(page, offset, total) {
  return (
    page.startAt === offset &&
    page.maxResults === 100 &&
    page.total === total &&
    Number.isSafeInteger(page.count) &&
    page.count >= 1 &&
    page.count <= 100
  );
}

function completeNativePages(observed) {
  if (
    !Array.isArray(observed?.issues) ||
    !Array.isArray(observed.pages) ||
    observed.pages.length < 3
  )
    return false;
  let offset = 0;
  for (const page of observed.pages) {
    if (!nativePageReceipt(page, offset, observed.issues.length)) return false;
    offset += page.count;
  }
  return offset === observed.issues.length;
}

function nativeDeviations(issue, truth, epics) {
  const { fields } = issue;
  if (!truth.templateScope.issueTypes.includes(fields.issuetype.name)) return [];
  if (!Array.isArray(fields.labels) || !Object.hasOwn(fields, truth.fieldIds.epicLink))
    return undefined;
  const codes = fields.labels.includes("anforderung") ? [] : ["label:anforderung"];
  if (fields.issuetype.name === "Task" && !epics.has(fields[truth.fieldIds.epicLink]))
    codes.push("parent");
  return codes;
}

function sameNativeMetadata(expected, actual, project) {
  if (!isRecord(expected) || !isRecord(actual?.fields)) return false;
  const fields = actual.fields;
  return (
    actual.key === expected.key &&
    actual.key.startsWith(`${project}-`) &&
    fields.issuetype?.name === expected.type &&
    fields.status?.name === expected.status
  );
}

function sameNativeParent(expected, fields, truth) {
  if (fields.issuetype.subtask === true) {
    return typeof expected.parent === "string" && fields.parent?.key === expected.parent;
  }
  if (expected.parent !== undefined && fields.parent?.key !== expected.parent) return false;
  if (truth.templateScope.issueTypes.includes(expected.type))
    return fields[truth.fieldIds.epicLink] === (expected.epic ?? null);
  return expected.epic === undefined || fields[truth.fieldIds.epicLink] === expected.epic;
}

function sameNativeIssue(expected, actual, truth, epics) {
  if (!sameNativeMetadata(expected, actual, truth.project)) return false;
  const fields = actual.fields;
  if (!sameStrings(fields.labels, expected.labels)) return false;
  if (!sameNativeParent(expected, fields, truth)) return false;
  return sameStrings(nativeDeviations(actual, truth, epics), expected.deviations);
}

function observedLargeTruth(observed, truth) {
  if (!completeNativePages(observed) || observed.issues.length !== truth.issueCount) return false;
  const expected = new Map(truth.issues.map((issue) => [issue.key, issue]));
  const actual = new Map(observed.issues.map((issue) => [issue.key, issue]));
  if (expected.size !== truth.issueCount || actual.size !== truth.issueCount) return false;
  const epics = new Set(
    observed.issues
      .filter((issue) => issue.fields?.issuetype?.name === "Epic")
      .map((issue) => issue.key),
  );
  return observed.issues.every((issue) =>
    sameNativeIssue(expected.get(issue.key), issue, truth, epics),
  );
}

function completeReportIdentity(data, summary, truth) {
  if (data?.outcome !== "succeeded" || data.status !== "complete") return false;
  if (data.reportId !== summary.reportId || data.report?.digest !== summary.report.digest)
    return false;
  return completeReportPopulation(data.report.completeness, truth.issueCount);
}

const completeReportPopulation = (complete, count) =>
  complete?.complete === true && complete.issuesRead === count && complete.issuesTotal === count;

function reportSummary(exchanges, truth) {
  return exchanges
    .filter(completedReport)
    .map((exchange) => exchange.result.data)
    .find(
      (data) =>
        data?.report?.scope?.projectKey === truth.project && isRecord(data.report.compliance),
    );
}

function readDeviationPage(data, call, summary, offset) {
  if (data === summary) return { ...data.report.compliance.deviations, startAt: 0 };
  const page = data.section;
  if (page?.name !== "deviations" || call.arguments?.reportId !== summary.reportId)
    return undefined;
  if (call.arguments.section !== "deviations" || call.arguments.startAt !== offset)
    return undefined;
  return page;
}

function deviationPageBounds(page, state) {
  if (
    !isRecord(page) ||
    !Array.isArray(page.items) ||
    page.startAt !== state.offset ||
    page.total !== state.total
  )
    return false;
  const end = state.offset + page.items.length;
  if (end > state.total || (end < state.total && page.items.length === 0)) return false;
  if (page.nextStartAt !== (end < state.total ? end : undefined)) return false;
  return true;
}

function appendDeviationPage(page, state) {
  if (!deviationPageBounds(page, state)) return false;
  for (const item of page.items) {
    if (!isRecord(item) || typeof item.key !== "string" || state.entries.has(item.key))
      return false;
    if (!sameStrings(item.ruleIds, item.ruleIds) || !sameStrings(item.fieldIds, item.fieldIds))
      return false;
    state.entries.set(item.key, {
      ruleIds: new Set(item.ruleIds),
      fieldIds: new Set(item.fieldIds),
      details: strings(item.details),
    });
  }
  state.offset += page.items.length;
  return true;
}

function templatePopulation(truth) {
  const without = new Map();
  for (const issue of truth.issues) {
    if (!truth.templateScope.issueTypes.includes(issue.type))
      without.set(issue.type, (without.get(issue.type) ?? 0) + 1);
  }
  const uncovered = [...without.values()].reduce((sum, count) => sum + count, 0);
  return { checked: truth.issueCount - uncovered, uncovered, without };
}

function sameUncoveredTypes(rows, without) {
  if (!Array.isArray(rows) || rows.length !== without.size) return false;
  const names = new Set();
  for (const row of rows) {
    if (
      !isRecord(row) ||
      !without.has(row.typeName) ||
      names.has(row.typeName) ||
      row.count !== without.get(row.typeName)
    )
      return false;
    names.add(row.typeName);
  }
  return true;
}

function completeComplianceScope(compliance, truth) {
  const population = templatePopulation(truth);
  if (compliance.checker !== "applied" || compliance.issuesChecked !== population.checked)
    return false;
  if (
    compliance.issuesWithoutTemplate !== population.uncovered ||
    compliance.issuesJudged !== truth.issueCount
  )
    return false;
  if (population.uncovered > 0 && compliance.requiredFieldRules !== "applied") return false;
  return sameUncoveredTypes(compliance.withoutTemplateByType, population.without);
}

function completeComplianceSummary(summary, truth) {
  if (typeof summary?.reportId !== "string" || !/^[a-f0-9]{64}$/u.test(summary.report.digest ?? ""))
    return undefined;
  const compliance = summary.report.compliance;
  const total = compliance.deviations?.total;
  if (!Number.isSafeInteger(total) || total < 0) return undefined;
  if (!completeComplianceScope(compliance, truth)) return undefined;
  return { compliance, total };
}

const carriesDeviations = (data) =>
  isRecord(data?.report?.compliance) || data?.section?.name === "deviations";

function completeLargeDeviations(exchanges, truth) {
  const summary = reportSummary(exchanges, truth);
  const admitted = completeComplianceSummary(summary, truth);
  if (admitted === undefined) return undefined;
  const { compliance, total } = admitted;
  const state = { total, offset: 0, entries: new Map() };
  for (const exchange of exchanges.filter(completedReport)) {
    const data = exchange.result.data;
    if (!carriesDeviations(data)) continue;
    if (!completeReportIdentity(data, summary, truth)) return undefined;
    const page = readDeviationPage(data, exchange.call, summary, state.offset);
    if (!appendDeviationPage(page, state)) return undefined;
  }
  if (state.offset !== total || state.entries.size !== total) return undefined;
  return { entries: state.entries, compliance };
}

function exactLargeEntries(issues, entries, epicLink) {
  return issues.every((issue) => {
    const entry = entries.get(issue.key);
    if (issue.deviations.length === 0) return entry === undefined;
    if (entry === undefined) return false;
    const rules = issue.deviations.map((code) =>
      code === "parent" ? "parent-missing" : "label-missing",
    );
    const fields = issue.deviations.map((code) => (code === "parent" ? epicLink : "labels"));
    return sameStrings([...entry.ruleIds], rules) && sameStrings([...entry.fieldIds], fields);
  });
}

const largeUnverified = (detail, counts = {}) => ({ status: "unverified", detail, counts });
const largeGradeStatus = (grade, exact, falseFindings) =>
  grade.keysOk && grade.detailOk && exact && falseFindings === 0 ? "green" : "red";

function templateGapsLabelled(answer, without) {
  const rows = answer
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("VORLAGENLÜCKE;"));
  const observed = new Map();
  for (const row of rows) {
    const cells = row.split(";");
    if (cells.length !== 3 || observed.has(cells[1]) || !/^[1-9][0-9]*$/u.test(cells[2]))
      return false;
    observed.set(cells[1], Number(cells[2]));
  }
  return sameUncoveredTypes(
    [...observed].map(([typeName, count]) => ({ typeName, count })),
    without,
  );
}

function exactLargeReport(report, grade, truth, answer) {
  return (
    report.compliance.issuesWithDeviations === grade.expected &&
    report.compliance.deviationCount === grade.deviationCount &&
    exactLargeEntries(truth.issues, report.entries, truth.fieldIds.epicLink) &&
    templateGapsLabelled(answer, templatePopulation(truth).without)
  );
}

function largeCoverageEvidence(observed, truth) {
  const population = templatePopulation(truth);
  return {
    counts: {
      issues: observed.issues.length,
      pages: observed.pages.length,
      templateCheckedIssues: population.checked,
      issuesWithoutTemplate: population.uncovered,
    },
    detail: `${population.checked} template-checked issues; ${population.uncovered} issues without template`,
  };
}

function gradeObservedLargeReport(report, truth, answer, coverage) {
  const grade = gradeDeviationReport(
    answer,
    truth.issues,
    report.entries,
    truth.fieldIds,
    LARGE_ISSUE_KEY,
  );
  const expectedKeys = new Set(
    truth.issues.filter((issue) => issue.deviations.length > 0).map((issue) => issue.key),
  );
  const extras = [...report.entries.keys()].filter((key) => !expectedKeys.has(key));
  const falseFindings = new Set([...grade.falseFindings, ...extras]).size;
  const exact = exactLargeReport(report, grade, truth, answer);
  return {
    status: largeGradeStatus(grade, exact, falseFindings),
    detail: `${grade.found}/${grade.expected} deviating issues; ${grade.deviationCount} deviations; ${falseFindings} false findings; ${coverage.counts.pages} independent native pages; ${coverage.detail}`,
    counts: {
      ...coverage.counts,
      deviations: grade.deviationCount,
      deviatingIssues: grade.expected,
      falseFindings,
    },
  };
}

/** Shared S11b/limit-run oracle. The caller supplies this turn's answer and tool exchanges. */
export function gradeLargeDeviationReport(exchanges, observed, value, answer) {
  const truth = largeDeviationTruth(value);
  if (truth === undefined) return largeUnverified("versioned large-project truth is unavailable");
  if (!observedLargeTruth(observed, truth))
    return largeUnverified("independent native pages or seed agreement are unavailable");
  const coverage = largeCoverageEvidence(observed, truth);
  const report = completeLargeDeviations(Array.isArray(exchanges) ? exchanges : [], truth);
  if (report === undefined)
    return largeUnverified(
      `a complete, coherent report deviation sequence is unavailable; ${coverage.detail}`,
      coverage.counts,
    );
  if (typeof answer !== "string")
    return largeUnverified(
      `this turn's readable report answer is unavailable; ${coverage.detail}`,
      coverage.counts,
    );
  return gradeObservedLargeReport(report, truth, answer, coverage);
}

/** Parent type proof comes only from the complete independent JQL population. */
function observedParentRequest(issues) {
  const reads = new Map();
  for (const issue of issues) {
    const response = {
      ok: true,
      status: 200,
      body: {
        id: issue.id,
        key: issue.key,
        fields: { issuetype: issue.fields.issuetype },
      },
    };
    for (const selector of [issue.id, issue.key])
      reads.set("issue/" + encodeURIComponent(selector) + "?fields=issuetype", response);
  }
  return (path, options) => {
    if (options?.method !== undefined && options.method !== "GET")
      throw new TypeError("The independent oracle is read-only");
    return Promise.resolve(reads.get(path) ?? { ok: false, reason: "unavailable" });
  };
}

function issueFacts(issue, project) {
  return {
    key: issue.key,
    projectKey: project,
    issueTypeId: issue.fields.issuetype.id,
    typeName: issue.fields.issuetype.name,
    category: issue.fields.status.statusCategory.key,
    fields: issue.fields,
  };
}

/** One completion promise; each pure check settles before the next issue is evaluated. */
function checkedNativeIssues(checker, issues, project) {
  const request = observedParentRequest(issues);
  const rows = [];
  let index = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      Promise.resolve()
        .then(() => {
          const issue = issues[index];
          const facts = issueFacts(issue, project);
          const covered = checker.covers(facts);
          if (covered && checker.fieldIds.some((id) => !Object.hasOwn(issue.fields, id)))
            throw new TypeError("Requested native rule evidence is unavailable");
          return Promise.resolve(checker.check(facts, request)).then((violations) => {
            if (violations === "unavailable")
              throw new TypeError("Native rule evidence is unavailable");
            rows.push({ issue, covered, violations });
          });
        })
        .then(() => {
          index += 1;
          if (index === issues.length) resolve(rows);
          else next();
        }, reject);
    };
    if (issues.length === 0) resolve(rows);
    else next();
  });
}

function runtimeTemplateTruth(truth, rows) {
  const covered = new Set(
    rows.filter((row) => row.covered).map((row) => row.issue.fields.issuetype.name),
  );
  return { ...truth, templateScope: { ...truth.templateScope, issueTypes: [...covered] } };
}

function literalSeedProof(truth, rows) {
  const expected = new Map(truth.issues.map((issue) => [issue.key, issue]));
  return rows.every(({ issue, violations }) => {
    const seeded = expected.get(issue.key)?.deviations;
    const actual = literalNativeDefects(issue, truth);
    return (
      sameStrings(seeded, actual) &&
      actual.every((code) =>
        violations.some(
          (item) => item.ruleId === (code === "parent" ? "parent-missing" : "label-missing"),
        ),
      )
    );
  });
}

function nativeTypeSelected(selector, issue) {
  const type = issue.fields.issuetype;
  return selector === type.id || selector.toLowerCase() === type.name.toLowerCase();
}

function literalNativeDefects(issue, truth) {
  if (issue.fields.issuetype.subtask === true) return [];
  const scope = truth.templateScope;
  const labelRule = scope.labelsForTypes.some((selector) => nativeTypeSelected(selector, issue));
  const codes =
    labelRule && !issue.fields.labels.includes("anforderung") ? ["label:anforderung"] : [];
  const parentRule = Object.entries(scope.parentForTypes).some(
    ([selector, field]) =>
      nativeTypeSelected(selector, issue) &&
      resolveJiraTemplateFieldIds(field, truth.fieldCatalog).includes(truth.fieldIds.epicLink),
  );
  if (parentRule && !issue.fields[truth.fieldIds.epicLink]) codes.push("parent");
  return codes;
}

function violationPattern(item) {
  if (item.ruleId.startsWith("summary-")) return DEVIATION_WORDS.summary;
  if (item.ruleId.startsWith("label-")) return DEVIATION_WORDS.label;
  if (item.ruleId.startsWith("parent-")) return DEVIATION_WORDS.parent;
  return new RegExp(escapeRegExp(item.subject ?? item.fieldId ?? item.ruleId), "iu");
}

function runtimeIssueAnswer(part, key, violations) {
  if (part === undefined || issueDenied(key, part)) return false;
  return violations.every((item) => {
    const pattern = violationPattern(item);
    if (part.context.some((line) => pattern.test(line) && deniesDeviation(line))) return false;
    return part.clauses.some(
      (line) => pattern.test(line) && VIOLATION_RE.test(line) && !deniesDeviation(line),
    );
  });
}

function exactRuntimeEntry(entry, violations) {
  if (violations.length === 0) return entry === undefined;
  if (entry === undefined) return false;
  const rules = [...new Set(violations.map((item) => item.ruleId))];
  const fields = [
    ...new Set(violations.flatMap((item) => (item.fieldId === undefined ? [] : [item.fieldId]))),
  ];
  const details = new Set(
    violations.map((item) =>
      item.subject === undefined ? item.ruleId : item.ruleId + ": " + item.subject,
    ),
  );
  return (
    sameStrings([...entry.ruleIds], rules) &&
    sameStrings([...entry.fieldIds], fields) &&
    sameStrings(entry.details, [...details])
  );
}

function gradeRuntimeRows(report, rows, truth, answer, coverage) {
  const parts = clausesByKey(answer, LARGE_ISSUE_KEY);
  const findings = rows.filter((row) => row.violations.length > 0);
  const keys = new Set(findings.map((row) => row.issue.key));
  const reportedKeys = [...parts]
    .filter(([key, part]) => !issueDenied(key, part))
    .map(([key]) => key);
  const falseFindings = new Set(
    [...reportedKeys, ...report.entries.keys()].filter((key) => !keys.has(key)),
  ).size;
  const deviationCount = findings.reduce((count, row) => count + row.violations.length, 0);
  const exact = rows.every((row) =>
    exactRuntimeEntry(report.entries.get(row.issue.key), row.violations),
  );
  const readable = findings.every((row) =>
    runtimeIssueAnswer(parts.get(row.issue.key), row.issue.key, row.violations),
  );
  const totals =
    report.compliance.issuesWithDeviations === findings.length &&
    report.compliance.deviationCount === deviationCount;
  const gaps = templateGapsLabelled(answer, templatePopulation(truth).without);
  return {
    status: exact && readable && totals && gaps && falseFindings === 0 ? "green" : "red",
    detail:
      "Independent full-rule findings: " + findings.length + "; deviations: " + deviationCount,
    counts: {
      ...coverage.counts,
      deviations: deviationCount,
      deviatingIssues: findings.length,
      falseFindings,
    },
  };
}

/** Reuse the report/write rule owner on a complete, independently observed native population. */
export function checkNativeIssueTemplates(issues, truth) {
  const checker = createJiraReportTemplateChecker(() => ({
    templates: truth.templateScope.templates.map((item) => item.rules),
    unreadable: 0,
  })).bind(truth.fieldCatalog);
  if (typeof checker !== "object" || checker === null) return undefined;
  return checkedNativeIssues(checker, issues, truth.project);
}

/** Runtime projects use the same full checker as write/report admission, on independent native facts. */
export async function gradeRuntimeDeviationReport(exchanges, observed, truth, answer) {
  if (!completeNativePages(observed) || observed.issues.length !== truth.issueCount)
    return largeUnverified("Independent runtime population is unavailable");
  const rows = await checkNativeIssueTemplates(observed.issues, truth);
  if (rows === undefined) return largeUnverified("Installed rule evidence is unavailable");
  if (!literalSeedProof(truth, rows)) return largeUnverified("Literal seed defects changed");
  const scoped = runtimeTemplateTruth(truth, rows);
  const coverage = largeCoverageEvidence(observed, scoped);
  const report = completeLargeDeviations(exchanges, scoped);
  if (report === undefined)
    return largeUnverified("Complete report rule evidence is unavailable", coverage.counts);
  return gradeRuntimeRows(report, rows, scoped, answer, coverage);
}
