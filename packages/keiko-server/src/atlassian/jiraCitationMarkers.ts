import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { projectJiraDescriptionInput } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  findCitationMarkerGroups,
  markdownCodeRanges,
  type CitationMarkerGroup,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { processServerLogSink } from "../process-log-sink.js";
import type { UiHandlerDeps } from "../deps.js";
import type { ChatMessage } from "../store/index.js";

/**
 * Numbered evidence markers in Jira text (#4173 AC2). A grounded answer cites `[5]`, and its
 * citations say what `[5]` is. A model that turns that answer into a Jira issue copies the markers,
 * which mean nothing outside the chat. Before a Jira write is shown for approval, each marker the
 * chat's latest grounded answer defines is replaced with its source label, so the human approves
 * and Jira receives the readable source. A marker that answer does not define stays as written and
 * is counted; nothing is guessed from an older answer, whose numbering is its own.
 */

const JIRA_TEXT_WRITES: ReadonlySet<string> = new Set([
  "keiko.jira.create",
  "keiko.jira.edit",
  "keiko.jira.comment",
  "keiko.jira.draft",
]);
const DEPTH_MAX = 8;
const LABEL_CHARS_MAX = 200;
const MARKER_INDEX_MAX = 999;
// Data Center wiki reads these as markup in a description; a source label is plain text. A
// backslash is wiki's line break, so a label's backslash (a Windows path) is written as a slash.
const WIKI_SPECIAL = /[[\]{}|*_^~+!]/gu;
export interface JiraCitationRewrite {
  readonly arguments: Record<string, unknown>;
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  /** Descriptions Data Center receives as wiki converted from Markdown (ADR-0128). */
  readonly markdownDescriptionCount: number;
}

export function isJiraTextWrite(canonicalId: string | undefined): boolean {
  return canonicalId !== undefined && JIRA_TEXT_WRITES.has(canonicalId);
}

function markerNumber(marker: unknown): number | undefined {
  if (typeof marker === "number") return Number.isInteger(marker) ? marker : undefined;
  if (typeof marker !== "string") return undefined;
  const match = /^\[(\d{1,3})\]$/u.exec(marker);
  return match === null ? undefined : Number(match[1]);
}

function citationLabel(citation: Record<string, unknown>): string | undefined {
  if (typeof citation.label === "string" && citation.label.trim().length > 0)
    return citation.label.trim().slice(0, LABEL_CHARS_MAX);
  if (typeof citation.scopePath !== "string") return undefined;
  const range = citation.lineRange as { startLine?: unknown; endLine?: unknown } | undefined;
  const lines =
    typeof range?.startLine === "number" && typeof range.endLine === "number"
      ? `:${String(range.startLine)}-${String(range.endLine)}`
      : "";
  return `${citation.scopePath}${lines}`.slice(0, LABEL_CHARS_MAX);
}

function answerLabels(answer: NonNullable<ChatMessage["groundedAnswer"]>): Map<number, string> {
  const labels = new Map<number, string>();
  const lists: unknown[] = [answer.citations];
  if ("knowledgeCitations" in answer) lists.push(answer.knowledgeCitations);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const citation of list as Record<string, unknown>[]) {
      const number = markerNumber(citation.marker);
      const label = citationLabel(citation);
      if (number !== undefined && label !== undefined && !labels.has(number))
        labels.set(number, label);
    }
  }
  return labels;
}

/**
 * The citations of the latest grounded answer written before the current request. Only that
 * answer counts: when it defines no marker, an older answer's numbering is not borrowed.
 */
export function latestCitationLabels(
  messages: readonly ChatMessage[],
  requestMessageId: string,
): ReadonlyMap<number, string> {
  const end = messages.findIndex((message) => message.id === requestMessageId);
  const earlier = end === -1 ? messages : messages.slice(0, end);
  for (let index = earlier.length - 1; index >= 0; index--) {
    const answer = earlier[index]?.groundedAnswer;
    if (earlier[index]?.role === "assistant" && answer !== undefined) return answerLabels(answer);
  }
  return new Map();
}

/**
 * The latest answer's labels without the numbers an older answer defines differently. Every
 * grounded answer numbers its own pack from 1, so a marker that two earlier answers define with
 * different sources designates none of them for a turn that sent no pack of its own; it stays as
 * written rather than naming a guess.
 */
export function unambiguousCitationLabels(
  messages: readonly ChatMessage[],
  requestMessageId: string,
  latest: ReadonlyMap<number, string>,
): ReadonlyMap<number, string> {
  const end = messages.findIndex((message) => message.id === requestMessageId);
  const earlier = (end === -1 ? messages : messages.slice(0, end)).flatMap((message) =>
    message.role === "assistant" && message.groundedAnswer !== undefined
      ? [answerLabels(message.groundedAnswer)]
      : [],
  );
  const agreed = new Map<number, string>();
  for (const [number, label] of latest)
    if (earlier.every((labels) => (labels.get(number) ?? label) === label))
      agreed.set(number, label);
  return agreed;
}

