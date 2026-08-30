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

  it.each([
    ["git.exe", ".CMD"],
    ["git.com", ""],
  ])("probes the closed trusted image set for %s regardless of PATHEXT=%j", (name, pathExt) => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = join(bin, name);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o777);
    expect(resolveGitExecutable({ PATH: bin, PATHEXT: pathExt }, workspace, "win32")).toEqual({
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

  it("rejects a workspace-contained symlink before following it to a trusted external image", () => {
    const externalBin = temporary("keiko-git-executable-external-");
    const externalGit = writeGit(externalBin);
    const workspaceBin = join(workspace, "bin");
    mkdirSync(workspaceBin);
    symlinkSync(externalGit, join(workspaceBin, "git"));

    expect(resolveGitExecutable({ PATH: workspaceBin }, workspace)).toEqual({
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

  // POSIX `X_OK` on a directory checks search permission, so accessSync alone cannot establish
  // that a PATH candidate is an executable file. A searchable directory named `git` is an absent
  // executable, not a planted executable in an untrusted location: keep scanning and report the
  // same redacted `not-found` classification as any other non-candidate.
  it("reports not-found for a searchable directory decoy named git", () => {
    const bin = temporary("keiko-git-executable-directory-decoy-");
    mkdirSync(join(bin, "git"), { mode: 0o755 });

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

  // T23 (PR #3355 review): the candidate list used to probe a bare, extensionless `git` FIRST on
  // win32, even though only `.com`/`.exe` images are ever trusted — `fs.constants.X_OK` behaves
  // like a plain existence check on real Windows, so a decoy sharing the bare name would win before
  // `git.exe` was ever tried.
  describe("Windows image-only candidate filtering (simulated Windows)", () => {
    it("skips an executable, extensionless 'git' decoy and resolves git.exe placed alongside it", () => {
      const bin = temporary("keiko-git-executable-bin-");
      // A regular file, no extension, executable — exactly the shape X_OK cannot tell apart from a
      // real image on Windows. Content proves it is never the one spawned: only the PATH matters to
      // the assertion below, but a real decoy would run arbitrary code if ever returned.
      writeFileSync(join(bin, "git"), "#!/bin/sh\necho pwned\n", { mode: 0o755 });
      const executable = join(bin, "git.exe");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(bin, 0o777);
      expect(resolveGitExecutable({ PATH: bin, PATHEXT: ".COM;.EXE" }, workspace, "win32")).toEqual(
        { ok: true, path: executable },
      );
    });

    it("skips a directory decoy named 'git' and resolves git.exe placed alongside it", () => {
      const bin = temporary("keiko-git-executable-bin-");
      mkdirSync(join(bin, "git"));
      const executable = join(bin, "git.exe");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(bin, 0o777);
      expect(resolveGitExecutable({ PATH: bin, PATHEXT: ".COM;.EXE" }, workspace, "win32")).toEqual(
        { ok: true, path: executable },
      );
    });

    it("rejects a git.exe reparse point whose resolved target is not a trusted image extension", () => {
      const bin = temporary("keiko-git-executable-bin-");
      const evilTarget = join(bin, "evil.bat");
      writeFileSync(evilTarget, "@echo off\r\n", { mode: 0o755 });
      symlinkSync(evilTarget, join(bin, "git.exe"));
      chmodSync(bin, 0o777);
      expect(resolveGitExecutable({ PATH: bin, PATHEXT: ".COM;.EXE" }, workspace, "win32")).toEqual(
        { ok: false, reason: "untrusted-location" },
      );
    });
  });

  // T43 (PR #3355 review, diagnostic fidelity): filtering `.cmd`/`.bat` out of the trusted candidate
  // names must never silently downgrade a planted script's location signal from
  // "untrusted-location" to a bare "not-found" — the discriminated union exists (KEIKO-0263) so an
  // operator can tell "PATH has been salted" apart from "git is not installed". A script is still
  // NEVER returned as `ok: true` either way — security is unaffected; only the reported reason is.
  describe("Windows excluded-extension diagnostic fidelity (simulated Windows)", () => {
    it("surfaces untrusted-location for a workspace-contained git.bat when no trusted image exists anywhere", () => {
      const bin = join(workspace, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "git.bat"), "@echo off\r\n", { mode: 0o755 });
      expect(
        resolveGitExecutable({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, workspace, "win32"),
      ).toEqual({ ok: false, reason: "untrusted-location" });
    });

    it("still reports not-found for a git.cmd in a trusted (non-workspace) location with no image present", () => {
      // Pins the existing ".each refuses a %s git..." contract from the other side: a script that
      // is NOT workspace-contained is not itself suspicious (a legitimate wrapper unrelated to this
      // resolver, or simply not evidence of tampering) and must stay silent, not manufacture a false
      // "untrusted-location" the operator would have no location to act on.
      const bin = temporary("keiko-git-executable-bin-");
      writeFileSync(join(bin, "git.cmd"), "@echo off\r\n", { mode: 0o755 });
      expect(
        resolveGitExecutable({ PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, workspace, "win32"),
      ).toEqual({ ok: false, reason: "not-found" });
    });
  });
});

describe.runIf(process.platform === "win32")(
  "resolveGitExecutable Windows reparse containment",
  () => {
    it("rejects a workspace PATH junction to an external git.exe", () => {
      const externalBin = temporary("keiko-git-executable-windows-external-");
      writeFileSync(join(externalBin, "git.exe"), "MZ", { mode: 0o755 });
      const workspaceBin = join(workspace, "bin");
      symlinkSync(externalBin, workspaceBin, "junction");

      expect(resolveGitExecutable({ PATH: workspaceBin }, workspace, "win32")).toEqual({
        ok: false,
        reason: "untrusted-location",
      });
    });
  },
);
