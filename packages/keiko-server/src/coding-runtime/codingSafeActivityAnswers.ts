import {
  CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS,
  CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
  CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS,
  CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS,
  type CodingSafeActivityAnswerPage,
  type CodingSafeActivityFullAnswer,
  type CodingSafeActivityTextDelta,
  type CodingSafeActivityTextPart,
} from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

// No model text is cut to fit the bounded safe-activity feed (owner decision "Work-ending limits").
// The feed stays the small live picture the authenticated channel sends whole on every update; the
// complete text of every assistant answer and reasoning the feed lists is kept here, beside it. A
// live update carries what each text gained since the previous one as an append-only delta, and a
// reader that missed some reads it page by page. The only bound is the run's memory bound, and its
// cut is shown on the message.

/** The complete text of one assistant answer or reasoning, as the model streamed it. */
export interface RetainedText {
  readonly messageId: string;
  readonly part: CodingSafeActivityTextPart;
  text: string;
  /** A high surrogate whose pair has not arrived yet; held back so no reader ever splits a pair. */
  pendingHighSurrogate: string;
  /** The run's memory bound left part of the text out. */
  truncated: boolean;
  /** The feed takes no more of this text: it holds a prefix of it, or nothing. */
  feedClosed: boolean;
  /** The feed has named this text as longer than it carries at least once. */
  named: boolean;
  /** Characters a live update has already announced as deltas. */
  published: number;
}

/** Per-part counts of texts the feed named and texts the memory bound cut, for body-free lines. */
export interface RetainedTextCounts {
  named: number;
  clipped: number;
}

export interface RetainedTexts {
  readonly byKey: Map<string, RetainedText>;
  readonly maxChars: number;
  /** UTF-16 code units held across all texts of the run. */
  chars: number;
  readonly counts: Record<CodingSafeActivityTextPart, RetainedTextCounts>;
}

/** The largest full-text naming the feed can carry, so a fitting message stays fitting once named. */
export const FULL_TEXT_RESERVE: CodingSafeActivityFullAnswer = {
  length: CODING_SAFE_ACTIVITY_MAX_RETAINED_ANSWER_CHARS,
  truncated: false,
};

export function createRetainedTexts(maxChars: number): RetainedTexts {
  return {
    byKey: new Map(),
    maxChars,
    chars: 0,
    counts: { answer: { named: 0, clipped: 0 }, reasoning: { named: 0, clipped: 0 } },
  };
}

/** An independent copy for a rollback; the strings are shared, never copied. */
export function cloneRetainedTexts(store: RetainedTexts): RetainedTexts {
  return {
    byKey: new Map([...store.byKey].map(([key, text]) => [key, { ...text }])),
    maxChars: store.maxChars,
    chars: store.chars,
    counts: { answer: { ...store.counts.answer }, reasoning: { ...store.counts.reasoning } },
  };
}

/** Puts `source`'s state back into `target`, keeping `target`'s identity. */
export function restoreRetainedTexts(target: RetainedTexts, source: RetainedTexts): void {
  target.byKey.clear();
  for (const [key, text] of source.byKey) target.byKey.set(key, text);
  target.chars = source.chars;
  target.counts.answer = source.counts.answer;
  target.counts.reasoning = source.counts.reasoning;
}

function textKey(part: CodingSafeActivityTextPart, messageId: string): string {
  return `${part}\u0000${messageId}`;
}

export function retainedText(
  store: RetainedTexts,
  part: CodingSafeActivityTextPart,
  messageId: string,
): RetainedText | undefined {
  return store.byKey.get(textKey(part, messageId));
}

/**
 * Appends a streamed piece to the text, inside the run's memory bound, and returns the part kept.
 * Once the bound cut a text it takes nothing more, so what it holds is a true prefix. A trailing
 * high surrogate waits for its pair, so the held text never ends in half a character.
 */
export function retainText(
  store: RetainedTexts,
  part: CodingSafeActivityTextPart,
  messageId: string,
  piece: string,
): { readonly retained: RetainedText; readonly kept: string } {
  const key = textKey(part, messageId);
  let retained = store.byKey.get(key);
  if (retained === undefined) {
    retained = {
      messageId,
      part,
      text: "",
      pendingHighSurrogate: "",
      truncated: false,
      feedClosed: false,
      named: false,
      published: 0,
    };
    store.byKey.set(key, retained);
  }
  if (retained.truncated) return { retained, kept: "" };
  const { whole, pending } = splitPendingSurrogate(retained.pendingHighSurrogate + piece);
  retained.pendingHighSurrogate = pending;
  const room = store.maxChars - store.chars;
  const kept = whole.length <= room ? whole : whole.slice(0, wholeCharacterCut(whole, room));
  retained.text += kept;
  store.chars += kept.length;
  if (kept.length < whole.length) {
    retained.truncated = true;
    retained.pendingHighSurrogate = "";
    store.counts[part].clipped += 1;
  }
  return { retained, kept };
}

