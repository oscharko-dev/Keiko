import { describe, expect, it } from "vitest";
import { awaitStartupReadiness } from "../testing/memory-lab/instance.mjs";

const MODEL = "gemma-4-31b-it";
const FAST = { settleMs: 200, pollMs: 5 };

// Answers the settling read and every later read from a script of model states; the last state
// repeats. `undefined` in a state means the model reports no readiness yet.
function scriptedBff(states) {
  const paths = [];
  return {
    paths,
    request: async (method, path) => {
      paths.push(`${method} ${path}`);
      const state = states[Math.min(paths.length - 1, states.length - 1)];
      const models = state === "absent" ? [] : [{ id: MODEL, conversationReady: state }];
      return { status: 200, json: { models } };
    },
  };
}

describe("memory lab startup readiness", () => {
  it("waits while the product's startup check is still settling instead of ending the run", async () => {
    // The failure this pins (2026-11-11, dev 4e1f07ea0): catalog discovery replaced the
    // configuration generation during the startup check, the settling read answered while the
    // renewed check ran, and the model reported no readiness yet. The lab ended the whole run
    // although the model was ready two seconds later.
    const bff = scriptedBff([undefined, undefined, true]);
    // The run records the re-reads, so a subject that needed the wait stays visible in its results.
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).resolves.toBe(2);
    expect(bff.paths[0]).toBe("GET /api/models?settleStartup=1");
    expect(bff.paths.slice(1)).toEqual(["GET /api/models", "GET /api/models"]);
  });

  it("records no re-read when the model is ready at the settling read", async () => {
    await expect(awaitStartupReadiness(scriptedBff([true]), MODEL, FAST)).resolves.toBe(0);
  });

  it("ends the run at once when the startup check failed", async () => {
    const bff = scriptedBff([false]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow(
      "conversationReady=false",
    );
    expect(bff.paths).toHaveLength(1);
  });

  it("ends the run at once when the model is not configured", async () => {
    const bff = scriptedBff(["absent"]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow("not configured");
    expect(bff.paths).toHaveLength(1);
  });

  it("ends the run when the model never reports readiness within the bound", async () => {
    const bff = scriptedBff([undefined]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow(
      "conversationReady=undefined",
    );
    expect(bff.paths.length).toBeGreaterThan(1);
  });

  it("ends the run when the model disappears while the check settles", async () => {
    const bff = scriptedBff([undefined, "absent"]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow("not configured");
    expect(bff.paths).toHaveLength(2);
  });

  it("refuses a failed read while the check settles", async () => {
    let reads = 0;
    const bff = {
      request: async () => {
        reads += 1;
        return reads === 1
          ? { status: 200, json: { models: [{ id: MODEL }] } }
          : { status: 503, json: undefined };
      },
    };
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow("HTTP 503");
    expect(reads).toBe(2);
  });

  it("refuses a failed model read", async () => {
    const bff = { request: async () => ({ status: 503, json: undefined }) };
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow("HTTP 503");
  });
});
