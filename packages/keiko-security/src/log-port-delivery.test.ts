// New internal warning API: Same-only proof; no Original import or ROOT warning export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { reportActivityLogPortFailure as publicReportPortFailure } from "@oscharko-dev/keiko-security";
import { reportActivityLogPortFailure as sourceReportPortFailure } from "./log-port-delivery.js";
import {
  emitSecurityLogEvent,
  reportActivityLogPortWarning,
  type SecurityLogSink,
} from "./log-port.js";

describe("internal activity-log port warning delivery (#3918)", (): void => {
  beforeEach(resetActivityLogLossCountersForTests);
  afterEach(resetActivityLogLossCountersForTests);

  it("forwards the fixed activity warning and arguments with the process receiver", (): void => {
    const receivers: unknown[] = [];
    const before = activityLogLossCounters();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(function (
      this: unknown,
    ): void {
      receivers.push(this);
    });
    try {
      reportActivityLogPortWarning("0123456789abcdef", "ENOSPC");
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Keiko activity log sink is failing; log lines are being dropped.",
        {
          type: "KeikoActivityLog",
          code: "KEIKO_LOG_SINK_FAILED",
          detail: "opDigest=0123456789abcdef errorKind=ENOSPC",
        },
      );
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(process);
      expect(activityLogLossCounters()).toEqual(before);
    } finally {
      warn.mockRestore();
    }
  });

  it("contains a refused warning method without counting another loss", (): void => {
    const before = activityLogLossCounters();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation((): never => {
      throw new TypeError("synthetic warning method refusal");
    });
    try {
      expect((): void => {
        reportActivityLogPortWarning("fedcba9876543210", "TypeError");
      }).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(activityLogLossCounters()).toEqual(before);
    } finally {
      warn.mockRestore();
    }
  });

  it("contains a refused warning getter and restores its original descriptor", (): void => {
    const original = Object.getOwnPropertyDescriptor(process, "emitWarning");
    if (original === undefined) throw new TypeError("missing process warning descriptor");
    const before = activityLogLossCounters();
    let reads = 0;
    try {
      Object.defineProperty(process, "emitWarning", {
        configurable: true,
        get(): never {
          reads += 1;
          throw new TypeError("synthetic warning getter refusal");
        },
      });
      expect((): void => {
        reportActivityLogPortWarning("fedcba9876543210", "TypeError");
      }).not.toThrow();
      expect(reads).toBe(1);
      expect(activityLogLossCounters()).toEqual(before);
    } finally {
      Object.defineProperty(process, "emitWarning", original);
    }
  });

  it("keeps the existing Security reporter on its exact default warning", (): void => {
    const failure: Error = Object.assign(new TypeError("synthetic sink refusal"), {
      code: "ENOSPC",
    });
    const sink: SecurityLogSink = {
      write(): never {
        throw failure;
      },
    };
    const warn = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
    try {
      resetActivityLogLossCountersForTests();
      emitSecurityLogEvent(sink, { category: "security", op: "security.keychain.fallback" });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Keiko security log sink is failing; log lines are being dropped.",
        {
          type: "KeikoActivityLog",
          code: "KEIKO_LOG_SINK_FAILED",
          detail: "opDigest=3a8b3e925403036f errorKind=ENOSPC",
        },
      );
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
    } finally {
      warn.mockRestore();
      resetActivityLogLossCountersForTests();
    }
  });
});

interface FailureNotice {
  readonly droppedOpDigest: string;
  readonly failureKind: string;
}

interface FailureNoticeSink {
  readonly write: (event: FailureNotice) => void;
}

function failureNotice(droppedOpDigest: string, failureKind: string): FailureNotice {
  return { droppedOpDigest, failureKind };
}

function codedDeliveryFailure(): Error {
  return Object.assign(new TypeError("synthetic delivery refusal"), { code: "ENOSPC" });
}

// Independent existing producer control, not a copy of the new helper's hash expression.
function securityNoticeDigest(droppedOp: string): string {
  let digest: unknown;
  const failure = codedDeliveryFailure();
  const sink: SecurityLogSink = {
    write(event): void {
      if (event.op === "security.log.sink-failed") {
        digest = event.extra?.droppedOpDigest;
        return;
      }
      throw failure;
    },
  };
  try {
    emitSecurityLogEvent(sink, { category: "security", op: droppedOp });
    if (typeof digest !== "string") throw new TypeError("missing Security producer digest");
    return digest;
  } finally {
    resetActivityLogLossCountersForTests();
  }
}

