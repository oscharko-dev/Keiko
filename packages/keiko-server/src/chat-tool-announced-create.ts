import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";

/**
 * Two ways a Jira answer can claim an action that did not happen (#4355 AC4), both decided without
 * a model: an answer that announces an issue was created while the turn holds no create call, and
 * an answer that writes a tool call as text, which nothing executed. The patterns are closed and
 * deliberately narrow: a sentence has to name both a creation and an issue-like object, and a
 * negated, future or conditional sentence announces nothing.
 */

/** The tool aliases whose call creates issues; any exchange the mutation journal classified counts too. */
const CREATE_TOOLS: ReadonlySet<string> = new Set(["jira_create", "jira_draft"]);

const CREATION = [
  /\b(?:i|we)(?:'ve| have) (?:created|opened|added|filed)\b/iu,
  /\b(?:i|we) (?:created|opened|added|filed)\b/iu,
  /\bbeen created\b/iu,
  /\b(?:was|were) created\b/iu,
  /\bsuccessfully created\b/iu,
  /\bwurden? (?:\p{L}+ )?(?:angelegt|erstellt)\b/iu,
  /\bhabe\b[^.!?\n]{0,60}\b(?:angelegt|erstellt)\b/iu,
  /\b(?:legte|erstellte) ich\b/iu,
] as const;
const ISSUE_OBJECTS = [
  /\b(?:epics?|tasks?|bugs?|issues?|tickets?)\b/iu,
  /\b(?:stor(?:y|ies)|sub-?tasks?)\b/iu,
  /\b(?:vorg[aä]nge?n?|aufgaben?|teilaufgaben?)\b/iu,
  /\bfehlermeldung(?:en)?\b/iu,
] as const;
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
const TEXT_CALLS = [
  /\b(?:jira|knowledge)_[a-z][a-z_]*\s*\(/giu,
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

function announces(sentence: string): boolean {
  return (
    !negated(sentence) &&
    CREATION.some((pattern) => pattern.test(sentence)) &&
    ISSUE_OBJECTS.some((pattern) => pattern.test(sentence))
  );
}

/** Whether the turn holds a create call, whatever its outcome (refused, approved or declined). */
function holdsCreateCall(exchanges: readonly ChatToolExchange[]): boolean {
  return exchanges.some(
    (exchange) => CREATE_TOOLS.has(exchange.call.name) || exchange.mutationOutcome !== undefined,
  );
}

/** How many sentences announce a created issue although the turn holds no create call. */
export function announcedCreateCount(
  exchanges: readonly ChatToolExchange[],
  answer: string,
): number {
  if (holdsCreateCall(exchanges)) return 0;
  return Math.min(COUNT_MAX, answer.split(SENTENCE_END).filter(announces).length);
}

/** How many tool calls the answer wrote as text; nothing executed them. */
export function toolCallsWrittenAsText(answer: string): number {
  const found = TEXT_CALLS.reduce((sum, pattern) => sum + [...answer.matchAll(pattern)].length, 0);
  return Math.min(COUNT_MAX, found);
}

export function announcedCreateCorrection(count: number): string {
  return (
    `Your answer says ${String(count)} time(s) that Jira issues were created, but this turn called ` +
    "no create tool, so nothing was created. Call the create tool now, or say plainly that " +
    "nothing was created."
  );
}

export function toolCallAsTextCorrection(count: number): string {
  return (
    `Your answer contains ${String(count)} tool call(s) written as text. Text is not executed. ` +
    "Call the tool through the tool interface, or answer without it."
  );
}
