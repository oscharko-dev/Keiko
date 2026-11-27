import { describe, expect, it } from "vitest";
import { isSystemNoiseEntry, isWindowsDriveRoot } from "./systemNoise.js";

const ANYWHERE = { atDriveRoot: false } as const;
const DRIVE_ROOT = { atDriveRoot: true } as const;

describe("Windows system noise (#4437)", () => {
  it.each([
    "$Recycle.Bin",
    "$RECYCLE.BIN",
    "System Volume Information",
    "desktop.ini",
    "Desktop.INI",
    "Thumbs.db",
    "ehthumbs.db",
    "ehthumbs_vista.db",
    "NTUSER.DAT",
    "ntuser.dat.LOG1",
    "NTUSER.DAT",
    "NTUSER.DAT{016888bd-6c6f-11de-8d1d-001e0bcde3ec}.TM.blf",
    "ntuser.ini",
    "NTUSER.POL",
    "NTUSER.DAT{53b39e88-18c4-11ea-a811-000d3aa4692b}.TM.blf",
  ])("prunes %s at any depth", (name) => {
    expect(isSystemNoiseEntry(name, ANYWHERE)).toBe(true);
    expect(isSystemNoiseEntry(name, DRIVE_ROOT)).toBe(true);
  });

  it.each([
    "RECYCLER",
    "Recycled",
    "Windows",
    "Windows.old",
    "$WINDOWS.~BT",
    "$Windows.~WS",
    "$WinREAgent",
    "$GetCurrent",
    "$SysReset",
    "Config.Msi",
    "PerfLogs",
    "Recovery",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "DumpStack.log",
    "DumpStack.log.tmp",
  ])("prunes %s only directly below a drive root", (name) => {
    expect(isSystemNoiseEntry(name, DRIVE_ROOT)).toBe(true);
    expect(isSystemNoiseEntry(name, ANYWHERE)).toBe(false);
  });

  it.each([
    // Owner decision 2026-11-17: application data stays searchable.
    "AppData",
    "Application Data",
    // Installed software can hold configuration a person searches for.
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "Users",
    "Documents",
    "OneDrive",
    // Near misses: the rule compares whole names, never substrings or stems.
    "desktop.ini.txt",
    "my desktop.ini",
    "Thumbs.db.bak",
    "$Recycle.Bin2",
    "System Volume",
    "ntuser",
    "ntuserdat",
    // A person's own files that only start like a profile file (#4483 audit).
    "ntuser.notes.md",
    "NTUSER.txt",
    "ntuser.database.md",
    "ntuser.data",
    "",
    ".",
    "..",
  ])("keeps %s", (name) => {
    expect(isSystemNoiseEntry(name, ANYWHERE)).toBe(false);
    expect(isSystemNoiseEntry(name, DRIVE_ROOT)).toBe(false);
  });

  it.each(["C:", "C:\\", "c:/", "Z:\\", "\\\\?\\C:\\"])("treats %s as a drive root", (path) => {
    expect(isWindowsDriveRoot(path)).toBe(true);
  });

  it.each([
    "C:\\Users",
    "C:\\Users\\person",
    "C:/Users/",
    "\\\\server\\share",
    "\\\\server\\share\\",
    "/",
    "/ws",
    "C",
    "CC:\\",
    "",
  ])("does not treat %s as a drive root", (path) => {
    expect(isWindowsDriveRoot(path)).toBe(false);
  });
});
