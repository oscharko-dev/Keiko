#!/usr/bin/env node
// One command that repairs every drift gate whose expected state is derived from the tree
// (quality-gate hardening plan 2026-11-21, P4): `node scripts/fix-gate-drift.mjs`.
//
// Each repair below regenerates an artifact from its deterministic source, or shrinks a register
// that may only shrink. None of them writes a baseline, so none can bless a regression: coverage,
// i18n and performance baselines, pinned evidence digests and reviewed risk acceptances stay
// out of this list on purpose, and so does anything that needs a browser or another platform.
// The command prints every file each repair changed, so the result is reviewed like any other
// edit before it is committed.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

/**
 * The repairs, in order, each a repository script run with this Node.js binary. The generators read
 * the built packages, so the build (what `npm run build:packages` runs) comes first.
 */
export const DRIFT_REPAIRS = Object.freeze([
  {
    label: "TypeScript toolchain the build uses",
    script: "scripts/check-typescript-toolchain.mjs",
    args: [],
  },
  { label: "package build the generators read", script: "scripts/build-packages.mjs", args: [] },
  { label: "Activity Log op catalog", script: "scripts/generate-op-catalog.mjs", args: [] },
  {
    label: "support-code inventory",
    script: "scripts/generate-support-code-inventory.mjs",
    args: [],
  },
  {
    label: "tool catalog manifest and migration",
    script: "scripts/check-tool-catalog-conformance.mjs",
    args: ["--write"],
  },
  {
    label: "zizmor ignore anchors that only shifted",
    script: "scripts/check-zizmor-anchors.mjs",
    args: ["--fix"],
  },
  {
    label: "legacy failure-path register (shrink only)",
    script: "scripts/check-error-observability.mjs",
    args: ["--prune-register"],
  },
]);

/** Paths `git status --porcelain` reports as changed or untracked. */
export function changedPaths(porcelain) {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).replace(/^.* -> /u, ""))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The paths a repair changed, from two snapshots of `path -> content digest` for every path that
 * differs from HEAD: a path whose content moved, appeared or disappeared. A file that was already
 * dirty and that the repair restored to HEAD counts as changed too.
 */
export function newlyChanged(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => before.get(path) !== after.get(path))
    .sort((left, right) => left.localeCompare(right));
}

function contentDigest(root, path) {
  const file = join(root, path);
  return existsSync(file)
    ? createHash("sha256").update(readFileSync(file)).digest("hex")
    : "deleted";
}

function gitStatus(root, git) {
  const result = spawnSync(git, ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error("git status failed");
  return new Map(changedPaths(result.stdout).map((path) => [path, contentDigest(root, path)]));
}

/**
 * Runs every repair in order and reports what each one changed. A repair that fails is named and
 * the remaining repairs still run, so one broken generator does not hide the others.
 */
export function runRepairs({ repairs, run, status, log }) {
  const failed = [];
  for (const repair of repairs) {
    const before = status();
    log(`fix-gate-drift: ${repair.label}`);
    if (run(repair) !== 0) failed.push(repair.label);
    for (const path of newlyChanged(before, status())) log(`fix-gate-drift:   changed ${path}`);
  }
  return failed;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Resolved through the trusted-root helper rather than PATH (javascript:S4036), and every repair
  // runs with this process's own Node.js binary.
  const git = resolveHostExecutable("git");
  const failed = runRepairs({
    repairs: DRIFT_REPAIRS,
    run: ({ script, args }) =>
      spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" }).status ?? 1,
    status: () => gitStatus(root, git),
    log: (line) => console.log(line),
  });
  if (failed.length > 0) {
    console.error(`fix-gate-drift: FAIL — ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("fix-gate-drift: PASS — review the changed files, then commit them");
}

if (isMainModule(import.meta.url)) main();
