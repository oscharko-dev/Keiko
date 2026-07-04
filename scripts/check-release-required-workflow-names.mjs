#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowsDir = join(repoRoot, ".github", "workflows");
const releaseWorkflowPath = join(workflowsDir, "release.yml");

function fail(message) {
  console.error(`release-required-workflow-names: FAIL - ${message}`);
  process.exit(1);
}

function releaseRequiredChecks() {
  const source = readFileSync(releaseWorkflowPath, "utf8");
  const match = source.match(/^\s*RELEASE_REQUIRED_CHECKS:\s*'([^']+)'/m);
  if (match === null) {
    fail("release.yml does not declare env.RELEASE_REQUIRED_CHECKS as a single-quoted JSON list.");
  }
  const parsed = JSON.parse(match[1]);
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
  const match = source.match(new RegExp(`^\\s*${key}:\\s*\\[([^\\]]+)\\]`, "m"));
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

function workflowJobNames(source) {
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
    const nameMatch = line.match(/^ {4}name:\s*(.+)$/u);
    if (nameMatch !== null && currentJobId !== null) {
      currentJobName = unquoteYamlScalar(nameMatch[1]);
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

const required = releaseRequiredChecks();
const emitted = allWorkflowJobNames();
const missing = required.filter((name) => !emitted.has(name));

if (missing.length > 0) {
  fail(`required check names are not emitted by any workflow job: ${missing.join(", ")}`);
}

console.log(
  `release-required-workflow-names: PASS - ${String(required.length)} release checks match workflow job names.`,
);
