// Tests for the package's activity-log seam. Four properties are load-bearing:
//
//   * the default sink is inert — an unwired caller must never pay for, or fail because of,
//     instrumentation;
//   * `memoryVaultErrorKind` classifies WITHOUT reading `message`, which is where a thrown error
//     routinely carries a path or a fragment of the value that failed, and without letting a
//     hostile property ACCESSOR throw out of the classification;
//   * a failing sink neither surfaces to the operation being logged nor disappears silently;
//   * the timer is monotonic and never reports a negative duration.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as vaultLog from "./vault-log.js";
import {
  activityLogLossCounters,
  activityLogEventWillBeRejected,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  emitMemoryVaultLogEvent,
  memoryVaultErrorKind,
  nullMemoryVaultLogSink,
  startMemoryVaultLogTimer,
  type MemoryVaultLogTransport,
  type MemoryVaultLogEvent,
  type MemoryVaultLogSink,
} from "./vault-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

// The specs below replace platform functions — `performance.now`, `process.emitWarning`. A spy
// restored on the last line of its own test is only restored when that test PASSES: an assertion
// that throws first leaves the platform patched for every later test in this worker, turning one
// red into a cascade that hides its own cause. Neither vitest config in this repository sets
// `restoreMocks`, so the hook is what guarantees it.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("nullMemoryVaultLogSink", () => {
  it("accepts an event without throwing and returns a shared instance", () => {
    const sink = nullMemoryVaultLogSink();
    expect(() => {
      sink.write({ category: "memory", op: "memory-vault.store.opened" });
    }).not.toThrow();
    expect(nullMemoryVaultLogSink()).toBe(sink);
  });
});

