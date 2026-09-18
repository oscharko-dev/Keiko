import { describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
  activityLogPinFileName,
  activityLogSegmentFileName,
  formatActivityLogSegmentId,
  isActivityLogOwnedFileName,
  orderActivityLogFileNames,
  parseActivityLogFileName,
  parseActivityLogPinFileName,
  parseActivityLogSegmentId,
  readableActivityLogFileNames,
  type ActivityLogSegmentIdentity,
} from "./observability.js";

const SEGMENT: ActivityLogSegmentIdentity = {
  startMs: Date.UTC(2026, 8, 18, 12, 0, 0, 123),
  pid: 4242,
  instanceId: "0a1b2c3d",
  index: 7,
};

describe("Activity Log file-name grammar", () => {
  it("round-trips one stable segment id through its active and sealed names", () => {
    const id = formatActivityLogSegmentId(SEGMENT);
    expect(id).toBe("20260918T120000123Z-4242-0a1b2c3d-000007");
    expect(parseActivityLogSegmentId(id)).toStrictEqual(SEGMENT);

    const active = activityLogSegmentFileName(SEGMENT, "active");
    const sealed = activityLogSegmentFileName(SEGMENT, "sealed");
    expect(active).toBe(`activity-${id}.active.jsonl`);
    expect(sealed).toBe(`activity-${id}.jsonl`);
    expect(parseActivityLogFileName(active)).toStrictEqual({
      kind: "active",
      name: active,
      segmentId: id,
      ...SEGMENT,
    });
    expect(parseActivityLogFileName(sealed)).toStrictEqual({
      kind: "sealed",
      name: sealed,
      segmentId: id,
      ...SEGMENT,
    });
  });

  it("keeps indexes past six digits canonical instead of truncating them", () => {
    const large = { ...SEGMENT, index: 1_234_567 };
    const id = formatActivityLogSegmentId(large);
    expect(id.endsWith("-1234567")).toBe(true);
    expect(parseActivityLogSegmentId(id)).toStrictEqual(large);
  });

  it("refuses to format an identity outside the closed grammar", () => {
    for (const invalid of [
      { ...SEGMENT, startMs: -1 },
      { ...SEGMENT, startMs: 1.5 },
      { ...SEGMENT, startMs: Date.UTC(10_000, 0, 1) },
      { ...SEGMENT, pid: 0 },
      { ...SEGMENT, pid: 2_147_483_648 },
      { ...SEGMENT, instanceId: "0A1B2C3D" },
      { ...SEGMENT, instanceId: "0a1b2c3" },
      { ...SEGMENT, index: 0 },
      { ...SEGMENT, index: 1_000_000_000 },
    ]) {
      expect(() => formatActivityLogSegmentId(invalid)).toThrow(RangeError);
    }
  });

  it("rejects every non-canonical or hostile spelling of a segment name", () => {
    const id = formatActivityLogSegmentId(SEGMENT);
    for (const name of [
      `activity-${id}.jsonl.bak`,
      `activity-${id}.active.json`,
      `activity-${id}.ACTIVE.jsonl`,
      `activity-${id}`,
      `x-activity-${id}.jsonl`,
      `activity-../${id}.jsonl`,
      "activity-20260231T120000123Z-4242-0a1b2c3d-000007.jsonl",
      "activity-20260918T246000123Z-4242-0a1b2c3d-000007.jsonl",
      "activity-20260918T120000123Z-0-0a1b2c3d-000007.jsonl",
      "activity-20260918T120000123Z-04242-0a1b2c3d-000007.jsonl",
      "activity-20260918T120000123Z-4242-0A1B2C3D-000007.jsonl",
      "activity-20260918T120000123Z-4242-0a1b2c3d-0000007.jsonl",
      "activity-20260918T120000123Z-4242-0a1b2c3d-000000.jsonl",
      "activity-20260918T120000123Z-4242-0a1b2c3d-7.jsonl",
    ]) {
      expect(parseActivityLogFileName(name), name).toBeUndefined();
    }
    expect(parseActivityLogSegmentId(`${id}-extra`)).toBeUndefined();
  });

  it("admits only the legacy current file and real calendar-day archives", () => {
    expect(parseActivityLogFileName(ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME)).toStrictEqual({
      kind: "legacy-current",
      name: "server.log",
    });
    expect(parseActivityLogFileName("server-2026-09-17.log")).toStrictEqual({
      kind: "legacy-archive",
      name: "server-2026-09-17.log",
      dayStartMs: Date.UTC(2026, 8, 17),
    });
    for (const name of [
      "server-2026-02-30.log",
      "server-2026-13-01.log",
      "server-2026-9-17.log",
      "server-2026-09-17.log.bak",
      "server.log.1",
      "Server.log",
      "ui.log",
    ]) {
      expect(parseActivityLogFileName(name), name).toBeUndefined();
    }
  });

  it("orders the logical log oldest first and drops every name outside the grammar", () => {
    const earlier = activityLogSegmentFileName(
      { ...SEGMENT, startMs: SEGMENT.startMs - 1 },
      "sealed",
    );
    const peerSamePid = activityLogSegmentFileName(
      { ...SEGMENT, instanceId: "ffffffff" },
      "sealed",
    );
    const lowerPid = activityLogSegmentFileName({ ...SEGMENT, pid: 7 }, "active");
    const sealed = activityLogSegmentFileName(SEGMENT, "sealed");
    const activeTwin = activityLogSegmentFileName(SEGMENT, "active");
    const next = activityLogSegmentFileName({ ...SEGMENT, index: 8 }, "active");
    const ordered = orderActivityLogFileNames([
      next,
      "notes.txt",
      activeTwin,
      "server.log",
      sealed,
      peerSamePid,
      "server-2026-09-17.log",
      lowerPid,
      "pin-0123456789abcdef01234567.json",
      "server-2026-09-01.log",
      earlier,
    ]).map((file) => file.name);

    expect(ordered).toStrictEqual([
      "server-2026-09-01.log",
      "server-2026-09-17.log",
      "server.log",
      earlier,
      lowerPid,
      sealed,
      activeTwin,
      next,
      peerSamePid,
    ]);
  });

  it("reads one name per segment, dropping an active name shadowed by its sealed twin", () => {
    const sealed = activityLogSegmentFileName(SEGMENT, "sealed");
    const activeTwin = activityLogSegmentFileName(SEGMENT, "active");
    const next = activityLogSegmentFileName({ ...SEGMENT, index: 8 }, "active");
    const ordered = orderActivityLogFileNames(["server.log", next, activeTwin, sealed]);

    expect(readableActivityLogFileNames(ordered).map((file) => file.name)).toStrictEqual([
      "server.log",
      sealed,
      next,
    ]);
    // Without a sealed twin, an active segment is the live file and is read.
    expect(
      readableActivityLogFileNames(orderActivityLogFileNames([activeTwin])).map((f) => f.name),
    ).toStrictEqual([activeTwin]);
  });

  it("names retention-pin records with a closed id grammar", () => {
    const pinId = "0123456789abcdef01234567";
    const name = activityLogPinFileName(pinId);
    expect(name).toBe(`pin-${pinId}.json`);
    expect(parseActivityLogPinFileName(name)).toBe(pinId);
    for (const invalid of [
      "pin-0123456789ABCDEF01234567.json",
      "pin-0123456789abcdef0123456.json",
      "pin-0123456789abcdef01234567.json.tmp",
      "pin-.json",
    ]) {
      expect(parseActivityLogPinFileName(invalid), invalid).toBeUndefined();
    }
    expect(() => activityLogPinFileName("../escape")).toThrow(RangeError);
  });

  it("claims exactly the grammar as owned, never an operator file", () => {
    expect(isActivityLogOwnedFileName("server.log")).toBe(true);
    expect(isActivityLogOwnedFileName("server-2026-09-17.log")).toBe(true);
    expect(isActivityLogOwnedFileName(activityLogSegmentFileName(SEGMENT, "active"))).toBe(true);
    expect(isActivityLogOwnedFileName("pin-0123456789abcdef01234567.json")).toBe(true);
    expect(isActivityLogOwnedFileName("operator-notes.txt")).toBe(false);
    expect(isActivityLogOwnedFileName("server-2026-09-17.log.bak")).toBe(false);
  });
});
