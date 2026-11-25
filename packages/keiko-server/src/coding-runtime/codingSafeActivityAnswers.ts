import {
  CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS,
  CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
  CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS,
  type CodingSafeActivityAnswerPage,
  type CodingSafeActivityFullAnswer,
  type CodingSafeActivityTextSegment,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

// A model's answer is never cut to fit the bounded safe-activity feed (owner decision "Work-ending
// limits"). The feed stays the small live picture the authenticated channel sends whole on every
// update; the complete text of every assistant answer the feed lists is kept here, beside it, and
// read page by page. The only bound is the run's memory bound, and its cut is shown on the message.

/** The complete text of one assistant answer, as the model streamed it. */
export interface RetainedAnswer {
  text: string;
  /** The run's memory bound left part of the answer out. */
  truncated: boolean;
  /** The feed's segments take no more of this answer: they hold a prefix of it, or nothing. */
  feedClosed: boolean;
  /** The feed has named this answer as longer than its segments at least once. */
  named: boolean;
}

export interface RetainedAnswers {
  readonly byMessage: Map<string, RetainedAnswer>;
  readonly maxChars: number;
  /** UTF-16 code units held across all answers of the run. */
  chars: number;
  /** Answers the memory bound cut, for the body-free record of each cut. */
  clippedCount: number;
  /** Answers longer than the feed carries, for the body-free record of each. */
  namedCount: number;
}

/** The largest `fullAnswer` the feed can carry, so a fitting message stays fitting once named. */
export const FULL_ANSWER_RESERVE: CodingSafeActivityFullAnswer = {
  length: CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS,
  truncated: false,
};

export function createRetainedAnswers(maxChars: number): RetainedAnswers {
  return { byMessage: new Map(), maxChars, chars: 0, clippedCount: 0, namedCount: 0 };
}

/**
 * Appends a streamed piece to the answer, inside the run's memory bound, and returns the part
 * kept. Once the bound cut an answer it takes nothing more, so what it holds is a true prefix.
 */
export function retainAnswerText(
  store: RetainedAnswers,
  messageId: string,
  text: string,
): { readonly answer: RetainedAnswer; readonly kept: string } {
  let answer = store.byMessage.get(messageId);
  if (answer === undefined) {
    answer = { text: "", truncated: false, feedClosed: false, named: false };
    store.byMessage.set(messageId, answer);
  }
  if (answer.truncated) return { answer, kept: "" };
  const room = store.maxChars - store.chars;
  const kept = text.length <= room ? text : text.slice(0, wholeCharacterCut(text, room));
  answer.text += kept;
  store.chars += kept.length;
  if (kept.length < text.length) {
    answer.truncated = true;
    store.clippedCount += 1;
  }
  return { answer, kept };
}

/** Releases the answers of messages the feed no longer lists (an evicted turn or message). */
export function releaseUnlistedAnswers(
  store: RetainedAnswers,
  listed: (messageId: string) => boolean,
): void {
  for (const [messageId, answer] of store.byMessage) {
    if (listed(messageId)) continue;
    store.chars -= answer.text.length;
    store.byMessage.delete(messageId);
  }
}

interface AnswerMessage {
  readonly segments: readonly CodingSafeActivityTextSegment[];
  fullAnswer?: CodingSafeActivityFullAnswer;
}

/**
 * Names the answer on its feed message when the segments do not carry all of it. Returns true when
 * the answer is named for the first time.
 */
export function syncFullAnswer(message: AnswerMessage, answer: RetainedAnswer): boolean {
  const carried = message.segments.reduce((length, segment) => length + segment.text.length, 0);
  if (answer.text.length === 0 || (answer.text.length <= carried && !answer.truncated)) {
    delete message.fullAnswer;
    return false;
  }
  message.fullAnswer = { length: answer.text.length, truncated: answer.truncated };
  if (answer.named) return false;
  answer.named = true;
  return true;
}

/**
 * One page of a retained answer from `offset`, or null when there is no such answer or the offset
 * does not lie on a whole character inside it. A page ends on a whole character.
 */
export function retainedAnswerPage(
  store: RetainedAnswers,
  runId: string,
  messageId: string,
  offset: number,
): CodingSafeActivityAnswerPage | null {
  const answer = store.byMessage.get(messageId);
  if (answer === undefined || answer.text.length === 0) return null;
  const { text } = answer;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return null;
  if (splitsSurrogatePair(text, offset)) return null;
  const end = wholeCharacterCut(text, offset + CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS);
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    runId,
    messageId,
    offset,
    text: text.slice(offset, end),
    length: text.length,
    truncated: answer.truncated,
  };
}

// The largest cut at or before `index` that leaves no surrogate pair split in two.
function wholeCharacterCut(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (index <= 0) return 0;
  return splitsSurrogatePair(text, index) ? index - 1 : index;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  return before >= 0xd8_00 && before <= 0xdb_ff && at >= 0xdc_00 && at <= 0xdf_ff;
}
