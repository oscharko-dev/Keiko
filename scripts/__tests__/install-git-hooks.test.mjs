import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HOOKS_PATH, installGitHooks, runInstall } from "../install-git-hooks.mjs";

// ADR-0131 amendment (2026-11-21): the full SonarCloud analysis left the pull-request path. The
// pre-push hook is what runs the local SonarJS scan of the changed files before a branch leaves
// the machine, so its installer and its wiring are pinned here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hookPath = resolve(root, ".githooks/pre-push");

function fakeGit(responses) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    return responses.shift() ?? { status: 0, stdout: "" };
  };
  return { git, calls };
}

describe("install-git-hooks", () => {
  it("sets a relative hooks path on a first install", () => {
    const { git, calls } = fakeGit([
      { status: 1, stdout: "" },
      { status: 0, stdout: "" },
    ]);
    expect(installGitHooks(git)).toEqual({ ok: true, previous: "", current: HOOKS_PATH });
    expect(calls).toEqual(["config --get core.hooksPath", "config core.hooksPath .githooks"]);
  });

  it("reports the previous hooks path it replaces", () => {
    const { git } = fakeGit([
      { status: 0, stdout: "custom-hooks\n" },
      { status: 0, stdout: "" },
    ]);
    expect(installGitHooks(git)).toEqual({
      ok: true,
      previous: "custom-hooks",
      current: HOOKS_PATH,
    });
  });

  it("fails closed when git cannot read or write the configuration", () => {
    expect(installGitHooks(fakeGit([{ status: 128, stdout: "" }]).git)).toEqual({
      ok: false,
      reason: "git config --get exited 128",
    });
    expect(
      installGitHooks(
        fakeGit([
          { status: 1, stdout: "" },
          { status: 255, stdout: "" },
        ]).git,
      ),
    ).toEqual({ ok: false, reason: "git config exited 255" });
  });

  it("configures a real checkout and reports a repeated install as unchanged", () => {
    const scratch = mkdtempSync(join(tmpdir(), "keiko-hooks-"));
    const lines = [];
    const sink = { write: (text) => lines.push(text) };
    try {
      expect(spawnSync("git", ["init", "-q", scratch]).status).toBe(0);
      expect(runInstall({ repoRoot: scratch, stdout: sink, stderr: sink })).toBe(0);
      expect(runInstall({ repoRoot: scratch, stdout: sink, stderr: sink })).toBe(0);
      const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: scratch,
        encoding: "utf8",
      });
      expect(configured.stdout.trim()).toBe(HOOKS_PATH);
      expect(lines).toEqual([
        "hooks:install: PASS - core.hooksPath=.githooks (was unset)\n",
        "hooks:install: PASS - core.hooksPath=.githooks (unchanged)\n",
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails closed outside a Git checkout", () => {
    const scratch = mkdtempSync(join(tmpdir(), "keiko-hooks-nogit-"));
    const lines = [];
    const sink = { write: (text) => lines.push(text) };
    try {
      const status = runInstall({ repoRoot: scratch, stdout: sink, stderr: sink });
      expect(status).toBe(1);
      expect(lines.join("")).toMatch(/^hooks:install: FAIL - git config/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("is exposed as one npm command", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(packageJson.scripts["hooks:install"]).toBe("node scripts/install-git-hooks.mjs");
  });
});

describe(".githooks/pre-push", () => {
  it("is executable and runs the changed-file SonarJS scan", () => {
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
    const hook = readFileSync(hookPath, "utf8");
    expect(hook).toContain('"${repo_root}/docker/gates/run-sonar.sh"');
    // The changed-file scope, never `--all`: the whole-project scan is the post-merge dev analysis.
    expect(hook).not.toContain("--all");
    expect(hook).toContain("set -euo pipefail");
  });

  it("lets a push that only deletes remote refs through without a scan", () => {
    const zero = "0".repeat(40);
    const result = spawnSync("bash", [hookPath, "origin", "git@example.invalid:repo.git"], {
      cwd: root,
      input: `(delete) ${zero} refs/heads/old-branch ${"a".repeat(40)}\n`,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("SonarJS analysis");
  });
});
