import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logHasGracefulProcessExit, readLogSuffix } from "../installable-package-smoke.mjs";

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

  it("rejects null, empty, malformed, and near-miss records", () => {
    expect(logHasGracefulProcessExit("null\n")).toBe(false);
    expect(logHasGracefulProcessExit("\n")).toBe(false);
    expect(logHasGracefulProcessExit("{not-json}\n")).toBe(false);
    expect(logHasGracefulProcessExit(line({ op: "process.heartbeat", reason: "sigterm" }))).toBe(
      false,
    );
  });

  it("reads the log suffix as bytes so a multibyte prefix cannot hide the appended exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-smoke-log-"));
    const logPath = join(dir, "server.log");
    try {
      const prefix = '{"message":"é"}\n';
      const suffix = line({ op: "process.exiting", reason: "sigterm" });
      writeFileSync(logPath, prefix + suffix);
      const offset = Buffer.byteLength(prefix);
      expect(logHasGracefulProcessExit(readLogSuffix(logPath, offset))).toBe(true);
      expect(logHasGracefulProcessExit(readLogSuffix(logPath, 0).slice(offset))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
