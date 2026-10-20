import { yamlPublicationNeedsContext } from "./redaction-yaml.js";
import { privateKeyBodyStart } from "./redaction-private-key.js";
import {
  completeCodePrefix,
  mayEndCodeFence,
  standaloneSourceStart,
  type OpenCodeFence,
} from "./redaction-code.js";

export interface StreamRedactionObservation {
  readonly pendingChars: number;
  readonly maxPendingChars: number;
  readonly publishedBlocks: number;
}

export interface StreamingRedactor {
  observe(): StreamRedactionObservation;
  /** Emits completed safe blocks; unresolved code and credential contexts remain private. */
  push(text: string): string;
  /** Only a successfully completed stream may publish its final unresolved block. */
  finish(): string;
}

function privateKeyScope(
  text: string,
  before: number,
): { start: number; completedThrough: number } {
  const boundary = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/gu;
  let open: number | undefined;
  let completedThrough = 0;
  for (const match of text.matchAll(boundary)) {
    if (match.index >= before) break;
    if (match[1] === "BEGIN") open ??= match.index;
    else {
      open = undefined;
      completedThrough = match.index + match[0].length;
    }
  }
  return { start: open === undefined ? before : Math.min(before, open), completedThrough };
}

function literalPrefixStart(text: string, before: number, literals: readonly string[]): number {
  let end = before;
  const prefix = text.slice(0, before);
  for (const literal of literals) {
    for (let length = Math.min(prefix.length, literal.length - 1); length > 0; length -= 1) {
      if (!prefix.endsWith(literal.slice(0, length))) continue;
      end = Math.min(end, before - length);
      break;
    }
  }
  return end;
}

class BlockRedactor implements StreamingRedactor {
  private parts: string[] = [];
  private pendingChars = 0;
  private lineTail = "";
  private maxPendingChars = 0;
  private publishedBlocks = 0;
  private waiting: OpenCodeFence | undefined;
  private waitingForTerminal = false;
  private waitingForKeyEnd = false;
  private waitingForHeadlessKey = false;

  constructor(
    private readonly redactText: (text: string) => string,
    private readonly literals: readonly string[],
    private readonly pendingContextStart: (
      text: string,
      before: number,
    ) => { readonly start: number; readonly retainUntilTerminal: boolean },
  ) {}

  observe(): StreamRedactionObservation {
    return {
      pendingChars: this.pendingChars,
      maxPendingChars: this.maxPendingChars,
      publishedBlocks: this.publishedBlocks,
    };
  }

  push(text: string): string {
    this.parts.push(text);
    this.pendingChars += text.length;
    this.maxPendingChars = Math.max(this.maxPendingChars, this.pendingChars);
    const lineEnd = text.lastIndexOf("\n") + 1;
    if (lineEnd === 0) {
      this.lineTail += text;
      return "";
    }
    const added = this.lineTail + text.slice(0, lineEnd);
    this.lineTail = text.slice(lineEnd);
    if (this.canKeepWaiting(added)) return "";
    const pending = this.parts.join("");
    const end = this.publicationEnd(pending, pending.length - this.lineTail.length);
    if (end === 0) return "";
    const safe = this.redactText(pending.slice(0, end));
    this.parts = [pending.slice(end)];
    this.pendingChars -= end;
    this.publishedBlocks += 1;
    return safe;
  }

  private canKeepWaiting(added: string): boolean {
    if (this.waitingForTerminal) return true;
    const keyBoundary = /-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/u.test(added);
    if (this.waiting !== undefined && !mayEndCodeFence(added, this.waiting) && !keyBoundary)
      return true;
    if ((this.waitingForKeyEnd || this.waitingForHeadlessKey) && !keyBoundary) return true;
    return (
      this.waiting === undefined &&
      !this.waitingForKeyEnd &&
      /^[A-Za-z0-9+/=\t\v\f \r\n]*$/u.test(added)
    );
  }

  private publicationEnd(pending: string, lineEnd: number): number {
    const key = privateKeyScope(pending, lineEnd);
    this.waitingForKeyEnd = key.start < lineEnd;
    let end = this.waitingForKeyEnd
      ? key.start
      : privateKeyBodyStart(pending, lineEnd, key.completedThrough);
    this.waitingForHeadlessKey = !this.waitingForKeyEnd && end < lineEnd;
    const context = this.pendingContextStart(pending, end);
    this.waitingForTerminal = context.retainUntilTerminal;
    end = context.start;
    end = literalPrefixStart(pending, end, this.literals);
    const code = completeCodePrefix(pending, end);
    this.waiting = code.waiting;
    if (this.waiting !== undefined) return code.end;
    const start = standaloneSourceStart(
      pending,
      code.end,
      (line) => !yamlPublicationNeedsContext(line) && this.redactText(line) === line,
    );
    this.waitingForTerminal = context.retainUntilTerminal || start < code.end;
    return start;
  }

  finish(): string {
    const safe = this.redactText(this.parts.join(""));
    if (this.pendingChars > 0) this.publishedBlocks += 1;
    this.parts = [];
    this.pendingChars = 0;
    this.lineTail = "";
    this.waiting = undefined;
    this.waitingForTerminal = false;
    this.waitingForKeyEnd = false;
    this.waitingForHeadlessKey = false;
    return safe;
  }
}

/** Shared buffering stays inside the existing bounded stream response lifetime. Cancelled
 * consumers discard their unresolved instance; only a completed stream calls finish(). */
export function createStreamingRedactor(
  redactText: (text: string) => string,
  literals: readonly string[],
  pendingContextStart: (
    text: string,
    before: number,
  ) => { readonly start: number; readonly retainUntilTerminal: boolean },
): StreamingRedactor {
  return new BlockRedactor(redactText, literals, pendingContextStart);
}
