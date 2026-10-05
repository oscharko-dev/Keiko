import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supportIncidentFileName } from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  countSupportIncidentEntries,
  ensureSupportIncidentDirectory,
  isSupportIncidentRecordAbsent,
  supportIncidentDirectory,
} from "./support-incident-store.js";
import {
  recordUserReportedIncident,
  setSupportIncidentTriggerForTests,
} from "./support-incident.js";
import { closeFileServerLogSinks, resetServerLogFailureNotices } from "./server-log.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    lstatSync: vi.fn(original.lstatSync),
    openSync: vi.fn(original.openSync),
    readdirSync: vi.fn(original.readdirSync),
    readSync: vi.fn(original.readSync),
  };
});

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-incident-count-"));
  setSupportIncidentTriggerForTests(false);
});
afterEach(() => {
  closeFileServerLogSinks();
  resetServerLogFailureNotices();
  setSupportIncidentTriggerForTests(undefined);
  vi.clearAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("incident count directory projection", () => {
  it("counts valid and torn records without opening bodies or following planted names", () => {
    expect(recordUserReportedIncident(stateDir).status).toBe("created");
    const directory = ensureSupportIncidentDirectory(stateDir);
    writeFileSync(join(directory, supportIncidentFileName("a".repeat(32))), "{torn");
    writeFileSync(join(directory, "foreign.json"), "private value");
    mkdirSync(join(directory, supportIncidentFileName("b".repeat(32))));
    symlinkSync(
      join(directory, "foreign.json"),
      join(directory, supportIncidentFileName("c".repeat(32))),
    );
    vi.clearAllMocks();

    expect(countSupportIncidentEntries(stateDir)).toBe(2);
    expect(readdirSync).toHaveBeenCalledExactlyOnceWith(directory, { withFileTypes: true });
    expect(openSync).not.toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
    expect(lstatSync).not.toHaveBeenCalled();
  });

  it("returns zero for an absent store and never creates it", () => {
    vi.clearAllMocks();
    expect(countSupportIncidentEntries(stateDir)).toBe(0);
    expect(readdirSync).toHaveBeenCalledExactlyOnceWith(supportIncidentDirectory(stateDir), {
      withFileTypes: true,
    });
    expect(openSync).not.toHaveBeenCalled();
    expect(() => lstatSync(supportIncidentDirectory(stateDir))).toThrow();
  });

  it("preserves actual directory errors instead of reporting an empty store", () => {
    writeFileSync(supportIncidentDirectory(stateDir), "occupied");
    expect(() => countSupportIncidentEntries(stateDir)).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});

describe("withdrawn incident metadata", () => {
  it("requires actual absence, keeping empty, torn and planted entries occupied without reading bodies", () => {
    const directory = ensureSupportIncidentDirectory(stateDir);
    writeFileSync(join(directory, supportIncidentFileName("a".repeat(32))), "");
    writeFileSync(join(directory, supportIncidentFileName("b".repeat(32))), "{torn");
    mkdirSync(join(directory, supportIncidentFileName("c".repeat(32))));
    symlinkSync(
      join(directory, "absent"),
      join(directory, supportIncidentFileName("d".repeat(32))),
    );
    vi.clearAllMocks();

    for (const prefix of ["a", "b", "c", "d"])
      expect(isSupportIncidentRecordAbsent(stateDir, prefix.repeat(32))).toBe(false);
    expect(isSupportIncidentRecordAbsent(stateDir, "e".repeat(32))).toBe(true);
    expect(openSync).not.toHaveBeenCalled();
    expect(readSync).not.toHaveBeenCalled();
    expect(readdirSync).not.toHaveBeenCalled();
    expect(lstatSync).toHaveBeenCalledTimes(5);
    expect(isSupportIncidentRecordAbsent(stateDir, "../foreign")).toBe(false);
    expect(lstatSync).toHaveBeenCalledTimes(5);
  });

  it("preserves metadata access errors instead of authorizing a retry", () => {
    writeFileSync(supportIncidentDirectory(stateDir), "occupied");
    expect(() => isSupportIncidentRecordAbsent(stateDir, "a".repeat(32))).toThrow(
      expect.objectContaining({ code: "ENOTDIR" }),
    );
  });
});