describe("memoryVaultErrorKind", () => {
  it("prefers a coded `code` over the constructor name", () => {
    const error = Object.assign(new TypeError("boom"), { code: "SQLITE_CORRUPT" });
    expect(memoryVaultErrorKind(error)).toBe("SQLITE_CORRUPT");
  });

  it("falls back to the constructor name when there is no code", () => {
    expect(memoryVaultErrorKind(new RangeError("boom"))).toBe("RangeError");
  });

  it("reports `unknown` for a primitive throw and for an empty-string code", () => {
    expect(memoryVaultErrorKind("a raw string throw")).toBe("unknown");
    expect(memoryVaultErrorKind(undefined)).toBe("unknown");
    expect(memoryVaultErrorKind(null)).toBe("unknown");
    expect(memoryVaultErrorKind({ code: "", name: "" })).toBe("unknown");
  });

  // `errorKind`/`extra.reasonKind` are ENVELOPE fields written before `extra` redaction runs, so a
  // provider- or OS-controlled `code`/`name` that carries a sentence must never pass through.
  it("refuses a `code` that is a sentence rather than a taxonomy code", () => {
    const echoed = Object.assign(new Error("boom"), {
      code: "permission denied for /Users/someone/memory/vault.db",
      name: "AccessError",
    });
    const kind = memoryVaultErrorKind(echoed);
    expect(kind).toBe("AccessError");
    expect(kind).not.toContain("/Users");
    expect(kind).not.toContain(" ");
  });

  it("degrades to the next candidate when a property accessor throws", () => {
    const hostile = { name: "TransportError" };
    Object.defineProperty(hostile, "code", {
      get(): string {
        throw new Error("accessor refused");
      },
      enumerable: true,
    });
    expect(() => memoryVaultErrorKind(hostile)).not.toThrow();
    expect(memoryVaultErrorKind(hostile)).toBe("TransportError");
  });

  it("never reads `message` — the field that carries content", () => {
    const readFields: string[] = [];
    const probe = new Proxy(
      { code: undefined, name: "ProbeError", message: "/Users/someone/secret-memory" },
      {
        get(target, property, receiver): unknown {
          readFields.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(memoryVaultErrorKind(probe)).toBe("ProbeError");
    expect(readFields).not.toContain("message");
  });
});

describe("emitMemoryVaultLogEvent", () => {
  const failure = (): Error => Object.assign(new Error("no space left"), { code: "ENOSPC" });

  function recordingSinkThatFailsOn(failingOps: readonly string[]): {
    sink: MemoryVaultLogSink;
    events: MemoryVaultLogTransport[];
  } {
    const events: MemoryVaultLogTransport[] = [];
    return {
      sink: {
        write: (event): void => {
          if (failingOps.includes(event.op)) throw failure();
          events.push(event);
        },
      },
      events,
    };
  }

  it("does nothing at all when no sink is wired", () => {
    expect(() => {
      emitMemoryVaultLogEvent(undefined, { category: "memory", op: "memory-vault.store.opened" });
    }).not.toThrow();
  });

  // The rule callers depend on: `openMemoryDatabase` logs from inside a corruption-recovery path,
  // and `encryptExistingContent` logs after a migration that already committed. A write that threw
  // there would replace a diagnosable outcome with a logging failure.
  it("never lets a sink failure surface to the operation being logged", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: MemoryVaultLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    expect(() => {
      emitMemoryVaultLogEvent(dead, { category: "memory", op: "memory-vault.store.opened" });
    }).not.toThrow();
  });

  it("reports a failing sink once, through the sink itself, as an envelope-only notice", () => {
    const { sink, events } = recordingSinkThatFailsOn(["memory-vault.store.opened"]);

    emitMemoryVaultLogEvent(sink, {
      category: "memory",
      op: "memory-vault.store.opened",
      errorKind: "Error",
      extra: { keySource: "keychain" },
    });
    emitMemoryVaultLogEvent(sink, { category: "memory", op: "memory-vault.store.opened" });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      level: "error",
      category: "diagnostic",
      op: "memory-vault.log.sink-failed",
      errorKind: "unavailable",
      extra: {
        completeness: "complete",
        droppedOpDigest: "3b9d5ea9d495ed7f",
        failureKind: "ENOSPC",
        loss: "none",
      },
    });
    const persisted = expectActivityLogProof(
      "memory-vault.log.sink-failed.body-free",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      droppedOpDigest: "3b9d5ea9d495ed7f",
      failureKind: "ENOSPC",
    });
  });

  it("keeps writing subsequent lines a recovered sink can take", () => {
    const { sink, events } = recordingSinkThatFailsOn(["memory-vault.store.opened"]);

    emitMemoryVaultLogEvent(sink, { category: "memory", op: "memory-vault.store.opened" });
    emitMemoryVaultLogEvent(sink, {
      category: "memory",
      op: "memory-vault.store.encryption-migrated",
    });

    expect(events.map((event) => event.op)).toEqual([
      "memory-vault.log.sink-failed",
      "memory-vault.store.encryption-migrated",
    ]);
  });

  // A sink that refuses the notice too is a dead transport, not a rejected shape. The report then
  // leaves by the one channel that is not the broken one.
  it("falls back to one process warning per sink when the transport itself is down", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: MemoryVaultLogSink = {
      write: (): never => {
        throw failure();
      },
    };

    emitMemoryVaultLogEvent(dead, { category: "memory", op: "memory-vault.store.opened" });
    emitMemoryVaultLogEvent(dead, {
      category: "memory",
      op: "memory-vault.store.encryption-migrated",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const calls: readonly (readonly unknown[])[] = warn.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      code: "KEIKO_LOG_SINK_FAILED",
      detail: "opDigest=3b9d5ea9d495ed7f errorKind=ENOSPC",
    });

    // Per sink, not per process: a replaced sink that also fails is a new fact about the log.
    const replacement: MemoryVaultLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    emitMemoryVaultLogEvent(replacement, {
      category: "memory",
      op: "memory-vault.store.encryption-migrated",
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("carries no body into the fallback report", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const secret = ["memory", "body", "value"].join("-");
    const dead: MemoryVaultLogSink = {
      write: (): never => {
        throw new Error(`writing failed for ${secret}`);
      },
    };

    // `secret` is embedded in the SINK's own thrown message, not in `event.extra` — this event's
    // `extra` is intentionally omitted, since `MemoryVaultLogExtra`'s closed schema (Finding:
    // Thread 8) has no field that could hold arbitrary free text like `secret` in the first
    // place. The proof this test carries is that `memoryVaultErrorKind` never reads `.message`
    // (see the `memoryVaultErrorKind` suite above), so a secret embedded in a thrown error's
    // message can never reach the fallback warning either.
    emitMemoryVaultLogEvent(dead, {
      category: "memory",
      op: "memory-vault.store.opened",
    });

    const reported = JSON.stringify(warn.mock.calls);
    expect(reported).not.toContain(secret);
    expect(reported).toContain("errorKind=Error");
  });
});

describe("startMemoryVaultLogTimer", () => {
  it("reports a non-negative elapsed duration rounded to three decimals", () => {
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1042.98765);
    const elapsed = startMemoryVaultLogTimer();
    expect(elapsed()).toBe(42.988);
  });

  it("is driven by performance.now, so a backwards wall clock cannot go negative", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const elapsed = startMemoryVaultLogTimer();
    expect(elapsed()).toBeGreaterThanOrEqual(0);
  });
});

