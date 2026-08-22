// Tests for the package's activity-log seam. Four properties are load-bearing:
//
//   * the default sink is inert — an unwired caller must never pay for, or fail because of,
//     instrumentation;
//   * `securityErrorKind` classifies WITHOUT reading `message`, which is where a thrown error
//     routinely carries a path or a fragment of the value that failed, and without letting a
//     hostile property ACCESSOR throw out of the classification;
//   * a failing sink neither surfaces to the operation being logged nor disappears silently;
//   * the timer is monotonic and never reports a negative duration.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitSecurityLogEvent,
  nullSecurityLogSink,
  securityErrorKind,
  startSecurityLogTimer,
  type SecurityLogEvent,
  type SecurityLogSink,
} from "./log-port.js";

// The specs below replace platform functions — `performance.now`, `process.emitWarning`. A spy
// restored on the last line of its own test is only restored when that test PASSES: an assertion
// that throws first leaves the platform patched for every later test in this worker, turning one
// red into a cascade that hides its own cause. Neither vitest config in this repository sets
// `restoreMocks`, so the hook is what guarantees it.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("nullSecurityLogSink", () => {
  it("accepts an event without throwing and returns a shared instance", () => {
    const sink = nullSecurityLogSink();
    expect(() => {
      sink.write({ category: "security", op: "test.op" });
    }).not.toThrow();
    expect(nullSecurityLogSink()).toBe(sink);
  });
});

describe("securityErrorKind", () => {
  it("prefers a coded `code` over the constructor name", () => {
    const error = Object.assign(new TypeError("boom"), { code: "ETIMEDOUT" });
    expect(securityErrorKind(error)).toBe("ETIMEDOUT");
  });

  it("falls back to the constructor name when there is no code", () => {
    expect(securityErrorKind(new RangeError("boom"))).toBe("RangeError");
  });

  it("reports `unknown` for a primitive throw and for an empty-string code", () => {
    expect(securityErrorKind("a raw string throw")).toBe("unknown");
    expect(securityErrorKind(undefined)).toBe("unknown");
    expect(securityErrorKind(null)).toBe("unknown");
    expect(securityErrorKind({ code: "", name: "" })).toBe("unknown");
  });

  // `errorKind`/`extra.reasonKind` are ENVELOPE fields written before `extra` redaction runs, so a
  // provider- or OS-controlled `code`/`name` that carries a sentence must never pass through.
  it("refuses a `code` that is a sentence rather than a taxonomy code", () => {
    const echoed = Object.assign(new Error("boom"), {
      code: "permission denied for /Users/someone/vault/shard.bin",
      name: "AccessError",
    });
    const kind = securityErrorKind(echoed);
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
    expect(() => securityErrorKind(hostile)).not.toThrow();
    expect(securityErrorKind(hostile)).toBe("TransportError");
  });

  it("never reads `message` — the field that carries content", () => {
    const readFields: string[] = [];
    const probe = new Proxy(
      { code: undefined, name: "ProbeError", message: "/Users/someone/secret-shard" },
      {
        get(target, property, receiver): unknown {
          readFields.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(securityErrorKind(probe)).toBe("ProbeError");
    expect(readFields).not.toContain("message");
  });
});

describe("emitSecurityLogEvent", () => {
  const failure = (): Error => Object.assign(new Error("no space left"), { code: "ENOSPC" });

  function recordingSinkThatFailsOn(failingOps: readonly string[]): {
    sink: SecurityLogSink;
    events: SecurityLogEvent[];
  } {
    const events: SecurityLogEvent[] = [];
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
      emitSecurityLogEvent(undefined, { category: "security", op: "security.keychain.fallback" });
    }).not.toThrow();
  });

  // The rule callers depend on: `readMacosKeychainSecret` logs from inside a catch on the boot
  // path, and `readShardEnvelope` logs from inside a catch a caller is about to treat as "absent".
  // A write that threw there would replace a diagnosable outcome with a logging failure.
  it("never lets a sink failure surface to the operation being logged", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: SecurityLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    expect(() => {
      emitSecurityLogEvent(dead, { category: "security", op: "security.keychain.fallback" });
    }).not.toThrow();
  });

  it("reports a failing sink once, through the sink itself, as an envelope-only notice", () => {
    const { sink, events } = recordingSinkThatFailsOn(["security.vault.shard-unreadable"]);

    emitSecurityLogEvent(sink, {
      category: "security",
      op: "security.vault.shard-unreadable",
      errorKind: "Error",
      extra: { count: 1 },
    });
    emitSecurityLogEvent(sink, { category: "security", op: "security.vault.shard-unreadable" });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      level: "error",
      category: "diagnostic",
      op: "security.log.sink-failed",
      errorKind: "ENOSPC",
      extra: { droppedOp: "security.vault.shard-unreadable" },
    });
  });

  it("keeps writing subsequent lines a recovered sink can take", () => {
    const { sink, events } = recordingSinkThatFailsOn(["security.keychain.fallback"]);

    emitSecurityLogEvent(sink, { category: "security", op: "security.keychain.fallback" });
    emitSecurityLogEvent(sink, { category: "security", op: "security.vault.shard-unreadable" });

    expect(events.map((event) => event.op)).toEqual([
      "security.log.sink-failed",
      "security.vault.shard-unreadable",
    ]);
  });

  // A sink that refuses the notice too is a dead transport, not a rejected shape. The report then
  // leaves by the one channel that is not the broken one.
  it("falls back to one process warning per sink when the transport itself is down", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: SecurityLogSink = {
      write: (): never => {
        throw failure();
      },
    };

    emitSecurityLogEvent(dead, { category: "security", op: "security.keychain.fallback" });
    emitSecurityLogEvent(dead, { category: "security", op: "security.vault.shard-unreadable" });

    expect(warn).toHaveBeenCalledTimes(1);
    const calls: readonly (readonly unknown[])[] = warn.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      code: "KEIKO_LOG_SINK_FAILED",
      detail: "op=security.keychain.fallback errorKind=ENOSPC",
    });

    // Per sink, not per process: a replaced sink that also fails is a new fact about the log.
    const replacement: SecurityLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    emitSecurityLogEvent(replacement, {
      category: "security",
      op: "security.vault.shard-unreadable",
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("carries no body into the fallback report", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const secret = ["shard", "reference", "value"].join("-");
    const dead: SecurityLogSink = {
      write: (): never => {
        throw new Error(`writing failed for ${secret}`);
      },
    };

    emitSecurityLogEvent(dead, {
      category: "security",
      op: "security.vault.shard-unreadable",
      extra: { note: secret },
    });

    const reported = JSON.stringify(warn.mock.calls);
    expect(reported).not.toContain(secret);
    expect(reported).toContain("errorKind=Error");
  });
});

describe("startSecurityLogTimer", () => {
  it("reports a non-negative elapsed duration rounded to three decimals", () => {
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1042.98765);
    const elapsed = startSecurityLogTimer();
    expect(elapsed()).toBe(42.988);
  });

  it("is driven by performance.now, so a backwards wall clock cannot go negative", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const elapsed = startSecurityLogTimer();
    expect(elapsed()).toBeGreaterThanOrEqual(0);
  });
});

describe("SecurityLogEvent", () => {
  it("carries only the envelope a redacting sink expects", () => {
    const event: SecurityLogEvent = {
      level: "warn",
      category: "security",
      op: "security.keychain.fallback",
      errorKind: "ETIMEDOUT",
      status: 504,
      durationMs: 12.5,
      extra: { reasonKind: "ETIMEDOUT", boundedExitKind: "timeout" },
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
});
