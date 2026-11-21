#!/usr/bin/env node
// Points this checkout's Git hooks at the repository-owned `.githooks` directory (ADR-0131
// amendment 2026-11-21). The full SonarCloud analysis runs only after integration, so the
// pre-push hook runs the local SonarJS scan of the changed files before a branch leaves the
// machine. Run once per checkout: `node scripts/install-git-hooks.mjs`. It is not a package.json
// script, because package.json is a pinned input of the design-system evidence
// (docs/design-system/evidence/1300).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

export const HOOKS_PATH = ".githooks";

/**
 * Sets `core.hooksPath` for the checkout the git runner addresses and returns the previous value.
 * The path stays relative, so every linked worktree resolves it against its own root. The runner
 * returns `{ status, stdout }`; `git config --get` exits 1 when the key is unset, which is the
 * ordinary first install, and any other failure is reported, never ignored.
 */
export function installGitHooks(git) {
  const read = git(["config", "--get", "core.hooksPath"]);
  if (read.status !== 0 && read.status !== 1) {
    return { ok: false, reason: `git config --get exited ${String(read.status)}` };
  }
  const previous = read.status === 0 ? read.stdout.trim() : "";
  const write = git(["config", "core.hooksPath", HOOKS_PATH]);
  if (write.status !== 0) {
    return { ok: false, reason: `git config exited ${String(write.status)}` };
  }
  return { ok: true, previous, current: HOOKS_PATH };
}

/** Installs the hooks for the checkout at `repoRoot` and reports the outcome; returns the exit code. */
export function runInstall({
  repoRoot = resolve(import.meta.dirname, ".."),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const git = (args) => {
    const result = spawnSync(resolveHostExecutable("git"), args, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout ?? "" };
  };
  const outcome = installGitHooks(git);
  if (!outcome.ok) {
    stderr.write(`install-git-hooks: FAIL - ${outcome.reason}\n`);
    return 1;
  }
  const { previous, current } = outcome;
  const before = previous === "" ? "unset" : previous;
  const change = previous === current ? "unchanged" : `was ${before}`;
  stdout.write(`install-git-hooks: PASS - core.hooksPath=${current} (${change})\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = runInstall();
