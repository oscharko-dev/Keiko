import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentPlatform,
  executableExtensions,
  isExecutableOnPath,
  probeBackends,
} from "./probe.js";

describe("executableExtensions", () => {
  it("returns a single empty suffix on POSIX", () => {
    expect(executableExtensions("linux", undefined)).toEqual([""]);
    expect(executableExtensions("darwin", ".EXE;.CMD")).toEqual([""]);
  });

  it("splits PATHEXT on Windows", () => {
    expect(executableExtensions("win32", ".EXE;.CMD;.BAT")).toEqual([".EXE", ".CMD", ".BAT"]);
  });

  it("falls back to the standard PATHEXT set on Windows when unset", () => {
    expect(executableExtensions("win32", undefined)).toEqual([".EXE", ".CMD", ".BAT", ".COM"]);
  });
});

describe("isExecutableOnPath", () => {
  let dir: string;
  const binary = "keiko-sandbox-probe-fixture";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "keiko-sandbox-probe-"));
    const file = join(dir, binary);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds an executable present in a PATH entry (POSIX resolution)", () => {
    expect(isExecutableOnPath(binary, { PATH: dir }, "linux")).toBe(true);
  });

  it("resolves a Windows binary via PATHEXT", () => {
    const winDir = mkdtempSync(join(tmpdir(), "keiko-sandbox-win-"));
    const winFile = join(winDir, "tool.CMD");
    writeFileSync(winFile, "@echo off\n");
    chmodSync(winFile, 0o755);
    expect(isExecutableOnPath("tool", { PATH: winDir, PATHEXT: ".CMD" }, "win32")).toBe(true);
    rmSync(winDir, { recursive: true, force: true });
  });

  it("returns false for a binary absent from PATH", () => {
    expect(isExecutableOnPath("keiko-sandbox-definitely-absent", { PATH: dir }, "linux")).toBe(
      false,
    );
  });

  it("returns false when PATH is empty or unset", () => {
    expect(isExecutableOnPath(binary, { PATH: "" }, "linux")).toBe(false);
    expect(isExecutableOnPath(binary, {}, "linux")).toBe(false);
  });
});

describe("probeBackends", () => {
  it("reports false for every backend when PATH is empty", () => {
    expect(probeBackends({ PATH: "" }, "linux")).toEqual({
      bubblewrap: false,
      unshare: false,
      seatbelt: false,
      docker: false,
      podman: false,
    });
  });

  it("reflects the real host PATH without throwing", () => {
    const availability = probeBackends();
    for (const value of Object.values(availability)) {
      expect(typeof value).toBe("boolean");
    }
  });
});

describe("currentPlatform", () => {
  it("returns the running platform", () => {
    expect(currentPlatform()).toBe(process.platform);
  });
});
