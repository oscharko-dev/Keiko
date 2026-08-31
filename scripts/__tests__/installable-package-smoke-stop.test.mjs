import { describe, expect, it } from "vitest";
import { logHasGracefulProcessExit } from "../installable-package-smoke.mjs";

function line(event) {
  return `${JSON.stringify(event)}\n`;
}

describe("logHasGracefulProcessExit", () => {
  it("accepts process.exiting with shutdown-request on the same record", () => {
    expect(
      logHasGracefulProcessExit(
        line({ op: "process.exiting", extra: { reason: "shutdown-request" } }),
      ),
    ).toBe(true);
  });

  it("accepts process.exiting with extra.reason sigterm", () => {
    expect(
      logHasGracefulProcessExit(line({ op: "process.exiting", extra: { reason: "sigterm" } })),
    ).toBe(true);
  });

  it("accepts the on-disk v2 envelope with flattened reason", () => {
    expect(
      logHasGracefulProcessExit(line({ op: "process.exiting", reason: "sigterm", uptimeMs: 12 })),
    ).toBe(true);
  });

  it("ignores a prior restart event when only the suffix is inspected", () => {
    const prior = line({ op: "process.exiting", reason: "sigterm" });
    const suffix = line({ op: "process.heartbeat", extra: { rssBytes: 1 } });
    expect(logHasGracefulProcessExit(prior + suffix)).toBe(true);
    expect(logHasGracefulProcessExit(suffix)).toBe(false);
  });

  it("rejects split records that only together mention both fields", () => {
    const split =
      line({ op: "process.exiting", extra: { reason: "sigint" } }) +
      line({ op: "cli.lifecycle.stop-requested", extra: { channel: "shutdown-request" } });
    expect(logHasGracefulProcessExit(split)).toBe(false);
  });

  it("rejects a forced drain reason", () => {
    expect(
      logHasGracefulProcessExit(line({ op: "process.exiting", extra: { reason: "forced" } })),
    ).toBe(false);
  });
});
