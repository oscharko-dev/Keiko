#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowsDir = join(repoRoot, ".github", "workflows");
const releaseWorkflowPath = join(workflowsDir, "release.yml");
const portableWorkflowPath = join(workflowsDir, "portable-assets.yml");

function fail(message) {
  console.error(`release-required-workflow-names: FAIL - ${message}`);
  process.exit(1);
}

// Plain string scan instead of a single `^\s*KEY:\s*'([^']+)'`m regex: chaining two unbounded
// `\s*` quantifiers around a literal key in one pattern is the S8786 shape Sonar flags for
// super-linear backtracking risk, even though this specific case is bounded by the width of
// leading indentation. Splitting into a per-line scan removes the ambiguity structurally.
function quotedEnvValue(source, key) {
  const prefix = `${key}:`;
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(prefix)) continue;
    const afterKey = trimmed.slice(prefix.length).trimStart();
    if (!afterKey.startsWith("'")) continue;
    const closeIndex = afterKey.indexOf("'", 1);
    if (closeIndex <= 1) continue; // require at least one char between quotes, like `[^']+`
    return afterKey.slice(1, closeIndex);
  }
  return undefined;
}

export function releaseRequiredChecks(source = readFileSync(releaseWorkflowPath, "utf8")) {
  const captured = quotedEnvValue(source, "RELEASE_REQUIRED_CHECKS");
  if (captured === undefined) {
    fail("release.yml does not declare env.RELEASE_REQUIRED_CHECKS as a single-quoted JSON list.");
  }
  const parsed = JSON.parse(captured);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    fail("RELEASE_REQUIRED_CHECKS must parse to an array of strings.");
  }
  return parsed;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function matrixValues(source, key) {
  const match = source.match(new RegExp(String.raw`^\s*${key}:\s*\[([^\]]+)\]`, "m"));
  if (match === null) return [];
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function expandMatrixName(name, source) {
  const matrixExpression = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/u;
  const match = name.match(matrixExpression);
  if (match === null) return [name];
  const values = matrixValues(source, match[1]);
  if (values.length === 0) return [name];
  return values.map((value) => name.replace(matrixExpression, value));
}

const JOB_NAME_LINE_PREFIX = "    name:";

export function workflowJobNames(source) {
  const names = [];
  const lines = source.split(/\r?\n/u);
  let inJobs = false;
  let currentJobId = null;
  let currentJobName = null;

  function flush() {
    if (currentJobId === null) return;
    const name = currentJobName ?? currentJobId;
    names.push(...expandMatrixName(name, source));
  }

  for (const line of lines) {
    if (/^jobs:\s*$/u.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/u);
    if (jobMatch !== null) {
      flush();
      currentJobId = jobMatch[1];
      currentJobName = null;
      continue;
    }
    // Plain prefix/slice check instead of `/^ {4}name:\s*(.+)$/u`: `unquoteYamlScalar` already
    // trims its input, so matching-then-trimming collapses to "has any content after the
    // literal prefix" - removing the regex avoids the S8786 chained-quantifier shape entirely.
    if (currentJobId !== null && line.startsWith(JOB_NAME_LINE_PREFIX)) {
      const rest = line.slice(JOB_NAME_LINE_PREFIX.length);
      if (rest.length > 0) currentJobName = unquoteYamlScalar(rest);
    }
  }
  flush();
  return names;
}

function allWorkflowJobNames() {
  const names = new Set();
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".yml")) continue;
    const source = readFileSync(join(workflowsDir, entry.name), "utf8");
    for (const name of workflowJobNames(source)) {
      names.add(name);
    }
  }
  return names;
}

// Exported as part of the release-authority seam so a sibling test file can derive the CURRENT
// base branch instead of restating it as a literal. A hardcoded `release/0.x` in the test rots
// silently at the next release cut: the drift `replace()` stops matching, the mutation becomes a
// no-op, and the pin goes green over an undetected contract drift.
export function envValue(source, name) {
  // The key is caller-provided through the exported seam: escape regex metacharacters so an
  // unusual env name can never silently match the wrong line and weaken a drift pin.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const match = source.match(new RegExp(String.raw`^\s*${escaped}:\s*(.+)$`, "m"));
  return match === null ? undefined : unquoteYamlScalar(match[1]);
}

export function portableReleaseAuthorityFailures(releaseSource, portableSource) {
  const failures = [];
  for (const name of ["RELEASE_BASE_BRANCH", "RELEASE_REQUIRED_CHECKS"]) {
    const expected = envValue(releaseSource, name);
    const actual = envValue(portableSource, name);
    if (expected === undefined || actual !== expected) failures.push(name);
  }
  return failures;
}

function main() {
  const releaseSource = readFileSync(releaseWorkflowPath, "utf8");
  const portableSource = readFileSync(portableWorkflowPath, "utf8");
  const authorityFailures = portableReleaseAuthorityFailures(releaseSource, portableSource);
  if (authorityFailures.length > 0) {
    fail(`portable-assets.yml release authority drifted: ${authorityFailures.join(", ")}`);
  }

  const required = releaseRequiredChecks(releaseSource);
  const emitted = allWorkflowJobNames();
  const missing = required.filter((name) => !emitted.has(name));

  if (missing.length > 0) {
    fail(`required check names are not emitted by any workflow job: ${missing.join(", ")}`);
  }

  console.log(
    `release-required-workflow-names: PASS - ${String(required.length)} release checks match workflow job names and portable authority.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename))
  main();
