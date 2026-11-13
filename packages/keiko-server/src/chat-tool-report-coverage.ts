import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";

// Report sections whose pages list findings the human asked to see one by one: a deviation or an
// issue without an epic is not summarised away. Figure sections (statuses, epics) are not listed.
const FINDING_SECTIONS: ReadonlySet<string> = new Set(["deviations", "orphans"]);
const REPORT_TOOL = "keiko.jira.report";
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,63}-\d{1,12}$/u;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Issue keys of one completed finding page, in page order. */
function findingKeys(exchange: ChatToolExchange): readonly string[] {
  const { result } = exchange;
  if (result?.status !== "completed" || result.toolRef?.canonicalId !== REPORT_TOOL) return [];
  const section = record(record(result.data)?.section);
  if (typeof section?.name !== "string" || !FINDING_SECTIONS.has(section.name)) return [];
  if (!Array.isArray(section.items)) return [];
  return section.items
    .map((item) => record(item)?.key)
    .filter((key): key is string => typeof key === "string" && ISSUE_KEY.test(key));
}

function mentions(answer: string, key: string): boolean {
  return new RegExp(String.raw`(?<![A-Z0-9_-])${key}(?!\d)`, "u").test(answer);
}

/**
 * The issue keys that finding pages of `jira.report` read in this turn list and the answer leaves
 * out. Keiko computes every finding; a listing answer that drops one silently misreports the
 * project (S11 of epic #4173: Gemma left out all seven estimate deviations the report listed).
 */
export function omittedReportFindingKeys(
  exchanges: readonly ChatToolExchange[],
  answer: string,
): readonly string[] {
  const listed = [...new Set(exchanges.flatMap(findingKeys))];
  return listed.filter((key) => !mentions(answer, key));
}

/** The one correction a turn gets when its answer leaves out listed findings. */
export function reportFindingCorrection(omitted: readonly string[]): string {
  return (
    `Your answer leaves out ${String(omitted.length)} issue(s) that the jira.report pages read in ` +
    `this turn list: ${omitted.join(", ")}. Answer again in full: name every listed issue with ` +
    "its finding as the report states it."
  );
}

const KEY_IN_TEXT = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9_]{0,63})-(\d{1,12})(?!\d)/gu;
const KEY_RANGE = /\b([A-Z][A-Z0-9_]{0,63})-(\d{1,12})\.\.\1-(\d{1,12})\b/gu;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;
const JIRA_TOOL_PREFIX = "keiko.jira.";

interface KeyRange {
  readonly project: string;
  readonly from: number;
  readonly to: number;
}

interface KnownKeys {
  readonly keys: ReadonlySet<string>;
  readonly ranges: readonly KeyRange[];
  readonly projects: ReadonlySet<string>;
}

/** Every issue key a text names, in order, as `PROJECT-123`. */
function keysIn(text: string): readonly string[] {
  return [...text.matchAll(KEY_IN_TEXT)].map((match) => `${match[1] ?? ""}-${match[2] ?? ""}`);
}

/** Compact draft results name created issues as ranges (`SYN-1..SYN-1200`). */
function rangesIn(text: string): readonly KeyRange[] {
  return [...text.matchAll(KEY_RANGE)].map((match) => ({
    project: match[1] ?? "",
    from: Number(match[2]),
    to: Number(match[3]),
  }));
}

const KEY_FIELDS: ReadonlySet<string> = new Set(["key", "projectKey", "issueKey", "parentKey"]);

/** The project of a value a Jira call or result states in a key field: `REQ` or `REQ-12`. */
function projectOfKeyValue(value: string): string | undefined {
  if (PROJECT_KEY.test(value)) return value;
  return ISSUE_KEY.test(value) ? projectOf(value) : undefined;
}

/** Project keys a Jira call or result states in its key fields; never from free text. */
function projectKeysIn(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) projectKeysIn(item, found);
    return;
  }
  const node = record(value);
  if (node === undefined) return;
  for (const [name, item] of Object.entries(node)) {
    const project =
      KEY_FIELDS.has(name) && typeof item === "string" ? projectOfKeyValue(item) : undefined;
    if (project !== undefined) found.add(project);
    else projectKeysIn(item, found);
  }
}

function knownKeys(exchanges: readonly ChatToolExchange[], context: readonly string[]): KnownKeys {
  const jira = exchanges.filter((exchange) =>
    exchange.result?.toolRef?.canonicalId.startsWith(JIRA_TOOL_PREFIX),
  );
  const texts = [
    ...context,
    ...exchanges.map((exchange) => JSON.stringify([exchange.call, exchange.result?.data ?? null])),
  ];
  const projects = new Set<string>();
  for (const exchange of jira) {
    projectKeysIn([exchange.call.arguments, exchange.result?.data], projects);
    // A compact draft result names what it created only as ranges (`SYN-1..SYN-1200`).
    for (const range of rangesIn(JSON.stringify(exchange.result?.data ?? null)))
      projects.add(range.project);
  }
  return { keys: new Set(texts.flatMap(keysIn)), ranges: texts.flatMap(rangesIn), projects };
}

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf("-"));
}

