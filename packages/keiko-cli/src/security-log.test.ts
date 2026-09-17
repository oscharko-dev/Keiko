import { describe, expect, it } from "vitest";
import {
  type SecurityLogEvent,
  type SecurityLogSink,
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";
import {
  createCliSecurityLogSink,
  createIsolatedCliFailureSink,
  emitCliWindowsSystemFailure,
  type CliWindowsSystemSurface,
} from "./security-log.js";

describe("createCliSecurityLogSink", () => {
  it("binds body-free security events to one truthful CLI invocation correlation", () => {
    const events: SecurityLogEvent[] = [];
    const stateDirs: string[] = [];
    const factory = (stateDir: string): SecurityLogSink => {
      stateDirs.push(stateDir);
      return {
        write(event): void {
          events.push(event);
        },
      };
    };
    const sink = createCliSecurityLogSink("/state", factory);

    expect(stateDirs).toEqual([]);

    sink?.write({
      category: "security",
      op: "security.windows-shortcut.system-root-refused",
      correlationId: "untrusted-event-correlation",
      errorKind: "WindowsSystemDirectoryError",
      extra: { mode: "read" },
    });
    sink?.write({
      category: "security",
      op: "security.windows-shortcut.system-root-refused",
      extra: { mode: "create" },
    });

    expect(stateDirs).toEqual(["/state"]);
    expect(events).toHaveLength(2);
    expect(events[0]?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(events[1]?.correlationId).toBe(events[0]?.correlationId);
    expect(JSON.stringify(events)).not.toContain("untrusted-event-correlation");
  });

  it("does not create correlation state when no production sink was wired", () => {
    expect(createCliSecurityLogSink("/state", undefined)).toBeUndefined();
  });

  it("preserves an invocation correlation supplied by the composition owner", () => {
    const events: SecurityLogEvent[] = [];
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const sink = createCliSecurityLogSink(
      "/state",
      () => ({ write: (event): void => void events.push(event) }),
      correlationId,
    );

    sink?.write({ category: "diagnostic", op: "cli.audit.started" });

    expect(events).toEqual([expect.objectContaining({ op: "cli.audit.started", correlationId })]);
  });
});

describe("createIsolatedCliFailureSink", () => {
  it("refuses an overlapping failure root before the factory can mutate the target", () => {
    let factoryCalls = 0;
    const sink = createIsolatedCliFailureSink(
      "/target",
      "/target/control-failures",
      () => {
        factoryCalls += 1;
        return { write: (): void => undefined };
      },
      "00000000-0000-4000-8000-000000000001",
    );

    expect(sink).toBeUndefined();
    expect(factoryCalls).toBe(0);
  });

  it("preserves the invocation correlation when the failure root is isolated", () => {
    const events: SecurityLogEvent[] = [];
    const correlationId = "00000000-0000-4000-8000-000000000001";
    const sink = createIsolatedCliFailureSink(
      "/target",
      "/control-failures",
      () => ({ write: (event): void => void events.push(event) }),
      correlationId,
    );

    sink?.write({ category: "diagnostic", op: "cli.audit.failed" });

    expect(events).toEqual([expect.objectContaining({ correlationId })]);
  });
});

describe("emitCliWindowsSystemFailure", () => {
  const operations: readonly (readonly [CliWindowsSystemSurface, string, string])[] = [
    [
      "launcher-install",
      "security.windows-launcher.system-root-refused",
      "security.windows-launcher.system-binary-missing",
    ],
    [
      "legacy-start-menu-cleanup",
      "security.windows-portable-legacy-launcher.system-root-refused",
      "security.windows-portable-legacy-launcher.system-binary-missing",
    ],
    [
      "portable-failure-alert",
      "security.windows-portable-alert.system-root-refused",
      "security.windows-portable-alert.system-binary-missing",
    ],
    [
      "start-open-browser",
      "security.windows-lifecycle-opener.system-root-refused",
      "security.windows-lifecycle-opener.system-binary-missing",
    ],
  ];

  function recordingSink(): {
    readonly events: SecurityLogEvent[];
    readonly sink: SecurityLogSink;
  } {
    const events: SecurityLogEvent[] = [];
    return { events, sink: { write: (event): void => void events.push(event) } };
  }

  it.each(operations)(
    "maps %s to fixed root-refusal and binary-missing events",
    (surface, rootRefused, binaryMissing) => {
      const { events, sink } = recordingSink();
      const sensitive = String.raw`C:\Users\Sensitive\planted-helper.exe`;

      expect(
        emitCliWindowsSystemFailure(new WindowsSystemDirectoryError(sensitive), sink, surface),
      ).toBe(true);
      expect(
        emitCliWindowsSystemFailure(new WindowsSystemBinaryMissingError(), sink, surface),
      ).toBe(true);
      expect(events).toEqual([
        {
          category: "security",
          errorKind: "WindowsSystemDirectoryError",
          extra: { surface },
          level: "warn",
          op: rootRefused,
        },
        {
          category: "diagnostic",
          errorKind: "WINDOWS_SYSTEM_BINARY_MISSING",
          extra: { surface },
          level: "error",
          op: binaryMissing,
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("Sensitive");
    },
  );

  it("leaves unrelated errors outside the Windows-system failure contract", () => {
    const { events, sink } = recordingSink();

    expect(emitCliWindowsSystemFailure(new Error("unrelated"), sink, "launcher-install")).toBe(
      false,
    );
    expect(events).toEqual([]);
  });
});
