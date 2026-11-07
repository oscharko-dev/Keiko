import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { projectJiraDescriptionInput } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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
// A run of markers such as `[13]`, `[13][14]` or `[13], [14]`; never a link `[5](…)` or `[5|…]`.
const MARKER_RUN = /(?<![\w![])\[\d{1,3}\](?:[ \t]*,?[ \t]*\[\d{1,3}\])*(?![(|\w])/gu;
const SPACED_MARKER_RUN = new RegExp(`([ \\t]*)(?:${MARKER_RUN.source})`, "gu");
// Data Center wiki reads these as markup in a description; a source label is plain text. A
// backslash is wiki's line break, so a label's backslash (a Windows path) is written as a slash.
const WIKI_SPECIAL = /[[\]{}|*_^~+!]/gu;
// Code keeps its brackets: a fenced block, a wiki code or noformat macro, or an inline code span.
const FENCE = "```";
const CODE_REGION = new RegExp(
  [
    String.raw`${FENCE}[\s\S]*?(?:${FENCE}|$)`,
    String.raw`\{(code|noformat)(?::[^}]*)?\}[\s\S]*?(?:\{\1\}|$)`,
    "`[^`\\n]+`",
    String.raw`\{\{[^}\n]*\}\}`,
  ].join("|"),
  "gu",
);

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
  run: string,
  labels: ReadonlyMap<number, string>,
  placement: Placement,
  counter: Counter,
): string {
  const numbers = [...new Set((run.match(/\d{1,3}/gu) ?? []).map(Number))];
  const known = numbers.filter((number) => labels.has(number));
  const unknown = numbers.filter((number) => !labels.has(number));
  counter.unresolved += unknown.length;
  if (known.length === 0) return run;
  counter.resolved += known.length;
  const rest = unknown.map((number) => `[${String(number)}]`).join("");
  // A summary is a title of at most 255 characters; its sources live in the description.
  if (placement === "remove") return rest;
  const names = [...new Set(known.map((number) => wikiLabel(labels.get(number) ?? "")))];
  return `(${names.join("; ")})${rest}`;
}

function rewriteProse(
  text: string,
  labels: ReadonlyMap<number, string>,
  placement: Placement,
  counter: Counter,
): string {
  if (placement === "wiki")
    return text.replaceAll(MARKER_RUN, (run) => rewriteRun(run, labels, placement, counter));
  // A removed marker takes the blank before it along: "Kick-off [5]" becomes "Kick-off".
  return text.replaceAll(SPACED_MARKER_RUN, (match: string, lead: string) => {
    const run = match.slice(lead.length);
    const rewritten = rewriteRun(run, labels, placement, counter);
    if (rewritten === run) return match;
    return rewritten === "" ? "" : `${lead}${rewritten}`;
  });
}

function rewriteText(
  text: string,
  labels: ReadonlyMap<number, string>,
  placement: Placement,
  counter: Counter,
): string {
  let out = "";
  let start = 0;
  for (const code of text.matchAll(CODE_REGION)) {
    out += rewriteProse(text.slice(start, code.index), labels, placement, counter) + code[0];
    start = code.index + code[0].length;
  }
  return out + rewriteProse(text.slice(start), labels, placement, counter);
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
