import { describe, expect, it } from "vitest";
import { CancelledError } from "../../src/gateway/errors.js";
import type { NormalizedResponse } from "../../src/gateway/types.js";
import type { Clock } from "../../src/gateway/types.js";
import { createSession, type AgentConfig, type HarnessDeps } from "../../src/harness/session.js";
import { counterIdSource } from "../../src/harness/fingerprint.js";
import type { ModelPort, ToolPort } from "../../src/harness/ports.js";
import { MemoryEventSink } from "../../src/harness/sinks.js";
import type { HarnessEvent, TaskInput } from "../../src/harness/types.js";
import { recordingTool, response, scriptedModel, stubClock } from "./_support.js";

const EXPLAIN: TaskInput = { taskType: "explain-plan", input: { filePath: "src/foo.ts" } };
const CONFIG: AgentConfig = { model: "m", workingDirectory: "/repo" };

function deps(model: ModelPort, sink: MemoryEventSink, tools?: ToolPort): HarnessDeps {
  return {
    model,
    tools: tools ?? recordingTool().port,
    sink,
    clock: stubClock().clock,
    idSource: counterIdSource(),
  };
}

function manualDeadlineClock(): { clock: Clock; expire: () => void } {
  let current = 0;
  let resolveSleep: (() => void) | undefined;
  const clock: Clock = {
    now: () => current,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve, reject) => {
        resolveSleep = (): void => {
          current = 51;
          resolve();
        };
        signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("deadline cleared"));
          },
          {
            once: true,
          },
        );
      }),
  };
  return {
    clock,
    expire: (): void => {
      resolveSleep?.();
    },
  };
}

describe("createSession", () => {
  it("returns a session with a non-empty runId and fingerprint", () => {
    const session = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    expect(session.runId).toBe("run-1");
    expect(session.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a reproducible runId and fingerprint across two runs with identical inputs", () => {
    const a = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    const b = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    expect(a.runId).toBe(b.runId); // counter IdSource: both start at run-1, proving determinism
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes the fingerprint when a limit changes", () => {
    const base = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    const tweaked = createSession(
      EXPLAIN,
      { ...CONFIG, limits: { maxIterations: 99 } },
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    expect(tweaked.fingerprint).not.toBe(base.fingerprint);
  });

  it("changes the fingerprint when replay-relevant config changes", () => {
    const base = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    const otherWorkspace = createSession(
      EXPLAIN,
      { ...CONFIG, workingDirectory: "/other-repo" },
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    const applyIntent = createSession(
      EXPLAIN,
      { ...CONFIG, dryRun: false },
      deps(scriptedModel([response()]).port, new MemoryEventSink()),
    );
    expect(otherWorkspace.fingerprint).not.toBe(base.fingerprint);
    expect(applyIntent.fingerprint).not.toBe(base.fingerprint);
  });

  it("resolves result to a completed RunResult on the happy path", async () => {
    const sink = new MemoryEventSink();
    const session = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response({ content: "ok" })]).port, sink),
    );
    const result = await session.result;
    expect(result.outcome).toBe("completed");
    expect(result.report).toBe("ok");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]?.type).toBe("run:started");
  });

  it("treats a cancel before the run advances as a cancelled outcome with no model call", async () => {
    let called = 0;
    const model: ModelPort = {
      call: (): Promise<NormalizedResponse> => {
        called += 1;
        return Promise.resolve(response());
      },
    };
    const session = createSession(EXPLAIN, CONFIG, deps(model, new MemoryEventSink()));
    session.cancel();
    const result = await session.result;
    expect(result.outcome).toBe("cancelled");
    expect(called).toBe(0);
  });

  it("propagates the cancel reason to the run:cancelled event", async () => {
    const sink = new MemoryEventSink();
    const session = createSession(EXPLAIN, CONFIG, deps(scriptedModel([response()]).port, sink));
    session.cancel("user pressed ctrl-c");
    const result = await session.result;
    const cancelled = result.events.find((e: HarnessEvent) => e.type === "run:cancelled");
    expect(cancelled?.type).toBe("run:cancelled");
    if (cancelled?.type === "run:cancelled") {
      expect(cancelled.reason).toBe("user pressed ctrl-c");
      expect(cancelled.atState).toBe("planning");
    }
  });

  it("every event in a completed run has schemaVersion '1'", async () => {
    const sink = new MemoryEventSink();
    const session = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response({ content: "ok" })]).port, sink),
    );
    const result = await session.result;
    expect(result.outcome).toBe("completed");
    for (const event of result.events) {
      expect(event.schemaVersion).toBe("1");
    }
  });

  it("does not call the model again after cancel during an in-flight model call", async () => {
    let resolveCall: ((value: NormalizedResponse) => void) | undefined;
    let calls = 0;
    const model: ModelPort = {
      call: (): Promise<NormalizedResponse> => {
        calls += 1;
        return new Promise<NormalizedResponse>((resolve) => {
          resolveCall = resolve;
        });
      },
    };
    const session = createSession(EXPLAIN, CONFIG, deps(model, new MemoryEventSink()));
    // Yield microtasks until the loop has entered the (never-resolving) model call.
    for (let i = 0; i < 20 && calls === 0; i += 1) {
      await Promise.resolve();
    }
    expect(calls).toBe(1);
    session.cancel("mid-flight");
    resolveCall?.(response());
    const result = await session.result;
    expect(result.outcome).toBe("cancelled");
    expect(calls).toBe(1);
    expect(result.patchDiff).toBeUndefined();
  });

  it("classifies a signal-aware in-flight model cancellation as cancelled", async () => {
    let calls = 0;
    const model: ModelPort = {
      call: (_request, signal): Promise<NormalizedResponse> => {
        calls += 1;
        return new Promise<NormalizedResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new CancelledError("aborted by signal"));
            },
            { once: true },
          );
        });
      },
    };
    const session = createSession(EXPLAIN, CONFIG, deps(model, new MemoryEventSink()));
    for (let i = 0; i < 20 && calls === 0; i += 1) {
      await Promise.resolve();
    }
    session.cancel("mid-flight");
    const result = await session.result;
    expect(result.outcome).toBe("cancelled");
    expect(result.failure).toBeUndefined();
  });

  it("turns an in-flight wall-time deadline into HARNESS_LIMIT_WALL_TIME", async () => {
    const deadline = manualDeadlineClock();
    const sink = new MemoryEventSink();
    const model: ModelPort = {
      call: (_request, signal): Promise<NormalizedResponse> =>
        new Promise<NormalizedResponse>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new CancelledError("deadline exceeded"));
            },
            { once: true },
          );
          deadline.expire();
        }),
    };
    const session = createSession(
      EXPLAIN,
      { ...CONFIG, limits: { maxWallTimeMs: 50 } },
      {
        ...deps(model, sink),
        clock: deadline.clock,
      },
    );
    const result = await session.result;
    expect(result.outcome).toBe("limit-exceeded");
    expect(result.failure?.category).toBe("HARNESS_LIMIT_WALL_TIME");
  });
});
