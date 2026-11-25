import type {
  AvailableCodingSafeActivityFeed,
  CodingSafeActivityMessage,
  CodingSafeActivityTextDelta,
  CodingSafeActivityTextPart,
} from "@oscharko-dev/keiko-contracts";
import { isActivityLogCorrelationId } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { getCodingAppSessionAnswerPage } from "./coding-app-session-channel-api";
import { clientErrorEvidence } from "./client-error-evidence";
import { reportClientDiagnostic } from "./client-diagnostics";

/**
 * The complete text of one assistant answer or reasoning the feed names as longer than it carries.
 * No model text is cut to fit the bounded feed: it streams in as append-only deltas and whatever a
 * reader missed is read page by page, so the text shown is whole.
 */
export interface CodingWorkbenchAnswerText {
  readonly text: string;
  /** The text holds every character the feed last said it has. */
  readonly complete: boolean;
  /** The server's memory bound cut the text: it is shown with a truncation mark. */
  readonly truncated: boolean;
  /** Reading the rest failed; the part held stays shown and the cut is marked until a retry. */
  readonly failed: boolean;
}

/** Complete texts by message id, for one run. */
export type CodingWorkbenchAnswers = ReadonlyMap<string, CodingWorkbenchAnswerText>;

export interface CodingWorkbenchModelTexts {
  readonly answers: CodingWorkbenchAnswers;
  readonly reasoning: CodingWorkbenchAnswers;
}

interface HeldText {
  text: string;
  /** The whole length the feed names, or the carried length when it names none. */
  target: number;
  named: boolean;
  truncated: boolean;
  failed: boolean;
  reading: boolean;
  /** Reasoning is read only once someone opens it; an answer always. */
  wanted: boolean;
  /** A feed listed the message: once it no longer does, the feed evicted it and the text is pruned. */
  listed: boolean;
}

// What the feed carries is a true prefix of the text: it extends a shorter held text, and a named
// whole text sets how far the reader has to read. A carried prefix that disagrees with the held
// text is the server's truth (a restored, rolled-back or re-redacted text): it replaces the held
// text instead of leaving a stale prefix.
function absorbCarried(
  held: HeldText,
  carried: string,
  full: CodingSafeActivityMessage["fullAnswer"],
): void {
  if (carried.length > held.text.length && carried.startsWith(held.text)) held.text = carried;
  else if (!carried.startsWith(held.text) && !held.text.startsWith(carried)) {
    held.text = carried;
    held.target = 0;
  }
  held.target = Math.max(held.target, full?.length ?? carried.length);
  held.named ||= full !== undefined;
  held.truncated = full?.truncated ?? held.truncated;
}

function key(part: CodingSafeActivityTextPart, messageId: string): string {
  return `${part}\u0000${messageId}`;
}

// Body-free: the run joins it to the server's page lines; never a message id or any text.
function reportTextReadFailure(runId: string, error: unknown): void {
  reportClientDiagnostic("Keiko Coding Workbench could not read the rest of a long model text.", {
    correlationId: isActivityLogCorrelationId(runId) ? runId : undefined,
    errorKind: "unavailable",
    ...(error === undefined ? {} : { errorEvidence: clientErrorEvidence(error) }),
  });
}

/**
 * Holds one run's model texts. Deltas are appended the moment they arrive, before any render
 * batching can drop the update that carried them; a feed update seeds what the feed carries, sets
 * each text's target and starts a page read only where the held text is behind. One read per text
 * runs at a time and a failed read is not retried until someone asks, so a broken page never turns
 * into a request per update.
 */
export class CodingWorkbenchModelTextReader {
  private readonly held = new Map<string, HeldText>();
  private readonly controller = new AbortController();

  public constructor(
    private readonly runId: string,
    private readonly onChange: (texts: CodingWorkbenchModelTexts) => void,
  ) {}

  public dispose(): void {
    this.controller.abort();
  }

  /** Appends every delta that continues a held text exactly; any other is read as pages later. */
  public ingestDeltas(deltas: readonly CodingSafeActivityTextDelta[] | undefined): void {
    for (const delta of deltas ?? []) {
      const held = this.entry(delta.part, delta.messageId);
      if (appendAt(held, delta.offset, delta.text) === "restart") {
        this.startRead(delta.part, delta.messageId);
      }
    }
  }

  /** Takes a feed update: seeds the carried text, sets targets, reads what is behind, publishes. */
  public sync(feed: AvailableCodingSafeActivityFeed): void {
    if (feed.runId !== this.runId) return;
    const present = new Set<string>();
    for (const turn of feed.turns) {
      for (const message of turn.messages) {
        if (message.role !== "assistant") continue;
        present.add(key("answer", message.messageId));
        present.add(key("reasoning", message.messageId));
        this.syncMessage(message);
      }
    }
    this.prune(present);
    this.publish();
  }

  /** Someone opened the reasoning: read the rest of it from now on. */
  public wantReasoning(messageId: string): void {
    const held = this.entry("reasoning", messageId);
    if (held.wanted) return;
    held.wanted = true;
    this.startRead("reasoning", messageId);
  }

  /** Reads a text whose read failed again, from where its held text ends. */
  public retry(part: CodingSafeActivityTextPart, messageId: string): void {
    const held = this.held.get(key(part, messageId));
    if (held === undefined || !held.failed) return;
    held.failed = false;
    this.publish();
    this.startRead(part, messageId);
  }

