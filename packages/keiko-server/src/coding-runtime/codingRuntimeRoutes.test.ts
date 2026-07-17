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
  handleCodingRuntimeApproval,
  handleCodingRuntimeEvents,
  handleCodingRuntimeFollowUp,
  handleCodingRuntimePause,
  handleCodingRuntimeQuestionAnswer,
  handleCodingRuntimeQuestionList,
  handleCodingRuntimeQuestionReject,
  handleCodingRuntimeRecoveryAcknowledgement,
  handleCodingRuntimeResume,
  handleCodingRuntimeRetry,
  handleCodingRuntimeStatus,
  handleCodingRuntimeStop,
  handleCodingRuntimeTakeover,
  handleCreateCodingRuntimeRun,
  handleCodingRuntimeReadiness,
  handleGetCodingRuntimeRun,
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
    pause: () => Promise.resolve({ ok: true as const, snapshot }),
    resume: () => Promise.resolve({ ok: true as const, snapshot }),
    submitFollowUp: (_runId: string, body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true as const, snapshot });
    },
    answerQuestion: (_runId: string, body: unknown) => {
      calls.push(body);
      return Promise.resolve({ ok: true as const, snapshot });
    },
    rejectQuestion: () => Promise.resolve({ ok: true as const, snapshot }),
    listQuestions: () =>
      Promise.resolve({
        ok: true as const,
        snapshot,
        questions: { schemaVersion: "1" as const, questions: [] },
      }),
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
  it("mounts the inline follow-up, question, and pause/resume operations behind the runtime group", () => {
    const patterns = API_ROUTES.map(({ pattern }) => pattern);
    // #2386: these operations ARE now mounted — behind the same loopback+CSRF+serverPrincipal
    // boundary that already guards the runtime group (POST + JSON + CSRF enforced in server.ts).
    expect(patterns.some((pattern) => pattern.endsWith("/questions"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/questions/answer"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/questions/reject"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/follow-up"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/pause"))).toBe(true);
    expect(patterns.some((pattern) => pattern.endsWith("/resume"))).toBe(true);
  });

  it("declares the productive singleton lifecycle routes and leaves deprecated authority routes unmounted", () => {
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
        "POST /api/coding-workbench/runtime/runs/:runId/pause",
        "POST /api/coding-workbench/runtime/runs/:runId/resume",
        "POST /api/coding-workbench/runtime/runs/:runId/follow-up",
        "POST /api/coding-workbench/runtime/runs/:runId/questions",
        "POST /api/coding-workbench/runtime/runs/:runId/questions/answer",
        "POST /api/coding-workbench/runtime/runs/:runId/questions/reject",
        "GET /api/coding-workbench/runtime/runs/:runId",
      ],
    );
    expect(API_ROUTES.some(({ pattern }) => pattern.includes("autonomous-delivery"))).toBe(false);
    expect(matchRoute("DELETE", "/api/coding-workbench/runtime/runs/run-1")).toBe(
      "method-not-allowed",
    );
    expect(matchRoute("GET", "/api/coding-workbench/runtime/nope")).toBeUndefined();
  });

  it("routes pause, resume, follow-up, and question mutations to the live run only", async () => {
    const handlers = [
      handleCodingRuntimePause,
      handleCodingRuntimeResume,
      handleCodingRuntimeFollowUp,
      handleCodingRuntimeQuestionAnswer,
      handleCodingRuntimeQuestionReject,
      handleCodingRuntimeQuestionList,
    ];
    for (const handler of handlers) {
      await expect(handler(context("{}", { runId: "run-1" }), runtime())).resolves.toMatchObject({
        status: 200,
      });
      await expect(handler(context("{}", { runId: "run-9" }), runtime())).resolves.toMatchObject({
        status: 404,
      });
      await expect(handler(context("{}"), runtime())).resolves.toMatchObject({ status: 404 });
    }
  });

  it("caps a question answer body at 64KB and never echoes its untrusted text", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const tooLarge = await handleCodingRuntimeQuestionAnswer(
      context(JSON.stringify({ padding: oversized }), { runId: "run-1" }),
      runtime(),
    );
    expect(tooLarge).toMatchObject({ status: 413 });
    expect(JSON.stringify(tooLarge.body)).not.toContain("xxxx");

    const deps = runtime();
    const answered = await handleCodingRuntimeQuestionAnswer(
      context(
        JSON.stringify({
          requestId: "req-1",
          expectedRevision: 2,
          questionId: "que_1",
          answers: [["untrusted-answer-text"]],
        }),
        { runId: "run-1" },
      ),
      deps,
    );
    expect(answered).toMatchObject({ status: 200, body: snapshot });
    // The route response projects only the content-free snapshot, never the answer text.
    expect(JSON.stringify(answered.body)).not.toContain("untrusted-answer-text");
  });

  it("projects only server-owned readiness facts and computes the effective mode fail-closed", () => {
    const result = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=autonomous-delivery"),
      runtime({
        // #2475: readiness reports the coding-runtime ceiling — the same knob the mint clamp
        // enforces — never the separate autonomous-delivery ceiling.
        codingRuntimeDeploymentCeiling: "supervised-coding",
        autonomousDeliveryDeploymentCeiling: "autonomous-delivery",
        codingRuntimeHostQualified: true,
        // No live run: the effective mode is the plain ceiling clamp.
        codingRuntimeOrchestrator: undefined,
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

  it("names the precise unavailable reason exactly while the runtime host is unqualified", () => {
    const unavailable = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding"),
      runtime({
        codingRuntimeHostQualified: false,
        codingRuntimeUnavailableReason: "payload-tampered",
        codingRuntimeOrchestrator: undefined,
      }),
    );
    expect(unavailable).toMatchObject({
      status: 200,
      body: { runtimeAvailable: false, runtimeUnavailableReason: "payload-tampered" },
    });

    const fallback = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding"),
      runtime({ codingRuntimeHostQualified: false, codingRuntimeOrchestrator: undefined }),
    );
    expect(fallback).toMatchObject({
      status: 200,
      body: { runtimeAvailable: false, runtimeUnavailableReason: "runtime-unqualified" },
    });

    const available = handleCodingRuntimeReadiness(
      context("", {}, "/api/coding-workbench/runtime/readiness?requestedMode=supervised-coding"),
      runtime({ codingRuntimeHostQualified: true, codingRuntimeOrchestrator: undefined }),
    );
    expect(
      (available.body as { runtimeUnavailableReason?: string }).runtimeUnavailableReason,
    ).toBeUndefined();
  });

  // #2386 regression: the server-confirmed effective mode is anchored to the LIVE run through the
  // mode-change gate. Requesting a wider mode while a supervised run is live must keep confirming
  // the run's own posture; narrowing is confirmed only from the paused (or idle) state.
  it("anchors the confirmed effective mode to the live run through the mode-change gate", () => {
    const liveStatus = (state: "running" | "paused"): unknown => ({
      ...snapshot,
      state,
      requestedMode: "supervised-coding",
    });
    const readiness = (state: "running" | "paused", requestedMode: string): unknown => {
      const result = handleCodingRuntimeReadiness(
        context("", {}, `/api/coding-workbench/runtime/readiness?requestedMode=${requestedMode}`),
        runtime({
          codingRuntimeDeploymentCeiling: "autonomous-delivery",
          codingRuntimeHostQualified: true,
          codingRuntimeOrchestrator: { status: () => liveStatus(state) },
        }),
      );
      return (result.body as { effectiveMode?: string }).effectiveMode;
    };

    // Widening past the live run is never confirmed — not even while paused.
    expect(readiness("paused", "autonomous-delivery")).toBe("supervised-coding");
    expect(readiness("running", "autonomous-delivery")).toBe("supervised-coding");
    // Any change while running is deferred to the run's posture; narrowing is confirmed from paused.
    expect(readiness("running", "governed-assist")).toBe("supervised-coding");
    expect(readiness("paused", "governed-assist")).toBe("governed-assist");
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

  it("rejects an over-budget mutation body with 413 without buffering it", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const result = await handleCreateCodingRuntimeRun(
      context(JSON.stringify({ padding: oversized })),
      runtime(),
    );
    expect(result).toMatchObject({ status: 413 });
    expect(JSON.stringify(result.body)).toContain("PAYLOAD_TOO_LARGE");
    expect(JSON.stringify(result.body)).not.toContain("xxxx");
  });

  it("normalizes an empty mutation body to an empty object for the orchestrator", async () => {
    const deps = runtime();
    const result = await handleCreateCodingRuntimeRun(context(""), deps);
    expect(result).toMatchObject({ status: 200 });
    expect((deps as unknown as { __calls: unknown[] }).__calls).toEqual([{}]);
  });

  it.each([
    ["malformed JSON", "not json"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON scalar", "42"],
  ])("rejects %s mutation bodies as invalid intent", async (_label, body) => {
    const result = await handleCreateCodingRuntimeRun(context(body), runtime());
    expect(result).toMatchObject({ status: 400 });
    expect(JSON.stringify(result.body)).toContain("CODING_RUNTIME_INVALID_INTENT");
  });

  it("serves the singleton status and fails closed without the runtime", () => {
    expect(handleCodingRuntimeStatus(context(""), runtime())).toEqual({
      status: 200,
      body: snapshot,
    });
    expect(
      handleCodingRuntimeStatus(context(""), {
        codingRuntimeOrchestrator: undefined,
      } as unknown as UiHandlerDeps),
    ).toMatchObject({ status: 503 });
  });

  it("serves a run snapshot by id and 404s an unknown run", () => {
    expect(handleGetCodingRuntimeRun(context("", { runId: "run-1" }), runtime())).toEqual({
      status: 200,
      body: snapshot,
    });
    expect(handleGetCodingRuntimeRun(context("", { runId: "run-9" }), runtime())).toMatchObject({
      status: 404,
    });
  });

  it.each([
    ["approval", handleCodingRuntimeApproval],
    ["stop", handleCodingRuntimeStop],
    ["takeover", handleCodingRuntimeTakeover],
    ["retry", handleCodingRuntimeRetry],
    ["recovery acknowledgement", handleCodingRuntimeRecoveryAcknowledgement],
  ] as const)("routes the %s mutation to the live run only", async (_label, handler) => {
    await expect(handler(context("{}", { runId: "run-1" }), runtime())).resolves.toMatchObject({
      status: 200,
      body: snapshot,
    });
    await expect(handler(context("{}"), runtime())).resolves.toMatchObject({ status: 404 });
    await expect(handler(context("{}", { runId: "run-9" }), runtime())).resolves.toMatchObject({
      status: 404,
    });
  });

  it("detaches the SSE subscriber exactly once when the response closes", () => {
    const ctx = context("", { runId: "run-1" });
    let detached = 0;
    const hub = {
      subscribe: () => ({
        ok: true as const,
        detach: () => {
          detached += 1;
        },
      }),
    };
    openCodingRuntimeSse(ctx.res, ctx.req, hub as never, "run-1", undefined);
    const response = ctx.res as unknown as FakeResponse;
    response.destroy();
    response.destroy();
    expect(detached).toBe(1);
    // A destroyed transport is never end()ed again; the guard must not double-finalize it.
    expect(response.writableEnded).toBe(false);
  });
});
