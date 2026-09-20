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

/** A path that is simply absent, which is the one filesystem error this scan may ignore. */
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Report a filesystem failure and fail the run. An unreadable directory or file would otherwise
 * shorten the consumer list silently, which is the opposite of what this tool is for: an
 * incomplete list that looks complete is worse than no list.
 */
function reportScanFailure(path, error) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : "?";
  console.error(
    `list-workflow-consumers: cannot scan ${relative(REPO_ROOT, path)} (${String(code)})`,
  );
  process.exitCode = 1;
}

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
    } catch (error) {
      // A directory that is not there is an expected absence. Anything else — a permission or I/O
      // failure — would silently shorten the consumer list while the run still looked successful,
      // so it is reported and the run fails rather than under-reporting coupling.
      if (isMissing(error)) return;
      reportScanFailure(dir, error);
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
    } catch (error) {
      if (isMissing(error)) continue;
      reportScanFailure(path, error);
    }
  }
  return found;
}

/** Regular-expression fragments, kept separate so each is written in its clearest form. */
const QUOTE = "[\"'`]";
const PATH_SEPARATOR = String.raw`[/\\]`;
const DIGITS = String.raw`\d+`;

/**
 * A workflow name as a regular-expression LITERAL: every metacharacter escaped, not only the dot.
 * The name reaches this from the command line, so escaping one character would leave the pattern
 * injectable (CodeQL js/regex-injection) and would also make a name like `a+b.yml` silently match
 * the wrong files.
 */
function asPattern(workflow) {
  return workflow.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
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
    } catch (error) {
      if (isMissing(error)) continue;
      reportScanFailure(file, error);
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
/** The workflow files that exist, which is the only set this tool ever reports on. */
function availableWorkflows() {
  return readdirSync(WORKFLOW_DIR).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );
}

/**
 * Which workflows to report: every one with --all, the named ones, otherwise ci.yml.
 *
 * A requested name is RESOLVED against the directory rather than used as given. A name that does
 * not exist is a typo the caller should see, not a scan that quietly finds nothing — and resolving
 * it means no command-line string ever reaches the pattern builder.
 */
function selectWorkflows(everyWorkflow, named) {
  const available = availableWorkflows();
  if (everyWorkflow) return available;
  if (named.length === 0) return available.filter((name) => name === "ci.yml");
  const selected = [];
  for (const request of named) {
    const match = available.find((name) => name === request);
    if (match === undefined) {
      console.error(`list-workflow-consumers: no such workflow: ${request}`);
      console.error(`  available: ${available.join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    selected.push(match);
  }
  return selected;
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
