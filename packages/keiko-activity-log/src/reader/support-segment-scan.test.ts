import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_LOG_DIRECTORY_NAME,
  ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
  activityLogSegmentFileName,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  fixtureLine,
  fixtureProcess,
  segmentIdentity,
  writeFixtureSegment,
} from "../../../../tests/support/activity-log-segments.js";
import { ActivityLogScanner, listActivityLogStoreFiles } from "./support-segment-scan.js";

// The names a racing retention pass removed after the directory was listed: the listing still
// reports them, and no file exists under them when they are inspected.
const raced = vi.hoisted(() => ({ directory: "", names: [] as string[] }));

// Only this file replaces the directory listing; every other `node:fs` function is the real one.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>): unknown => {
      const listed: unknown = actual.readdirSync(...args);
      if (!Array.isArray(listed) || String(args[0]) !== raced.directory) return listed;
      return [...listed.filter((name): name is string => typeof name === "string"), ...raced.names];
    },
  };
});

const T0 = Date.UTC(2026, 8, 18, 9, 0, 0);
const CORRELATION = "segment-scan-0000001";
let stateDir: string;
let logsDirectory: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-segment-scan-"));
  logsDirectory = join(stateDir, ACTIVITY_LOG_DIRECTORY_NAME);
  raced.directory = logsDirectory;
});

afterEach(() => {
  raced.directory = "";
  raced.names.length = 0;
  rmSync(stateDir, { recursive: true, force: true });
});

function writeSegment(pid: number, startMs: number): string {
  const process = fixtureProcess(pid, `aaaa${String(pid)}`);
  return writeFixtureSegment(stateDir, segmentIdentity(process, startMs, 1), [
    fixtureLine(process, startMs, { op: "client.diagnostic", correlationId: CORRELATION }),
  ]);
}

describe("Activity Log store listing", () => {
  it("omits a listed segment that vanished before it was inspected, without throwing", () => {
    const first = writeSegment(4101, T0);
    const third = writeSegment(4103, T0 + 2000);
    const vanished = activityLogSegmentFileName(
      segmentIdentity(fixtureProcess(4102, "aaaa4102"), T0 + 1000, 1),
      "sealed",
    );
    raced.names.push(vanished);
    // The listing names the vanished segment between the two real ones, and no file backs it.
    expect(readdirSync(logsDirectory)).toContain(vanished);
    expect(existsSync(join(logsDirectory, vanished))).toBe(false);

    const files = listActivityLogStoreFiles(stateDir);
    expect(files.map((file) => file.name)).toEqual([basename(first), basename(third)]);
    // The omitted name leaves no hole in the logical order.
    expect(files.map((file) => file.order)).toEqual([0, 1]);
  });

  it("lists nothing, without throwing, when every listed name vanished", () => {
    mkdirSync(logsDirectory, { mode: 0o700 });
    raced.names.push(
      activityLogSegmentFileName(
        segmentIdentity(fixtureProcess(4101, "aaaa4101"), T0, 1),
        "sealed",
      ),
      ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME,
    );
    expect(readdirSync(logsDirectory)).toHaveLength(2);
    expect(listActivityLogStoreFiles(stateDir)).toEqual([]);
  });
});

describe("Activity Log entries that are not private regular files", () => {
  function writeVictim(): string {
    const victim = join(stateDir, "victim.jsonl");
    const process = fixtureProcess(4101, "aaaa4101");
    const line = fixtureLine(process, T0, { op: "client.diagnostic", correlationId: CORRELATION });
    writeFileSync(victim, `${line}\n`, { mode: 0o600 });
    return victim;
  }

  function plant(kind: string, segment: string, victim: string): void {
    rmSync(segment, { recursive: true, force: true });
    if (kind === "directory") mkdirSync(segment, { mode: 0o700 });
    else if (kind === "dangling-symlink") symlinkSync(join(stateDir, "missing-victim"), segment);
    else linkSync(victim, segment);
  }

  it.each(["directory", "dangling-symlink", "hard-link"])(
    "lists a %s at a segment name and never reads through it",
    (kind) => {
      const segment = writeSegment(4101, T0);
      const victim = writeVictim();
      const victimBytes = readFileSync(victim);
      plant(kind, segment, victim);

      // It is listed, never silently missing from a selection's evidence, and holds no bytes of
      // its own: only a hard link reports the size of the file it shares.
      const [file, ...others] = listActivityLogStoreFiles(stateDir);
      expect(others).toEqual([]);
      expect(file).toMatchObject({
        name: basename(segment),
        kind: "sealed",
        sizeBytes: kind === "hard-link" ? victimBytes.length : 0,
        order: 0,
      });
      if (file === undefined) throw new TypeError("the entry was not listed");

      // Opening it is refused, so it is named unreadable and nothing is read.
      const scanner = new ActivityLogScanner(stateDir);
      expect(Array.from(scanner.scan(file))).toEqual([]);
      expect(scanner.drain(file)).toBeUndefined();
      expect([...scanner.unreadable]).toEqual([basename(segment)]);
      expect(scanner.scannedBytes).toBe(0);
      expect(scanner.scannedLines).toBe(0);
      expect(scanner.manifestOf(file)).toBeUndefined();
      expect(readFileSync(victim).equals(victimBytes)).toBe(true);
      expect(statSync(victim).mode & 0o777).toBe(0o600);
      expect(existsSync(join(stateDir, "missing-victim"))).toBe(false);
    },
  );

  it("lists a directory at the legacy current file name and never reads through it", () => {
    mkdirSync(join(logsDirectory, ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME), {
      recursive: true,
      mode: 0o700,
    });
    const segment = writeSegment(4101, T0);
    const files = listActivityLogStoreFiles(stateDir);
    // The legacy file precedes every segment in the one logical log.
    expect(files.map((file) => [file.name, file.kind, file.sizeBytes, file.order])).toEqual([
      [ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME, "legacy-current", 0, 0],
      [basename(segment), "sealed", statSync(segment).size, 1],
    ]);
    const [legacy, readable] = files;
    if (legacy === undefined || readable === undefined) throw new TypeError("entries not listed");

    const scanner = new ActivityLogScanner(stateDir);
    expect(Array.from(scanner.scan(legacy))).toEqual([]);
    expect([...scanner.unreadable]).toEqual([ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME]);
    // The readable segment next to it is still read in full.
    expect(Array.from(scanner.scan(readable)).map((line) => line.index)).toEqual([0]);
    expect([...scanner.unreadable]).toEqual([ACTIVITY_LOG_LEGACY_CURRENT_FILE_NAME]);
  });
});
