import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildRedactor, createRunRegistry, type UiHandlerDeps } from "./index.js";
import {
  handleGetMemoryAutonomyPolicy,
  handlePutMemoryAutonomyPolicy,
} from "./memory-autonomy-policy-handlers.js";
import type { RouteContext } from "./routes.js";
import { createInMemoryUiStore } from "./store/index.js";

function context(body = ""): RouteContext {
  return {
    req: Readable.from([Buffer.from(body)]) as RouteContext["req"],
    res: {} as RouteContext["res"],
    params: {},
    url: new URL("http://127.0.0.1/api/memory/autonomy-policy"),
  };
}

function deps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: createInMemoryUiStore(),
    codingRuntimeDeploymentCeiling: "supervised-coding",
  };
}

describe("memory autonomy policy routes", () => {
  it("defaults safely and persists a requested mode clamped by the deployment ceiling", async () => {
    const handlerDeps = deps();
    expect(handleGetMemoryAutonomyPolicy(context(), handlerDeps)).toMatchObject({
      status: 200,
      body: { requestedMode: "governed-assist", effectiveMode: "governed-assist" },
    });

    const updated = await handlePutMemoryAutonomyPolicy(
      context(JSON.stringify({ requestedMode: "autonomous-delivery" })),
      handlerDeps,
    );
    expect(updated).toEqual({
      status: 200,
      body: {
        requestedMode: "autonomous-delivery",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
      },
    });
    expect(handlerDeps.store.getMemoryAutonomyMode()).toBe("autonomous-delivery");
  });

  it("rejects malformed and unknown modes without changing persisted policy", async () => {
    const handlerDeps = deps();
    await expect(handlePutMemoryAutonomyPolicy(context("{"), handlerDeps)).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      handlePutMemoryAutonomyPolicy(
        context(JSON.stringify({ requestedMode: "unbounded" })),
        handlerDeps,
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(handlerDeps.store.getMemoryAutonomyMode()).toBeUndefined();
  });

  it("rejects an empty request body without changing persisted policy", async () => {
    const handlerDeps = deps();
    await expect(handlePutMemoryAutonomyPolicy(context(""), handlerDeps)).resolves.toMatchObject({
      status: 400,
    });
    expect(handlerDeps.store.getMemoryAutonomyMode()).toBeUndefined();
  });

  it("rejects a request body over the byte limit without changing persisted policy", async () => {
    const handlerDeps = deps();
    const oversized = JSON.stringify({
      requestedMode: "autonomous-delivery",
      pad: "x".repeat(2048),
    });
    await expect(
      handlePutMemoryAutonomyPolicy(context(oversized), handlerDeps),
    ).resolves.toMatchObject({ status: 400 });
    expect(handlerDeps.store.getMemoryAutonomyMode()).toBeUndefined();
  });
});
