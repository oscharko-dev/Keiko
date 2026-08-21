// Tests for the package's activity-log seam. Four properties are load-bearing:
//
//   * the default sink is inert — an unwired caller must never pay for, or fail because of,
//     instrumentation;
//   * `knowledgeErrorKind` classifies WITHOUT reading `message`, which is where a thrown
//     error routinely carries a path, an endpoint, or a fragment of the failed content, and
//     without letting a hostile property ACCESSOR throw out of the classification;
//   * a failing sink neither surfaces to the operation being logged nor disappears silently;
//   * the timer is monotonic and never reports a negative duration.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitKnowledgeLogEvent,
  knowledgeErrorKind,
  nullKnowledgeLogSink,
  startKnowledgeLogTimer,
  type KnowledgeLogEvent,
  type KnowledgeLogSink,
} from "./knowledge-log.js";

// The specs below replace platform functions — `performance.now`, `process.emitWarning`. A spy
// restored on the last line of its own test is only restored when that test PASSES: an assertion
// that throws first leaves the platform patched for every later test in this worker, turning one
// red into a cascade that hides its own cause. Neither vitest config in this repository sets
// `restoreMocks`, so the hook is what guarantees it.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("nullKnowledgeLogSink", () => {
  it("accepts an event without throwing and returns a shared instance", () => {
    const sink = nullKnowledgeLogSink();
    expect(() => {
      sink.write({ category: "indexing", op: "test.op" });
    }).not.toThrow();
    expect(nullKnowledgeLogSink()).toBe(sink);
  });
});