describe("complete caller-owned port failure delivery (#3918)", (): void => {
  beforeEach(resetActivityLogLossCountersForTests);
  afterEach(resetActivityLogLossCountersForTests);

  for (const [surface, reportFailure] of [
    ["source", sourceReportPortFailure],
    ["public", publicReportPortFailure],
  ] as const) {
    describe(surface, (): void => {
      it("classifies before writer lookup and forwards the exact produced notice and receiver", (): void => {
        const droppedOp = "test.delivery.é.漢.🦊";
        const expectedDigest = securityNoticeDigest(droppedOp);
        const trace: string[] = [];
        const receivers: unknown[] = [];
        const forwarded: FailureNotice[] = [];
        const producedFields: string[] = [];
        const cause = {
          get code(): string {
            trace.push("code");
            return "ENOSPC";
          },
          get name(): never {
            throw new TypeError("accepted code must skip name");
          },
        };
        const notice = failureNotice(expectedDigest, "ENOSPC");
        const sink: FailureNoticeSink = {
          get write(): (event: FailureNotice) => void {
            trace.push("write");
            return function (this: unknown, event: FailureNotice): void {
              trace.push("method");
              receivers.push(this);
              forwarded.push(event);
            };
          },
        };
        reportFailure<FailureNotice, FailureNoticeSink>(
          sink,
          droppedOp,
          cause,
          new WeakSet<FailureNoticeSink>(),
          (digest, kind): FailureNotice => {
            trace.push("producer");
            producedFields.push(digest, kind);
            return notice;
          },
        );
        expect(trace).toEqual(["code", "write", "producer", "method"]);
        expect(producedFields).toEqual([expectedDigest, "ENOSPC"]);
        expect(receivers).toHaveLength(1);
        expect(receivers[0]).toBe(sink);
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]).toBe(notice);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
      });

      it("suppresses repeats for one state while preserving distinct callers on the same sink", (): void => {
        let reads = 0;
        const cause = {
          get code(): string {
            reads += 1;
            return "ENOSPC";
          },
        };
        const notices: FailureNotice[] = [];
        const sink: FailureNoticeSink = { write: (notice): void => void notices.push(notice) };
        const first = new WeakSet<FailureNoticeSink>();
        const second = new WeakSet<FailureNoticeSink>();
        reportFailure(sink, "test.delivery", cause, first, failureNotice);
        reportFailure(sink, "test.delivery", cause, first, failureNotice);
        reportFailure(sink, "test.delivery", cause, second, failureNotice);
        expect(reads).toBe(2);
        expect(notices).toHaveLength(2);
        expect(first.has(sink)).toBe(true);
        expect(second.has(sink)).toBe(true);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
      });

      it("marks before inherited hostile classification and closes reentrant delivery", (): void => {
        const trace: string[] = [];
        const receivers: unknown[] = [];
        const notices: FailureNotice[] = [];
        const sink: FailureNoticeSink = { write: (notice): void => void notices.push(notice) };
        const reported = new WeakSet<FailureNoticeSink>();
        const foreignCode = {
          [Symbol.toPrimitive](): never {
            trace.push("coerce");
            throw new TypeError("classification must not coerce");
          },
        };
        const prototype = {
          get code(): typeof foreignCode {
            trace.push("code");
            receivers.push(this);
            reportFailure(sink, "test.reentrant", undefined, reported, failureNotice);
            return foreignCode;
          },
          get name(): string {
            trace.push("name");
            receivers.push(this);
            return "TypeError";
          },
          get message(): never {
            trace.push("message");
            throw new TypeError("private-message-canary");
          },
        };
        const cause: unknown = Object.create(prototype);
        reportFailure(sink, "test.delivery", cause, reported, failureNotice);
        expect(trace).toEqual(["code", "name"]);
        expect(receivers).toHaveLength(2);
        expect(receivers[0]).toBe(cause);
        expect(receivers[1]).toBe(cause);
        expect(notices).toHaveLength(1);
        expect(notices[0]?.failureKind).toBe("TypeError");
      });

      it("does not invoke the producer when the write getter refuses the notice", (): void => {
        const expectedDigest = securityNoticeDigest("test.delivery");
        let lookups = 0;
        let productions = 0;
        const sink: FailureNoticeSink = {
          get write(): never {
            lookups += 1;
            throw new TypeError("synthetic notice getter refusal");
          },
        };
        const warn = vi.spyOn(process, "emitWarning").mockImplementation((): void => undefined);
        try {
          reportFailure<FailureNotice, FailureNoticeSink>(
            sink,
            "test.delivery",
            codedDeliveryFailure(),
            new WeakSet<FailureNoticeSink>(),
            (digest, kind): FailureNotice => {
              productions += 1;
              return failureNotice(digest, kind);
            },
          );
          expect(lookups).toBe(1);
          expect(productions).toBe(0);
          expect(warn).toHaveBeenCalledExactlyOnceWith(
            "Keiko activity log sink is failing; log lines are being dropped.",
            {
              type: "KeikoActivityLog",
              code: "KEIKO_LOG_SINK_FAILED",
              detail: `opDigest=${expectedDigest} errorKind=ENOSPC`,
            },
          );
          expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
        } finally {
          warn.mockRestore();
        }
      });

      it("contains producer refusal after one lookup and before any method invocation", (): void => {
        const trace: string[] = [];
        const sink: FailureNoticeSink = {
          get write(): (event: FailureNotice) => void {
            trace.push("write");
            return (): void => {
              trace.push("method");
            };
          },
        };
        const warn = vi.spyOn(process, "emitWarning").mockImplementation((): void => {
          trace.push("warning");
        });
        try {
          reportFailure(
            sink,
            "test.delivery",
            codedDeliveryFailure(),
            new WeakSet<FailureNoticeSink>(),
            (): never => {
              trace.push("producer");
              throw new TypeError("synthetic notice producer refusal");
            },
          );
          expect(trace).toEqual(["write", "producer", "warning"]);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
        } finally {
          warn.mockRestore();
        }
      });

      it("contains method refusal after producing the notice with its original receiver", (): void => {
        const trace: string[] = [];
        const receivers: unknown[] = [];
        const sink: FailureNoticeSink = {
          get write(): (event: FailureNotice) => void {
            trace.push("write");
            return function (this: unknown): never {
              trace.push("method");
              receivers.push(this);
              throw new TypeError("synthetic notice method refusal");
            };
          },
        };
        const warn = vi.spyOn(process, "emitWarning").mockImplementation((): void => {
          trace.push("warning");
        });
        try {
          reportFailure<FailureNotice, FailureNoticeSink>(
            sink,
            "test.delivery",
            codedDeliveryFailure(),
            new WeakSet<FailureNoticeSink>(),
            (digest, kind): FailureNotice => {
              trace.push("producer");
              return failureNotice(digest, kind);
            },
          );
          expect(trace).toEqual(["write", "producer", "method", "warning"]);
          expect(receivers).toHaveLength(1);
          expect(receivers[0]).toBe(sink);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
        } finally {
          warn.mockRestore();
        }
      });

      it("contains a warning getter refusal and marks the sink before that fallback", (): void => {
        const original = Object.getOwnPropertyDescriptor(process, "emitWarning");
        if (original === undefined) throw new TypeError("missing process warning descriptor");
        const reported = new WeakSet<FailureNoticeSink>();
        let warningReads = 0;
        const sink: FailureNoticeSink = {
          write(): never {
            throw new TypeError("synthetic notice refusal");
          },
        };
        try {
          Object.defineProperty(process, "emitWarning", {
            configurable: true,
            get(): never {
              warningReads += 1;
              throw new TypeError("synthetic warning getter refusal");
            },
          });
          expect((): void => {
            reportFailure(sink, "test.delivery", undefined, reported, failureNotice);
          }).not.toThrow();
          reportFailure(sink, "test.delivery", undefined, reported, failureNotice);
          expect(warningReads).toBe(1);
          expect(reported.has(sink)).toBe(true);
          expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
        } finally {
          Object.defineProperty(process, "emitWarning", original);
        }
      });

      it("contains a warning method refusal without retrying the already marked sink", (): void => {
        const reported = new WeakSet<FailureNoticeSink>();
        const sink: FailureNoticeSink = {
          write(): never {
            throw new TypeError("synthetic notice refusal");
          },
        };
        const warn = vi.spyOn(process, "emitWarning").mockImplementation((): never => {
          throw new TypeError("synthetic warning method refusal");
        });
        try {
          expect((): void => {
            reportFailure(sink, "test.delivery", undefined, reported, failureNotice);
          }).not.toThrow();
          reportFailure(sink, "test.delivery", undefined, reported, failureNotice);
          expect(warn).toHaveBeenCalledTimes(1);
          expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
        } finally {
          warn.mockRestore();
        }
      });

      it("contains both cause getters and revoked proxies without reading callable properties", (): void => {
        const trace: string[] = [];
        let callableReads = 0;
        const callable = (): void => undefined;
        Object.defineProperty(callable, "code", {
          get(): never {
            callableReads += 1;
            throw new TypeError("unexpected callable read");
          },
        });
        const hostile = new Proxy(
          {},
          {
            get(_target, key): never {
              trace.push(String(key));
              throw new TypeError("synthetic cause getter refusal");
            },
          },
        );
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        const notices: FailureNotice[] = [];
        const sink: FailureNoticeSink = { write: (notice): void => void notices.push(notice) };
        for (const cause of [callable, hostile, revoked.proxy]) {
          reportFailure(
            sink,
            "test.delivery",
            cause,
            new WeakSet<FailureNoticeSink>(),
            failureNotice,
          );
        }
        expect(trace).toEqual(["code", "name"]);
        expect(callableReads).toBe(0);
        expect(notices.map((notice): string => notice.failureKind)).toEqual([
          "unknown",
          "unknown",
          "unknown",
        ]);
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
      });
    });
  }
});
