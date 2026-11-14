import { afterEach, describe, expect, it } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import { liveProcessHasLaunchId } from "./ui-process-identity.js";

// #4351: the Windows process-identity query reports a slow or unavailable run to the sink of the
// command that asked. The CLI used to ask without one, so the line was lost as an unwired port.
describe("the Windows launch-identity check of the CLI", () => {
  afterEach(() => {
    resetActivityLogLossCountersForTests();
  });

  it("writes its unavailable-run line to the sink it was given and counts no unwired port", () => {
    resetActivityLogLossCountersForTests();
    const events: SecurityLogEvent[] = [];
    const securityLogSink: SecurityLogSink = { write: (event) => void events.push(event) };
    // PowerShell cannot be resolved on this host, which is the unavailable path of the query.
    const alive = liveProcessHasLaunchId(4711, "launch-id", {
      platform: "win32",
      readEnviron: () => undefined,
      securityLogSink,
    });
    expect(alive).toBe(false);
    expect(events.map((event) => event.op)).toContain("security.windows-program.run");
    expect(activityLogLossCounters()["port-unwired"]).toBe(0);
  });
});
