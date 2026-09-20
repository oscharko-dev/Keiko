#!/usr/bin/env node
// What else reads the workflow you are about to change?
//
// A workflow file is not only consumed by GitHub. Gates and tests in this repository read it too —
// by parsing it, by counting things in it, and in one case by LINE NUMBER — and none of that
// coupling is visible from the workflow itself. A single added `if:` line on one job has broken
// seven independent contracts at once, each surfacing one CI round later as an unrelated-looking
// failure.
//
// The information was always derivable; it was just never at hand. This prints it: given a
// workflow (default `ci.yml`), the scripts and suites that read it, and the gate command to run
// for each one that has a dedicated gate. It is a lookup tool, not a gate — it blocks nothing and
// is deliberately not wired into CI, because the answer to "too many coupled gates" is not another
// gate.
//
// Usage:
//   node scripts/list-workflow-consumers.mjs            # ci.yml
//   node scripts/list-workflow-consumers.mjs release.yml
//   node scripts/list-workflow-consumers.mjs --all      # every workflow

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareStrings } from "./lib/compare-strings.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const SEARCH_ROOTS = ["scripts", "tests", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".next", ".turbo", "build"]);
const SOURCE_SUFFIXES = [".mjs", ".js", ".ts", ".tsx", ".mts", ".cts"];

/**
 * Gates that read workflow files. This is a fixed, reviewed list rather than a text search,
 * because the gates that hurt most do NOT name a workflow: `check:zizmor-anchors` resolves its
 * targets through `.github/zizmor.yml`, and `check:e2e-suite-wiring` walks the whole directory.
 * A search for "ci.yml" misses exactly those two — the line-number anchors and the condition
 * evaluator — which is the failure this tool exists to prevent.
 */
const WORKFLOW_GATES = Object.freeze([
  {
    command: "npm run check:zizmor-anchors",
    why: "LINE-NUMBER anchors in .github/zizmor.yml; ANY inserted line shifts them",
    repair: "npm run check:zizmor-anchors -- --fix",
  },
  {
    command: "npm run check:e2e-suite-wiring",
    why: "reduces each job's `if:` to decide whether a suite is PR-blocking; an unknown term reads as 'does not run'",
  },
  {
    command: "npm run check:workflow-branch-parity",
    why: "branch lists must match across ci.yml, CodeQL and Dependency Review",
  },
  {
    command: "npm run check:release-required-workflows",
    why: "RELEASE_REQUIRED_CHECKS must name real job names; a skipped required job blocks the release",
  },
  {
    command: "npm run check:activity-log",
    why: "its host job may carry no condition other than the reviewed reuse guard",
  },
  {
    command: "npm run check:dependency-currency",
    why: "pinned action SHAs are recorded in the closeout document",
  },
]);

/**
 * Every source file under the search roots, skipping build output and dependencies.
 * @returns {string[]} absolute paths
 */
function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) found.push(path);
    }
  };
  for (const root of SEARCH_ROOTS) {
    const path = join(REPO_ROOT, root);
    try {
      if (statSync(path).isDirectory()) walk(path);
    } catch {
      continue;
    }
  }
  return found;
}

/** Regular-expression fragments, kept separate so each is written in its clearest form. */
const QUOTE = "[\"'`]";
const PATH_SEPARATOR = String.raw`[/\\]`;
const DIGITS = String.raw`\d+`;

/** A workflow name as a regular-expression literal: only the dot needs escaping. */
function asPattern(workflow) {
  return workflow.replaceAll(".", String.raw`\.`);
}

/**
 * How a file refers to the workflow, so a reader can tell a parse from a line-number anchor.
 * @returns {string[]} short labels, strongest coupling first
 */
function couplingKinds(text, workflow) {
  const kinds = [];
  if (new RegExp(String.raw`${asPattern(workflow)}:\d+`, "u").test(text)) {
    kinds.push("LINE NUMBERS — shifts on any inserted line");
  }
  if (/toBe\(\d+\)|toHaveLength\(\d+\)/u.test(text)) kinds.push("exact counts");
  if (/parseDocument\(|YAML\.parse\(|yaml["']\)/u.test(text)) kinds.push("parses YAML");
  if (/\bjob\.if\b|\.jobs\[[^\]]+\]\.if\b|\bif:\s*\$\{\{/u.test(text)) {
    kinds.push("reads job conditions");
  }
  return kinds.length > 0 ? kinds : ["references it"];
}

/**
 * Report every consumer of one workflow.
 * @returns {number} consumer count
 */
function reportWorkflow(workflow, files) {
  // A bare filename also appears in prose, fixtures and unrelated strings. Require a reference
  // that actually addresses the workflow: a path, or the `<name>:<line>` anchor form.
  const escaped = asPattern(workflow);
  const addresses = new RegExp(
    `workflows${PATH_SEPARATOR}${escaped}|${QUOTE}${escaped}${QUOTE}|${escaped}:${DIGITS}`,
    "u",
  );
  const consumers = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!addresses.test(text)) continue;
    const rel = relative(REPO_ROOT, file);
    consumers.push({
      rel,
      base: rel.split("/").at(-1) ?? rel,
      kinds: couplingKinds(text, workflow),
    });
  }
  const ordered = consumers.toSorted((a, b) => compareStrings(a.rel, b.rel));

  console.log(`\n${workflow} — ${String(ordered.length)} consumer(s)\n`);
  for (const { rel, kinds } of ordered) {
    console.log(`  ${rel}`);
    console.log(`      ${kinds.join("; ")}`);
  }
  console.log("\n  These run inside `npm test`: a changed count fails there, not only in CI.");
  return ordered.length;
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const requested = args.filter((arg) => !arg.startsWith("--"));
/** Which workflows to report: every one with --all, the named ones, otherwise ci.yml. */
function selectWorkflows(everyWorkflow, named) {
  if (everyWorkflow) {
    return readdirSync(WORKFLOW_DIR).filter(
      (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
    );
  }
  return named.length > 0 ? named : ["ci.yml"];
}

const workflows = selectWorkflows(all, requested);

const files = sourceFiles();
for (const workflow of workflows.toSorted(compareStrings)) reportWorkflow(workflow, files);

console.log("\nGates to run after changing any workflow:\n");
for (const { command, why, repair } of WORKFLOW_GATES) {
  console.log(`  ${command}`);
  console.log(`      ${why}`);
  if (repair !== undefined) console.log(`      repair: ${repair}`);
}
