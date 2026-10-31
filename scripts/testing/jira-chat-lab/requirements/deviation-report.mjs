// Oracle of the compliance journey S11 (epic #4173, #4174). A deviation counts as reported only when
// two independent facts agree: the structured result of the `jira.report` tool names the issue with a
// matching rule or field id, and the answer attributes the deviation to that issue without denying
// it. Word occurrence alone proves nothing: "Summary, Parent and Label are correct" contains the
// words of every seeded deviation.
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
  const ids = [...entry.ruleIds, ...entry.fieldIds].map(normalized);
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
  estimate: /sch[aä]tzung|estimate|story ?points?|aufwand/i,
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
const NEGATED_FINE = new RegExp(String.raw`${NEGATOR}(?:\s+\p{L}+){0,2}\s+${FINE}`, "giu");
const NOTHING_FOUND_RE = new RegExp(NOTHING_FOUND, "iu");
const FINE_RE = new RegExp(FINE, "iu");

/**
 * Whether a clause denies a deviation instead of describing one. "Nicht korrekt" and "is not
 * compliant" describe a deviation; a fine-claim that no negator in reach flips is a denial.
 */
export function deniesDeviation(clause) {
  if (NOTHING_FOUND_RE.test(clause)) return true;
  return FINE_RE.test(clause.replaceAll(NEGATED_FINE, " "));
}

const CLAUSE_BREAK = /[.;!?\n]+|\s+(?:aber|jedoch|während|whereas|but|however|although|obwohl)\s+/i;

/** Per issue key, the clauses of the lines that name it and of the lines that continue them. */
function clausesByKey(answer) {
  const segments = new Map();
  let current = [];
  for (const line of answer.split("\n")) {
    const keys = line.match(ISSUE_KEY);
    if (keys) current = [...new Set(keys)];
    for (const key of current) segments.set(key, [...(segments.get(key) ?? []), line]);
  }
  return new Map(
    [...segments].map(([key, lines]) => [
      key,
      lines
        .join("\n")
        .split(CLAUSE_BREAK)
        .map((clause) => clause.trim())
        .filter((clause) => clause !== ""),
    ]),
  );
}

const hasKey = (clause, key) => new RegExp(String.raw`${escapeRegExp(key)}(?!\d)`).test(clause);
const mentionsAnyDeviation = (clause) =>
  [...Object.values(DEVIATION_WORDS), /abnahmekriterien|abgrenzung|testhinweise/i].some((pattern) =>
    pattern.test(clause),
  );

/**
 * An issue is denied as a whole when a clause naming it states that nothing is wrong without naming
 * any field: "RPT-1: Keine Abweichung". What follows cannot undo that statement.
 */
function issueDenied(key, clauses) {
  return clauses.some(
    (clause) => hasKey(clause, key) && deniesDeviation(clause) && !mentionsAnyDeviation(clause),
  );
}

/** Whether a non-denying clause of an issue's part of the answer describes the deviation. */
function describedInAnswer(code, clauses) {
  const pattern = deviationPattern(code);
  return clauses.some((clause) => pattern.test(clause) && !deniesDeviation(clause));
}

/** Deviations of one expected issue that the tool did not report and the answer did not describe. */
function gaps(issue, structured, clauses, fieldIds) {
  const entry = structured.get(issue.key);
  const sectionCount = issue.deviations.filter((code) => code.startsWith("section:")).length;
  const label = (code) => `${issue.key} ${code}`;
  return {
    unreported: issue.deviations
      .filter(
        (code) => entry === undefined || !structurallyReported(code, entry, fieldIds, sectionCount),
      )
      .map(label),
    undescribed: issue.deviations.filter((code) => !describedInAnswer(code, clauses)).map(label),
  };
}

/**
 * Grades a compliance report. `structured` is `structuredDeviations(...)` of the turn and must be
 * available. Exactly the deviating issues are named without denial, and each seeded deviation of
 * each of them is both reported by the tool for that issue and described in that issue's part of the
 * answer without negation.
 */
export function gradeDeviationReport(answer, issues, structured, fieldIds = {}) {
  const expected = issues.filter((issue) => issue.deviations.length > 0);
  const expectedKeys = new Set(expected.map((issue) => issue.key));
  const clauses = clausesByKey(answer);
  const reported = new Set(
    [...clauses.keys()].filter((key) => !issueDenied(key, clauses.get(key))),
  );
  const found = expected.filter((issue) => reported.has(issue.key) && structured.has(issue.key));
  const falseFindings = [...reported].filter((key) => !expectedKeys.has(key));
  // A denied issue is described by nothing: its clauses do not count.
  const perIssue = expected.map((issue) =>
    gaps(
      issue,
      structured,
      reported.has(issue.key) ? (clauses.get(issue.key) ?? []) : [],
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
