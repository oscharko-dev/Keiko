import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toBe(executable);
  });

  it("resolves a PATHEXT executable under simulated Windows trust semantics", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = join(bin, "git.exe");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(bin, 0o777);
    expect(resolveGitExecutable({ PATH: bin, PATHEXT: ".EXE" }, workspace, "win32")).toBe(
      executable,
    );
  });

  it("rejects a workspace-contained executable", () => {
    const bin = join(workspace, "bin");
    mkdirSync(bin);
    writeGit(bin);
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toBeUndefined();
  });

  it("rejects a group-writable executable directory", () => {
    const bin = temporary("keiko-git-executable-bin-");
    writeGit(bin);
    chmodSync(bin, 0o775);
    expect(resolveGitExecutable({ PATH: bin }, workspace)).toBeUndefined();
  });

  it("accepts a group-writable toolcache owned by a group unavailable to the caller", () => {
    const bin = temporary("keiko-git-executable-bin-");
    const executable = writeGit(bin);
    chmodSync(bin, 0o775);
    expect(resolveGitExecutable({ PATH: bin }, workspace, process.platform, new Set())).toBe(
      executable,
    );
  });

  it("ignores relative and missing PATH entries", () => {
    expect(resolveGitExecutable({ PATH: "relative-bin" }, workspace)).toBeUndefined();
    expect(resolveGitExecutable({ PATH: join(workspace, "missing") }, workspace)).toBeUndefined();
  });
});
