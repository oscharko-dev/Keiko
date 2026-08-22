// Tests for the package's activity-log seam. Three properties are load-bearing:
//
//   * the default sink is inert — an unwired caller must never pay for, or fail because of,
//     instrumentation;
//   * `consolidationErrorKind` classifies WITHOUT reading `message`, which is where a thrown
//     error routinely carries a fragment of the failed content, and without letting a hostile
//     property ACCESSOR throw out of the classification;
//   * a failing sink neither surfaces to the consolidation run being logged nor disappears
//     silently.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consolidationErrorKind,
  emitConsolidationLogEvent,
  nullConsolidationLogSink,
  type ConsolidationLogEvent,
  type ConsolidationLogSink,
} from "./log-port.js";

// The specs below replace `process.emitWarning`. A spy restored on the last line of its own test
// is only restored when that test PASSES: an assertion that throws first leaves the platform
// patched for every later test in this worker, turning one red into a cascade that hides its own
// cause. Neither vitest config in this repository sets `restoreMocks`, so the hook is what
// guarantees it.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("nullConsolidationLogSink", () => {
  it("accepts an event without throwing and returns a shared instance", () => {
    const sink = nullConsolidationLogSink();
    expect(() => {
      sink.write({ category: "consolidation", op: "test.op" });
    }).not.toThrow();
    expect(nullConsolidationLogSink()).toBe(sink);
  });
});

describe("consolidationErrorKind", () => {
  it("prefers a coded `code` over the constructor name", () => {
    const error = Object.assign(new TypeError("boom"), { code: "ENOENT" });
    expect(consolidationErrorKind(error)).toBe("ENOENT");
  });

  it("falls back to the constructor name when there is no code", () => {
    expect(consolidationErrorKind(new RangeError("boom"))).toBe("RangeError");
  });

  it("reports `unknown` for a primitive throw and for an empty-string code", () => {
    expect(consolidationErrorKind("a raw string throw")).toBe("unknown");
    expect(consolidationErrorKind(undefined)).toBe("unknown");
    expect(consolidationErrorKind(null)).toBe("unknown");
    expect(consolidationErrorKind({ code: "", name: "" })).toBe("unknown");
  });

  // A provider client is free to put a sentence in `code`. `errorKind` is an ENVELOPE field, read
  // before `extra` is redacted, so a reducer that trusted the property name would write the
  // sentence verbatim into the activity log.
  it("refuses a `code` that is a sentence rather than a taxonomy code", () => {
    const echoed = Object.assign(new Error("boom"), {
      code: "merge rejected: winner body was Acme Q3 revenue",
      name: "ConsolidationError",
    });
    const kind = consolidationErrorKind(echoed);
    expect(kind).toBe("ConsolidationError");
    expect(kind).not.toContain("Acme");
    expect(kind).not.toContain(" ");
  });

  it("never reads `message` — the field that carries content", () => {
    const readFields: string[] = [];
    const probe = new Proxy(
      { code: undefined, name: "ProbeError", message: "the winner body was secret" },
      {
        get(target, property, receiver): unknown {
          readFields.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(consolidationErrorKind(probe)).toBe("ProbeError");
    expect(readFields).not.toContain("message");
  });

  // Reading `code` runs foreign code: it can be an accessor, or a Proxy trap. `emitConsolidationLogEvent`
  // classifies a cause while it is already handling a sink failure, so a throw here must degrade to
  // the next candidate rather than escape as the failure itself.
  it("degrades to the next candidate when a property accessor throws", () => {
    const hostile = { name: "TransportError" };
    Object.defineProperty(hostile, "code", {
      get(): string {
        throw new Error("accessor refused");
      },
      enumerable: true,
    });
    expect(() => consolidationErrorKind(hostile)).not.toThrow();
    expect(consolidationErrorKind(hostile)).toBe("TransportError");
  });

  it("degrades to `unknown` when every candidate accessor throws", () => {
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("trap refused");
        },
      },
    );
    expect(consolidationErrorKind(hostile)).toBe("unknown");
  });
});

describe("emitConsolidationLogEvent", () => {
  const failure = (): Error => Object.assign(new Error("no space left"), { code: "ENOSPC" });

  function recordingSinkThatFailsOn(failingOps: readonly string[]): {
    sink: ConsolidationLogSink;
    events: ConsolidationLogEvent[];
  } {
    const events: ConsolidationLogEvent[] = [];
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
      emitConsolidationLogEvent(undefined, {
        category: "consolidation",
        op: "consolidation.summary.fallback",
      });
    }).not.toThrow();
  });

  it("never lets a sink failure surface to the operation being logged", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: ConsolidationLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    expect(() => {
      emitConsolidationLogEvent(dead, {
        category: "consolidation",
        op: "consolidation.summary.fallback",
      });
    }).not.toThrow();
  });

  it("reports a failing sink once, through the sink itself, as an envelope-only notice", () => {
    const { sink, events } = recordingSinkThatFailsOn(["consolidation.summary.fallback"]);

    emitConsolidationLogEvent(sink, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
      extra: { reason: "generator-threw" },
    });
    emitConsolidationLogEvent(sink, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      level: "error",
      category: "diagnostic",
      op: "consolidation.log.sink-failed",
      errorKind: "ENOSPC",
      extra: { droppedOp: "consolidation.summary.fallback" },
    });
  });

  it("keeps writing subsequent lines a recovered sink can take", () => {
    const { sink, events } = recordingSinkThatFailsOn(["consolidation.summary.fallback"]);

    emitConsolidationLogEvent(sink, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
    });
    emitConsolidationLogEvent(sink, {
      category: "diagnostic",
      op: "consolidation.log.sink-failed",
    });

    expect(events.map((event) => event.op)).toEqual([
      "consolidation.log.sink-failed",
      "consolidation.log.sink-failed",
    ]);
  });

  it("falls back to one process warning per sink when the transport itself is down", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: ConsolidationLogSink = {
      write: (): never => {
        throw failure();
      },
    };

    emitConsolidationLogEvent(dead, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
    });
    emitConsolidationLogEvent(dead, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const calls: readonly (readonly unknown[])[] = warn.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      code: "KEIKO_LOG_SINK_FAILED",
      detail: "op=consolidation.summary.fallback errorKind=ENOSPC",
    });

    // Per sink, not per process: a replaced sink that also fails is a new fact about the log.
    const replacement: ConsolidationLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    emitConsolidationLogEvent(replacement, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // The fallback is a log line and a process warning, so it is held to the same rule as every
  // other line: identifiers, counts and classifications only.
  it("carries no body into the fallback report", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const secret = ["winner", "body", "text"].join("-");
    const dead: ConsolidationLogSink = {
      write: (): never => {
        throw new Error(`writing failed for ${secret}`);
      },
    };

    emitConsolidationLogEvent(dead, {
      category: "consolidation",
      op: "consolidation.summary.fallback",
      extra: { reason: secret },
    });

    const reported = JSON.stringify(warn.mock.calls);
    expect(reported).not.toContain(secret);
    // The cause carried its text in `message`, which is never read, so it classifies by name.
    expect(reported).toContain("errorKind=Error");
  });
});

describe("ConsolidationLogEvent", () => {
  it("carries only the envelope a redacting sink expects", () => {
    const event: ConsolidationLogEvent = {
      level: "warn",
      category: "consolidation",
      op: "consolidation.summary.fallback",
      errorKind: "timeout",
      status: 504,
      durationMs: 12.5,
      extra: { reason: "generator-threw" },
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
