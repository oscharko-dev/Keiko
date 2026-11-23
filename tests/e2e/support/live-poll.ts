// The one wait the live journey lanes use between two observations: Playwright's own poller instead
// of a fixed sleep. A step re-reads the product until the state it waits for is observed, and the
// cadence a lane needs (a provider's rate limit, a re-preview against GitHub) is the poll interval,
// not a pause the step takes on its own.
import { expect } from "@playwright/test";

export interface LivePollOptions {
  /** How long the step may wait in total before it reports what it never observed. */
  readonly timeoutMs: number;
  /** The pause between two observations; the first observation runs at once. */
  readonly intervalMs: number;
}

/**
 * Runs `observe` until it reports `true`, and resolves whether it did within `timeoutMs`.
 *
 * An error `observe` throws ends the wait at once and is rethrown unchanged: a strict-mode break,
 * a detached element or a terminal run must never read as "not there yet" and surface minutes
 * later as a plain timeout. Running out of time resolves `false`, so the caller names what it was
 * waiting for in its own words.
 */
export async function pollUntilObserved(
  observe: () => Promise<boolean>,
  options: LivePollOptions,
): Promise<boolean> {
  let failure: { readonly error: unknown } | undefined;
  const guarded = async (): Promise<boolean> => {
    try {
      return await observe();
    } catch (error) {
      failure = { error };
      throw error;
    }
  };
  try {
    await expect
      .poll(guarded, { timeout: options.timeoutMs, intervals: [options.intervalMs] })
      .toBe(true);
    return true;
  } catch (error) {
    if (failure !== undefined) throw failure.error;
    if (isPollTimeout(error)) return false;
    throw error;
  }
}

function isPollTimeout(error: unknown): boolean {
  return error instanceof Error && /\bTimeout \d+ms exceeded\b/u.test(error.message);
}
