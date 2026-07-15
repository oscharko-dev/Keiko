#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const requiredReviewFiles = [
  "00-governance-and-delivery.md",
  "10-security-and-trust-boundaries.md",
  "20-architecture-quality-and-evidence.md",
];
const requiredIncludes = [
  "@AGENTS.md",
  "@CONTRIBUTING.md",
  "@docs/qa/keiko-for-quality.md",
  "@docs/qa/gitar-review-policy.md",
  "@docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md",
];
const requiredCoreInstructions = [
  "Assume every pull request targeting `dev` is a large, completed-epic integration PR",
  "exact current head",
  "direct app-bound required checks",
  "unreviewed files",
  "every finding at every severity",
  "failure-first regression",
  "package-surface",
  "Linux-authoritative release evidence",
  "gitar review",
  "Do not block merges, auto-approve",
  "Never force-push, push directly to `dev`, use `gitar unblock`",
];

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(join(directory, entry.name), "utf8"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function fileSetFailures(actual, expected, label) {
  const failures = [];
  const actualNames = new Set(actual.map((entry) => entry.name));
  for (const name of expected) {
    if (!actualNames.has(name)) failures.push(`${label} is missing ${name}`);
  }
  for (const name of actualNames) {
    if (!expected.includes(name)) failures.push(`${label} has unexpected file ${name}`);
  }
  return failures;
}

export function validateGitarSources(sources) {
  const failures = fileSetFailures(
    sources.reviews,
    requiredReviewFiles,
    "Gitar review instructions",
  );
  if (sources.approvalExists) {
    failures.push("Gitar Core configuration must not include Pro Auto-Approve criteria");
  }
  for (const rule of sources.rules) {
    failures.push(`Gitar Core configuration must not include Pro rule ${rule.name}`);
  }

  const reviewSource = sources.reviews.map((entry) => entry.source).join("\n");
  for (const include of requiredIncludes) {
    if (!reviewSource.includes(include)) {
      failures.push(`Gitar review instructions must include ${include}`);
    }
  }
  for (const instruction of requiredCoreInstructions) {
    if (!reviewSource.includes(instruction)) {
      failures.push(`Gitar Core review instructions must include: ${instruction}`);
    }
  }
  return failures;
}

export function loadGitarSources(root = repoRoot) {
  const gitarRoot = join(root, ".gitar");
  return {
    approvalExists: existsSync(join(gitarRoot, "config", "approve.md")),
    reviews: markdownFiles(join(gitarRoot, "review")),
    rules: markdownFiles(join(gitarRoot, "rules")),
  };
}

function main() {
  const failures = validateGitarSources(loadGitarSources());
  if (failures.length > 0) {
    const details = failures.map((failure) => `- ${failure}`).join("\n");
    console.error(`check:gitar-config FAILED\n${details}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "check:gitar-config PASS - Core-only configuration and 3 review instruction files validated.",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
