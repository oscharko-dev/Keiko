import { afterEach, describe, expect, it } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import { keyFromKeychain } from "./cipher.js";

// #4351: a withheld or unavailable keychain leaves its registered line on the sink the caller names
// and is never lost as an unwired port. The login keychain is never touched: the first case is
// withheld by the operator switch, the second runs a stand-in executable that does not exist.
describe("the memory vault's keychain tier", () => {
  afterEach(() => {
    resetActivityLogLossCountersForTests();
  });

  function recording(): { readonly sink: SecurityLogSink; readonly ops: () => string[] } {
    const events: SecurityLogEvent[] = [];
    return {
      sink: { write: (event) => void events.push(event) },
      ops: () => events.map((e) => e.op),
    };
  }

  it("writes the withheld line to the caller's sink", () => {
    resetActivityLogLossCountersForTests();
    const log = recording();
    const key = keyFromKeychain({
      sink: log.sink,
      platform: "darwin",
      env: { KEIKO_OS_KEYCHAIN: "off" },
    });
    expect(key).toBeUndefined();
    expect(log.ops()).toContain("security.keychain.withheld");
    expect(activityLogLossCounters()["port-unwired"]).toBe(0);
  });

  it("writes the fallback line to the caller's sink when the keychain is unavailable", () => {
    resetActivityLogLossCountersForTests();
    const log = recording();
    const key = keyFromKeychain({
      sink: log.sink,
      platform: "darwin",
      executable: "/nonexistent/keiko-test-security",
      env: {},
    });
    expect(key).toBeUndefined();
    expect(log.ops()).toContain("security.keychain.fallback");
    expect(activityLogLossCounters()["port-unwired"]).toBe(0);
  });
});
