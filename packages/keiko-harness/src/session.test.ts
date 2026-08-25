import { describe, expect, it } from "vitest";
import {
  CancelledError,
  type Clock,
  type NormalizedResponse,
} from "@oscharko-dev/keiko-model-gateway";
import { createSession, type AgentConfig, type HarnessDeps } from "./session.js";
import { counterIdSource } from "./fingerprint.js";
import type { EventSink, ModelPort, ToolPort } from "./ports.js";
import { MemoryEventSink } from "./sinks.js";
import type { HarnessEvent, TaskInput } from "./types.js";
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

  it("keeps a handler's recorded failure when the deadline timer fires right after it", async () => {
    // The real-clock deadline timer writes the same failure slot as the loop guard, so it carries
    // the same misattribution risk: once a handler has recorded WHY the run stopped, the timer
    // must not relabel it as budget exhaustion (KEIKO-0098).
    const { AuthenticationError } = await import("@oscharko-dev/keiko-model-gateway");
    const deadline = manualDeadlineClock();
    const events: HarnessEvent[] = [];
    // Expiring the deadline the moment model:call:failed is emitted schedules the timer body to
    // run after onModelError has synchronously recorded HARNESS_MODEL_ERROR — the exact interleave
    // the finding describes, without relying on wall-clock timing.
    const trigger: EventSink = {
      emit: (event): void => {
        events.push(event);
        if (event.type === "model:call:failed") deadline.expire();
      },
    };
    const model: ModelPort = {
      call: (): Promise<NormalizedResponse> =>
        Promise.reject(new AuthenticationError("provider returned 400 invalid request")),
    };
    const session = createSession(
      EXPLAIN,
      { ...CONFIG, limits: { maxWallTimeMs: 50 } },
      { ...deps(model, new MemoryEventSink()), sink: trigger, clock: deadline.clock },
    );
    const result = await session.result;
    expect(result.outcome).toBe("failed");
    expect(result.failure?.category).toBe("HARNESS_MODEL_ERROR");
  });

  it(
    "never attaches a failure record to a completed RunResult even when the wall-time " +
      "deadline callback is already in flight when the run finishes (KEIKO-0774)",
    async () => {
      // Expire the deadline synchronously from inside the run:completed emit — i.e. from within
      // runLoop's own synchronous execution, strictly before runLoop's promise (and therefore
      // `settled`/`cleared`) can possibly have flipped. This deterministically reproduces the race:
      // the deadline callback's job is enqueued before either guard is set, so on unfixed code it
      // still writes ctx.failure for a run that outcome-wise completed successfully. The invariant
      // this pins is enforced at buildResult (via terminalFailure), not by preventing that write.
      const deadline = manualDeadlineClock();
      const trigger: EventSink = {
        emit: (event): void => {
          if (event.type === "run:completed") deadline.expire();
        },
      };
      const session = createSession(
        EXPLAIN,
        { ...CONFIG, limits: { maxWallTimeMs: 50 } },
        {
          ...deps(scriptedModel([response({ content: "ok" })]).port, new MemoryEventSink()),
          sink: trigger,
          clock: deadline.clock,
        },
      );
      const result = await session.result;
      expect(result.outcome).toBe("completed");
      expect(result.failure).toBeUndefined();
    },
  );

  it("cancel() after the run has settled is a silent no-op", async () => {
    const session = createSession(
      EXPLAIN,
      CONFIG,
      deps(scriptedModel([response({ content: "ok" })]).port, new MemoryEventSink()),
    );
    const result = await session.result;
    expect(() => {
      session.cancel("too late");
    }).not.toThrow();
    expect(result.outcome).toBe("completed");
    expect(result.failure).toBeUndefined();
  });

  it("reaches a terminal state when an auxiliary sink throws (KEIKO-0205)", async () => {
    // A downstream sink throws on emit; the run must still resolve to a RunResult and
    // the primary (in-memory) sink must still receive every subsequent event. Today
    // this rejects because Emitter.emit lets the sink throw escape the fan-out.
    let throwCount = 0;
    const throwingSink: EventSink = {
      emit: (): void => {
        throwCount += 1;
        throw new Error("sink is broken");
      },
    };
    const session = createSession(EXPLAIN, CONFIG, {
      ...deps(scriptedModel([response({ content: "ok" })]).port, new MemoryEventSink()),
      sink: throwingSink,
    });
    const result = await session.result;
    expect(result.outcome).toBe("completed");
    expect(result.events.length).toBeGreaterThan(0);
    // The throwing sink is quarantined after its first failure, so only one throw is
    // observed even though the run emits many events.
    expect(throwCount).toBe(1);
  });
});
