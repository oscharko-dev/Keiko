#!/usr/bin/env node
// Semantic duplication gate (#3898, owner decision of 2026-10-24).
//
// fallow 3.34 and later fail `dupes --fail-on-issues` on every clone group, which the 3.9 line never
// did, and the repository holds about a thousand groups that predate the gate. The owner's decision:
// generated files are excluded (`.fallowrc.json`), the rest is frozen in a shrink-only baseline
// (`docs/qa/fallow/dupes-baseline.json`), and a change fails on the clone groups it introduces.
//
//   node scripts/check-semantic-duplication.mjs                       # whole project
//   node scripts/check-semantic-duplication.mjs --changed-since <ref> # groups touching changed files
//   node scripts/check-semantic-duplication.mjs --save-baseline       # after removing duplicates
//
// fallow forms clone groups over the whole project, so the analysis always runs over the whole
// project against the baseline (a group seen from the changed files alone has a different identity
// and would never match it); `--changed-since` only narrows which new groups this change owns. A
// baseline entry whose clone is gone fails too, so the baseline is pruned in the change that removes
// the duplicate and can only shrink; `--save-baseline` refuses to record more groups than it holds.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveGitExecutable } from "./check-dependency-hygiene.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DUPES_BASELINE = "docs/qa/fallow/dupes-baseline.json";
export const FALLOW_DUPES_ARGS = Object.freeze([
  "dupes",
  "--mode",
  "semantic",
  "--min-tokens",
  "100",
  "--min-lines",
  "10",
  "--ignore-imports",
  "--no-package-baselines",
]);
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

// The pinned package's own entry, resolved as a dependency (run with this Node, never a PATH lookup).
// knip cannot see a spawned entry, so `fallow` is listed in its `ignoreDependencies`.
function fallowBinary() {
  const manifest = createRequire(import.meta.url).resolve("fallow/package.json");
  return join(dirname(manifest), "bin", "fallow");
}

function runFallow(args) {
  const result = spawnSync(process.execPath, [fallowBinary(), ...FALLOW_DUPES_ARGS, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function report(args) {
  const result = runFallow([...args, "--format", "json"]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`fallow produced no JSON report (exit ${String(result.status)})`);
  }
}

function changedFiles(ref) {
  const git = (args) => {
    const result = spawnSync(resolveGitExecutable(), args, { cwd: REPO_ROOT, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return result.stdout.split("\n").filter((line) => line.length > 0);
  };
  return new Set([
    ...git(["diff", "--name-only", "--diff-filter=ACMR", ref]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ]);
}

/** The new clone groups this change owns: every group, or those with an instance in a changed file. */
export function ownedGroups(groups, changed) {
  if (changed === undefined) return groups;
  return groups.filter((group) => group.instances.some((instance) => changed.has(instance.file)));
}

export function staleEntries(staleness) {
  return typeof staleness?.stale_entries === "number" ? staleness.stale_entries : 0;
}

function describe(group) {
  return group.instances
    .map(
      (instance) => `${instance.file}:${String(instance.start_line)}-${String(instance.end_line)}`,
    )
    .join(" | ");
}

function baselineEntryCount() {
  const path = join(REPO_ROOT, DUPES_BASELINE);
  if (!existsSync(path)) return 0;
  const baseline = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(baseline.clone_groups) ? baseline.clone_groups.length : 0;
}

function saveBaseline() {
  const current = report([]);
  const held = baselineEntryCount();
  const found = current.clone_groups.length;
  if (held > 0 && found > held) {
    console.error(
      `semantic-duplication: FAIL — the baseline only shrinks: ${String(found)} clone group(s) ` +
        `found, ${String(held)} held. Remove the new duplicates instead of recording them.`,
    );
    return 1;
  }
  const saved = runFallow(["--save-baseline", DUPES_BASELINE, "--format", "compact"]);
  if (saved.status !== 0) {
    console.error(`semantic-duplication: FAIL — fallow could not save the baseline.`);
    return 1;
  }
  console.log(`semantic-duplication: baseline saved with ${String(found)} clone group(s).`);
  return 0;
}

function reportFailures(owned, stale) {
  for (const group of owned) console.error(`  new clone group: ${describe(group)}`);
  if (owned.length > 0) {
    console.error(
      `semantic-duplication: FAIL — ${String(owned.length)} clone group(s) introduced. ` +
        "Extract the shared code instead of copying it.",
    );
  }
  if (stale > 0) {
    const entries = stale === 1 ? "entry is" : "entries are";
    console.error(
      `semantic-duplication: FAIL — ${String(stale)} baseline ${entries} no longer duplicated. ` +
        "Prune the baseline: node scripts/check-semantic-duplication.mjs --save-baseline",
    );
  }
}

function check(ref) {
  const current = report(["--baseline", DUPES_BASELINE]);
  const owned = ownedGroups(
    current.clone_groups,
    ref === undefined ? undefined : changedFiles(ref),
  );
  const stale = staleEntries(current.baseline_staleness);
  if (owned.length > 0 || stale > 0) {
    reportFailures(owned, stale);
    return 1;
  }
  const scope = ref === undefined ? "" : ` since ${ref}`;
  const held = String(current.baseline_staleness?.baseline_entries ?? 0);
  console.log(`semantic-duplication: PASS — no new clone group${scope}; ${held} baselined.`);
  return 0;
}

function main(argv) {
  if (argv.includes("--save-baseline")) return saveBaseline();
  const index = argv.indexOf("--changed-since");
  const ref = index === -1 ? undefined : argv[index + 1];
  if (index !== -1 && (ref === undefined || ref.length === 0)) {
    console.error("semantic-duplication: FAIL — --changed-since needs a ref.");
    return 1;
  }
  return check(ref);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
