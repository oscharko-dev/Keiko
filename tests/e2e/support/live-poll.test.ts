// The live journey lanes wait between observations only through `pollUntilObserved` (SonarCloud
// S2925, epic #2360). These pins hold the three outcomes every caller relies on: an observed state
// resolves at once, an error the observation throws ends the wait unchanged, and running out of
// time resolves `false` instead of throwing Playwright's own assertion text.
import { describe, expect, it } from "vitest";
import { pollUntilObserved } from "./live-poll.js";

const FAST = { timeoutMs: 2_000, intervalMs: 10 } as const;

describe("pollUntilObserved", () => {
  it("resolves true on the observation that first reports the state", async () => {
    let calls = 0;
    const observed = await pollUntilObserved(() => {
      calls += 1;
      return Promise.resolve(calls === 3);
    }, FAST);

    expect(observed).toBe(true);
    expect(calls).toBe(3);
  });

  it("runs the first observation at once and stops after an immediate success", async () => {
    let calls = 0;
    const observed = await pollUntilObserved(
      () => {
        calls += 1;
        return Promise.resolve(true);
      },
      { timeoutMs: 60_000, intervalMs: 60_000 },
    );

    expect(observed).toBe(true);
    expect(calls).toBe(1);
  });

  it("resolves false when the state is never observed within the timeout", async () => {
    let calls = 0;
    const observed = await pollUntilObserved(
      () => {
        calls += 1;
        return Promise.resolve(false);
      },
      { timeoutMs: 100, intervalMs: 10 },
    );

    expect(observed).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });

  it("rethrows an error the observation throws, unchanged, without observing again", async () => {
    class StructuralBreak extends Error {}
    const failure = new StructuralBreak("strict mode violation");
    let calls = 0;

    const waited = pollUntilObserved(() => {
      calls += 1;
      return calls === 2 ? Promise.reject(failure) : Promise.resolve(false);
    }, FAST);

    await expect(waited).rejects.toBe(failure);
    expect(calls).toBe(2);
  });
});
