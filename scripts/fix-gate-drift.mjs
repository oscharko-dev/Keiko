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
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
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

/**
 * Paths `git status --porcelain -z` reports as changed or untracked. The NUL-separated form never
 * quotes a path (a tab, a non-ASCII byte or a quote stays as it is, whatever core.quotePath says),
 * and a rename or copy carries its origin as the next record, which is skipped.
 */
export function changedPaths(porcelain) {
  const records = porcelain.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length <= 3) continue;
    paths.push(record.slice(3));
    if (/[RC]/u.test(record.slice(0, 2))) index += 1;
  }
  return paths.sort((left, right) => left.localeCompare(right));
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

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * What a changed path holds now: a regular file by its content, a symbolic link by its target text
 * (a link to a directory cannot be read as a file), anything else by its kind.
 */
export function contentDigest(root, path) {
  let entry;
  try {
    entry = lstatSync(join(root, path));
  } catch (error) {
    if (error?.code === "ENOENT") return "deleted";
    throw error;
  }
  if (entry.isSymbolicLink()) return `link:${sha256(readlinkSync(join(root, path)))}`;
  if (entry.isFile()) return sha256(readFileSync(join(root, path)));
  return entry.isDirectory() ? "directory" : "other";
}

export function gitStatus(root, git, spawn = spawnSync) {
  const result = spawn(git, ["status", "--porcelain", "-z", "--untracked-files=all"], {
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

/**
 * Runs the repairs and returns the exit code. `root`, `git`, `spawn`, `repairs`, `log` and `error`
 * are seams for the in-process tests; the command line uses this checkout, the trusted Git binary,
 * `spawnSync`, DRIFT_REPAIRS and the console.
 */
export function main({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  // Resolved through the trusted-root helper rather than PATH (javascript:S4036), and every repair
  // runs with this process's own Node.js binary.
  git = resolveHostExecutable("git"),
  spawn = spawnSync,
  repairs = DRIFT_REPAIRS,
  log = console.log,
  error = console.error,
} = {}) {
  const failed = runRepairs({
    repairs,
    run: ({ script, args }) =>
      spawn(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" }).status ?? 1,
    status: () => gitStatus(root, git, spawn),
    log,
  });
  if (failed.length > 0) {
    error(`fix-gate-drift: FAIL — ${failed.join(", ")}`);
    return 1;
  }
  log("fix-gate-drift: PASS — review the changed files, then commit them");
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
