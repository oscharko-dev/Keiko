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
    "Answer again: name only issue keys a tool result shows. If a change was refused, say that " +
    "nothing was created and give the reason the tool result states."
  );
}
