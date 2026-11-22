import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HOOKS_PATH, installGitHooks, runInstall } from "../install-git-hooks.mjs";

// ADR-0131 amendment (2026-11-21): the full SonarCloud analysis left the pull-request path. The
// pre-push hook is what runs the local SonarJS scan of the changed files before a branch leaves
// the machine, so its installer and its wiring are pinned here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hookPath = resolve(root, ".githooks/pre-push");

// Every real Git process in this file runs without the developer's global and system config, so an
// inherited `core.hooksPath` or signing rule cannot change what the tests observe.
function isolateGitConfig(scratch) {
  const global = join(scratch, "gitconfig-global");
  writeFileSync(global, "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", global);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
      isolateGitConfig(scratch);
      const checkout = join(scratch, "checkout");
      expect(spawnSync("git", ["init", "-q", checkout]).status).toBe(0);
      expect(runInstall({ repoRoot: checkout, stdout: sink, stderr: sink })).toBe(0);
      expect(runInstall({ repoRoot: checkout, stdout: sink, stderr: sink })).toBe(0);
      const configured = spawnSync("git", ["config", "--get", "core.hooksPath"], {
        cwd: checkout,
        encoding: "utf8",
      });
      expect(configured.stdout.trim()).toBe(HOOKS_PATH);
      expect(lines).toEqual([
        "install-git-hooks: PASS - core.hooksPath=.githooks (was unset)\n",
        "install-git-hooks: PASS - core.hooksPath=.githooks (unchanged)\n",
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
      expect(lines.join("")).toMatch(/^install-git-hooks: FAIL - git config/u);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

const ZERO_SHA = "0".repeat(40);

function git(cwd, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Hook Test",
      "-c",
      "user.email=hook@test.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// An isolated checkout carrying the real hook and a fake scanner that records each run and exits
// with FAKE_SCAN_STATUS.
function hookCheckout(scratch) {
  isolateGitConfig(scratch);
  const checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, ".githooks"), { recursive: true });
  mkdirSync(join(checkout, "docker/gates"), { recursive: true });
  git(scratch, ["init", "-q", checkout]);
  copyFileSync(hookPath, join(checkout, ".githooks/pre-push"));
  writeFileSync(
    join(checkout, "docker/gates/run-sonar.sh"),
    '#!/usr/bin/env bash\necho scanned >> "$FAKE_SCAN_MARKER"\nexit "${FAKE_SCAN_STATUS:-0}"\n',
    { mode: 0o755 },
  );
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-q", "-m", "fixture"]);
  return { checkout, head: git(checkout, ["rev-parse", "HEAD"]), marker: join(scratch, "scans") };
}

function runHook({ checkout, marker }, input, scanStatus = "0") {
  const result = spawnSync("bash", [join(checkout, ".githooks/pre-push"), "origin", "x"], {
    cwd: checkout,
    input,
    encoding: "utf8",
    env: { ...process.env, FAKE_SCAN_MARKER: marker, FAKE_SCAN_STATUS: scanStatus },
  });
  const scans = existsSync(marker)
    ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
    : 0;
  return { status: result.status, stderr: result.stderr, scans };
}

function withHookCheckout(test) {
  const scratch = mkdtempSync(join(tmpdir(), "keiko-pre-push-"));
  try {
    test(hookCheckout(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

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
    withHookCheckout((fixture) => {
      const result = runHook(fixture, `(delete) ${ZERO_SHA} refs/heads/old ${"a".repeat(40)}\n`);
      expect(result).toMatchObject({ status: 0, scans: 0 });
    });
  });

  it("permits a commit-bearing push when the scan passes", () => {
    withHookCheckout((fixture) => {
      const line = `refs/heads/feat ${fixture.head} refs/heads/feat ${ZERO_SHA}\n`;
      expect(runHook(fixture, line, "0")).toMatchObject({ status: 0, scans: 1 });
    });
  });

  it("rejects the push when the scan reports a finding or cannot run", () => {
    withHookCheckout((fixture) => {
      const line = `refs/heads/feat ${fixture.head} refs/heads/feat ${ZERO_SHA}\n`;
      const result = runHook(fixture, line, "1");
      expect(result).toMatchObject({ status: 1, scans: 1 });
      expect(result.stderr).toContain("pre-push: FAIL - fix the findings above");
    });
  });

  it("rejects a push whose working tree differs from the pushed commit, before scanning", () => {
    withHookCheckout((fixture) => {
      writeFileSync(join(fixture.checkout, "repair.ts"), "export const repaired = true;\n");
      const line = `refs/heads/feat ${fixture.head} refs/heads/feat ${ZERO_SHA}\n`;
      const result = runHook(fixture, line);
      expect(result).toMatchObject({ status: 1, scans: 0 });
      expect(result.stderr).toContain("working tree differs from the pushed commit");
    });
  });

  it("rejects a push of a commit that is not the checked-out HEAD, before scanning", () => {
    withHookCheckout((fixture) => {
      const other = "b".repeat(40);
      const result = runHook(fixture, `refs/heads/other ${other} refs/heads/other ${ZERO_SHA}\n`);
      expect(result).toMatchObject({ status: 1, scans: 0 });
      expect(result.stderr).toContain("refs/heads/other is not the checked-out HEAD");
    });
  });
});
