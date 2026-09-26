import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activityLogSegmentFileName } from "@oscharko-dev/keiko-contracts/runtime/observability";
import { logHasGracefulProcessExit } from "../installable-package-smoke.mjs";
import { activityLogSnapshot, readActivityLogSince } from "../lib/activity-log-files.mjs";

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

  // #3530: the stop proof reads only what the stop appended to the segmented Activity Log, by
  // bytes and by stable segment id, so an earlier restart's exit cannot satisfy it, a multibyte
  // prefix cannot hide the new exit, and a seal between the snapshot and the read is not re-read.
  it("inspects only what the stop appended, across a seal and a new segment", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-smoke-log-"));
    const identity = {
      startMs: Date.parse("2026-09-18T10:00:00.000Z"),
      pid: 4242,
      instanceId: "a1b2c3d4",
      index: 1,
    };
    const active = join(dir, activityLogSegmentFileName(identity, "active"));
    try {
      writeFileSync(
        active,
        `{"message":"é"}\n${line({ op: "process.exiting", reason: "sigterm" })}`,
      );
      const snapshot = activityLogSnapshot(dir);
      expect(logHasGracefulProcessExit(readActivityLogSince(dir, snapshot))).toBe(false);

      appendFileSync(active, line({ op: "process.heartbeat", extra: { rssBytes: 1 } }));
      renameSync(active, join(dir, activityLogSegmentFileName(identity, "sealed")));
      expect(logHasGracefulProcessExit(readActivityLogSince(dir, snapshot))).toBe(false);
      writeFileSync(
        join(dir, activityLogSegmentFileName({ ...identity, index: 2 }, "active")),
        line({ op: "process.exiting", reason: "sigterm" }),
      );
      expect(logHasGracefulProcessExit(readActivityLogSince(dir, snapshot))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
