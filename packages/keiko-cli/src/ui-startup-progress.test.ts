// #4358: the Windows UI process records its startup progress for the launcher that waits on it.
// The suite is hermetic: the clock and the module-load hook are injected, nothing waits on time.
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEIKO_STATE_FILES } from "./state-paths.js";
import {
  beginUiStartupProgress,
  readUiStartupSign,
  UI_STARTUP_MAX_HORIZON_MS,
  UI_STARTUP_PROGRESS_INTERVAL_MS,
  uiStartupProgressPath,
  type UiStartupProgress,
} from "./ui-startup-progress.js";

const LAUNCH_ID = "ab".repeat(16);
const OTHER_LAUNCH_ID = "cd".repeat(16);

let stateDir: string;
let active: UiStartupProgress | undefined;
let clock: number;
let onLoad: (() => void) | undefined;
let loadHookRemoved: boolean;
let failures: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "keiko-startup-progress-"));
  clock = 0;
  onLoad = undefined;
  loadHookRemoved = false;
  failures = [];
});

afterEach(() => {
  active?.stop();
  active = undefined;
  rmSync(stateDir, { recursive: true, force: true });
});

function begin(launchId = LAUNCH_ID, dir = stateDir): UiStartupProgress {
  active = beginUiStartupProgress(dir, launchId, {
    recordFailure: (failure) => failures.push(failure),
    now: () => clock,
    registerLoadHook: (listener) => {
      onLoad = listener;
      return (): void => {
        loadHookRemoved = true;
      };
    },
  });
  return active;
}

function token(): string | undefined {
  return readUiStartupSign(stateDir, LAUNCH_ID)?.token;
}

describe("UI startup progress", () => {
  it("records a first step at once, as one fixed-width line without a path or account", () => {
    begin();
    const text = readFileSync(uiStartupProgressPath(stateDir), "utf8");
    expect(text).toBe(`${LAUNCH_ID} ${"1".padStart(16, "0")} 0000000\n`);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)).toEqual({
      token: "1".padStart(16, "0"),
      horizonMs: 0,
    });
    expect(KEIKO_STATE_FILES).toContain("ui.starting");
  });

  it("advances only when the main thread reports a completed step", () => {
    const progress = begin();
    const first = token();
    // Time alone is not progress: nothing writes while no step completes.
    clock += 60_000;
    expect(token()).toBe(first);
    progress.advance();
    expect(token()).not.toBe(first);
  });

  it("counts every loaded module as progress, at most once per interval", () => {
    begin();
    const first = token();
    onLoad?.();
    expect(token()).toBe(first);
    clock += UI_STARTUP_PROGRESS_INTERVAL_MS;
    onLoad?.();
    const second = token();
    expect(second).not.toBe(first);
    for (let module = 0; module < 500; module += 1) onLoad?.();
    expect(token()).toBe(second);
  });

  it("announces the bound of a blocking step at once and clamps it", () => {
    const progress = begin();
    progress.announce(70_000);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(70_000);
    progress.announce(10 * UI_STARTUP_MAX_HORIZON_MS);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(UI_STARTUP_MAX_HORIZON_MS);
    progress.announce(-5);
    expect(readUiStartupSign(stateDir, LAUNCH_ID)?.horizonMs).toBe(0);
  });

  it("removes the record and the load hook when the start is over, and stays stopped", () => {
    const progress = begin();
    progress.stop();
    progress.stop();
    progress.announce(1_000);
    progress.advance();
    expect(loadHookRemoved).toBe(true);
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
  ])("reads %s as no progress, and not as a failure", (_label, content) => {
    if (content !== undefined) writeFileSync(uiStartupProgressPath(stateDir), content);
    const seen: string[] = [];
    expect(readUiStartupSign(stateDir, LAUNCH_ID, (failure) => seen.push(failure))).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("reports nothing and changes nothing for a launch id that is not one", () => {
    const progress = begin("not-a-launch-id");
    progress.announce(1_000);
    progress.advance();
    progress.stop();
    expect(onLoad).toBeUndefined();
    expect(existsSync(uiStartupProgressPath(stateDir))).toBe(false);
  });

  it("never fails the start when the record cannot be created, and hands the failure on", () => {
    const progress = begin(LAUNCH_ID, join(stateDir, "missing", "state"));
    expect(failures).toEqual(["record-unavailable"]);
    expect(() => {
      progress.announce(1_000);
      progress.advance();
      progress.stop();
    }).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "never writes or reads through a link planted at the record's name",
    () => {
      const target = join(stateDir, "victim.txt");
      writeFileSync(target, "untouched");
      symlinkSync(target, uiStartupProgressPath(stateDir));
      const seen: string[] = [];
      expect(
        readUiStartupSign(stateDir, LAUNCH_ID, (failure) => seen.push(failure)),
      ).toBeUndefined();
      expect(seen).toEqual(["unreadable"]);
      begin();
      expect(readFileSync(target, "utf8")).toBe("untouched");
      expect(readUiStartupSign(stateDir, LAUNCH_ID)).toBeDefined();
    },
  );
});