function splitPendingSurrogate(text: string): { readonly whole: string; readonly pending: string } {
  const last = text.charCodeAt(text.length - 1);
  return isHighSurrogate(last)
    ? { whole: text.slice(0, -1), pending: text.slice(-1) }
    : { whole: text, pending: "" };
}

/** Releases the texts of messages the feed no longer lists (an evicted turn or message). */
export function releaseUnlistedTexts(
  store: RetainedTexts,
  listed: (messageId: string) => boolean,
): void {
  for (const [key, retained] of store.byKey) {
    if (listed(retained.messageId)) continue;
    store.chars -= retained.text.length;
    store.byKey.delete(key);
  }
}

/**
 * The full-text naming a message's feed part needs: absent when the carried part is the whole text,
 * otherwise the text's whole length and whether the memory bound cut it. `firstNamed` is true the
 * first time the text is named, for its single body-free record.
 */
export function fullTextFor(
  carried: number,
  retained: RetainedText,
): { readonly full: CodingSafeActivityFullAnswer | undefined; readonly firstNamed: boolean } {
  const { length } = retained.text;
  if (length === 0 || (length <= carried && !retained.truncated)) {
    return { full: undefined, firstNamed: false };
  }
  const firstNamed = !retained.named;
  retained.named = true;
  return { full: { length, truncated: retained.truncated }, firstNamed };
}

/**
 * One page of a retained text from `offset`, or null when there is no such text or the offset does
 * not lie on a whole character inside it. A page ends on a whole character.
 */
export function retainedTextPage(
  store: RetainedTexts,
  runId: string,
  request: {
    readonly messageId: string;
    readonly part: CodingSafeActivityTextPart;
    readonly offset: number;
  },
): CodingSafeActivityAnswerPage | null {
  const retained = retainedText(store, request.part, request.messageId);
  if (retained === undefined || retained.text.length === 0) return null;
  const { text } = retained;
  const { offset } = request;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return null;
  if (splitsSurrogatePair(text, offset)) return null;
  const end = wholeCharacterCut(text, offset + CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS);
  return {
    schemaVersion: CODING_SAFE_ACTIVITY_CONTRACT_VERSION,
    runId,
    messageId: request.messageId,
    part: request.part,
    offset,
    text: text.slice(offset, end),
    length: text.length,
    truncated: retained.truncated,
  };
}

/**
 * What every listed text gained since the previous live update, within `budgetBytes` of serialized
 * deltas. Every text counts as announced afterwards: a gain left out — over the budget, over the
 * delta count, or longer than a page — reaches the reader as pages, never as a gap it cannot see.
 */
export function takeTextDeltas(
  store: RetainedTexts,
  listed: (messageId: string) => boolean,
  budgetBytes: number,
): readonly CodingSafeActivityTextDelta[] {
  const deltas: CodingSafeActivityTextDelta[] = [];
  let used = 0;
  for (const retained of store.byKey.values()) {
    const offset = retained.published;
    retained.published = retained.text.length;
    if (offset >= retained.text.length || !listed(retained.messageId)) continue;
    const delta: CodingSafeActivityTextDelta = {
      messageId: retained.messageId,
      part: retained.part,
      offset,
      text: retained.text.slice(offset),
    };
    const cost = utf8.encode(JSON.stringify(delta)).length + 1;
    if (
      delta.text.length > CODING_SAFE_ACTIVITY_ANSWER_PAGE_MAX_CHARS ||
      deltas.length >= CODING_SAFE_ACTIVITY_MAX_TEXT_DELTAS ||
      used + cost > budgetBytes
    ) {
      continue;
    }
    deltas.push(delta);
    used += cost;
  }
  return deltas;
}

const utf8 = new TextEncoder();

// The largest cut at or before `index` that leaves no surrogate pair split in two.
function wholeCharacterCut(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (index <= 0) return 0;
  return splitsSurrogatePair(text, index) ? index - 1 : index;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd8_00 && code <= 0xdb_ff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc_00 && code <= 0xdf_ff;
}
