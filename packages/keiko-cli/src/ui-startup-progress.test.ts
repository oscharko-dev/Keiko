import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEIKO_STATE_FILES } from "./state-paths.js";
import {
  beginUiStartupProgress,
  readUiStartupSign,
  UI_STARTUP_MAX_HORIZON_MS,
  uiStartupProgressPath,
  type UiStartupProgress,
} from "./ui-startup-progress.js";

const LAUNCH_ID = "ab".repeat(16);
const OTHER_LAUNCH_ID = "cd".repeat(16);

let stateDir: string;
let active: UiStartupProgress | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-startup-progress-"));
});

afterEach(() => {
  active?.stop();
  active = undefined;
  rmSync(stateDir, { recursive: true, force: true });
});

function begin(launchId = LAUNCH_ID): UiStartupProgress {
  active = beginUiStartupProgress(stateDir, launchId);
  return active;
}

/** Keeps the main thread busy, as code loading does, until `done` holds or `limitMs` passed. */
function workUntil(done: () => boolean, limitMs: number): boolean {
  const startedAt = performance.now();
  let spin = 0;
  while (performance.now() - startedAt < limitMs) {
    for (let index = 0; index < 2_000_000; index += 1) spin = (spin + index) % 9973;
    if (done()) return true;
  }
  return done();
}

describe("UI startup sign of life", () => {
  it("records a first sign at once, as one fixed-width line without a path or account", () => {
    begin();
    const text = readFileSync(uiStartupProgressPath(stateDir), "utf8");
    expect(text).toMatch(/^[0-9a-f]{32} \d{16} 0000000\n$/u);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)).toMatchObject({ horizonMs: 0 });
    expect(KEIKO_STATE_FILES).toContain("ui.starting");
  });

  // The main thread is busy for the whole wait and never returns to the event loop: only the worker
  // thread can have written the new record.
  it("keeps recording while the main thread is busy and cannot run a timer", () => {
    begin();
    const first = readUiStartupSign(stateDir, LAUNCH_ID)?.token;
    const changed = workUntil(
      () => readUiStartupSign(stateDir, LAUNCH_ID)?.token !== first,
      20_000,
    );
    expect(changed).toBe(true);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(0);
  });

  it("announces the bound of a blocking step and clamps it", () => {
    const progress = begin();
    progress.announce(70_000);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(70_000);
    progress.announce(10 * UI_STARTUP_MAX_HORIZON_MS);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(UI_STARTUP_MAX_HORIZON_MS);
    progress.announce(-5);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(0);
  });

  it("removes the record when the start is over, and stays removed", () => {
    const progress = begin();
    progress.stop();
    progress.stop();
    progress.announce(1_000);
    expect(existsSync(uiStartupProgressPath(stateDir))).toBe(false);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)).toBeUndefined();
  });

  it("answers only the launch that wrote the record", () => {
    begin();
    expect(readUiStartupSign(stateDir, OTHER_LAUNCH_ID)).toBeUndefined();
  });

  it("replaces the record of an earlier launch by name", () => {
    writeFileSync(
      uiStartupProgressPath(stateDir),
      `${OTHER_LAUNCH_ID} ${"1".repeat(16)} 0000000\n`,
    );
    begin();
    expect(readUiStartupSign(stateDir, OTHER_LAUNCH_ID)).toBeUndefined();
    expect(readUiStartupSign(stateDir, LAUNCH_ID)).toBeDefined();
  });

  it.each([
    ["no record", undefined],
    ["an empty record", ""],
    ["a short record", `${LAUNCH_ID} 1 0\n`],
    ["trailing bytes", `${LAUNCH_ID} ${"1".repeat(16)} 0000000\nX`],
    ["a non-numeric bound", `${LAUNCH_ID} ${"1".repeat(16)} 00000x0\n`],
    ["free text", "still starting, please wait\n"],
  ])("reads %s as no sign of life", (_label, content) => {
    if (content !== undefined) writeFileSync(uiStartupProgressPath(stateDir), content);
    const failures: string[] = [];
    expect(readUiStartupSign(stateDir, LAUNCH_ID, (f) => failures.push(f))).toBeUndefined();
    // A missing or malformed record is no sign of life; only a record that cannot be opened as a
    // regular file is a failure.
    expect(failures).toEqual([]);
  });

  it("reports nothing and changes nothing for a launch id that is not one", () => {
    const progress = beginUiStartupProgress(stateDir, "not-a-launch-id");
    progress.announce(1_000);
    progress.stop();
    expect(existsSync(uiStartupProgressPath(stateDir))).toBe(false);
  });

  it("never fails the start when the record cannot be created, and hands the failure on", () => {
    const failures: string[] = [];
    const progress = beginUiStartupProgress(join(stateDir, "missing", "state"), LAUNCH_ID, (f) =>
      failures.push(f),
    );
    expect(failures).toEqual(["record-unavailable"]);
    expect(() => {
      progress.announce(1_000);
      progress.stop();
    }).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "never writes or reads through a link planted at the record's name",
    () => {
      const target = join(stateDir, "victim.txt");
      writeFileSync(target, "untouched");
      symlinkSync(target, uiStartupProgressPath(stateDir));
      const failures: string[] = [];
      expect(readUiStartupSign(stateDir, LAUNCH_ID, (f) => failures.push(f))).toBeUndefined();
      expect(failures).toEqual(["unreadable"]);
      begin();
      expect(readFileSync(target, "utf8")).toBe("untouched");
      expect(readUiStartupSign(stateDir, LAUNCH_ID)).toBeDefined();
    },
  );
});
