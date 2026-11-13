import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { chatToolDraftReceipts, chatToolIssueKey } from "./chat-tool-receipts.js";

/**
 * Two ways a Jira answer can claim an action that did not happen (#4355 AC4), both decided without
 * a model: an answer that announces an issue was created although this turn holds no created
 * receipt, and an answer that writes a tool call as text, which nothing executed. The detector is
 * narrow on purpose: a missed claim is variance the lab classifies, a wrongly corrected truthful
 * answer costs a round and a confusing instruction. Documented non-goals, never detected: a claim
 * in a language other than English or German, a creation named without an issue-like object ("I did
 * it"), a claim split over two sentences, and an announced edit, comment or transition.
 */

const CREATION: readonly {
  readonly pattern: RegExp;
  readonly object: "after" | "before" | "inside";
}[] = [
  { pattern: /\b(?:i|we)(?:'ve| have) (?:created|opened|added|filed)\b/iu, object: "after" },
  { pattern: /\b(?:i|we) (?:created|opened|added|filed)\b/iu, object: "after" },
  { pattern: /\bbeen created\b/iu, object: "before" },
  { pattern: /\b(?:was|were) created\b/iu, object: "before" },
  { pattern: /\bsuccessfully created\b/iu, object: "after" },
  { pattern: /\bwurden? (?:\p{L}+ )?(?:angelegt|erstellt)\b/iu, object: "before" },
  { pattern: /\bhabe\b[^.!?\n]{0,60}\b(?:angelegt|erstellt)\b/iu, object: "inside" },
  { pattern: /\b(?:legte|erstellte) ich\b/iu, object: "after" },
];
const ISSUE_OBJECTS = [
  /\b(?:epics?|tasks?|bugs?|issues?|tickets?)\b/iu,
  /\b(?:stor(?:y|ies)|sub-?tasks?)\b/iu,
  /\b(?:vorg[aä]nge?n?|aufgaben?|teilaufgaben?)\b/iu,
  /\bfehlermeldung(?:en)?\b/iu,
] as const;
/** Something else was made: a summary, a report, a list, a comment, a file. */
const NOT_AN_ISSUE = [
  /(?<!\p{L})(?:summary|overview|report|list|comment|note|file|document|draft|plan|table)(?!\p{L})/iu,
  /(?<!\p{L})(?:übersicht|uebersicht|tabelle|bericht|liste|zusammenfassung)(?!\p{L})/iu,
  /(?<!\p{L})(?:kommentar|notiz|datei|dokument|entwurf)(?!\p{L})/iu,
] as const;
const WINDOW_CHARS = 60;
/** Words and phrases that make a sentence a refusal, a question, a plan or a condition. */
const NEGATING_WORDS: ReadonlySet<string> = new Set([
  "not",
  "never",
  "no",
  "cannot",
  "can't",
  "couldn't",
  "wasn't",
  "weren't",
  "won't",
  "would",
  "will",
  "should",
  "shall",
  "if",
  "unable",
  "from",
  "nicht",
  "kein",
  "keine",
  "konnte",
  "könnte",
  "werde",
  "würde",
  "wuerde",
  "soll",
  "sollte",
  "falls",
  "wenn",
  "noch",
  "aus",
  "anhand",
]);
const NEGATING_PHRASES = ["could not", "based on", "out of"] as const;
/** Third-person or dated history: who created it and when, or a quoted Created field. */
const HISTORY = [
  /\bcreated\s+(?:by|on|at|in|from)\b/iu,
  /\b(?:angelegt|erstellt)\s+(?:von|am|um)\b/iu,
  /\bcreated\s*:/iu,
] as const;
/** A back-reference to something made earlier in the conversation. */
const BACK_REFERENCE =
  /\b(?:above|earlier|previously|before|already|oben|zuvor|vorhin|bereits|schon)\b/iu;
const ISSUE_KEY = /\b[A-Z][A-Z0-9_]{0,63}-\d{1,12}\b/gu;
const TEXT_CALLS = [
  /\b(?:jira|knowledge)_[a-z][a-z_]*\s*\(\s*[{"'[]/giu,
  /["']name["']\s*:\s*["'](?:jira|knowledge)_[a-z_]+["']/giu,
  /<(?:tool_call|function_call)>/giu,
] as const;
const SENTENCE_END = /(?<=[.!?])\s+|\n+/u;
const COUNT_MAX = 99;

function negated(sentence: string): boolean {
  if (sentence.includes("?")) return true;
  const lower = sentence.toLowerCase();
  if (NEGATING_PHRASES.some((phrase) => lower.includes(phrase))) return true;
  return (lower.match(/[\p{L}']+/gu) ?? []).some((word) => NEGATING_WORDS.has(word));
}

/** The text around a creation where its object stands: before a passive verb, after an active one. */
function objectWindow(
  sentence: string,
  match: RegExpExecArray,
  side: "after" | "before" | "inside",
): string {
  const start = match.index;
  const end = start + match[0].length;
  if (side === "inside") return match[0];
  return side === "after"
    ? sentence.slice(end, end + WINDOW_CHARS)
    : sentence.slice(Math.max(0, start - WINDOW_CHARS), start);
}

function createsAnIssue(sentence: string): boolean {
  return CREATION.some(({ pattern, object }) => {
    const match = pattern.exec(sentence);
    if (match === null) return false;
    const window = objectWindow(sentence, match, object);
    return (
      !NOT_AN_ISSUE.some((other) => other.test(window)) &&
      ISSUE_OBJECTS.some((noun) => noun.test(window))
    );
  });
}

function namesKnownKey(sentence: string, known: () => string): boolean {
  const keys = sentence.match(ISSUE_KEY) ?? [];
  return keys.some((key) => known().includes(key));
}

function announces(sentence: string, known: () => string): boolean {
  return (
    !negated(sentence) &&
    !HISTORY.some((pattern) => pattern.test(sentence)) &&
    !BACK_REFERENCE.test(sentence) &&
    createsAnIssue(sentence) &&
    !namesKnownKey(sentence, known)
  );
}

/** Whether this turn holds a created receipt: an effect, not a tool name. */
function holdsCreatedReceipt(exchanges: readonly ChatToolExchange[]): boolean {
  return exchanges.some((exchange) => {
    if (exchange.mutationOutcome !== "succeeded") return false;
    const created = chatToolDraftReceipts(exchange)?.some((receipt) => receipt.state === "created");
    return created === true || chatToolIssueKey(exchange.result?.data) !== undefined;
  });
}

/**
 * How many sentences announce a created issue although this turn holds no created receipt. A
 * sentence about an issue key that a tool result or an earlier message already holds, one that
 * refers back to earlier work, one that gives who or when, and one that makes something else (a
 * summary) announce nothing.
 */
export function announcedCreateCount(
  exchanges: readonly ChatToolExchange[],
  answer: string,
  context: readonly string[] = [],
): number {
  if (holdsCreatedReceipt(exchanges)) return 0;
  let known: string | undefined;
  const lazyKnown = (): string =>
    (known ??= `${context.join("\n")}\n${exchanges.map((e) => JSON.stringify(e.result ?? "")).join("\n")}`);
  return Math.min(
    COUNT_MAX,
    answer.split(SENTENCE_END).filter((sentence) => announces(sentence, lazyKnown)).length,
  );
}

/** How many tool calls the answer wrote as text; nothing executed them. */
export function toolCallsWrittenAsText(answer: string): number {
  const found = TEXT_CALLS.reduce((sum, pattern) => sum + [...answer.matchAll(pattern)].length, 0);
  return Math.min(COUNT_MAX, found);
}

/** The corrections ask for an honest answer; they never ask for a write. */
export function announcedCreateCorrection(count: number): string {
  return (
    `Your answer says ${String(count)} time(s) that a Jira issue was created, but no Jira issue was ` +
    "created in this turn. Say plainly what happened and what the person can ask for; do not " +
    "create or change anything now."
  );
}

export function toolCallAsTextCorrection(count: number): string {
  return (
    `Your answer contains ${String(count)} tool call(s) written as text. That text did not call a ` +
    "tool and nothing was executed. Say plainly what happened and what the person can ask for; do " +
    "not create or change anything now."
  );
}
