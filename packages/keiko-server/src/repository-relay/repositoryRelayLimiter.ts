import { RelayRefusal } from "./repositoryRelayResponse.js";

/**
 * What keeps one run, or all runs together, from exhausting Keiko through the repository relay
 * (#4522). A text answer (a POM, metadata, a packument) is buffered whole, up to 64 MiB, so a shell
 * that opens many parallel requests could otherwise pin gigabytes; a client that never reads, or an
 * upstream that never answers, would hold a connection for ever.
 *
 * - Concurrency: at most `perBinding` exchanges in flight for one binding and `process` for all.
 *   A request over a cap waits in a bounded FIFO, for a bounded time, and leaves it when its client
 *   disconnects; past the queue it is refused at once as `relay-busy` (503, `Retry-After: 1`).
 * - Buffered text: each text exchange reserves its bytes (the declared length first, then as it
 *   grows) against one process-wide budget before it buffers them, and returns them when it ends.
 * - Upstream silence: `UpstreamWatchdog` ends an exchange whose upstream sent no byte for the idle
 *   limit, or that outlived the total ceiling, so a slow download is not cut and a dead upstream is.
 */
export const REPOSITORY_RELAY_BINDING_MAX_IN_FLIGHT = 16;
export const REPOSITORY_RELAY_PROCESS_MAX_IN_FLIGHT = 32;
export const REPOSITORY_RELAY_MAX_WAITERS = 256;
export const REPOSITORY_RELAY_QUEUE_WAIT_MS = 30_000;
export const REPOSITORY_RELAY_TEXT_BUDGET_BYTES = 512 * 1024 * 1024;
/** An upstream that sends no byte for this long is dead. */
export const REPOSITORY_RELAY_UPSTREAM_IDLE_MS = 60_000;
/** The longest one exchange may take, however steadily its upstream sends. */
export const REPOSITORY_RELAY_UPSTREAM_TOTAL_MS = 60 * 60 * 1000;

export interface RelayGateLimits {
  readonly perBinding: number;
  readonly process: number;
  readonly maxWaiters: number;
  readonly waitMs: number;
  readonly textBudgetBytes: number;
}

export const DEFAULT_RELAY_GATE_LIMITS: RelayGateLimits = {
  perBinding: REPOSITORY_RELAY_BINDING_MAX_IN_FLIGHT,
  process: REPOSITORY_RELAY_PROCESS_MAX_IN_FLIGHT,
  maxWaiters: REPOSITORY_RELAY_MAX_WAITERS,
  waitMs: REPOSITORY_RELAY_QUEUE_WAIT_MS,
  textBudgetBytes: REPOSITORY_RELAY_TEXT_BUDGET_BYTES,
};

/** One admitted exchange; `release` is idempotent and returns everything the slot holds. */
export interface RelaySlot {
  /** Holds `totalBytes` of the text budget for this exchange; refuses past the budget. */
  reserveText(totalBytes: number): void;
  release(): void;
}

interface Waiter {
  readonly key: object;
  readonly grant: () => void;
}

function busy(): RelayRefusal {
  return new RelayRefusal(503, "relay-busy");
}

export class RelayAdmissionGate {
  private inFlight = 0;
  private textBytes = 0;
  private readonly perKey = new Map<object, number>();
  private waiters: Waiter[] = [];

  public constructor(private readonly limits: RelayGateLimits = DEFAULT_RELAY_GATE_LIMITS) {}

  /** In-flight, waiting and reserved counts, for tests and diagnostics; never a key. */
  public snapshot(): {
    readonly inFlight: number;
    readonly waiting: number;
    readonly textBytes: number;
  } {
    return { inFlight: this.inFlight, waiting: this.waiters.length, textBytes: this.textBytes };
  }

  private hasRoom(key: object): boolean {
    return (
      this.inFlight < this.limits.process && (this.perKey.get(key) ?? 0) < this.limits.perBinding
    );
  }

  private take(key: object): RelaySlot {
    this.inFlight += 1;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    let reserved = 0;
    let released = false;
    return {
      reserveText: (totalBytes): void => {
        if (released || totalBytes <= reserved) return;
        if (this.textBytes + (totalBytes - reserved) > this.limits.textBudgetBytes) throw busy();
        this.textBytes += totalBytes - reserved;
        reserved = totalBytes;
      },
      release: (): void => {
        if (released) return;
        released = true;
        this.textBytes -= reserved;
        this.inFlight -= 1;
        const left = (this.perKey.get(key) ?? 1) - 1;
        if (left <= 0) this.perKey.delete(key);
        else this.perKey.set(key, left);
        this.drain();
      },
    };
  }

  // Grants, in arrival order, every waiter that now has room; one whose binding is still at its cap
  // does not hold up a later waiter of another binding.
  private drain(): void {
    const stillWaiting: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (this.hasRoom(waiter.key)) waiter.grant();
      else stillWaiting.push(waiter);
    }
    this.waiters = stillWaiting;
  }

  /**
   * A slot for one exchange of the binding `key`. Waits in the queue while a cap is reached and
   * refuses as `relay-busy` when the queue is full or the wait ran out; `signal` ends the wait.
   */
  public acquire(key: object, signal: AbortSignal): Promise<RelaySlot> {
    if (signal.aborted) return Promise.reject(new RelayRefusal(409, "run-aborted"));
    if (this.hasRoom(key)) return Promise.resolve(this.take(key));
    if (this.waiters.length >= this.limits.maxWaiters) return Promise.reject(busy());
    return new Promise<RelaySlot>((resolve, reject) => {
      const leave = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters = this.waiters.filter((waiter) => waiter !== entry);
      };
      const onAbort = (): void => {
        leave();
        reject(new RelayRefusal(409, "run-aborted"));
      };
      const timer = setTimeout(() => {
        leave();
        reject(busy());
      }, this.limits.waitMs);
      const entry: Waiter = {
        key,
        grant: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(this.take(key));
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(entry);
    });
  }
}

let processGate: RelayAdmissionGate | undefined;

/** The one gate every repository relay exchange of this process passes through. */
export function processRelayGate(): RelayAdmissionGate {
  processGate ??= new RelayAdmissionGate();
  return processGate;
}

/**
 * Ends an exchange whose upstream went quiet or ran too long. `signal` carries the parent's abort
 * and the watchdog's own, whose reason is the closed `upstream-timeout` refusal, so a fetch or a
 * body read that it interrupts rejects with that refusal itself.
 */
export class UpstreamWatchdog {
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly total: ReturnType<typeof setTimeout>;
  private expired = false;

  public constructor(
    parent: AbortSignal,
    private readonly idleMs: number,
    totalMs: number,
  ) {
    this.signal = AbortSignal.any([parent, this.controller.signal]);
    this.total = setTimeout(() => {
      this.expire();
    }, totalMs);
    this.touch();
  }

  public get timedOut(): boolean {
    return this.expired;
  }

  private expire(): void {
    this.expired = true;
    this.stop();
    this.controller.abort(new RelayRefusal(504, "upstream-timeout"));
  }

  /** Upstream progress: restarts the idle limit. */
  public touch(): void {
    if (this.expired) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.expire();
    }, this.idleMs);
  }

  public stop(): void {
    clearTimeout(this.idle);
    clearTimeout(this.total);
  }
}