describe("MemoryVaultLogEvent", () => {
  it("carries only the envelope a redacting sink expects", () => {
    const event: MemoryVaultLogEvent = {
      level: "warn",
      category: "memory",
      op: "memory-vault.store.opened",
      errorKind: "SQLITE_CORRUPT",
      status: 500,
      durationMs: 12.5,
      extra: { keySource: "keychain" },
    };
    expect(Object.keys(event).sort()).toEqual([
      "category",
      "durationMs",
      "errorKind",
      "extra",
      "level",
      "op",
      "status",
    ]);
  });

  // Finding: Thread 8. Before this fix `op: string` and `extra?: Readonly<Record<string,
  // unknown>>` accepted anything, so a memory body or filesystem path could reach this event with
  // no compile-time signal. RED (before fix): both `@ts-expect-error` directives below were
  // themselves compile errors ("Unused '@ts-expect-error' directive") under `npm run typecheck`,
  // because the old, open shape happily accepted an arbitrary `op` string and an arbitrary
  // `extra` key — there was nothing to suppress.
  it("rejects an arbitrary op and an arbitrary extra field at compile time", () => {
    // @ts-expect-error — `op` is now a closed `MemoryVaultLogOp` union; a caller-chosen string is
    // no longer assignable.
    const badOp: MemoryVaultLogEvent = { category: "memory", op: "arbitrary.caller.chosen.op" };
    const badExtra: MemoryVaultLogEvent = {
      category: "memory",
      op: "memory-vault.store.opened",
      // @ts-expect-error — `extra` is now a closed, body-free `MemoryVaultLogExtra` schema; an
      // unlisted key (here shaped like a leaked filesystem path) is no longer assignable.
      extra: { path: "/Users/someone/memory/vault.db" },
    };
    expect(badOp.category).toBe("memory");
    expect(badExtra.category).toBe("memory");
  });
});

