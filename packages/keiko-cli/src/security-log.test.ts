import { describe, expect, it } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import { createCliSecurityLogSink } from "./security-log.js";

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
});
