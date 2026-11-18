import { describe, expect, it } from "vitest";
import { awaitStartupReadiness } from "../testing/memory-lab/instance.mjs";

const MODEL = "gemma-4-31b-it";
const FAST = { settleMs: 200, pollMs: 5 };
const ACTIVATION = "POST /api/gateway/readiness";

// Answers the settling read and every later model read from a script of model states; the last
// state repeats. `undefined` in a state means the model reports no readiness yet. The activation a
// person sends from Settings > Models is answered with `activation` and consumes no state.
function scriptedBff(states, activation = { status: 200, json: {} }) {
  const paths = [];
  const bodies = [];
  let reads = 0;
  return {
    paths,
    bodies,
    request: async (method, path, body) => {
      paths.push(`${method} ${path}`);
      if (method === "POST") {
        bodies.push(body);
        return activation;
      }
      const state = states[Math.min(reads, states.length - 1)];
      reads += 1;
      const models = state === "absent" ? [] : [{ id: MODEL, conversationReady: state }];
      return { status: 200, json: { models } };
    },
  };
}

describe("memory lab startup readiness", () => {
  it("activates the answer model the way a person does when it reports no readiness", async () => {
    // ADR-0171 D2 (amended 2026-11-16): a server process checks no chat model at start, so the
    // answer model stays without readiness until somebody activates it. Before this, every live
    // run of the lab ended at the start with `conversationReady=undefined`.
    const bff = scriptedBff([undefined, true]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).resolves.toBe(0);
    expect(bff.paths).toEqual(["GET /api/models?settleStartup=1", ACTIVATION, "GET /api/models"]);
    expect(bff.bodies).toEqual([{ modelId: MODEL }]);
  });

  it("waits while the product's check is still settling instead of ending the run", async () => {
    // The failure this pins (2026-11-11, dev 4e1f07ea0): catalog discovery replaced the
    // configuration generation during the startup check, the settling read answered while the
    // renewed check ran, and the model reported no readiness yet. The lab ended the whole run
    // although the model was ready two seconds later.
    const bff = scriptedBff([undefined, undefined, undefined, true]);
    // The run records the re-reads, so a subject that needed the wait stays visible in its results.
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).resolves.toBe(2);
    expect(bff.paths[0]).toBe("GET /api/models?settleStartup=1");
    expect(bff.paths.slice(1)).toEqual([
      ACTIVATION,
      "GET /api/models",
      "GET /api/models",
      "GET /api/models",
    ]);
  });

  it("records no re-read and sends no activation when the model is ready at the settling read", async () => {
    const bff = scriptedBff([true]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).resolves.toBe(0);
    expect(bff.paths).toEqual(["GET /api/models?settleStartup=1"]);
  });

  it("ends the run at once when the startup check failed", async () => {
    const bff = scriptedBff([false]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow(
      "conversationReady=false",
    );
    expect(bff.paths).toHaveLength(1);
  });

  it("ends the run at once when the activation check fails", async () => {
    const bff = scriptedBff([undefined, false]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow(
      "conversationReady=false",
    );
    expect(bff.paths).toEqual(["GET /api/models?settleStartup=1", ACTIVATION, "GET /api/models"]);
  });

  it("refuses an activation the product does not accept", async () => {
    const bff = scriptedBff([undefined], { status: 409, json: undefined });
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow(
      "answer model activation failed with HTTP 409",
    );
    expect(bff.paths).toEqual(["GET /api/models?settleStartup=1", ACTIVATION]);
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
    expect(bff.paths.length).toBeGreaterThan(3);
  });

  it("ends the run when the model disappears while the check settles", async () => {
    const bff = scriptedBff([undefined, "absent"]);
    await expect(awaitStartupReadiness(bff, MODEL, FAST)).rejects.toThrow("not configured");
    expect(bff.paths).toEqual(["GET /api/models?settleStartup=1", ACTIVATION, "GET /api/models"]);
  });

  it("refuses a failed read while the check settles", async () => {
    let reads = 0;
    const bff = {
      request: async (method) => {
        if (method === "POST") return { status: 200, json: {} };
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
