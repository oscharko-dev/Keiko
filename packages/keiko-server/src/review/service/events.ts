// The progress events of live review runs (Issue #4136): phase changes and body-free counts while a
// run is in flight, then exactly one `settled` event, after which the run's subscribers are closed.
// No candidate content is ever part of an event; the run record carries findings after settlement.

import type {
  ReviewRunEvent,
  ReviewRunPhase,
  ReviewRunProgressCounts,
  ReviewRunSettlement,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

export interface ReviewRunEventListener {
  /** Receives one event; returns nothing, never throws into the run. */
  readonly onEvent: (event: ReviewRunEvent) => void;
  /** Called once when the run settled or the hub was disposed. */
  readonly onClose: () => void;
}

interface LiveRunEvents {
  readonly startedAt: number;
  phase: ReviewRunPhase;
  counts: ReviewRunProgressCounts;
  readonly listeners: Set<ReviewRunEventListener>;
}

const ZERO_COUNTS: ReviewRunProgressCounts = { filesPackaged: 0, candidates: 0, counterChecked: 0 };

export class ReviewRunEventHub {
  private readonly runs = new Map<string, LiveRunEvents>();

  public constructor(private readonly now: () => number) {}

  public open(runId: string): void {
    this.runs.set(runId, {
      startedAt: this.now(),
      phase: "preparing",
      counts: ZERO_COUNTS,
      listeners: new Set(),
    });
  }

  public isLive(runId: string): boolean {
    return this.runs.has(runId);
  }

  private phaseEvent(runId: string, live: LiveRunEvents): ReviewRunEvent {
    return {
      kind: "phase",
      runId,
      phase: live.phase,
      elapsedMs: this.now() - live.startedAt,
      counts: live.counts,
    };
  }

  /** Subscribes to a live run: the current state is delivered at once. `false` when not live. */
  public subscribe(runId: string, listener: ReviewRunEventListener): (() => void) | undefined {
    const live = this.runs.get(runId);
    if (live === undefined) return undefined;
    live.listeners.add(listener);
    listener.onEvent(this.phaseEvent(runId, live));
    return (): void => {
      live.listeners.delete(listener);
    };
  }

  public update(
    runId: string,
    change: { readonly phase?: ReviewRunPhase; readonly counts?: Partial<ReviewRunProgressCounts> },
  ): void {
    const live = this.runs.get(runId);
    if (live === undefined) return;
    if (change.phase !== undefined) live.phase = change.phase;
    live.counts = { ...live.counts, ...change.counts };
    const event = this.phaseEvent(runId, live);
    for (const listener of live.listeners) listener.onEvent(event);
  }

  /** Emits the one `settled` event and closes every subscriber of the run. */
  public settle(runId: string, settlement: ReviewRunSettlement, presentedCount: number): void {
    const live = this.runs.get(runId);
    if (live === undefined) return;
    this.runs.delete(runId);
    const event: ReviewRunEvent = {
      kind: "settled",
      runId,
      settlement,
      presentedCount,
      elapsedMs: this.now() - live.startedAt,
      counts: live.counts,
    };
    for (const listener of live.listeners) {
      listener.onEvent(event);
      listener.onClose();
    }
  }

  public listenerCount(runId: string): number {
    return this.runs.get(runId)?.listeners.size ?? 0;
  }
}
