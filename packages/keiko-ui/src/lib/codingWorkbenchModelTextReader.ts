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
}

function key(part: CodingSafeActivityTextPart, messageId: string): string {
  return `${part}\u0000${messageId}`;
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
      appendAt(held, delta.offset, delta.text);
    }
  }

  /** Takes a feed update: seeds the carried text, sets targets, reads what is behind, publishes. */
  public sync(feed: AvailableCodingSafeActivityFeed): void {
    if (feed.runId !== this.runId) return;
    for (const turn of feed.turns) {
      for (const message of turn.messages) {
        if (message.role === "assistant") this.syncMessage(message);
      }
    }
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
    // What the feed carries is a true prefix of the text: it extends a shorter held text.
    if (carried.length > held.text.length && carried.startsWith(held.text)) held.text = carried;
    held.target = Math.max(held.target, full?.length ?? carried.length);
    held.named ||= full !== undefined;
    held.truncated = full?.truncated ?? held.truncated;
    this.startRead(part, messageId);
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
    while (!this.controller.signal.aborted && held.text.length < held.target) {
      const offset = held.text.length;
      try {
        const { page } = await getCodingAppSessionAnswerPage(
          { runId: this.runId, messageId, part, offset },
          this.controller.signal,
        );
        if (this.controller.signal.aborted) return;
        if (page === null || !appendAt(held, page.offset, page.text)) {
          this.fail(held, undefined);
          return;
        }
        held.target = Math.max(held.target, page.length);
        held.truncated = page.truncated;
        this.publish();
        // A page that ends the text adds nothing more; the next read waits for the text to grow.
        if (page.text.length === 0) return;
      } catch (error) {
        if (!this.controller.signal.aborted) this.fail(held, error);
        return;
      }
    }
  }

  private fail(held: HeldText, error: unknown): void {
    held.failed = true;
    this.publish();
    // Body-free: the run joins it to the server's page lines; never a message id or any text.
    reportClientDiagnostic("Keiko Coding Workbench could not read the rest of a long model text.", {
      correlationId: isActivityLogCorrelationId(this.runId) ? this.runId : undefined,
      errorKind: "unavailable",
      ...(error === undefined ? {} : { errorEvidence: clientErrorEvidence(error) }),
    });
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

// Appends what `text` starting at `offset` adds beyond the held text; false when it would leave a
// gap, which the reader then reads as pages. Text the reader already holds adds nothing.
function appendAt(held: HeldText, offset: number, text: string): boolean {
  if (offset > held.text.length) return false;
  const end = offset + text.length;
  if (end > held.text.length) held.text += text.slice(held.text.length - offset);
  return true;
}