describe("knowledgeErrorKind", () => {
  it("prefers a coded `code` over the constructor name", () => {
    const error = Object.assign(new TypeError("boom"), { code: "ENOENT" });
    expect(knowledgeErrorKind(error)).toBe("ENOENT");
  });

  it("falls back to the constructor name when there is no code", () => {
    expect(knowledgeErrorKind(new RangeError("boom"))).toBe("RangeError");
  });

  it("reports `unknown` for a primitive throw and for an empty-string code", () => {
    expect(knowledgeErrorKind("a raw string throw")).toBe("unknown");
    expect(knowledgeErrorKind(undefined)).toBe("unknown");
    expect(knowledgeErrorKind(null)).toBe("unknown");
    expect(knowledgeErrorKind({ code: "", name: "" })).toBe("unknown");
  });

  // A provider client is free to put a sentence in `code`, and an aggregation layer routinely
  // copies a remote error's `code` string straight out of a JSON body. `errorKind` is an ENVELOPE
  // field, read before `extra` is redacted, so a reducer that trusted the property name wrote the
  // sentence — including one echoing the rejected input — verbatim into the activity log.
  it("refuses a `code` that is a sentence rather than a taxonomy code", () => {
    const echoed = Object.assign(new Error("boom"), {
      code: "input rejected: Acme Q3 revenue was 41.2 million",
      name: "GatewayError",
    });
    const kind = knowledgeErrorKind(echoed);
    expect(kind).toBe("GatewayError");
    expect(kind).not.toContain("Acme");
    expect(kind).not.toContain(" ");
  });

  it("refuses a prose `name` too, degrading to `unknown` rather than leaking", () => {
    expect(
      knowledgeErrorKind({ code: "rejected the uploaded contract", name: "not a name!" }),
    ).toBe("unknown");
  });

  it("refuses an over-long or non-identifier code whatever it is called", () => {
    expect(knowledgeErrorKind({ code: "E".repeat(65) })).toBe("unknown");
    expect(knowledgeErrorKind({ code: "/Users/someone/secret.pdf" })).toBe("unknown");
    expect(knowledgeErrorKind({ code: "9NOTANIDENTIFIER" })).toBe("unknown");
  });

  it("keeps the taxonomy codes the instrumentation surface actually emits", () => {
    for (const code of ["ENOENT", "SQLITE_CORRUPT", "RATE_LIMIT", "keiko.store.locked", "E-1"]) {
      expect(knowledgeErrorKind({ code })).toBe(code);
    }
  });

  it("never reads `message` — the field that carries content", () => {
    const readFields: string[] = [];
    const probe = new Proxy(
      { code: undefined, name: "ProbeError", message: "/Users/someone/secret.pdf" },
      {
        get(target, property, receiver): unknown {
          readFields.push(String(property));
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(knowledgeErrorKind(probe)).toBe("ProbeError");
    expect(readFields).not.toContain("message");
  });

  // Reading `code` runs foreign code: it can be an accessor, or a Proxy trap. Every caller
  // classifies a cause while it is already handling a failure — `store.ts` mid-quarantine,
  // `orchestrator.ts` mid-document — and builds the event BEFORE any sink guard is reached, so a
  // throw here would escape as the failure instead of describing it. An unreadable property is an
  // unclassifiable one and must degrade to the next candidate.
  it("degrades to the next candidate when a property accessor throws", () => {
    const hostile = { name: "TransportError" };
    Object.defineProperty(hostile, "code", {
      get(): string {
        throw new Error("accessor refused");
      },
      enumerable: true,
    });
    expect(() => knowledgeErrorKind(hostile)).not.toThrow();
    expect(knowledgeErrorKind(hostile)).toBe("TransportError");
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
    expect(knowledgeErrorKind(hostile)).toBe("unknown");
  });
});

describe("emitKnowledgeLogEvent", () => {
  const failure = (): Error => Object.assign(new Error("no space left"), { code: "ENOSPC" });

  function recordingSinkThatFailsOn(failingOps: readonly string[]): {
    sink: KnowledgeLogSink;
    events: KnowledgeLogEvent[];
  } {
    const events: KnowledgeLogEvent[] = [];
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
      emitKnowledgeLogEvent(undefined, { category: "indexing", op: "indexing.job.received" });
    }).not.toThrow();
  });

  // The rule the callers depend on: `store.ts` logs from inside a catch that is mid-recovery or
  // about to rethrow, and `embedding-batcher.ts` logs from inside a retry ladder. A write that
  // threw there would replace a diagnosable failure with a logging failure.
  it("never lets a sink failure surface to the operation being logged", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: KnowledgeLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    expect(() => {
      emitKnowledgeLogEvent(dead, { category: "diagnostic", op: "knowledge.store.quarantined" });
    }).not.toThrow();
  });

  // …and the other half of the rule: the drop is not silent. The likelier failure is one shape the
  // transport refused, so the notice goes out on the same sink, where the operator is already
  // reading.
  it("reports a failing sink once, through the sink itself, as an envelope-only notice", () => {
    const { sink, events } = recordingSinkThatFailsOn(["knowledge.store.quarantined"]);

    emitKnowledgeLogEvent(sink, {
      category: "diagnostic",
      op: "knowledge.store.quarantined",
      extra: { reopened: true },
    });
    emitKnowledgeLogEvent(sink, { category: "diagnostic", op: "knowledge.store.quarantined" });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      level: "error",
      category: "diagnostic",
      op: "knowledge.log.sink-failed",
      errorKind: "ENOSPC",
      extra: { droppedOp: "knowledge.store.quarantined" },
    });
  });

  it("keeps writing subsequent lines a recovered sink can take", () => {
    const { sink, events } = recordingSinkThatFailsOn(["indexing.job.received"]);

    emitKnowledgeLogEvent(sink, { category: "indexing", op: "indexing.job.received" });
    emitKnowledgeLogEvent(sink, { category: "indexing", op: "indexing.job.started" });

    expect(events.map((event) => event.op)).toEqual([
      "knowledge.log.sink-failed",
      "indexing.job.started",
    ]);
  });

  // A sink that refuses the notice too is a dead transport, not a rejected shape. The report then
  // has to leave by the one channel that is not the broken one, or a dead activity log looks
  // exactly like an idle one — the six-minute silence this whole seam exists to end.
  it("falls back to one process warning per sink when the transport itself is down", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: KnowledgeLogSink = {
      write: (): never => {
        throw failure();
      },
    };

    emitKnowledgeLogEvent(dead, { category: "indexing", op: "indexing.job.received" });
    emitKnowledgeLogEvent(dead, { category: "indexing", op: "indexing.job.started" });

    expect(warn).toHaveBeenCalledTimes(1);
    const calls: readonly (readonly unknown[])[] = warn.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      code: "KEIKO_LOG_SINK_FAILED",
      detail: "op=indexing.job.received errorKind=ENOSPC",
    });

    // Per sink, not per process: a replaced sink that also fails is a new fact about the log.
    const replacement: KnowledgeLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    emitKnowledgeLogEvent(replacement, { category: "indexing", op: "indexing.job.started" });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  // The fallback is a log line and a process warning, so it is held to the same rule as every
  // other line: identifiers, counts and classifications only.
  it("carries no body into the fallback report", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const secret = ["classified", "document", "text"].join("-");
    const dead: KnowledgeLogSink = {
      write: (): never => {
        throw new Error(`writing failed for ${secret}`);
      },
    };

    emitKnowledgeLogEvent(dead, {
      category: "indexing",
      op: "indexing.document.failed",
      extra: { title: secret },
    });

    const reported = JSON.stringify(warn.mock.calls);
    expect(reported).not.toContain(secret);
    // The cause carried its text in `message`, which is never read, so it classifies by name.
    expect(reported).toContain("errorKind=Error");
  });
});

describe("startKnowledgeLogTimer", () => {
  it("reports a non-negative elapsed duration rounded to three decimals", () => {
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1042.98765);
    const elapsed = startKnowledgeLogTimer();
    expect(elapsed()).toBe(42.988);
  });

  it("is driven by performance.now, so a backwards wall clock cannot go negative", () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const elapsed = startKnowledgeLogTimer();
    expect(elapsed()).toBeGreaterThanOrEqual(0);
  });
});

describe("KnowledgeLogEvent", () => {
  it("carries only the envelope a redacting sink expects", () => {
    const event: KnowledgeLogEvent = {
      level: "warn",
      category: "embedding",
      op: "embedding.batch.retry",
      errorKind: "timeout",
      status: 504,
      durationMs: 12.5,
      extra: { attempt: 1 },
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
