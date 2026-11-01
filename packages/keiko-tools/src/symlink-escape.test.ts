// S-H1 regression: symlink write/cwd escape. The lexical resolveWithinWorkspace alone is not
// enough — a symlink inside the workspace can point outside it (or into .git). The patch write
// path and run_command cwd MUST also realpath-check the target (and its nearest existing parent
// for create targets), mirroring the read path. These tests use REAL symlinks on disk.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import {
  plantDirectoryRedirect,
  plantSymlinkOrSkip,
} from "../../../tests/support/symlink-fixture.js";
import { applyPatch, validatePatch } from "./patch.js";
import { runCommand } from "./exec.js";
import { nodeSpawnFn } from "./exec.js";
import { recordingSpawn } from "./_support.js";
import { PatchValidationError } from "./errors.js";
import { createContainedNodeWorkspaceWriter } from "./writer.js";
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
    selectedRoot: root,
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

// Every directory escape runs twice: once through a real directory symlink (skipped with a reason
// on a Windows host without symlink privilege) and once through a directory redirect, which is a
// junction on Windows and a directory symlink elsewhere, so a Windows host still exercises the
// reparse boundary. Junction targets must be absolute; every target below is.
const DIRECTORY_LINKS = [{ link: "directory symlink" }, { link: "directory redirect" }] as const;
type DirectoryLink = (typeof DIRECTORY_LINKS)[number]["link"];

function plantDirectoryLink(
  context: TestContext,
  link: DirectoryLink,
  absoluteTarget: string,
  path: string,
): void {
  if (link === "directory symlink") {
    plantSymlinkOrSkip(context, absoluteTarget, path, "dir");
    return;
  }
  plantDirectoryRedirect(absoluteTarget, path);
}

describe("S-H1 — patch write through an escaping symlink", () => {
  it("rejects a modify whose target file is a symlink escaping the root; writes nothing", (context) => {
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "one\ntwo\n", "utf8");
    plantSymlinkOrSkip(context, victim, join(root, "link.txt"), "file");
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

  it.for(DIRECTORY_LINKS)(
    "rejects creating a file through a symlinked directory into an outside location ($link)",
    ({ link }, context) => {
      plantDirectoryLink(context, link, outside, join(root, "linkdir"));
      const diff = "--- /dev/null\n+++ b/linkdir/evil.txt\n@@ -0,0 +1,1 @@\n+pwned\n";
      const v = validatePatch(info, diff);
      expect(v.reasons.map((r) => r.code)).toContain("path-unsafe");
      expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
        PatchValidationError,
      );
      expect(readdirSync(outside)).not.toContain("evil.txt");
    },
  );

  it.for(DIRECTORY_LINKS)(
    "rejects creating .git/hooks/pre-commit through a symlinked .git directory (RCE escalation) ($link)",
    ({ link }, context) => {
      const realGit = mkdtempSync(join(tmpdir(), "keiko-symlink-git-"));
      context.onTestFinished(() => {
        rmSync(realGit, { recursive: true, force: true });
      });
      mkdirSync(join(realGit, "hooks"), { recursive: true });
      plantDirectoryLink(context, link, realGit, join(root, "gitlink"));
      const diff = "--- /dev/null\n+++ b/gitlink/hooks/pre-commit\n@@ -0,0 +1,1 @@\n+#!/bin/sh\n";
      expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
        PatchValidationError,
      );
      expect(readdirSync(join(realGit, "hooks"))).not.toContain("pre-commit");
    },
  );

  it("rejects a symlink alias whose real target is a denied in-workspace file", (context) => {
    writeFileSync(join(root, ".env"), "SECRET=1\n", "utf8");
    plantSymlinkOrSkip(context, join(root, ".env"), join(root, "alias.env"), "file");
    const diff = "--- a/alias.env\n+++ b/alias.env\n@@ -1,1 +1,1 @@\n-SECRET=1\n+SECRET=2\n";
    const v = validatePatch(info, diff);
    expect(v.ok).toBe(false);
    expect(v.reasons.map((r) => r.code)).toContain("path-denied");
    expect(() => applyPatch(info, diff, { applyEnabled: true, signal: liveSignal() })).toThrow(
      PatchValidationError,
    );
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("rejects a final symlink swap at the patch write edge", (context) => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/x.txt"), "one\ntwo\n", "utf8");
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "outside\n", "utf8");
    // The swap below plants a file symlink mid-write. Probe that privilege first so a host without
    // it skips with a reason instead of passing on the rollback of an EPERM thrown by the swap.
    plantSymlinkOrSkip(context, victim, join(outside, "swap-probe.txt"), "file");
    const base = createContainedNodeWorkspaceWriter(root);
    const writer = {
      ...base,
      writeFileUtf8(absolutePath: string, content: string): void {
        rmSync(absolutePath, { force: true });
        symlinkSync(victim, absolutePath);
        base.writeFileUtf8(absolutePath, content);
      },
    };
    const diff = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+HACKED\n";
    expect(() =>
      applyPatch(info, diff, { applyEnabled: true, signal: liveSignal(), writer }),
    ).toThrow(/symbolic link|rolled back/u);
    expect(readFileSync(victim, "utf8")).toBe("outside\n");
  });

  it("rejects a parent directory symlink swap at the patch create edge", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    const base = createContainedNodeWorkspaceWriter(root);
    const writer = {
      ...base,
      mkdirp(absoluteDir: string): void {
        rmSync(absoluteDir, { recursive: true, force: true });
        // A junction on Windows, so the parent swap is exercised without symlink privilege.
        plantDirectoryRedirect(outside, absoluteDir);
        base.mkdirp(absoluteDir);
      },
    };
    const diff = "--- /dev/null\n+++ b/src/created.txt\n@@ -0,0 +1,1 @@\n+pwned\n";
    expect(() =>
      applyPatch(info, diff, { applyEnabled: true, signal: liveSignal(), writer }),
    ).toThrow(/symbolic link|rolled back|non-directory/u);
    expect(readdirSync(outside)).not.toContain("created.txt");
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

  it.for(DIRECTORY_LINKS)(
    "rejects a cwd that is a symlink escaping the root, without spawning ($link)",
    async ({ link }, context) => {
      plantDirectoryLink(context, link, outside, join(root, "cwdlink"));
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
    },
  );

  it.for(DIRECTORY_LINKS)(
    "rejects a cwd that resolves to a denied in-workspace .git path ($link)",
    async ({ link }, context) => {
      mkdirSync(join(root, ".git"), { recursive: true });
      plantDirectoryLink(context, link, join(root, ".git"), join(root, "cwdgit"));
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
    },
  );

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

  it.for(DIRECTORY_LINKS)(
    "passes the symlink-resolved real cwd to spawn for an in-root cwd alias ($link)",
    async ({ link }, context) => {
      mkdirSync(join(root, "real-cwd"), { recursive: true });
      plantDirectoryLink(context, link, join(root, "real-cwd"), join(root, "cwd-alias"));
      const rec = recordingSpawn();
      const pending = runCommand(
        {
          command: "node",
          args: ["-e", "1"],
          cwd: "cwd-alias",
          timeoutMs: undefined,
          signal: liveSignal(),
        },
        { ...realDeps(), spawn: rec.fn },
      );
      queueMicrotask(() => rec.child.emit("close", 0, null));
      await pending;
      expect(rec.calls()[0]?.options.cwd).toBe(realpathSync(join(root, "real-cwd")));
    },
  );
});
