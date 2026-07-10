// Issue #2211 — /api/editor/verification/* route tests. A FakeVerificationRunnerManager replaces the
// real manager so these tests never spawn. SSE framing + backpressure are tested against a fake
// ServerResponse, mirroring command-runner-routes.test.ts's openCommandSseStream pattern.

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  EDITOR_VERIFICATION_SCHEMA_VERSION,
  type EditorVerificationCatalog,
  type EditorVerificationEvent,
  type EditorVerificationRun,
} from "@oscharko-dev/keiko-contracts";
import type { RouteContext } from "../routes.js";
import type { SseBackpressureSignal } from "../sse-write.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  handleCreateVerificationRun,
  handleDeleteVerificationRun,
  handleVerificationCatalog,
  openVerificationSseStream,
} from "./verificationRoutes.js";
import type {
  VerificationRunInput,
  VerificationRunnerEventEmitter,
  VerificationRunnerManager,
} from "./verificationRunner.js";

class FakeManager implements VerificationRunnerManager {
  public readonly executed: VerificationRunInput[] = [];
  public abortReturns = true;
  private readonly subscribers = new Set<VerificationRunnerEventEmitter>();

  public readonly discover = (projectId: string): EditorVerificationCatalog => ({
    schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
    projectId,
    kinds: [{ kind: "typecheck", available: true, trustState: "approval-required" }],
  });

  public readonly execute = (
    input: VerificationRunInput,
  ): { runId: string; run: EditorVerificationRun } => {
    this.executed.push(input);
    const run: EditorVerificationRun = {
      runId: "run-1",
      kinds: [...input.kinds],
      state: "running",
      startedAtMs: 1,
    };
    return { runId: run.runId, run };
  };

  public readonly runToReport = (): Promise<never> => {
    throw new Error("runToReport is not exercised by the human-facing route tests.");
  };

  public readonly abort = (): boolean => this.abortReturns;
  public readonly inFlightCount = (): number => 0;
  public readonly subscribe = (listener: VerificationRunnerEventEmitter): (() => void) => {
    this.subscribers.add(listener);
    return (): void => {
      this.subscribers.delete(listener);
    };
  };

  public emitExternal(event: EditorVerificationEvent): void {
    for (const listener of [...this.subscribers]) listener(event);
  }
}

function deps(manager?: VerificationRunnerManager): UiHandlerDeps {
  return {
    verificationRunner: manager,
    redactor: (value: string): string => value,
  } as UiHandlerDeps;
}

function fakeReq(body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  queueMicrotask(() => {
    if (body !== undefined) req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

function ctx(over: { url?: string; body?: string; runId?: string }): RouteContext {
  return {
    req: fakeReq(over.body),
    res: undefined,
    params: over.runId === undefined ? {} : { runId: over.runId },
    url: new URL(over.url ?? "http://127.0.0.1:1983/api/editor/verification/catalog"),
  } as unknown as RouteContext;
}

interface FakeSseRes {
  res: ServerResponse;
  readonly writes: string[];
  destroyCount: number;
  writeReturns: boolean;
}

function makeFakeSseRes(): FakeSseRes {
  const writes: string[] = [];
  const emitter = new EventEmitter();
  const state: FakeSseRes = {
    res: undefined as unknown as ServerResponse,
    writes,
    destroyCount: 0,
    writeReturns: true,
  };
  const res = {
    writeHead: (): ServerResponse => res as unknown as ServerResponse,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return state.writeReturns;
    },
    end: (): ServerResponse => res as unknown as ServerResponse,
    destroy: (): void => {
      state.destroyCount += 1;
    },
    on: (event: string, listener: (...args: unknown[]) => void): ServerResponse => {
      emitter.on(event, listener);
      return res as unknown as ServerResponse;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

describe("verification catalog route (AC2)", () => {
  it("503s with a typed error when the runner dep is undefined", async () => {
    const result = await handleVerificationCatalog(
      ctx({ url: "http://127.0.0.1:1983/api/editor/verification/catalog?projectId=/ws" }),
      deps(undefined),
    );
    expect(result.status).toBe(503);
  });

  it("400s when projectId is missing", async () => {
    const result = await handleVerificationCatalog(ctx({}), deps(new FakeManager()));
    expect(result.status).toBe(400);
  });

  it("returns the detected catalog projection when the runner is present", async () => {
    const result = await handleVerificationCatalog(
      ctx({ url: "http://127.0.0.1:1983/api/editor/verification/catalog?projectId=/ws" }),
      deps(new FakeManager()),
    );
    expect(result.status).toBe(200);
    expect((result.body as EditorVerificationCatalog).projectId).toBe("/ws");
  });
});

describe("verification run + cancel routes", () => {
  it("starts a run and returns the EditorVerificationRun", async () => {
    const manager = new FakeManager();
    const result = await handleCreateVerificationRun(
      ctx({ body: JSON.stringify({ projectId: "/ws", kinds: ["typecheck"] }) }),
      deps(manager),
    );
    expect(result.status).toBe(200);
    expect((result.body as EditorVerificationRun).runId).toBe("run-1");
    expect(manager.executed[0]?.projectId).toBe("/ws");
  });

  it("400s a run request missing projectId", async () => {
    const result = await handleCreateVerificationRun(
      ctx({ body: JSON.stringify({ kinds: ["typecheck"] }) }),
      deps(new FakeManager()),
    );
    expect(result.status).toBe(400);
  });

  it("404s a cancel for an unknown run id", () => {
    const manager = new FakeManager();
    manager.abortReturns = false;
    const result = handleDeleteVerificationRun(ctx({ runId: "nope" }), deps(manager));
    expect(result.status).toBe(404);
  });
});

describe("openVerificationSseStream (AC6)", () => {
  it("writes a ready frame first and frames events as verification:<kind>", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeManager();
    openVerificationSseStream(fake.res, manager, (value) => value);
    expect(fake.writes[0]).toContain("event: ready");
    manager.emitExternal({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-cancelled",
      runId: "r",
    });
    expect(fake.writes.some((frame) => frame.includes("event: verification:run-cancelled"))).toBe(
      true,
    );
  });

  it("destroys the socket exactly once on backpressure (res.write returns false)", () => {
    const fake = makeFakeSseRes();
    const manager = new FakeManager();
    const signals: SseBackpressureSignal[] = [];
    fake.writeReturns = false;
    openVerificationSseStream(
      fake.res,
      manager,
      (value) => value,
      (signal) => {
        signals.push(signal);
      },
    );
    manager.emitExternal({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-cancelled",
      runId: "r",
    });
    expect(fake.destroyCount).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.accepted).toBe(false);
    // A second event produces no further work (the abort unsubscribed).
    const writesAfter = fake.writes.length;
    manager.emitExternal({
      schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
      kind: "run-failed",
      runId: "r",
      reason: "x",
    });
    expect(fake.writes.length).toBe(writesAfter);
  });
});
