import { describe, expect, it } from "vitest";
import { FeedbackPublicationRunner } from "./feedback-publication-runner.js";
import { FeedbackPublicationWorker } from "./feedback-publication-worker.js";
import type { RuntimeTimer } from "./runtime-timer.js";

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("feedback publication runner", () => {
  it("starts one idle probe, fills bounded lanes on work, and claims nothing after stop", async () => {
    const callbacks: (() => void)[] = [];
    const timer: RuntimeTimer = {
      setInterval: (value) => {
        callbacks.push(value);
        return callbacks.length;
      },
      clearInterval: () => undefined,
    };
    const releases: ((found: boolean) => void)[] = [];
    let claims = 0;
    const worker = {
      runOne: (signal?: AbortSignal): Promise<boolean> => {
        claims += 1;
        return new Promise((resolve) => {
          releases.push(resolve);
          signal?.addEventListener(
            "abort",
            () => {
              resolve(false);
            },
            { once: true },
          );
        });
      },
    } as unknown as FeedbackPublicationWorker;
    const runner = new FeedbackPublicationRunner({
      worker,
      concurrency: 2,
      pollIntervalMs: 100,
      drainDeadlineMs: 1_000,
      timer,
    });
    runner.start();
    expect(claims).toBe(1);
    releases[0]?.(true);
    await turn();
    expect(claims).toBe(3);
    await runner.stop();
    callbacks.at(-1)?.();
    expect(claims).toBe(3);
  });

  it("backs a single empty probe off from the default interval to the 30 second cap", async () => {
    const callbacks: (() => void)[] = [];
    const delays: number[] = [];
    const timer: RuntimeTimer = {
      setInterval: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return callbacks.length;
      },
      clearInterval: () => undefined,
    };
    let claims = 0;
    const worker = {
      runOne: (): Promise<boolean> => {
        claims += 1;
        return Promise.resolve(false);
      },
    } as unknown as FeedbackPublicationWorker;
    const runner = new FeedbackPublicationRunner({
      worker,
      concurrency: 8,
      pollIntervalMs: 100,
      drainDeadlineMs: 1_000,
      timer,
    });
    runner.start();
    await turn();
    for (let index = 0; index < 12; index += 1) {
      callbacks.at(-1)?.();
      await turn();
    }
    expect(delays.slice(0, 4)).toEqual([100, 200, 400, 800]);
    expect(Math.max(...delays)).toBe(30_000);
    expect(claims).toBe(13);
    await runner.stop();
  });

  it("emits safe terminal diagnostics, lowers only its facet, and recovers on success", async () => {
    const callbacks: (() => void)[] = [];
    const timer: RuntimeTimer = {
      setInterval: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearInterval: () => undefined,
    };
    let failures = 3;
    const worker = {
      runOne: (): Promise<boolean> => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error("SENTINEL_TITLE_BODY_REPOSITORY_TOKEN"));
        }
        return Promise.resolve(false);
      },
    } as unknown as FeedbackPublicationWorker;
    const diagnostics: string[] = [];
    const health: boolean[] = [];
    const runner = new FeedbackPublicationRunner({
      worker,
      concurrency: 2,
      pollIntervalMs: 100,
      drainDeadlineMs: 1_000,
      timer,
      diagnostics: (event): void => {
        diagnostics.push(JSON.stringify(event));
      },
      onHealthChange: (healthy): void => {
        health.push(healthy);
      },
    });
    runner.start();
    await turn();
    callbacks.at(-1)?.();
    await turn();
    callbacks.at(-1)?.();
    await turn();
    expect(health.at(-1)).toBe(false);
    callbacks.at(-1)?.();
    await turn();
    expect(health.at(-1)).toBe(true);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.join(" ")).not.toContain("SENTINEL");
    await runner.stop();
  });
});