interface Counter {
  resolved: number;
  unresolved: number;
  markdown: number;
}

/** Counted with the canonical projection the connector applies, never a second guess. */
function countMarkdownDescription(value: unknown, counter: Counter): void {
  const projected = projectJiraDescriptionInput(value);
  if (projected !== undefined && projected.text !== value) counter.markdown++;
}

type Placement = "wiki" | "remove";

function wikiLabel(label: string): string {
  return label.replaceAll("\\", "/").replaceAll(WIKI_SPECIAL, (special) => `\\${special}`);
}

function rewriteRun(
  numbers: readonly number[],
  original: string,
  labels: ReadonlyMap<number, string>,
  placement: Placement,
  counter: Counter,
): string {
  const known = numbers.filter((number) => labels.has(number));
  const unknown = numbers.filter((number) => !labels.has(number));
  counter.unresolved += unknown.length;
  if (known.length === 0) return original;
  counter.resolved += known.length;
  const rest = unknown.map((number) => `[${String(number)}]`).join("");
  // A summary is a title of at most 255 characters; its sources live in the description.
  if (placement === "remove") return rest;
  const names = [...new Set(known.map((number) => wikiLabel(labels.get(number) ?? "")))];
  return `(${names.join("; ")})${rest}`;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/** The next `character` at or after `from`, found once per stretch instead of once per start. */
class NextIndex {
  private found = -2;
  private from = 0;
  constructor(
    private readonly text: string,
    private readonly character: string,
  ) {}
  at(from: number): number {
    if (this.found === -1 && from >= this.from) return -1;
    if (this.found >= from && from >= this.from) return this.found;
    this.found = this.text.indexOf(this.character, from);
    this.from = from;
    return this.found;
  }
}

/**
 * The Markdown code regions, kept consistent with the Jira macros accepted so far. Delimiters are
 * recognised according to the outer code context: a macro tag inside Markdown code is literal, and
 * a macro that opens in prose makes the Markdown delimiters inside it literal.
 */
class MarkdownContext {
  private position = 0;
  private rereads = 0;
  /** Where Markdown could no longer be told apart from macros; everything after is protected. */
  protectedFrom: number | undefined;
  constructor(
    private readonly text: string,
    private ranges: Span[],
  ) {}
  get spans(): readonly Span[] {
    return this.ranges;
  }
  rewind(): void {
    this.position = 0;
  }
  /** Whether `at` lies inside a region; `at` must not decrease between calls after a rewind. */
  contains(at: number): boolean {
    let range = this.ranges[this.position];
    while (range !== undefined && range.end <= at) range = this.ranges[++this.position];
    return range !== undefined && range.start <= at;
  }
  /** A macro accepted at `[start, end)`: Markdown regions that began inside it no longer exist. */
  supersede(start: number, end: number): void {
    let count = 0;
    let overflow = false;
    for (
      let range = this.ranges[this.position];
      range !== undefined && range.start < end;
      range = this.ranges[this.position + count]
    ) {
      if (range.start >= start && range.end > end) overflow = true;
      count++;
    }
    if (count === 0) return;
    this.ranges.splice(this.position, count);
    if (!overflow) return;
    // Parsing ran on through the macro under the wrong state: read the rest afresh. A bounded
    // number of rereads keeps hostile input linear; past it the rest stays unresolved, as written.
    if (this.rereads >= REREAD_MAX) {
      this.protectedFrom = Math.min(this.protectedFrom ?? end, end);
      this.ranges = this.ranges.slice(0, this.position);
      return;
    }
    this.rereads++;
    const kept = this.ranges.slice(0, this.position);
    const rest = markdownCodeRanges(this.text.slice(end)).map((range) => ({
      start: range.start + end,
      end: range.end + end,
    }));
    this.ranges = [...kept, ...rest];
  }
}

const REREAD_MAX = 16;
const BLOCK_MACRO_OPEN = /\{(code|noformat)(?=[:}])/gu;

/** A `{code}` or `{noformat}` macro up to its closing tag, or to the end of an unclosed one. */
function blockMacroSpans(text: string, markdown: MarkdownContext): Span[] {
  const spans: Span[] = [];
  const brace = new NextIndex(text, "}");
  let cursor = 0;
  for (;;) {
    BLOCK_MACRO_OPEN.lastIndex = cursor;
    const open = BLOCK_MACRO_OPEN.exec(text);
    if (open === null) return spans;
    if (markdown.contains(open.index)) {
      cursor = open.index + 1;
      continue;
    }
    const headEnd = open.index + open[0].length;
    const close = text.charAt(headEnd) === ":" ? brace.at(headEnd) : headEnd;
    if (close === -1) {
      cursor = open.index + 1;
      continue;
    }
    const tag = `{${open[1] ?? ""}}`;
    const closing = text.indexOf(tag, close + 1);
    const end = closing === -1 ? text.length : closing + tag.length;
    spans.push({ start: open.index, end });
    markdown.supersede(open.index, end);
    cursor = end;
  }
}

/** An inline `{{monospace}}` span: no closing brace or line break before its `}}`. */
function inlineMacroSpans(text: string, markdown: MarkdownContext): Span[] {
  const spans: Span[] = [];
  const brace = new NextIndex(text, "}");
  const newline = new NextIndex(text, "\n");
  let start = text.indexOf("{{");
  while (start !== -1) {
    const close = brace.at(start + 2);
    const line = newline.at(start + 2);
    const literal = markdown.contains(start);
    const closed =
      !literal && close !== -1 && (line === -1 || close < line) && text[close + 1] === "}";
    if (closed) spans.push({ start, end: close + 2 });
    start = text.indexOf("{{", closed ? close + 2 : start + 1);
  }
  return spans;
}

/** Every region whose brackets are code: Markdown fences and inline code, and Jira macros. */
function codeSpans(text: string): readonly Span[] {
  const markdown = new MarkdownContext(
    text,
    markdownCodeRanges(text).map((range) => ({ start: range.start, end: range.end })),
  );
  const blocks = blockMacroSpans(text, markdown);
  markdown.rewind();
  const all = [...markdown.spans, ...blocks, ...inlineMacroSpans(text, markdown)];
  if (markdown.protectedFrom !== undefined)
    all.push({ start: markdown.protectedFrom, end: text.length });
  all.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Span[] = [];
  for (const span of all) {
    const last = merged.at(-1);
    if (last !== undefined && span.start < last.end)
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else merged.push(span);
  }
  return merged;
}

const CODE_MASK = "\u0001";

/**
 * The text with every code region blanked at the same offsets. The shared grammar reads Markdown
 * code on its own; masking hands it the regions decided here, so a delimiter that is literal in an
 * outer context cannot start a region that hides later prose.
 */
function maskCode(text: string, code: readonly Span[]): string {
  let out = "";
  let cursor = 0;
  for (const span of code) {
    out += text.slice(cursor, span.start);
    out += text.slice(span.start, span.end).replaceAll(/[^\n]/gu, CODE_MASK);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** The shared marker grammar's groups that stand in prose, never inside code. */
function proseMarkerGroups(text: string, code: readonly Span[]): readonly CitationMarkerGroup[] {
  let next = 0;
  return findCitationMarkerGroups(maskCode(text, code)).filter((group) => {
    while (code[next] !== undefined && (code[next]?.end ?? 0) <= group.start) next++;
    const inCode = code[next] !== undefined && (code[next]?.start ?? 0) < group.end;
    return !inCode && group.indices.every((index) => index <= MARKER_INDEX_MAX);
  });
}

/** Spaces and tabs around at most one comma: the separator of `[1], [2]` and `[1][2]`. */
function isMarkerSeparator(text: string, from: number, to: number): boolean {
  let commas = 0;
  for (let position = from; position < to; position++) {
    const character = text.charAt(position);
    if (character === ",") commas++;
    else if (character !== " " && character !== "\t") return false;
  }
  return commas <= 1;
}

const NOT_BEFORE_MARKER = /[\w![]/u;
const NOT_AFTER_MARKER = /[\w(|]/u;

/** A link `[5](…)`, a wiki link `[5|…]` or a bracket inside a word is never a source marker. */
function standsAlone(text: string, group: CitationMarkerGroup, side: "start" | "end"): boolean {
  return side === "start"
    ? !NOT_BEFORE_MARKER.test(text.charAt(group.start - 1))
    : !NOT_AFTER_MARKER.test(text.charAt(group.end));
}

function endsAlone(text: string, group: CitationMarkerGroup | undefined): boolean {
  return group !== undefined && standsAlone(text, group, "end");
}

interface MarkerRun extends Span {
  readonly numbers: readonly number[];
}

function runOfChain(text: string, chain: readonly CitationMarkerGroup[]): MarkerRun | undefined {
  const first = chain[0] !== undefined && standsAlone(text, chain[0], "start") ? 0 : 1;
  let last = chain.length - 1;
  while (last >= first && !endsAlone(text, chain[last])) last--;
  const head = chain[first];
  const tail = chain[last];
  if (head === undefined || tail === undefined) return undefined;
  const numbers = chain.slice(first, last + 1).flatMap((group) => group.indices);
  return { start: head.start, end: tail.end, numbers: [...new Set(numbers)] };
}

/** Runs of markers such as `[13]`, `[13][14]`, `[13], [14]` or `[13, 14]`, in one pass. */
function markerRuns(text: string, groups: readonly CitationMarkerGroup[]): readonly MarkerRun[] {
  const runs: MarkerRun[] = [];
  let chain: CitationMarkerGroup[] = [];
  const flush = (): void => {
    const run = runOfChain(text, chain);
    if (run !== undefined) runs.push(run);
    chain = [];
  };
  for (const group of groups) {
    const previous = chain.at(-1);
    if (previous !== undefined && !isMarkerSeparator(text, previous.end, group.start)) flush();
    chain.push(group);
  }
  flush();
  return runs;
}

function trimBlanks(text: string): string {
  let end = text.length;
  while (text.charAt(end - 1) === " " || text.charAt(end - 1) === "\t") end--;
  return text.slice(0, end);
}

function rewriteText(
  text: string,
  labels: ReadonlyMap<number, string>,
  placement: Placement,
  counter: Counter,
): string {
  const groups = proseMarkerGroups(text, codeSpans(text));
  let out = "";
  let cursor = 0;
  for (const run of markerRuns(text, groups)) {
    const original = text.slice(run.start, run.end);
    const rewritten = rewriteRun(run.numbers, original, labels, placement, counter);
    const before = text.slice(cursor, run.start);
    // A removed marker takes the blank before it along: "Kick-off [5]" becomes "Kick-off".
    out += rewritten === "" ? trimBlanks(before) : before + rewritten;
    cursor = run.end;
  }
  return out + text.slice(cursor);
}

function rewriteString(
  key: string,
  value: string,
  labels: ReadonlyMap<number, string>,
  counter: Counter,
): string {
  if (key === "description" || key === "body") return rewriteText(value, labels, "wiki", counter);
  return key === "summary" ? rewriteText(value, labels, "remove", counter) : value;
}

function isTaggedMarkdown(key: string, record: Record<string, unknown>): boolean {
  return key === "description" && record.format === "markdown" && typeof record.text === "string";
}

function rewriteValue(
  key: string,
  value: unknown,
  labels: ReadonlyMap<number, string>,
  counter: Counter,
  depth: number,
): unknown {
  if (key === "description") countMarkdownDescription(value, counter);
  if (typeof value === "string") return rewriteString(key, value, labels, counter);
  if (depth >= DEPTH_MAX || value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => rewriteValue(key, item, labels, counter, depth + 1));
  const record = value as Record<string, unknown>;
  // A tagged Markdown description keeps its wrapper; only its text is rewritten.
  if (isTaggedMarkdown(key, record))
    return { ...record, text: rewriteText(String(record.text), labels, "wiki", counter) };
  return Object.fromEntries(
    Object.entries(record).map(([name, item]) => [
      name,
      rewriteValue(name, item, labels, counter, depth + 1),
    ]),
  );
}

/** Rewrites summary, description and comment text anywhere in a Jira write's arguments. */
export function resolveJiraCitationMarkers(
  args: Record<string, unknown>,
  labels: ReadonlyMap<number, string>,
): JiraCitationRewrite {
  const counter: Counter = { resolved: 0, unresolved: 0, markdown: 0 };
  const rewritten = rewriteValue("", args, labels, counter, 0) as Record<string, unknown>;
  return {
    arguments: counter.resolved === 0 ? args : rewritten,
    resolvedCount: counter.resolved,
    unresolvedCount: counter.unresolved,
    markdownDescriptionCount: counter.markdown,
  };
}

const MARKER_COUNT = { type: "integer", dataClass: "count", required: true } as const;
const CITATION_MARKERS = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "jira.citation.markers",
  category: "process",
  owner: "keiko-server",
  emitter: "atlassian.jiraCitationMarkers.recordJiraCitationMarkers",
  fields: {
    callCount: MARKER_COUNT,
    labelCount: MARKER_COUNT,
    resolvedCount: MARKER_COUNT,
    unresolvedCount: MARKER_COUNT,
    markdownDescriptionCount: MARKER_COUNT,
    completeness: { type: "string", dataClass: "completeness-state", required: true },
    loss: { type: "string", dataClass: "loss-state", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["atlassian-action-execution"],
  proofIds: ["jira.citation.markers.line"],
  releaseImpact: "patch",
});

/** Counts only: no marker text, source label, document name or Jira text. */
export function recordJiraCitationMarkers(
  sink: UiHandlerDeps["activityLog"],
  correlationId: string | undefined,
  counts: {
    readonly callCount: number;
    readonly labelCount: number;
    readonly resolvedCount: number;
    readonly unresolvedCount: number;
    readonly markdownDescriptionCount: number;
  },
): void {
  (sink ?? processServerLogSink()).write(
    activityLogEvent(
      CITATION_MARKERS,
      { correlationId: correlationId ?? UNKNOWN_CORRELATION_ID },
      { ...counts, completeness: "complete", loss: "none" },
    ),
  );
}