  private syncMessage(message: CodingSafeActivityMessage): void {
    const answer = message.segments.map((segment) => segment.text).join("");
    this.syncPart("answer", message.messageId, answer, message.fullAnswer);
    this.syncPart(
      "reasoning",
      message.messageId,
      message.reasoning?.text ?? "",
      message.fullReasoning,
    );
  }

  private syncPart(
    part: CodingSafeActivityTextPart,
    messageId: string,
    carried: string,
    full: CodingSafeActivityMessage["fullAnswer"],
  ): void {
    if (carried.length === 0 && full === undefined && !this.held.has(key(part, messageId))) return;
    const held = this.entry(part, messageId);
    held.listed = true;
    absorbCarried(held, carried, full);
    this.startRead(part, messageId);
  }

  // Drops the text of every message a feed once listed and no longer does, so a long run does not
  // grow without bound. A text only deltas have reached so far was never listed and stays.
  private prune(present: ReadonlySet<string>): void {
    for (const [k, held] of this.held) {
      if (held.listed && !present.has(k)) this.held.delete(k);
    }
  }

  private entry(part: CodingSafeActivityTextPart, messageId: string): HeldText {
    const k = key(part, messageId);
    let held = this.held.get(k);
    if (held === undefined) {
      held = {
        text: "",
        target: 0,
        named: false,
        truncated: false,
        failed: false,
        reading: false,
        wanted: part === "answer",
        listed: false,
      };
      this.held.set(k, held);
    }
    return held;
  }

  private startRead(part: CodingSafeActivityTextPart, messageId: string): void {
    const held = this.held.get(key(part, messageId));
    if (held === undefined || !held.wanted || held.reading || held.failed) return;
    if (held.text.length >= held.target) return;
    held.reading = true;
    void this.readRest(part, messageId, held).finally(() => {
      held.reading = false;
    });
  }

  private async readRest(
    part: CodingSafeActivityTextPart,
    messageId: string,
    held: HeldText,
  ): Promise<void> {
    while (
      !this.controller.signal.aborted &&
      this.held.get(key(part, messageId)) === held &&
      held.text.length < held.target
    ) {
      const offset = held.text.length;
      try {
        const next = await this.readPage(part, messageId, held, offset);
        if (next === "stop") return;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        this.markFailed(held);
        reportTextReadFailure(this.runId, error);
        return;
      }
    }
  }

  // Reads and absorbs one page; "stop" ends the read (failed, aborted or the text ended).
  private async readPage(
    part: CodingSafeActivityTextPart,
    messageId: string,
    held: HeldText,
    offset: number,
  ): Promise<"next" | "stop"> {
    const { page } = await getCodingAppSessionAnswerPage(
      { runId: this.runId, messageId, part, offset },
      this.controller.signal,
    );
    if (this.controller.signal.aborted) return "stop";
    // The held text shrank under the read (it was replaced): the page is stale, read again.
    if (page !== null && held.text.length < offset) return "next";
    const outcome = page === null ? "gap" : appendAt(held, page.offset, page.text);
    if (page === null || outcome === "gap") {
      this.markFailed(held);
      reportTextReadFailure(this.runId, undefined);
      return "stop";
    }
    // A mismatch dropped the held text under the read: read again from its end.
    if (outcome === "restart") return "next";
    held.target = Math.max(held.target, page.length);
    held.truncated = page.truncated;
    this.publish();
    // A page that ends the text adds nothing more; the next read waits for the text to grow.
    return page.text.length === 0 ? "stop" : "next";
  }

  private markFailed(held: HeldText): void {
    held.failed = true;
    this.publish();
  }

  private publish(): void {
    if (this.controller.signal.aborted) return;
    const answers = new Map<string, CodingWorkbenchAnswerText>();
    const reasoning = new Map<string, CodingWorkbenchAnswerText>();
    for (const [k, held] of this.held) {
      if (!held.named && !held.failed) continue;
      const [part, messageId] = k.split("\u0000") as [CodingSafeActivityTextPart, string];
      (part === "answer" ? answers : reasoning).set(messageId, {
        text: held.text,
        complete: held.text.length >= held.target,
        truncated: held.truncated,
        failed: held.failed,
      });
    }
    this.onChange({ answers, reasoning });
  }
}

type AppendOutcome = "appended" | "gap" | "restart";

// Appends what `text` starting at `offset` adds beyond the held text; "gap" when it would leave a
// gap, which the reader then reads as pages. Text the reader already holds adds nothing. Where the
// piece overlaps held text the overlap must match: on a mismatch the held text is stale. A piece
// that starts at 0 replaces it; any other piece drops it and asks for a fresh read ("restart").
function appendAt(held: HeldText, offset: number, text: string): AppendOutcome {
  if (offset > held.text.length) return "gap";
  const overlap = Math.min(held.text.length - offset, text.length);
  if (held.text.slice(offset, offset + overlap) !== text.slice(0, overlap)) {
    held.text = offset === 0 ? text : "";
    if (offset === 0) held.target = text.length;
    return offset === 0 ? "appended" : "restart";
  }
  const end = offset + text.length;
  if (end > held.text.length) held.text += text.slice(held.text.length - offset);
  return "appended";
}