function covered(known: KnownKeys, key: string): boolean {
  if (known.keys.has(key)) return true;
  const project = projectOf(key);
  const number = Number(key.slice(project.length + 1));
  return known.ranges.some(
    (range) => range.project === project && number >= range.from && number <= range.to,
  );
}

/**
 * Issue keys of the turn's Jira projects (the projects its Jira tool calls and results name) that
 * the answer names although no tool exchange of the
 * turn and no message it was given contains them. Keiko cannot vouch for such a key: S01 of epic
 * #4173 (Qwen) answered "successfully created … REQ-42" after three refused creates. Keys of other
 * shapes (`UTF-8`, a requirement id such as `LH-004`) never count unless a Jira project of the turn
 * carries that key; a turn without a Jira tool call checks nothing.
 */
export function unsupportedIssueKeys(
  exchanges: readonly ChatToolExchange[],
  context: readonly string[],
  answer: string,
): readonly string[] {
  const known = knownKeys(exchanges, context);
  if (known.projects.size === 0) return [];
  const named = [...new Set(keysIn(answer))];
  return named.filter((key) => known.projects.has(projectOf(key)) && !covered(known, key));
}

/** The one correction a turn gets when its answer names issue keys no tool result shows. */
export function unsupportedIssueKeyCorrection(unsupported: readonly string[]): string {
  return (
    `Your answer names ${String(unsupported.length)} issue key(s) that no tool result of this turn ` +
    `and no earlier message contains: ${unsupported.join(", ")}. No tool created or read them. ` +
    "Answer again and name only issue keys a tool result shows. If a change was refused, either " +
    "correct the call as the tool result states and call the tool again, or say that nothing " +
    "was created and give the reason the tool result states."
  );
}

/** A requirement and the issue keys the report states for it; empty when no issue names it. */
export interface ReportedRequirementCoverage {
  readonly id: string;
  readonly keys: readonly string[];
}

const REQUIREMENTS_SECTION = "requirements";
// The correction names at most this many requirements; the count still covers every mismatch.
const COVERAGE_CORRECTION_ROWS_MAX = 64;

/** One requirement item of a report page, or undefined when its key list is capped or malformed. */
function coverageEntry(
  item: Readonly<Record<string, unknown>> | undefined,
): ReportedRequirementCoverage | undefined {
  if (typeof item?.id !== "string" || item.id.length === 0) return undefined;
  if (item.covered === false) return { id: item.id, keys: [] };
  if (item.covered !== true || !Array.isArray(item.coveredBy)) return undefined;
  const keys = item.coveredBy.filter(
    (key): key is string => typeof key === "string" && ISSUE_KEY.test(key),
  );
  // A capped or partly malformed list cannot judge an answer that names more issues.
  if (keys.length !== item.coveredBy.length || item.coveredByTotal !== keys.length)
    return undefined;
  return { id: item.id, keys };
}

/** The items of one completed `jira.report` requirements page; empty for any other exchange. */
function requirementItems(exchange: ChatToolExchange): readonly unknown[] {
  const { result } = exchange;
  if (result?.status !== "completed" || result.toolRef?.canonicalId !== REPORT_TOOL) return [];
  const section = record(record(result.data)?.section);
  return section?.name === REQUIREMENTS_SECTION && Array.isArray(section.items)
    ? section.items
    : [];
}

/** Requirement coverage the turn's completed `jira.report` requirement pages state, by id. */
function reportedCoverage(
  exchanges: readonly ChatToolExchange[],
): ReadonlyMap<string, ReportedRequirementCoverage> {
  const coverage = new Map<string, ReportedRequirementCoverage>();
  for (const item of exchanges.flatMap(requirementItems)) {
    const entry = coverageEntry(record(item));
    if (entry !== undefined) coverage.set(entry.id, entry);
  }
  return coverage;
}

const TOKEN_CHAR = /[\p{L}\p{N}_-]/u;

/** Whether a line names a token on its own: `LH-001` but not `LH-0010` or `XLH-001`. */
function namesToken(line: string, token: string): boolean {
  for (let at = line.indexOf(token); at >= 0; at = line.indexOf(token, at + 1)) {
    const before = line.charAt(at - 1);
    const after = line.charAt(at + token.length);
    if ((at === 0 || !TOKEN_CHAR.test(before)) && (after === "" || !TOKEN_CHAR.test(after)))
      return true;
  }
  return false;
}

function sameKeys(named: ReadonlySet<string>, stated: readonly string[]): boolean {
  return named.size === stated.length && stated.every((key) => named.has(key));
}

/**
 * Requirements an answer line attributes to other issues than the turn's `jira.report` requirement
 * pages state. Keiko computes the coverage; an answer that copies it with an issue added, swapped or
 * left out misreports the project (S12 of epic #4173: Qwen gave eight of 41 requirements a key that
 * fit the numbering, not the report). Only a line that names exactly one reported requirement and
 * at least one issue of the report's projects is judged; a line without issue keys is not.
 */
