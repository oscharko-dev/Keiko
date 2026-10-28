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
import { defineClassifierObservationContract } from "../../../tests/support/log-classifier-observations.js";
import {
  activityLogEvent,
  activityLogEventRegistration,
  activityLogLossCounters,
  defineActivityLogOperation,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import {
  bindSecurityLogCorrelation,
  emitSecurityLogEvent,
  nullSecurityLogSink,
  securityErrorKind,
  startSecurityLogTimer,
  type SecurityLogEvent,
  type SecurityLogSink,
} from "./log-port.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const CORRELATION_WRAPPER_FIXTURE = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "test.security-correlation-wrapper",
  category: "security",
  owner: "keiko-security",
  emitter: "log-port.test.security-correlation-wrapper",
  fields: {},
  causal: "none",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["test-fixture"],
  proofIds: ["test.security-correlation-wrapper.registration"],
  releaseImpact: "none",
});

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

describe("bindSecurityLogCorrelation", () => {
  it("stamps every write with the bound correlation id", () => {
    const events: SecurityLogEvent[] = [];
    const bound = bindSecurityLogCorrelation(
      { write: (event): void => void events.push(event) },
      "corr-1",
    );
    bound?.write({ category: "security", op: "security.vault.entries-merged" });
    expect(events).toEqual([
      expect.objectContaining({
        op: "security.vault.entries-merged",
        correlationId: "corr-1",
      }),
    ]);
  });

  it("returns undefined when no sink is wired", () => {
    expect(bindSecurityLogCorrelation(undefined, "corr-1")).toBeUndefined();
  });

  it("preserves typed registration while binding correlation", () => {
    const events: SecurityLogEvent[] = [];
    const bound = bindSecurityLogCorrelation(
      { write: (event): void => void events.push(event) },
      "security-correlation-1",
    );
    const event = activityLogEvent(CORRELATION_WRAPPER_FIXTURE, {}, {});

    bound?.write(event);

    expect(activityLogEventRegistration(events[0] ?? {})).toBe(CORRELATION_WRAPPER_FIXTURE);
  });

  it("deduplicates sink-failed reports across correlation wrappers of the same sink", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const events: SecurityLogEvent[] = [];
    const flaky: SecurityLogSink = {
      write: (event): void => {
        if (event.op === "security.log.sink-failed") {
          events.push(event);
          return;
        }
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      },
    };
    const first = bindSecurityLogCorrelation(flaky, "corr-1");
    const second = bindSecurityLogCorrelation(flaky, "corr-2");
    emitSecurityLogEvent(first, { category: "security", op: "security.vault.entries-merged" });
    emitSecurityLogEvent(second, { category: "security", op: "security.vault.shard-unreadable" });
    expect(events).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
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
      errorKind: "unavailable",
      extra: {
        completeness: "complete",
        loss: "none",
        droppedOpDigest: "764c7a89e99dae45",
        failureKind: "ENOSPC",
      },
    });
    const persisted = expectActivityLogProof(
      "security.log.sink-failed.body-free",
      formatActivityLogProofLine(events[0] ?? {}),
    );
    expect(persisted).toMatchObject({
      droppedOpDigest: "764c7a89e99dae45",
      failureKind: "ENOSPC",
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
      detail: "opDigest=3a8b3e925403036f errorKind=ENOSPC",
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
    // Date.now steps BACKWARDS between the start and the read: a Date.now-based timer would
    // compute a negative delta here. performance.now is mocked to a known, forward-moving pair so
    // the assertion pins the exact value a performance.now-based implementation must produce —
    // discriminating this from a Date.now-based one, which `toBeGreaterThanOrEqual(0)` against a
    // constant-0 Date.now mock could not (that passed for either implementation).
    vi.spyOn(Date, "now").mockReturnValueOnce(5000).mockReturnValueOnce(1000);
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2017.5);
    const elapsed = startSecurityLogTimer();
    expect(elapsed()).toBe(17.5);
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

// #3532: the process warning is once per sink, but the process loss ledger counts every line a
// failing sink loses, so a quiet log can be told apart from a log that stopped working.
describe("emitSecurityLogEvent loss accounting", () => {
  it("counts every line a dead sink loses in the process loss ledger", () => {
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    resetActivityLogLossCountersForTests();
    const dead: SecurityLogSink = {
      write: (): never => {
        throw new Error("sink is down");
      },
    };
    try {
      for (let index = 0; index < 3; index += 1) {
        emitSecurityLogEvent(dead, { category: "security", op: "security.keychain.fallback" });
      }
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(3);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });

  it("counts an event handed to an unwired port as lost", () => {
    resetActivityLogLossCountersForTests();
    try {
      emitSecurityLogEvent(undefined, { category: "security", op: "security.keychain.fallback" });
      expect(activityLogLossCounters()["port-unwired"]).toBe(1);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
});

import { writeActivityLogPortEvent as sourceWriteActivityLogPortEvent } from "./log-port-delivery.js";
import { writeActivityLogPortEvent as publicWriteActivityLogPortEvent } from "@oscharko-dev/keiko-security";

describe("#3918 actual source and public synchronous primary delivery", (): void => {
  for (const [surface, deliver] of [
    ["source", sourceWriteActivityLogPortEvent],
    ["public", publicWriteActivityLogPortEvent],
  ] as const) {
    it(`${surface}: counts an unwired delivery without observing event fields`, (): void => {
      resetActivityLogLossCountersForTests();
      try {
        let reads = 0;
        let callbacks = 0;
        const event = new Proxy(
          {},
          {
            get(): never {
              reads += 1;
              throw new TypeError("unwired event must remain unread");
            },
          },
        );
        deliver(undefined, event, (): void => {
          callbacks += 1;
        });
        expect(reads).toBe(0);
        expect(callbacks).toBe(0);
        expect(activityLogLossCounters()["port-unwired"]).toBe(1);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
      } finally {
        resetActivityLogLossCountersForTests();
      }
    });

    it(`${surface}: looks up write once and preserves its receiver and event`, (): void => {
      resetActivityLogLossCountersForTests();
      try {
        const event = Object.freeze({ marker: "synthetic primary event" });
        const trace: string[] = [];
        const receivers: unknown[] = [];
        const receivedEvents: unknown[] = [];
        let callbacks = 0;
        const before = activityLogLossCounters();
        const sink = {
          get write(): (received: typeof event) => void {
            trace.push("write-get");
            receivers.push(this);
            return function (this: unknown, received: typeof event): void {
              trace.push("write-call");
              receivers.push(this);
              receivedEvents.push(received);
            };
          },
        };
        deliver(sink, event, (): void => {
          callbacks += 1;
        });
        expect(trace).toEqual(["write-get", "write-call"]);
        expect(receivers[0]).toBe(sink);
        expect(receivers[1]).toBe(sink);
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0]).toBe(event);
        expect(callbacks).toBe(0);
        expect(activityLogLossCounters()).toEqual(before);
      } finally {
        resetActivityLogLossCountersForTests();
      }
    });

    it(`${surface}: counts a write getter failure before the owning callback`, (): void => {
      resetActivityLogLossCountersForTests();
      try {
        const event = Object.freeze({ marker: "synthetic getter event" });
        const failure: Error = Object.freeze(new TypeError("synthetic write getter refusal"));
        const trace: string[] = [];
        const getterReceivers: unknown[] = [];
        const callbackInputs: unknown[][] = [];
        const lossSnapshots: number[] = [];
        const sink = {
          get write(): (received: typeof event) => void {
            getterReceivers.push(this);
            trace.push("write-get");
            throw failure;
          },
        };
        deliver(sink, event, (failedSink, failedEvent, cause): void => {
          trace.push("callback");
          callbackInputs.push([failedSink, failedEvent, cause]);
          lossSnapshots.push(activityLogLossCounters()["port-sink-failed"]);
        });
        expect(trace).toEqual(["write-get", "callback"]);
        expect(getterReceivers).toHaveLength(1);
        expect(getterReceivers[0]).toBe(sink);
        expect(callbackInputs).toHaveLength(1);
        expect(callbackInputs[0]?.[0]).toBe(sink);
        expect(callbackInputs[0]?.[1]).toBe(event);
        expect(callbackInputs[0]?.[2]).toBe(failure);
        expect(lossSnapshots).toEqual([1]);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
        expect(activityLogLossCounters()["port-unwired"]).toBe(0);
      } finally {
        resetActivityLogLossCountersForTests();
      }
    });

    it(`${surface}: counts every method refusal before each callback`, (): void => {
      resetActivityLogLossCountersForTests();
      try {
        const event = Object.freeze({ marker: "synthetic repeated event" });
        const failure: Error = Object.freeze(new TypeError("synthetic write method refusal"));
        const trace: string[] = [];
        const receivers: unknown[] = [];
        const receivedEvents: unknown[] = [];
        const callbackInputs: unknown[][] = [];
        const lossSnapshots: number[] = [];
        const sink = {
          write(this: unknown, received: typeof event): never {
            trace.push("write");
            receivers.push(this);
            receivedEvents.push(received);
            throw failure;
          },
        };
        const onFailure = (
          failedSink: typeof sink,
          failedEvent: typeof event,
          cause: unknown,
        ): void => {
          trace.push("callback");
          callbackInputs.push([failedSink, failedEvent, cause]);
          lossSnapshots.push(activityLogLossCounters()["port-sink-failed"]);
        };
        deliver(sink, event, onFailure);
        deliver(sink, event, onFailure);
        expect(trace).toEqual(["write", "callback", "write", "callback"]);
        expect(receivers[0]).toBe(sink);
        expect(receivers[1]).toBe(sink);
        expect(receivedEvents[0]).toBe(event);
        expect(receivedEvents[1]).toBe(event);
        expect(callbackInputs).toHaveLength(2);
        for (const [failedSink, failedEvent, cause] of callbackInputs) {
          expect(failedSink).toBe(sink);
          expect(failedEvent).toBe(event);
          expect(cause).toBe(failure);
        }
        expect(lossSnapshots).toEqual([1, 2]);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(2);
        expect(activityLogLossCounters()["port-unwired"]).toBe(0);
      } finally {
        resetActivityLogLossCountersForTests();
      }
    });

    it(`${surface}: propagates the owning callback error without catching it again`, (): void => {
      resetActivityLogLossCountersForTests();
      try {
        const event = Object.freeze({ marker: "synthetic callback event" });
        const writeFailure: Error = Object.freeze(new TypeError("synthetic primary refusal"));
        const callbackFailure: Error = Object.freeze(new TypeError("synthetic callback refusal"));
        const trace: string[] = [];
        const callbackInputs: unknown[][] = [];
        const lossSnapshots: number[] = [];
        const sink = {
          write(): never {
            trace.push("write");
            throw writeFailure;
          },
        };
        let caught: unknown;
        try {
          deliver(sink, event, (failedSink, failedEvent, cause): never => {
            trace.push("callback");
            callbackInputs.push([failedSink, failedEvent, cause]);
            lossSnapshots.push(activityLogLossCounters()["port-sink-failed"]);
            throw callbackFailure;
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(callbackFailure);
        expect(trace).toEqual(["write", "callback"]);
        expect(callbackInputs).toHaveLength(1);
        expect(callbackInputs[0]?.[0]).toBe(sink);
        expect(callbackInputs[0]?.[1]).toBe(event);
        expect(callbackInputs[0]?.[2]).toBe(writeFailure);
        expect(lossSnapshots).toEqual([1]);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
        expect(activityLogLossCounters()["port-unwired"]).toBe(0);
      } finally {
        resetActivityLogLossCountersForTests();
      }
    });

    it(`${surface}: forwards an actual registered Security failure event intact`, (): void => {
      resetActivityLogLossCountersForTests();
      try {
        const produced: SecurityLogEvent[] = [];
        const flaky: SecurityLogSink = {
          write(event): void {
            if (event.op !== "security.log.sink-failed") {
              throw new TypeError("synthetic-private-producer-canary");
            }
            produced.push(event);
          },
        };
        emitSecurityLogEvent(flaky, {
          category: "security",
          op: "security.vault.shard-unreadable",
        });
        expect(produced).toHaveLength(1);
        const notice = produced[0];
        if (notice === undefined) throw new TypeError("missing actual producer notice");
        const registration = activityLogEventRegistration(notice);
        const beforeForwarding = activityLogLossCounters();
        const forwarded: SecurityLogEvent[] = [];
        let callbacks = 0;
        const sink: SecurityLogSink = {
          write(event): void {
            forwarded.push(event);
          },
        };
        deliver(sink, notice, (): void => {
          callbacks += 1;
        });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).toBe(notice);
        expect(registration).toBeDefined();
        expect(activityLogEventRegistration(forwarded[0] ?? {})).toBe(registration);
        const line = formatActivityLogProofLine(forwarded[0] ?? {});
        expectActivityLogProof("security.log.sink-failed.body-free", line);
        expect(line).not.toContain("synthetic-private-producer-canary");
        expect(callbacks).toBe(0);
        expect(beforeForwarding["port-sink-failed"]).toBe(1);
        expect(activityLogLossCounters()).toEqual(beforeForwarding);
      } finally {
        resetActivityLogLossCountersForTests();
      }
    });
  }
});

import { securityErrorKind as publicSecurityErrorKind } from "@oscharko-dev/keiko-security";

describe("#3918 source and public Security classifier observation contract", (): void => {
  for (const [surface, classify] of [
    ["source", securityErrorKind],
    ["public", publicSecurityErrorKind],
  ] as const) {
    describe(surface, (): void => {
      defineClassifierObservationContract(classify);
    });
  }
});
