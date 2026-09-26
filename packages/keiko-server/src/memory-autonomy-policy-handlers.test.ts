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
    correlationId: undefined,
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
      body: { requestedMode: "governed-assist", effectiveMode: "governed-assist", revision: 0 },
    });

    const updated = await handlePutMemoryAutonomyPolicy(
      context(JSON.stringify({ requestedMode: "autonomous-delivery", expectedRevision: 0 })),
      handlerDeps,
    );
    expect(updated).toEqual({
      status: 200,
      body: {
        requestedMode: "autonomous-delivery",
        effectiveMode: "supervised-coding",
        deploymentCeiling: "supervised-coding",
        revision: 1,
      },
    });
    expect(handlerDeps.store.readMemoryAutonomyPolicy()).toEqual({
      requestedMode: "autonomous-delivery",
      revision: 1,
    });
  });

  it("lets a stale downgrade win and rejects a stale authority increase", async () => {
    const handlerDeps = deps();
    await expect(
      handlePutMemoryAutonomyPolicy(
        context(JSON.stringify({ requestedMode: "autonomous-delivery", expectedRevision: 0 })),
        handlerDeps,
      ),
    ).resolves.toMatchObject({ status: 200, body: { revision: 1 } });
    await expect(
      handlePutMemoryAutonomyPolicy(
        context(JSON.stringify({ requestedMode: "governed-assist", expectedRevision: 0 })),
        handlerDeps,
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { requestedMode: "governed-assist", revision: 2 },
    });
    await expect(
      handlePutMemoryAutonomyPolicy(
        context(JSON.stringify({ requestedMode: "autonomous-delivery", expectedRevision: 1 })),
        handlerDeps,
      ),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "CONFLICT" } },
    });
    expect(handleGetMemoryAutonomyPolicy(context(), handlerDeps)).toMatchObject({
      body: { requestedMode: "governed-assist", revision: 2 },
    });
  });

  it("rejects malformed and unknown modes without changing persisted policy", async () => {
    const handlerDeps = deps();
    await expect(handlePutMemoryAutonomyPolicy(context("{"), handlerDeps)).resolves.toMatchObject({
      status: 400,
    });
    await expect(
      handlePutMemoryAutonomyPolicy(
        context(JSON.stringify({ requestedMode: "unbounded", expectedRevision: 0 })),
        handlerDeps,
      ),
    ).resolves.toMatchObject({ status: 400 });
    expect(handlerDeps.store.readMemoryAutonomyPolicy()).toBeUndefined();
  });

  it.each([
    ["a missing revision", { requestedMode: "governed-assist" }],
    ["a negative revision", { requestedMode: "governed-assist", expectedRevision: -1 }],
    ["a fractional revision", { requestedMode: "governed-assist", expectedRevision: 1.5 }],
    ["a string revision", { requestedMode: "governed-assist", expectedRevision: "0" }],
  ])("rejects %s without changing persisted policy", async (_label, update) => {
    const handlerDeps = deps();
    await expect(
      handlePutMemoryAutonomyPolicy(context(JSON.stringify(update)), handlerDeps),
    ).resolves.toMatchObject({ status: 400 });
    expect(handlerDeps.store.readMemoryAutonomyPolicy()).toBeUndefined();
  });

  it("rejects an empty request body without changing persisted policy", async () => {
    const handlerDeps = deps();
    await expect(handlePutMemoryAutonomyPolicy(context(""), handlerDeps)).resolves.toMatchObject({
      status: 400,
    });
    expect(handlerDeps.store.readMemoryAutonomyPolicy()).toBeUndefined();
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
    expect(handlerDeps.store.readMemoryAutonomyPolicy()).toBeUndefined();
  });

  it("settles with 400 instead of hanging when the client aborts mid-upload", async () => {
    const handlerDeps = deps();
    const req = new Readable({ read: (): void => undefined });
    const ctx: RouteContext = {
      correlationId: undefined,
      req: req as RouteContext["req"],
      res: {} as RouteContext["res"],
      params: {},
      url: new URL("http://127.0.0.1/api/memory/autonomy-policy"),
    };
    const result = handlePutMemoryAutonomyPolicy(ctx, handlerDeps);
    req.emit("aborted");
    await expect(result).resolves.toMatchObject({ status: 400 });
    expect(handlerDeps.store.readMemoryAutonomyPolicy()).toBeUndefined();
  });
});
