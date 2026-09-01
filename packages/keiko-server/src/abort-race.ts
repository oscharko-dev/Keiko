export class AbortRaceError extends Error {
  public constructor() {
    super("operation cancelled");
    this.name = "AbortRaceError";
  }
}

export type AbortDeadlineReason = "aborted" | "timeout";

export class AbortDeadlineRaceError extends Error {
  public constructor(public readonly reason: AbortDeadlineReason) {
    super(`operation ${reason}`);
    this.name = "AbortDeadlineRaceError";
  }
}

export interface AbortDeadlineContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface AbortDeadlineOptions {
  readonly deadlineAtMs: number;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal | undefined;
}

interface ArmedAbortDeadline extends AbortDeadlineContext {
  readonly stopped: Promise<never>;
  finish(): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function armDeadlineTimer(timeoutMs: number, onTimeout: () => void): () => void {
  if (!Number.isFinite(timeoutMs)) return () => undefined;
  let unelapsedMs = timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    const delayMs = Math.min(unelapsedMs, MAX_TIMER_DELAY_MS);
    timer = setTimeout(
      () => {
        unelapsedMs -= delayMs;
        if (unelapsedMs <= 0) onTimeout();
        else schedule();
      },
      Math.max(0, delayMs),
    );
    timer.unref();
  };
  schedule();
  return (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

function abortDeadlineReason(options: AbortDeadlineOptions): AbortDeadlineReason | undefined {
  if (options.signal?.aborted === true) return "aborted";
  if (Number.isNaN(options.deadlineAtMs)) return "timeout";
  return options.nowMs() >= options.deadlineAtMs ? "timeout" : undefined;
}

function armAbortDeadline(options: AbortDeadlineOptions): ArmedAbortDeadline {
  const controller = new AbortController();
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
  const remainingMs = Math.max(0, Math.floor(options.deadlineAtMs - options.nowMs()));
  const timeoutMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
  let rejectStopped: (error: AbortDeadlineRaceError) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const stop = (reason: AbortDeadlineReason): void => {
    rejectStopped(new AbortDeadlineRaceError(reason));
    controller.abort();
  };
  const onAbort = (): void => {
    stop("aborted");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const disposeDeadline = armDeadlineTimer(remainingMs, () => {
    stop("timeout");
  });
  const initialReason = abortDeadlineReason(options);
  if (initialReason !== undefined) stop(initialReason);
  return {
    signal,
    timeoutMs,
    stopped,
    finish: (): void => {
      disposeDeadline();
      options.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    },
  };
}

export async function raceAbortDeadline<T>(
  operation: (context: AbortDeadlineContext) => Promise<T>,
  options: AbortDeadlineOptions,
): Promise<T> {
  const preflightReason = abortDeadlineReason(options);
  if (preflightReason !== undefined) throw new AbortDeadlineRaceError(preflightReason);
  const execution = armAbortDeadline(options);
  const work = Promise.resolve().then(async () => {
    const reason = abortDeadlineReason(options);
    if (reason !== undefined) throw new AbortDeadlineRaceError(reason);
    return await operation({ signal: execution.signal, timeoutMs: execution.timeoutMs });
  });
  try {
    const result = await Promise.race([work, execution.stopped]);
    // The absolute deadline is authoritative even when synchronous work blocked the event loop and
    // prevented the timer promise from settling first. A value produced at/after the deadline is
    // late; accepting it would make the same operation depend on timer scheduling rather than time.
    const reason = abortDeadlineReason(options);
    if (reason !== undefined) throw new AbortDeadlineRaceError(reason);
    return result;
  } catch (error) {
    const reason = abortDeadlineReason(options);
    if (reason !== undefined) throw new AbortDeadlineRaceError(reason);
    throw error;
  } finally {
    execution.finish();
  }
}

// Own cancellation at the server orchestration boundary instead of trusting every external port to
// settle when its AbortSignal fires. Both resolution handlers remain attached after cancellation,
// so a hostile or merely slow promise cannot create an unhandled late rejection.
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let listening = false;
    const cleanup = (): void => {
      if (!listening) return;
      signal.removeEventListener("abort", onAbort);
      listening = false;
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = (): void => {
      settle(() => {
        reject(new AbortRaceError());
      });
    };
    void work.then(
      (value) => {
        settle(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        settle(() => {
          reject(error instanceof Error ? error : new Error("operation failed"));
        });
      },
    );
    listening = true;
    signal.addEventListener("abort", onAbort, { once: true });
    // Also covers a signal that was already aborted before listener installation.
    if (signal.aborted) onAbort();
  });
}
