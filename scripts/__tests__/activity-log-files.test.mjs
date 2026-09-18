import {
  appendFileSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityLogPinFileName,
  activityLogSegmentFileName,
  formatActivityLogSegmentId,
  orderActivityLogFileNames,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  activityLogDirectory,
  activityLogFiles,
  activityLogSnapshot,
  readActivityLogSince,
  readActivityLogText,
} from "../lib/activity-log-files.mjs";

const IDENTITY = {
  startMs: Date.parse("2026-09-18T10:00:00.000Z"),
  pid: 999,
  instanceId: "a1b2c3d4",
  index: 1,
};

function segment(overrides, state) {
  return activityLogSegmentFileName({ ...IDENTITY, ...overrides }, state);
}

function line(op) {
  return `${JSON.stringify({ op })}\n`;
}

describe("activity-log-files (repository tooling reader)", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-tooling-activity-log-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the logs directory of a state directory", () => {
    expect(activityLogDirectory("/state")).toBe(join("/state", "logs"));
  });

  it("reads nothing, and never throws, when the logs directory does not exist", () => {
    const missing = join(dir, "missing");
    expect(activityLogFiles(missing)).toEqual([]);
    expect(readActivityLogText(missing)).toBe("");
    expect(readActivityLogSince(missing, activityLogSnapshot(missing))).toBe("");
  });

  it("lists regular files in the shared logical order, never by name, with stable keys", () => {
    const names = [
      segment({ pid: 10_000 }, "sealed"),
      segment({}, "sealed"),
      segment({ index: 2 }, "active"),
      "server.log",
      "server-2026-09-17.log",
    ];
    for (const name of names) writeFileSync(join(dir, name), line(name), { mode: 0o600 });
    writeFileSync(join(dir, activityLogPinFileName("0123456789abcdef01234567")), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "operator\n");
    symlinkSync(join(dir, "notes.txt"), join(dir, "server-2026-09-01.log"));
    const expected = orderActivityLogFileNames(names).map((file) => file.name);
    expect(expected).not.toEqual([...names].sort());

    const files = activityLogFiles(dir);

    expect(files.map((file) => file.name)).toEqual(expected);
    expect(files.find((file) => file.name === "server.log")?.key).toBe("server.log");
    expect(files.find((file) => file.name === segment({}, "sealed"))?.key).toBe(
      formatActivityLogSegmentId(IDENTITY),
    );
  });

  it("joins every file's lines oldest first and never merges a torn tail into the next file", () => {
    writeFileSync(join(dir, "server.log"), `${line("legacy")}{"op":"torn`);
    writeFileSync(join(dir, segment({}, "active")), line("segment"));

    expect(readActivityLogText(dir)).toBe(`${line("legacy")}{"op":"torn\n${line("segment")}`);
  });

  it("reads a segment caught mid-seal once, under its sealed name", () => {
    writeFileSync(join(dir, segment({}, "sealed")), line("once"));
    linkSync(join(dir, segment({}, "sealed")), join(dir, segment({}, "active")));

    expect(readActivityLogText(dir)).toBe(line("once"));
  });

  it("reads only what was appended after a snapshot, across a seal and a new segment", () => {
    const active = join(dir, segment({}, "active"));
    const prefix = `${JSON.stringify({ op: "before", note: "é" })}\n`;
    writeFileSync(active, prefix);
    const snapshot = activityLogSnapshot(dir);

    appendFileSync(active, line("appended"));
    renameSync(active, join(dir, segment({}, "sealed")));
    writeFileSync(join(dir, segment({ index: 2 }, "active")), line("next-segment"));

    expect(readActivityLogSince(dir, snapshot)).toBe(`${line("appended")}${line("next-segment")}`);
    expect(readActivityLogText(dir)).toBe(`${prefix}${line("appended")}${line("next-segment")}`);
  });

  it("reads a file smaller than its snapshot whole, as a replaced file", () => {
    writeFileSync(join(dir, "server.log"), `${line("old-a")}${line("old-b")}`);
    const snapshot = activityLogSnapshot(dir);
    writeFileSync(join(dir, "server.log"), line("new"));

    expect(readActivityLogSince(dir, snapshot)).toBe(line("new"));
  });
});