// #3532: the process warning is once per sink, but the process loss ledger counts every line a
// failing sink loses, so a quiet log can be told apart from a log that stopped working.
describe("emitMemoryVaultLogEvent loss accounting", () => {
  it("counts every line a dead sink loses in the process loss ledger", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    resetActivityLogLossCountersForTests();
    const dead: MemoryVaultLogSink = {
      write: (): never => {
        throw new Error("sink is down");
      },
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        emitMemoryVaultLogEvent(dead, { category: "memory", op: "memory-vault.store.opened" });
      }
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(3);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });

  it("counts an event handed to an unwired port as lost", () => {
    resetActivityLogLossCountersForTests();
    try {
      emitMemoryVaultLogEvent(undefined, { category: "memory", op: "memory-vault.store.opened" });
      expect(activityLogLossCounters()["port-unwired"]).toBe(1);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
});

describe("initial write refusal log producer", () => {
  it("preserves known and parent ids and supplies the canonical unknown fallback", () => {
    expect(vaultLog).toHaveProperty("emitMemoryWriteRejected");
    const events: MemoryVaultLogTransport[] = [];
    const sink = {
      write: (event: MemoryVaultLogTransport): void => {
        events.push(event);
      },
    };
    vaultLog.emitMemoryWriteRejected(sink, "insert", {
      correlationId: "request-one",
      parentCorrelationId: "parent-request",
    });
    vaultLog.emitMemoryWriteRejected(sink, "update", { correlationId: "request-two" });
    vaultLog.emitMemoryWriteRejected(sink, "graph", undefined);
    vaultLog.emitMemoryWriteRejected(sink, "insert", { correlationId: "bad" });
    expect(
      events.map((event) =>
        expectActivityLogProof(
          "memory-vault.write.rejected.initial-admission",
          formatActivityLogProofLine(event),
        ),
      ),
    ).toMatchObject([
      { correlationId: "request-one", parentCorrelationId: "parent-request", admitted: false },
      { correlationId: "request-two", admitted: false },
      { correlationId: "unknown-correlation-id", admitted: false },
      { correlationId: "unknown-correlation-id", admitted: false },
    ]);
  });

  it("never lets an unreadable context or failed sink escape the evidence boundary", () => {
    expect(vaultLog).toHaveProperty("emitMemoryWriteRejected");
    const context = {
      get correlationId(): string {
        throw new TypeError("private-context-canary");
      },
    };
    const events: MemoryVaultLogTransport[] = [];
    expect(() => {
      vaultLog.emitMemoryWriteRejected(
        {
          write: (event): void => {
            events.push(event);
          },
        },
        "insert",
        context,
      );
    }).not.toThrow();
    expect(events).toHaveLength(1);
    expect(activityLogEventWillBeRejected(events[0] ?? {})).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-context-canary");
    const before = activityLogLossCounters()["port-sink-failed"];
    expect(() => {
      vaultLog.emitMemoryWriteRejected(
        {
          write: (): never => {
            throw new TypeError("private-sink-canary");
          },
        },
        "update",
        { correlationId: "sink-request" },
      );
    }).not.toThrow();
    expect(activityLogLossCounters()["port-sink-failed"]).toBe(before + 1);
    const unwired = activityLogLossCounters()["port-unwired"];
    vaultLog.emitMemoryWriteRejected(undefined, "insert", undefined);
    expect(activityLogLossCounters()["port-unwired"]).toBe(unwired + 1);
  });
});

describe("physical write refusal and capture evidence", () => {
  it("retains canonical physical invalidity without changing initial refusal fields", () => {
    const events: MemoryVaultLogTransport[] = [];
    vaultLog.emitMemoryWriteRejected(
      { write: (event) => events.push(event) },
      "update-batch",
      { correlationId: "physical-validation-request" },
      "physical-admission",
    );
    expect(
      expectActivityLogProof(
        "memory-vault.write.rejected.initial-admission",
        formatActivityLogProofLine(events[0] ?? {}),
      ),
    ).toMatchObject({
      stage: "physical-admission",
      reason: "invalid-record",
      method: "update-batch",
      admitted: false,
      rejectionCount: 1,
      errorKind: "validation-failed",
    });
  });

  it("uses the evidence provider's receiver and admits a legitimate empty cause chain", () => {
    const events: MemoryVaultLogTransport[] = [];
    const failure = new TypeError("private-capture-log-canary");
    const sink: MemoryVaultLogSink = {
      write: (event) => events.push(event),
      errorEvidence(error: unknown): vaultLog.MemoryVaultErrorEvidence {
        expect(this).toBe(sink);
        expect(error).toBe(failure);
        return { frames: ["packages/keiko-memory-vault/src/serialize.ts:10:2"], causeChain: [] };
      },
    };
    vaultLog.emitMemoryWriteCaptureFailed(
      sink,
      "insert",
      {
        correlationId: "physical-capture-request",
        parentCorrelationId: "physical-capture-parent",
      },
      failure,
    );
    expect(
      expectActivityLogProof(
        "memory-vault.write.capture-failed.physical-admission",
        formatActivityLogProofLine(events[0] ?? {}),
      ),
    ).toMatchObject({
      correlationId: "physical-capture-request",
      parentCorrelationId: "physical-capture-parent",
      method: "insert",
      stage: "physical-admission",
      reason: "capture-unavailable",
      admitted: false,
      rejectionCount: 1,
      errorKind: "internal",
      completeness: "complete",
      loss: "none",
    });
    expect(JSON.stringify(events)).not.toContain("private-capture-log-canary");
  });

  it.each([
    "absent",
    "throws",
    "getter",
    "fields-getter",
    "empty",
    "foreign",
    "invalid-causes",
  ] as const)("retains partial capture evidence when the provider is %s", (mode) => {
    const events: MemoryVaultLogTransport[] = [];
    const sink: MemoryVaultLogSink = { write: (event) => events.push(event) };
    if (mode !== "absent")
      Object.defineProperty(sink, "errorEvidence", {
        get: () => {
          if (mode === "getter") throw new TypeError("private-provider-canary");
          return (): vaultLog.MemoryVaultErrorEvidence => {
            if (mode === "throws") throw new TypeError("private-provider-canary");
            if (mode === "fields-getter")
              return {
                get frames(): readonly string[] {
                  throw new TypeError("private-provider-canary");
                },
                causeChain: [],
              };
            return {
              frames:
                mode === "empty"
                  ? []
                  : mode === "foreign"
                    ? ["raw-private-stack"]
                    : ["packages/keiko-memory-vault/src/serialize.ts:10:2"],
              causeChain: mode === "invalid-causes" ? ["raw private cause text"] : [],
            };
          };
        },
      });
    const before = activityLogLossCounters();
    vaultLog.emitMemoryWriteCaptureFailed(sink, "graph", undefined, new TypeError("fixture"));
    expect(
      expectActivityLogProof(
        "memory-vault.write.capture-failed.physical-admission",
        formatActivityLogProofLine(events[0] ?? {}),
      ),
    ).toMatchObject({
      correlationId: "unknown-correlation-id",
      completeness: "partial",
      loss: "none",
    });
    expect(activityLogLossCounters()).toEqual(before);
    expect(JSON.stringify(events)).not.toContain("private-provider-canary");
    expect(JSON.stringify(events)).not.toContain("raw-private-stack");
    expect(JSON.stringify(events)).not.toContain("raw private cause text");
  });

  it("counts a failed capture emission once through the existing sink fallback", () => {
    const events: MemoryVaultLogTransport[] = [];
    const before = activityLogLossCounters()["port-sink-failed"];
    vaultLog.emitMemoryWriteCaptureFailed(
      {
        write: (event) => {
          if (event.op === "memory-vault.write.capture-failed")
            throw new TypeError("fixture transport");
          events.push(event);
        },
      },
      "update",
      { correlationId: "capture-loss-request" },
      new TypeError("fixture"),
    );
    expect(activityLogLossCounters()["port-sink-failed"]).toBe(before + 1);
    expect(events.map((event) => event.op)).toEqual(["memory-vault.log.sink-failed"]);
    const unwired = activityLogLossCounters()["port-unwired"];
    vaultLog.emitMemoryWriteCaptureFailed(undefined, "insert", undefined, new TypeError("fixture"));
    expect(activityLogLossCounters()["port-unwired"]).toBe(unwired + 1);
  });
});

describe("#3918 synchronous port delivery observations", () => {
  it("counts an unwired event without observing its operation", () => {
    resetActivityLogLossCountersForTests();
    try {
      const event: MemoryVaultLogTransport = {
        category: "memory",
        get op(): never {
          throw new TypeError("unwired event must remain unread");
        },
      };
      emitMemoryVaultLogEvent(undefined, event);
      expect(activityLogLossCounters()["port-unwired"]).toBe(1);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });

  it("reads the write method once and preserves its receiver and exact event", () => {
    resetActivityLogLossCountersForTests();
    try {
      let getterReads = 0;
      let writes = 0;
      const event: MemoryVaultLogTransport = {
        category: "memory",
        get op(): never {
          throw new TypeError("healthy delivery must not inspect the event");
        },
      };
      const sink: MemoryVaultLogSink = {
        get write(): (received: MemoryVaultLogTransport) => void {
          getterReads += 1;
          expect(this).toBe(sink);
          return function (this: MemoryVaultLogSink, received: MemoryVaultLogTransport): void {
            expect(this).toBe(sink);
            expect(received).toBe(event);
            writes += 1;
          };
        },
      };
      emitMemoryVaultLogEvent(sink, event);
      expect(getterReads).toBe(1);
      expect(writes).toBe(1);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
      expect(activityLogLossCounters()["port-unwired"]).toBe(0);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });

  it("counts a getter failure before operation and cause inspection", () => {
    resetActivityLogLossCountersForTests();
    try {
      const trace: string[] = [];
      const failure = new Error("opaque primary transport failure");
      Object.defineProperty(failure, "code", {
        get(this: Error): string {
          expect(this).toBe(failure);
          trace.push(`cause-code:${activityLogLossCounters()["port-sink-failed"].toString()}`);
          return "ENOSPC";
        },
      });
      const event: MemoryVaultLogTransport = {
        category: "memory",
        get op(): "memory-vault.store.opened" {
          trace.push(`op:${activityLogLossCounters()["port-sink-failed"].toString()}`);
          return "memory-vault.store.opened";
        },
      };
      const notices: MemoryVaultLogTransport[] = [];
      let getterReads = 0;
      const sink: MemoryVaultLogSink = {
        get write(): (received: MemoryVaultLogTransport) => void {
          trace.push("write-get");
          getterReads += 1;
          if (getterReads === 1) throw failure;
          return (received): void => {
            trace.push("notice-write");
            notices.push(received);
          };
        },
      };
      emitMemoryVaultLogEvent(sink, event);
      expect(trace).toEqual(["write-get", "op:1", "cause-code:1", "write-get", "notice-write"]);
      expect(notices.map((notice) => notice.op)).toEqual(["memory-vault.log.sink-failed"]);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });

  it("preserves an operation-getter failure escaping the owning continuation", () => {
    resetActivityLogLossCountersForTests();
    try {
      const failure = new TypeError("opaque failed-event operation");
      const event: MemoryVaultLogTransport = {
        category: "memory",
        get op(): never {
          expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
          throw failure;
        },
      };
      let getterReads = 0;
      const sink: MemoryVaultLogSink = {
        get write(): (received: MemoryVaultLogTransport) => void {
          getterReads += 1;
          throw new TypeError("primary write getter failed");
        },
      };
      let observed: unknown;
      try {
        emitMemoryVaultLogEvent(sink, event);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(getterReads).toBe(1);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
});

describe("#3918 classifier foreign observation contract", (): void => {
  it("accepts inherited code once with its original receiver and skips name", (): void => {
    const trace: string[] = [];
    const receivers: unknown[] = [];
    const prototype = {
      get code(): string {
        trace.push("code");
        receivers.push(this);
        return "ENOSPC";
      },
      get name(): never {
        trace.push("name");
        throw new TypeError("accepted code must short-circuit");
      },
    };
    const cause: unknown = Object.create(prototype);
    expect(memoryVaultErrorKind(cause)).toBe("ENOSPC");
    expect(trace).toEqual(["code"]);
    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(cause);
  });

  it("falls back in inherited read order without coercing a foreign code", (): void => {
    const trace: string[] = [];
    const receivers: unknown[] = [];
    const foreignCode = {
      [Symbol.toPrimitive](): string {
        trace.push("coerce");
        return "ENOSPC";
      },
    };
    const prototype = {
      get code(): typeof foreignCode {
        trace.push("code");
        receivers.push(this);
        return foreignCode;
      },
      get name(): string {
        trace.push("name");
        receivers.push(this);
        return "TypeError";
      },
      get message(): never {
        trace.push("message");
        throw new TypeError("private-classifier-canary");
      },
    };
    const cause: unknown = Object.create(prototype);
    expect(memoryVaultErrorKind(cause)).toBe("TypeError");
    expect(trace).toEqual(["code", "name"]);
    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(cause);
    expect(receivers[1]).toBe(cause);
  });

  it("refuses callable properties and contains both throwing and revoked proxies", (): void => {
    let callableReads = 0;
    const callable = (): string => "unused callable";
    Object.defineProperty(callable, "code", {
      get(): never {
        callableReads += 1;
        throw new TypeError("callable property must remain unread");
      },
    });
    const trace: string[] = [];
    const hostile = new Proxy(
      {},
      {
        get(_target, key): never {
          trace.push(String(key));
          throw new TypeError("private-classifier-canary");
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(memoryVaultErrorKind(callable)).toBe("unknown");
    expect(callableReads).toBe(0);
    expect(memoryVaultErrorKind(hostile)).toBe("unknown");
    expect(trace).toEqual(["code", "name"]);
    expect(memoryVaultErrorKind(revoked.proxy)).toBe("unknown");
  });
});

it("#3918 preserves inherited fallback observations through the registered failure port", (): void => {
  resetActivityLogLossCountersForTests();
  try {
    const trace: string[] = [];
    const receivers: unknown[] = [];
    const prototype = {
      get code(): never {
        trace.push("code");
        receivers.push(this);
        throw new TypeError("private-classifier-canary");
      },
      get name(): string {
        trace.push("name");
        receivers.push(this);
        return "ENOSPC";
      },
    };
    const cause: Error = new TypeError("private-classifier-canary");
    Object.setPrototypeOf(cause, prototype);
    const notices: MemoryVaultLogTransport[] = [];
    const sink: MemoryVaultLogSink = {
      write(event): void {
        if (event.op !== "memory-vault.log.sink-failed") throw cause;
        notices.push(event);
      },
    };
    emitMemoryVaultLogEvent(sink, { category: "memory", op: "memory-vault.store.opened" });
    expect(trace).toEqual(["code", "name"]);
    expect(receivers).toHaveLength(2);
    expect(receivers[0]).toBe(cause);
    expect(receivers[1]).toBe(cause);
    expect(notices).toHaveLength(1);
    const line = formatActivityLogProofLine(notices[0] ?? {});
    const persisted = expectActivityLogProof("memory-vault.log.sink-failed.body-free", line);
    expect(persisted.failureKind).toBe("ENOSPC");
    expect(line).not.toContain("private-classifier-canary");
    expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
  } finally {
    resetActivityLogLossCountersForTests();
  }
});
