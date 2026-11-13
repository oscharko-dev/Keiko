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
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:now\s+|just\s+|successfully\s+)?(?:created|opened|added|filed)\b/iu,
  /\b(?:has|have|was|were)\s+(?:now\s+|successfully\s+)?(?:been\s+)?created\b/iu,
  /\bsuccessfully\s+created\b/iu,
  /\b(?:wurde|wurden)\s+(?:\p{L}+\s+)?(?:erfolgreich\s+)?(?:angelegt|erstellt)\b/iu,
  /\b(?:ich\s+)?habe\b[^.!?\n]{0,60}\b(?:angelegt|erstellt)\b/iu,
  /\b(?:legte|erstellte)\s+ich\b/iu,
] as const;
const ISSUE_OBJECT =
  /\b(?:epics?|stor(?:y|ies)|tasks?|bugs?|sub-?tasks?|issues?|tickets?|vorg(?:a|ä)ng(?:e|en)?|aufgaben?|fehler(?:meldung(?:en)?)?|teilaufgaben?)\b/iu;
const NOT_AN_ANNOUNCEMENT =
  /\?|\b(?:not|never|no|cannot|can't|couldn't|could not|wasn't|weren't|won't|would|will|should|shall|if|unable|from|based on|out of)\b|\b(?:aus|anhand|nicht|kein|keine|konnte|k(?:ö|o)nnte|werde|w(?:ü|ue)rde|soll|sollte|falls|wenn|noch)\b/iu;
const TEXT_CALL =
  /\b(?:jira|knowledge)_[a-z][a-z_]*\s*\(|["']name["']\s*:\s*["'](?:jira|knowledge)_[a-z_]+["']|<(?:tool_call|function_call)>/giu;
const SENTENCE_END = /(?<=[.!?])\s+|\n+/u;
const COUNT_MAX = 99;

function announces(sentence: string): boolean {
  return (
    !NOT_AN_ANNOUNCEMENT.test(sentence) &&
    CREATION.some((pattern) => pattern.test(sentence)) &&
    ISSUE_OBJECT.test(sentence)
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
  return Math.min(COUNT_MAX, answer.match(TEXT_CALL)?.length ?? 0);
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