export function reportCoverageMismatches(
  exchanges: readonly ChatToolExchange[],
  answer: string,
): readonly ReportedRequirementCoverage[] {
  const coverage = reportedCoverage(exchanges);
  const projects = new Set([...coverage.values()].flatMap((entry) => entry.keys.map(projectOf)));
  if (projects.size === 0) return [];
  const mismatched = new Map<string, ReportedRequirementCoverage>();
  for (const line of answer.split("\n")) {
    const [entry, ...others] = [...coverage.values()].filter((item) => namesToken(line, item.id));
    if (entry === undefined || others.length > 0) continue;
    const named = new Set(keysIn(line).filter((key) => projects.has(projectOf(key))));
    if (named.size > 0 && !sameKeys(named, entry.keys)) mismatched.set(entry.id, entry);
  }
  return [...mismatched.values()];
}

/** The one correction a turn gets when its answer attributes issues other than the report does. */
export function reportCoverageCorrection(
  mismatched: readonly ReportedRequirementCoverage[],
): string {
  const rows = mismatched
    .slice(0, COVERAGE_CORRECTION_ROWS_MAX)
    .map((entry) => `${entry.id}: ${entry.keys.length === 0 ? "no issue" : entry.keys.join(", ")}`);
  const more = mismatched.length - rows.length;
  const rest = more > 0 ? `; and ${String(more)} more` : "";
  return (
    `Your answer gives ${String(mismatched.length)} requirement(s) other issues than the ` +
    `jira.report requirements section read in this turn states. The report states: ` +
    `${rows.join("; ")}${rest}. Answer again in full ` +
    "and give every requirement exactly the issues the report states for it."
  );
}

/** The latest completed `jira.report` summary of the turn, if any turn exchange holds one. */
function latestReportSummary(
  exchanges: readonly ChatToolExchange[],
): Readonly<Record<string, unknown>> | undefined {
  for (const exchange of [...exchanges].reverse()) {
    const { result } = exchange;
    if (result?.status !== "completed" || result.toolRef?.canonicalId !== REPORT_TOOL) continue;
    const summary = record(record(result.data)?.report);
    if (summary !== undefined) return summary;
  }
  return undefined;
}

const SCALAR_EVIDENCE_PATHS: readonly (readonly string[])[] = [
  ["progress", "project"],
  ["compliance"],
  ["completeness"],
];

function scalarLines(source: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  return Object.entries(source ?? {}).flatMap(([name, value]) =>
    typeof value === "number" || typeof value === "boolean" || typeof value === "string"
      ? [`${name}: ${String(value)}`]
      : [],
  );
}

/**
 * The figures Keiko computed for a Jira report, one per line: the report's own figure text and the
 * scalar members of its project progress, compliance and completeness. A claim about a figure the
 * model took from this result is judged against these lines, beside the citation's own excerpt
 * (#4355); a figure the report does not state matches no line and stays unsupported.
 */
export function reportEvidenceLines(exchanges: readonly ChatToolExchange[]): readonly string[] {
  const summary = latestReportSummary(exchanges);
  if (summary === undefined) return [];
  const figures = typeof summary.figures === "string" ? summary.figures.split("\n") : [];
  const scalars = SCALAR_EVIDENCE_PATHS.flatMap((path) =>
    scalarLines(
      path.reduce<Readonly<Record<string, unknown>> | undefined>(
        (node, name) => record(node?.[name]),
        summary,
      ),
    ),
  );
  return [...figures, ...scalars].map((line) => line.trim()).filter((line) => line.length > 0);
}

const RESULT_KEY = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/u;

function resultKeys(node: unknown, depth: number, into: Set<string>): void {
  if (depth > 3 || typeof node !== "object" || node === null) return;
  for (const [name, value] of Object.entries(node)) {
    if (RESULT_KEY.test(name)) into.add(name);
    resultKeys(value, depth + 1, into);
  }
}

/**
 * The report's internal result keys the answer prints as `key: value` (for example
 * `issuesChecked: 33`): a person reads figures in words, not field names (#4355).
 */
export function rawReportKeys(
  exchanges: readonly ChatToolExchange[],
  answer: string,
): readonly string[] {
  const summary = latestReportSummary(exchanges);
  if (summary === undefined) return [];
  const keys = new Set<string>();
  resultKeys(summary, 0, keys);
  return [...keys].filter((name) =>
    new RegExp(String.raw`(?<![\p{L}\p{N}_])${name}\s*[:=]`, "u").test(answer),
  );
}

/** The one correction a turn gets when its answer prints internal report result keys. */
export function rawReportKeyCorrection(names: readonly string[]): string {
  return (
    `Your answer prints ${String(names.length)} internal result key(s) of the report: ` +
    `${names.join(", ")}. A person reads figures in words. Answer again and state the same ` +
    "figures in plain language, without field names."
  );
}
