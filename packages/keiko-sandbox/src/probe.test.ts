import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import {
  currentPlatform,
  executableExtensions,
  isExecutableOnPath,
  probeBackends,
} from "./probe.js";

function modeWritableByGroupOrOther(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

function isTrustedDirectoryPath(path: string): boolean {
  const root = parse(path).root;
  let current = path;
  for (;;) {
    const stat = statSync(current);
    if (!stat.isDirectory() || modeWritableByGroupOrOther(stat.mode)) return false;
    if (current === root) return true;
    current = dirname(current);
  }
}

function createTrustedFixtureDir(): string | undefined {
  for (const candidate of [process.cwd(), homedir()]) {
    try {
      const parent = realpathSync(candidate);
      if (!isTrustedDirectoryPath(parent)) continue;
      return mkdtempSync(join(parent, ".tmp-keiko-sandbox-probe-"));
    } catch {
      // Candidate is unavailable, untrusted, or not writable; keep looking.
    }
  }
  return undefined;
}

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
  const trustedDir = createTrustedFixtureDir();
  const binary = "keiko-sandbox-probe-fixture";

  beforeAll(() => {
    if (trustedDir === undefined) return;
    chmodSync(trustedDir, 0o755);
    const file = join(trustedDir, binary);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  });

  afterAll(() => {
    if (trustedDir !== undefined) {
      rmSync(trustedDir, { recursive: true, force: true });
    }
  });

  it.skipIf(trustedDir === undefined)(
    "finds an executable present in a trusted PATH entry (POSIX resolution)",
    () => {
      if (trustedDir === undefined) throw new Error("trusted fixture directory was not created");
      expect(isExecutableOnPath(binary, { PATH: trustedDir }, "linux")).toBe(true);
    },
  );

  it("resolves a Windows binary via PATHEXT", () => {
    const winDir = mkdtempSync(join(tmpdir(), "keiko-sandbox-win-"));
    const winFile = join(winDir, "tool.CMD");
    writeFileSync(winFile, "@echo off\n");
    chmodSync(winFile, 0o755);
    expect(isExecutableOnPath("tool", { PATH: winDir, PATHEXT: ".CMD" }, "win32")).toBe(true);
    rmSync(winDir, { recursive: true, force: true });
  });

  it("returns false for a binary absent from PATH", () => {
    expect(
      isExecutableOnPath(
        "keiko-sandbox-definitely-absent",
        { PATH: trustedDir ?? tmpdir() },
        "linux",
      ),
    ).toBe(false);
  });

  it("rejects executables from writable PATH directories on POSIX", () => {
    const unsafeDir = mkdtempSync(join(tmpdir(), "keiko-sandbox-unsafe-path-"));
    const file = join(unsafeDir, "unsafe-tool");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
    chmodSync(unsafeDir, 0o777);
    try {
      expect(isExecutableOnPath("unsafe-tool", { PATH: unsafeDir }, "linux")).toBe(false);
    } finally {
      chmodSync(unsafeDir, 0o700);
      rmSync(unsafeDir, { recursive: true, force: true });
    }
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
