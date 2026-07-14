/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "../deps.js";
import { API_ROUTES, STREAMING, matchRoute, type RouteContext } from "../routes.js";
import {
  CODING_RUNTIME_ROUTE_GROUP,
  handleCodingRuntimeEvents,
  handleCreateCodingRuntimeRun,
  handleCodingRuntimeReadiness,
  openCodingRuntimeSse,
} from "./codingRuntimeRoutes.js";

const snapshot: CodingWorkbenchRuntimeSnapshot = {
  schemaVersion: "1",
  state: "ready",
  revision: 2,
  updatedAt: "2026-07-13T00:00:00.000Z",
  runId: "run-1",
  requestedMode: "governed-assist",
  runtimeSource: "keiko-sidecar",
  modelSource: "keiko-model-gateway",
};

function context(
  body = "{}",
  params: Record<string, string> = {},
  path = "/api/coding-workbench/runtime/runs",
): RouteContext {
  const req = new PassThrough() as unknown as RouteContext["req"];
  req.headers = {};
  queueMicrotask(() => (req as unknown as PassThrough).end(body));
  return {
    req,
    res: new FakeResponse() as unknown as RouteContext["res"],
    params,
    url: new URL(`http://localhost${path}`),
  };
}

class FakeResponse extends EventEmitter {
  public readonly chunks: string[] = [];
  public writableEnded = false;
  public destroyed = false;
  public writeHead(): this {
    return this;
  }
  public write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  public end(): this {
    this.writableEnded = true;
    return this;
  }
  public destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function runtime(overrides: Partial<Record<string, unknown>> = {}): UiHandlerDeps {
  const calls: unknown[] = [];
  const orchestrator = {
    start: (body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true as const, snapshot });
    },
    retry: () => Promise.resolve({ ok: true as const, snapshot }),
    decideApproval: () => Promise.resolve({ ok: true as const, snapshot }),
    stop: () => Promise.resolve({ ok: true as const, snapshot }),
    takeover: () => Promise.resolve({ ok: true as const, snapshot }),
    acknowledgeRecovery: () => Promise.resolve({ ok: true as const, snapshot }),
    status: () => snapshot,
    getSnapshot: (runId: string) => (runId === "run-1" ? snapshot : undefined),
  };
  const eventHub = {
    subscribe: (
      _runId: string,
      _cursor: string | undefined,
      subscriber: { write: (event: CodingWorkbenchRuntimeSseEvent) => boolean },
    ) => {
      subscriber.write({
        schemaVersion: "1",
        cursor: "run-1:0",
        sequence: 0,
        occurredAt: snapshot.updatedAt,
        kind: "status",
        runId: "run-1",
        state: "ready",
        revision: 2,
      });
      return { ok: true as const, detach: () => undefined };
    },
  };
  return {
    codingRuntimeOrchestrator: orchestrator,
    codingRuntimeEventHub: eventHub,
    __calls: calls,
    ...overrides,
  } as unknown as UiHandlerDeps;
}

