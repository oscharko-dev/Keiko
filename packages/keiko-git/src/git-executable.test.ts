import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitExecutable } from "./git-executable.js";

let workspace: string;
const cleanup: string[] = [];

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(root);
  return root;
}

beforeEach(() => {
  workspace = temporary("keiko-git-executable-workspace-");
});

afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.skipIf(process.platform === "win32")("resolveGitExecutable", () => {
  function writeGit(bin: string): string {
    const executable = join(bin, "git");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return executable;
  }

  it("returns the absolute real path of a trusted executable outside the workspace", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = writeGit(bin);
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toEqual({
      ok: true,
      path: executable,
    });
  });

  it("resolves a PATHEXT executable under simulated Windows trust semantics", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = join(bin, "git.exe");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o777);
    expect(resolveGitExecutable({ PATH: bin, PATHEXT: ".EXE" }, workspace, "win32")).toEqual({
      ok: true,
      path: executable,
    });
  });

  // A `git.cmd`/`git.bat` is never accepted as git, even when PATHEXT lists those extensions and
  // the file passes every trust check. `runner.ts` spawns the resolved path with `shell: false`,
  // which raises EINVAL for a batch target on Windows (Node's fix for CVE-2024-27980) — so
  // resolving one could only ever yield a cryptic spawn failure instead of an honest "not-found".
  // It is also the PATH-salting shape this resolver exists to reject: a batch file is arbitrary
  // code under a trusted name, and keiko-git (a contracts-only leaf, ADR-0019 rule 2b) cannot reach
  // the hardened cmd.exe wrapper that would be needed to launch one safely.
  it.each([".CMD", ".BAT"])(
    "refuses a %s git even when PATHEXT offers it and the file is otherwise trusted",
    (extension) => {
      const bin = temporary("keiko-git-executable-bin-");
      writeFileSync(join(bin, `git${extension.toLowerCase()}`), "@echo off\r\n", { mode: 0o755 });
      chmodSync(bin, 0o777);
      expect(
        resolveGitExecutable({ PATH: bin, PATHEXT: `.EXE;${extension}` }, workspace, "win32"),
      ).toEqual({ ok: false, reason: "not-found" });
    },
  );

  // The real image still wins from the same directory, so narrowing the extension set costs no
  // legitimate resolution: a normal Git-for-Windows install ships git.exe.
  it("still resolves git.exe when a git.cmd sits beside it", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = join(bin, "git.exe");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "git.cmd"), "@echo off\r\n", { mode: 0o755 });
    chmodSync(bin, 0o777);
    expect(
      resolveGitExecutable({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, workspace, "win32"),
    ).toEqual({ ok: true, path: executable });
  });

  it("rejects a workspace-contained executable", () => {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
    writeGit(bin);
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toEqual({
      ok: false,
      reason: "untrusted-location",
    });
  });

  // KEIKO-0263: the resolver now returns a discriminated union so the runner (and any other
  // caller) can tell "an executable exists but lives in an untrusted location" apart from
  // "no git on PATH at all". Both used to be a bare undefined mapping to the same operator
  // message, which hid planted-binary indicators from diagnostics.
  it("rejects a group-writable executable directory with the untrusted-location reason", () => {
    const bin = temporary("keiko-git-executable-bin-");
    writeGit(bin);
    chmodSync(bin, 0o775);
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toEqual({
      ok: false,
      reason: "untrusted-location",
    });
  });

  it("reports not-found when no PATH entry carries a git executable", () => {
    const bin = temporary("keiko-git-executable-empty-bin-");
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("accepts a group-writable toolcache owned by a group unavailable to the caller", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = writeGit(bin);
    chmodSync(bin, 0o775);
    expect(resolveGitExecutable({ PATH: bin }, workspace, process.platform, new Set())).toEqual({
      ok: true,
      path: executable,
    });
  });

  it("ignores relative and missing PATH entries", () => {
    expect(resolveGitExecutable({ PATH: "relative-bin" }, workspace)).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(resolveGitExecutable({ PATH: join(workspace, "missing") }, workspace)).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  // KEIKO-0296: the existing writability guard only exercises the `dirname(candidate)` entry of
  // protectedPaths. These two pin the `real` and `dirname(real)` entries — the primary defense
  // against PATH-based binary-planting via symlinks and against a candidate file whose own bits
  // are group/world-writable even when its containing directory is not.
  it("rejects a trusted-directory symlink whose resolved target lives in a writable directory", () => {
    // Untrusted target directory (group-writable) holds the real git.
    const targetBin = temporary("keiko-git-executable-target-");
    const target = writeGit(targetBin);
    chmodSync(targetBin, 0o775);

    // The PATH entry itself is a trusted directory (0o755) with a symlink named `git` that
    // points at the writable target — a classic binary-planting shape.
    const linkBin = temporary("keiko-git-executable-link-");
    symlinkSync(target, join(linkBin, "git"));

    expect(resolveGitExecutable({ PATH: linkBin }, workspace)).toEqual({
      ok: false,
      reason: "untrusted-location",
    });
  });

  it("rejects a group-writable executable file even when its directory is not writable", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = writeGit(bin);
    // Directory: trusted (0o755). File itself: group-writable (0o775). The protectedPaths list
    // has to include `real` for this check to bite — dropping it would silently ship this class.
    chmodSync(executable, 0o775);
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toEqual({
      ok: false,
      reason: "untrusted-location",
    });
  });
});
