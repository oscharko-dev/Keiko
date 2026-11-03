// Negative tests for the lab's guards: weakened configuration and stale evidence must be refused
// before any instance starts. Nothing here forks the product.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../testing/coding-workbench-lab/lab-common.mjs";
import { awaitLearning } from "../testing/memory-lab/instance.mjs";
import { normalizeOptions, runLab } from "../testing/memory-lab/run.mjs";

function values(overrides = {}) {
  return {
    mode: "offline",
    out: join(tmpdir(), "memory-lab-options-out"),
    scenarios: join(tmpdir(), "memory-lab-options-scenarios"),
    arms: "product",
    repetitions: "1",
    "memory-mode": "governed-assist",
    ceiling: "governed-assist",
    "budget-tokens": "1200",
    keep: false,
    "generated-at": "0",
    "retain-bodies": true,
    "quiet-ms": "400",
    "max-wait-ms": "30000",
    "learner-grace-ms": "3000",
    "turn-timeout-ms": "60000",
    ...overrides,
  };
}

describe("memory lab option guards", () => {
  let directory;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("accepts a complete offline configuration", () => {
    const options = normalizeOptions(values());
    expect(options.mode).toBe("offline");
    expect(options.arms).toEqual(["product"]);
    expect(options.graceMs).toBe(3000);
    expect(options.brokenLearner).toBeUndefined();
  });

  it("refuses an output directory inside the checkout", () => {
    expect(() => normalizeOptions(values({ out: join(REPO_ROOT, "lab-out") }))).toThrow(
      /outside the checkout/u,
    );
    expect(() => normalizeOptions(values({ out: "" }))).toThrow(/--out is required/u);
  });

  it.each([
    ["config", { "answer-model": "a", "learn-model": "b" }],
    ["answer-model", { config: "/tmp/gateway.json", "learn-model": "b" }],
    ["learn-model", { config: "/tmp/gateway.json", "answer-model": "a" }],
  ])("refuses a live configuration without %s", (_missing, present) => {
    expect(() => normalizeOptions(values({ mode: "live", ...present }))).toThrow(
      /live mode needs/u,
    );
  });

  it("refuses the broken-learner proof in live mode", () => {
    expect(() =>
      normalizeOptions(
        values({
          mode: "live",
          config: "/tmp/gateway.json",
          "answer-model": "a",
          "learn-model": "b",
          "broken-learner": "whole-message",
        }),
      ),
    ).toThrow(/offline proof/u);
  });

  it.each([
    ["an unknown arm", { arms: "product,guess" }, /--arms must be one of/u],
    ["an unknown mode", { mode: "replay" }, /--mode must be one of/u],
    ["an unknown ceiling", { ceiling: "unlimited" }, /--ceiling must be one of/u],
    ["an unknown memory mode", { "memory-mode": "loud" }, /--memory-mode must be one of/u],
    ["an unknown broken learner", { "broken-learner": "lazy" }, /--broken-learner must be one of/u],
    ["a non-integer repetition count", { repetitions: "two" }, /--repetitions must be an integer/u],
    ["a negative budget", { "budget-tokens": "-1" }, /--budget-tokens must be an integer/u],
    ["a fractional quiet period", { "quiet-ms": "1.5" }, /--quiet-ms must be an integer/u],
  ])("refuses %s", (_name, patch, pattern) => {
    expect(() => normalizeOptions(values(patch))).toThrow(pattern);
  });

  it("refuses to overwrite an output directory that already holds a scorecard", async () => {
    directory = mkdtempSync(join(tmpdir(), "memory-lab-stale-"));
    writeFileSync(join(directory, "scorecard.json"), "{}");
    await expect(
      runLab(normalizeOptions(values({ out: directory })), () => undefined),
    ).rejects.toThrow(/refusing to overwrite/u);
  });
});

function ledgerInstance(counts) {
  let calls = 0;
  return {
    request: async () => {
      const captures = Array.from(
        { length: counts[Math.min(calls, counts.length - 1)] },
        () => ({}),
      );
      calls += 1;
      return { status: 200, json: { captures } };
    },
  };
}

describe("memory lab learning wait", () => {
  it("waits through the grace period when no pending-work signal exists", async () => {
    const started = Date.now();
    const settled = await awaitLearning(ledgerInstance([0]), {
      quietMs: 10,
      graceMs: 150,
      maxMs: 5000,
    });
    expect(settled.captures).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("returns after the quiet period once every queued extraction was served", async () => {
    const started = Date.now();
    const settled = await awaitLearning(ledgerInstance([1]), {
      quietMs: 20,
      graceMs: 5000,
      maxMs: 5000,
      pendingLearner: () => 0,
    });
    expect(settled.captures).toBe(1);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("fails closed when the ledger never settles in time", async () => {
    let count = 0;
    const restless = {
      request: async () => {
        count += 1;
        await delay(1);
        return { status: 200, json: { captures: Array.from({ length: count }, () => ({})) } };
      },
    };
    await expect(
      awaitLearning(restless, { quietMs: 50, graceMs: 10, maxMs: 120, pendingLearner: () => 0 }),
    ).rejects.toThrow(/did not settle/u);
  });
});