describe("coding runtime routes", () => {
  it("does not mount content-bearing follow-up or question operations", () => {
    const patterns = API_ROUTES.map(({ pattern }) => pattern);
    expect(patterns.some((pattern) => pattern.includes("/questions"))).toBe(false);
    expect(patterns.some((pattern) => pattern.includes("/follow-up"))).toBe(false);
  });

  it("declares only the productive singleton lifecycle routes and leaves deprecated authority routes unmounted", () => {
    expect(CODING_RUNTIME_ROUTE_GROUP.map(({ method, pattern }) => `${method} ${pattern}`)).toEqual(
      [
        "POST /api/coding-workbench/runtime/runs",
        "GET /api/coding-workbench/runtime/readiness",
        "GET /api/coding-workbench/runtime/status",
        "GET /api/coding-workbench/runtime/runs/:runId/events",
        "POST /api/coding-workbench/runtime/runs/:runId/approvals",
        "POST /api/coding-workbench/runtime/runs/:runId/stop",
        "POST /api/coding-workbench/runtime/runs/:runId/takeover",
        "POST /api/coding-workbench/runtime/runs/:runId/retry",
        "POST /api/coding-workbench/runtime/runs/:runId/recovery-ack",
        "GET /api/coding-workbench/runtime/runs/:runId",
      ],
    );
    expect(API_ROUTES.some(({ pattern }) => pattern.includes("autonomous-delivery"))).toBe(false);
    expect(matchRoute("DELETE", "/api/coding-workbench/runtime/runs/run-1")).toBe(
      "method-not-allowed",
    );
    expect(matchRoute("GET", "/api/coding-workbench/runtime/nope")).toBeUndefined();
  });

  it("projects only server-owned readiness facts and computes the effective mode fail-closed", () => {
    const result = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery"),
      runtime({
        autonomousDeliveryDeploymentCeiling: "supervised-coding",
        codingRuntimeHostQualified: true,
      }),
    );

    expect(result).toEqual({
      status: 200,
      body: {
        schemaVersion: "1",
        requestedMode: "autonomous-delivery",
        deploymentCeiling: "supervised-coding",
        effectiveMode: "supervised-coding",
        runtimeAvailable: true,
      },
    });
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ["workspace", "authority", "endpoint", "credential", "path"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps readiness independently available when the runtime is absent and rejects malformed modes", () => {
    const unavailable = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist"),
      runtime({ codingRuntimeOrchestrator: undefined, codingRuntimeEventHub: undefined }),
    );
    expect(unavailable).toMatchObject({
      status: 200,
      body: {
        requestedMode: "governed-assist",
        deploymentCeiling: "governed-assist",
        effectiveMode: "governed-assist",
        runtimeAvailable: false,
      },
    });

    for (const path of [
      "/api/coding-workbench/runtime/readiness",
      "/api/coding-workbench/runtime/readiness?requestedMode=nope",
      "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist&extra=forged",
      "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist&requestedMode=supervised-coding",
    ]) {
      expect(handleCodingRuntimeReadiness(context("", {}, path), runtime())).toMatchObject({
        status: 400,
        body: { error: { code: "CODING_RUNTIME_INVALID_INTENT" } },
      });
    }
  });

  it("reports the runtime unavailable when lifecycle collaborators exist without a qualified host", () => {
    const result = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist"),
      runtime(),
    );

    expect(result).toMatchObject({
      status: 200,
      body: { runtimeAvailable: false },
    });
  });

  it("parses a bounded JSON body and passes it only to the orchestrator", async () => {
    const deps = runtime();
    const result = await handleCreateCodingRuntimeRun(
      context('{"requestId":"r","taskIntent":"private","requestedMode":"governed-assist"}'),
      deps,
    );
    expect(result).toMatchObject({ status: 200, body: { runId: "run-1" } });
    expect((deps as unknown as { __calls: unknown[] }).__calls).toEqual([
      { requestId: "r", taskIntent: "private", requestedMode: "governed-assist" },
    ]);
    expect(JSON.stringify(result.body)).not.toContain("private");
  });

  it("fails closed when runtime dependencies are absent and returns 404 for a stale run", async () => {
    await expect(
      handleCreateCodingRuntimeRun(context(), {} as UiHandlerDeps),
    ).resolves.toMatchObject({ status: 503 });
    const stopRoute = CODING_RUNTIME_ROUTE_GROUP.find(({ pattern }) => pattern.endsWith("/stop"));
    if (!stopRoute) throw new Error("missing stop route");
    const stale = await stopRoute.handler(
      context('{"requestId":"gone"}', { runId: "gone" }),
      runtime(),
    );
    expect(stale).toMatchObject({ status: 404 });
  });

  it("replays SSE events with Last-Event-ID and sends a bounded reset on cursor failure", () => {
    const response = new FakeResponse();
    const req = new EventEmitter() as unknown as RouteContext["req"];
    const hub = {
      subscribe: (_runId: string, cursor: string | undefined) =>
        cursor === "bad"
          ? {
              ok: false as const,
              reason: "cursor-malformed" as const,
              snapshotNeeded: true as const,
            }
          : { ok: true as const, detach: () => undefined },
    };
    openCodingRuntimeSse(
      response as unknown as RouteContext["res"],
      req,
      hub as never,
      "run-1",
      "bad",
    );
    expect(response.chunks.join("")).toContain("event: reset");
    expect(response.chunks.join("")).toContain("cursor-malformed");
    expect(response.writableEnded).toBe(true);
  });

  it("destroys a slow SSE connection when the transport applies backpressure", () => {
    const response = new FakeResponse();
    response.write = (): boolean => false;
    const req = new EventEmitter() as unknown as RouteContext["req"];
    const hub = {
      subscribe: (
        _runId: string,
        _cursor: string | undefined,
        subscriber: {
          write: (event: CodingWorkbenchRuntimeSseEvent) => boolean;
        },
      ) => {
        subscriber.write({
          schemaVersion: "1",
          cursor: "run-1:0",
          sequence: 0,
          occurredAt: snapshot.updatedAt,
          kind: "status",
          runId: "run-1",
          state: "ready",
          revision: 2,
        });
        return { ok: true as const, detach: () => undefined };
      },
    };
    openCodingRuntimeSse(
      response as unknown as RouteContext["res"],
      req,
      hub as never,
      "run-1",
      undefined,
    );
    expect(response.destroyed).toBe(true);
  });

  it("opens the event handler as streaming and includes replay data", () => {
    const ctx = context("", { runId: "run-1" });
    ctx.req.headers["last-event-id"] = "run-1:0";
    expect(handleCodingRuntimeEvents(ctx, runtime())).toBe(STREAMING);
    expect((ctx.res as unknown as FakeResponse).chunks.join("")).toContain('"cursor":"run-1:0"');
  });
});
