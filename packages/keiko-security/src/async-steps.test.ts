import { describe, expect, it } from "vitest";
import { runAsyncSteps } from "./async-steps.js";

describe("runAsyncSteps", () => {
  it("runs every step after the previous one settled and returns the final value", async () => {
    const order: number[] = [];
    let step = 0;
    const result = await runAsyncSteps(async () => {
      order.push(step);
      await Promise.resolve();
      step += 1;
      return step === 5 ? { done: true, value: "finished" } : { done: false };
    });
    expect(result).toBe("finished");
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("completes a run of a hundred thousand steps", async () => {
    let step = 0;
    const result = await runAsyncSteps(async () => {
      step += 1;
      await Promise.resolve();
      return step === 100_000 ? { done: true, value: step } : { done: false };
    });
    expect(result).toBe(100_000);
  });

  it("ends the run with the error of a rejecting step and runs no further step", async () => {
    let calls = 0;
    await expect(
      runAsyncSteps(async () => {
        calls += 1;
        await Promise.resolve();
        if (calls === 3) throw new Error("step failed");
        return { done: false };
      }),
    ).rejects.toThrow("step failed");
    expect(calls).toBe(3);
  });

  it("ends the run with the error of a step that throws before returning a promise", async () => {
    let calls = 0;
    await expect(
      runAsyncSteps<never>(() => {
        calls += 1;
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    expect(calls).toBe(1);
  });
});
