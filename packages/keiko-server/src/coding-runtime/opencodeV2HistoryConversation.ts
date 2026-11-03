import type { CodingHistoryMessage } from "./codingRuntimeHistory.js";
import type { CodingSafeActivitySignal } from "./codingSafeActivityProjection.js";

/** What the captured conversation reads of a projected candidate. */
export interface ConversationCandidate {
  readonly signal?: CodingSafeActivitySignal | undefined;
  readonly nativeRetryState?: true;
  // A text part's own text as the runtime persisted it. Coding History is built from this, never from
  // the live text the timeline shows while the part streams: partial answers are not captured.
  readonly capturedText?: string;
}

// Coding History records what the runtime persisted: a text part's own text, never the live text the
// timeline shows while the part streams, so a turn cut short does not leave a partial answer behind
// and a streaming turn does not rewrite the stored message on every delta.
export function conversationMessages(
  candidates: readonly ConversationCandidate[],
): readonly CodingHistoryMessage[] {
  const messages = new Map<string, CodingHistoryMessage>();
  for (const { signal, capturedText, nativeRetryState } of candidates) {
    if (signal?.kind === "message" && !nativeRetryState)
      messages.set(signal.messageId, {
        messageId: signal.messageId,
        role: signal.role,
        content: "",
      });
    if (signal?.kind !== "text") continue;
    const message = messages.get(signal.messageId);
    if (message !== undefined)
      messages.set(signal.messageId, {
        ...message,
        content: message.content + (capturedText ?? signal.text),
      });
  }
  return [...messages.values()];
}

// The conversation as it was last handed to Coding History: the entries of the messages before the
// pass's anchor (`stable`, shared with the ledger and only ever appended to) and those from it on.
interface ConversationParts {
  readonly stable: readonly CodingHistoryMessage[];
  readonly stableLength: number;
  readonly tail: readonly CodingHistoryMessage[];
}

function entryAt(parts: ConversationParts, index: number): CodingHistoryMessage | undefined {
  return index < parts.stableLength ? parts.stable[index] : parts.tail[index - parts.stableLength];
}

function sameMessage(
  left: CodingHistoryMessage | undefined,
  right: CodingHistoryMessage | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  return (
    left.messageId === right.messageId && left.role === right.role && left.content === right.content
  );
}

// An unchanged conversation is recognised by comparing it with the last one accepted, not by hashing
// it again on every read. Two conversations built on the same stable entries share them, so only
// what lies beyond the shorter of the two is compared: the cost follows the tail, not the session.
function sameConversation(left: ConversationParts | undefined, right: ConversationParts): boolean {
  if (left === undefined) return false;
  const total = right.stableLength + right.tail.length;
  if (left.stableLength + left.tail.length !== total) return false;
  const from = left.stable === right.stable ? Math.min(left.stableLength, right.stableLength) : 0;
  for (let index = from; index < total; index += 1)
    if (!sameMessage(entryAt(left, index), entryAt(right, index))) return false;
  return true;
}

/**
 * Keeps the conversation Coding History captures from the history projection. A pass that read the
 * whole window rebuilds it (`reset`); a pass that read only the tail keeps the entries of the
 * messages before it and rebuilds the rest, so the work follows the tail. Capture is retried on
 * every pass until the port accepts it, and an unchanged accepted conversation is not sent again.
 */
export class ConversationLedger {
  private stable: CodingHistoryMessage[] = [];
  private captured: ConversationParts | undefined;

  constructor(
    private readonly capture: ((messages: readonly CodingHistoryMessage[]) => boolean) | undefined,
  ) {}

  /**
   * `settled` is how many of the pass's candidates belong to messages before the next anchor: their
   * entries join the stable ones. The rest is the volatile tail.
   */
  observe(candidates: readonly ConversationCandidate[], settled: number, reset: boolean): void {
    if (this.capture === undefined) return;
    if (reset) this.stable = [];
    for (const message of conversationMessages(candidates.slice(0, settled)))
      this.stable.push(message);
    const parts: ConversationParts = {
      stable: this.stable,
      stableLength: this.stable.length,
      tail: conversationMessages(candidates.slice(settled)),
    };
    if (sameConversation(this.captured, parts)) return;
    if (this.capture([...parts.stable, ...parts.tail])) this.captured = parts;
  }
}
