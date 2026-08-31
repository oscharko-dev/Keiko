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

  it("accepts process.exiting with sigterm on the same record", () => {
    expect(
      logHasGracefulProcessExit(line({ op: "process.exiting", extra: { reason: "sigterm" } })),
    ).toBe(true);
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
