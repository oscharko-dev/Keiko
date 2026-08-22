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

import {
  emitMemoryVaultLogEvent,
  memoryVaultErrorKind,
  nullMemoryVaultLogSink,
  startMemoryVaultLogTimer,
  type MemoryVaultLogEvent,
  type MemoryVaultLogSink,
} from "./vault-log.js";

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
    events: MemoryVaultLogEvent[];
  } {
    const events: MemoryVaultLogEvent[] = [];
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
      errorKind: "ENOSPC",
      extra: { droppedOp: "memory-vault.store.opened" },
    });
  });

  it("keeps writing subsequent lines a recovered sink can take", () => {
    const { sink, events } = recordingSinkThatFailsOn(["memory-vault.store.opened"]);

    emitMemoryVaultLogEvent(sink, { category: "memory", op: "memory-vault.store.opened" });
    emitMemoryVaultLogEvent(sink, { category: "memory", op: "store.encryption-migrated" });

    expect(events.map((event) => event.op)).toEqual([
      "memory-vault.log.sink-failed",
      "store.encryption-migrated",
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
    emitMemoryVaultLogEvent(dead, { category: "memory", op: "store.encryption-migrated" });

    expect(warn).toHaveBeenCalledTimes(1);
    const calls: readonly (readonly unknown[])[] = warn.mock.calls;
    expect(calls[0]?.[1]).toMatchObject({
      code: "KEIKO_LOG_SINK_FAILED",
      detail: "op=memory-vault.store.opened errorKind=ENOSPC",
    });

    // Per sink, not per process: a replaced sink that also fails is a new fact about the log.
    const replacement: MemoryVaultLogSink = {
      write: (): never => {
        throw failure();
      },
    };
    emitMemoryVaultLogEvent(replacement, {
      category: "memory",
      op: "store.encryption-migrated",
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
