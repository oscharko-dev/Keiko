export class AbortRaceError extends Error {
  public constructor() {
    super("operation cancelled");
    this.name = "AbortRaceError";
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
