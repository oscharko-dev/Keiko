// New internal warning API: Same-only proof; no Original import or ROOT warning export.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
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
