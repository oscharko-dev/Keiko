// S-H1 regression: symlink write/cwd escape. The lexical resolveWithinWorkspace alone is not
// enough — a symlink inside the workspace can point outside it (or into .git). The patch write
// path and run_command cwd MUST also realpath-check the target (and its nearest existing parent
// for create targets), mirroring the read path. These tests use REAL symlinks on disk.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPatch, validatePatch } from "./patch.js";
import { runCommand } from "./exec.js";
import { nodeSpawnFn } from "./exec.js";
import { PatchValidationError } from "./errors.js";
import {
  PathDeniedError,
  PathEscapeError,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import { DEFAULT_COMMAND_RULES, DEFAULT_SANDBOX_POLICY, type CommandRule } from "./types.js";

let root: string;
let outside: string;
let info: WorkspaceInfo;

const NODE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "node" },
  ...DEFAULT_COMMAND_RULES,
]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keiko-symlink-ws-"));
  outside = mkdtempSync(join(tmpdir(), "keiko-symlink-out-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
  info = {
    root,
    name: "demo",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
    ignoreLines: [],
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function liveSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("S-H1 — patch write through an escaping symlink", () => {
  it("rejects a modify whose target file is a symlink escaping the root; writes nothing", () => {
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "one\ntwo\n", "utf8");
    symlinkSync(victim, join(root, "link.txt"));
    const diff = "--- a/link.txt\n+++ b/link.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+HACKED\n";
    // validatePatch surfaces it as a path-unsafe rejection (graceful for propose_patch)...
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("path-unsafe");
    // ...and applyPatch refuses to write, throwing PatchValidationError.
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    // The outside victim is unchanged: nothing was written through the link.
    expect(readdirSync(outside)).toContain("victim.txt");
    expect(readFileSync(victim, "utf8")).toBe("one\ntwo\n");
  });

  it("rejects creating a file through a symlinked directory into an outside location", () => {
    symlinkSync(outside, join(root, "linkdir"));
    const diff = "--- /dev/null\n+++ b/linkdir/evil.txt\n@@ -0,0 +1,1 @@\n+pwned\n";
    const v = validatePatch(info, diff);
    expect(v.reasons.map((r) => r.code)).toContain("path-unsafe");
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    expect(readdirSync(outside)).not.toContain("evil.txt");
  });

  it("rejects creating .git/hooks/pre-commit through a symlinked .git directory (RCE escalation)", () => {
    const realGit = mkdtempSync(join(tmpdir(), "keiko-symlink-git-"));
    mkdirSync(join(realGit, "hooks"), { recursive: true });
    symlinkSync(realGit, join(root, "gitlink"));
    const diff = "--- /dev/null\n+++ b/gitlink/hooks/pre-commit\n@@ -0,0 +1,1 @@\n+#!/bin/sh\n";
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    expect(readdirSync(join(realGit, "hooks"))).not.toContain("pre-commit");
    rmSync(realGit, { recursive: true, force: true });
  });

  it("rejects a symlink alias whose real target is a denied in-workspace file", () => {
    writeFileSync(join(root, ".env"), "SECRET=1\n", "utf8");
    symlinkSync(join(root, ".env"), join(root, "alias.env"));
    const diff = "--- a/alias.env\n+++ b/alias.env\n@@ -1,1 +1,1 @@\n-SECRET=1\n+SECRET=2\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("path-denied");
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
  });
});

describe("S-H1 — positive control: a normal in-root path still applies", () => {
  it("applies a create to a real in-root path", () => {
    const diff = "--- /dev/null\n+++ b/src/new.txt\n@@ -0,0 +1,1 @@\n+created\n";
    const result = applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() });
    expect(result.created).toEqual(["src/new.txt"]);
  });
});

describe("S-H1 — run_command cwd through an escaping symlink", () => {
  function realDeps(): Parameters<typeof runCommand>[1] {
    return {
      workspace: info,
      policy: { ...DEFAULT_SANDBOX_POLICY, defaultTimeoutMs: 10_000 },
      commandRules: NODE_COMMAND_RULES,
      spawn: nodeSpawnFn,
      processEnv: { PATH: process.env.PATH ?? "" },
      now: () => Date.now(),
    };
  }

  it("rejects a cwd that is a symlink escaping the root, without spawning", async () => {
    symlinkSync(outside, join(root, "cwdlink"));
    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: "cwdlink",
          timeoutMs: undefined,
          signal: liveSignal(),
        },
        realDeps(),
      ),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects a cwd that resolves to a denied in-workspace .git path", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    symlinkSync(join(root, ".git"), join(root, "cwdgit"));
    await expect(
      runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: "cwdgit",
          timeoutMs: undefined,
          signal: liveSignal(),
        },
        realDeps(),
      ),
    ).rejects.toBeInstanceOf(PathDeniedError);
  });

  it("positive control: a normal in-root cwd runs", async () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    const result = await runCommand(
      {
        command: "node",
        args: ["-e", "process.stdout.write('ok')"],
        cwd: "sub",
        timeoutMs: undefined,
        signal: liveSignal(),
      },
      realDeps(),
    );
    expect(result.stdout).toContain("ok");
  });
});
