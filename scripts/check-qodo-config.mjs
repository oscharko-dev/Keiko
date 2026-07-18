#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const configFile = ".pr_agent.toml";
const bestPracticesFile = "best_practices.md";
const bestPracticesMaxLines = 800;

const requiredReferences = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/qa/keiko-for-quality.md",
  "docs/qa/qodo-review-policy.md",
  "docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md",
  "docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md",
];

const requiredInstructions = [
  "Assume every pull request targeting `dev` is a large, completed-epic integration PR",
  "exact current head",
  "direct app-bound required checks",
  "unreviewed files",
  "every finding at every severity",
  "failure-first regression",
  "package-surface",
  "Linux-authoritative release evidence",
  "Qodo is advisory",
  "Do not block merges, auto-approve",
  "Never force-push, push directly to `dev`",
];

// Qodo is comment-only and must never gain merge authority: none of these
// auto-approval switches may be enabled in the repository configuration.
const autoApprovalKeys = [
  "approve_pr_on_self_review",
  "auto_approve_for_no_suggestions",
  "enable_auto_approval",
];

function readIfPresent(root, name) {
  const path = join(root, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function loadQodoSources(root = repoRoot) {
  return {
    bestPractices: readIfPresent(root, bestPracticesFile),
    config: readIfPresent(root, configFile),
  };
}

// Parse `key = true|false` TOML assignments with a linear scan (no backtracking regex).
function booleanSettings(config) {
  const values = new Map();
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    const token = line
      .slice(equals + 1)
      .trim()
      .split(/[\s#]/u)[0];
    if (token === "true" || token === "false") values.set(key, token);
  }
  return values;
}

function autoApprovalFailures(config) {
  const settings = booleanSettings(config);
  const failures = [];
  for (const key of autoApprovalKeys) {
    if (settings.get(key) === "true") {
      failures.push(`Qodo config must not enable ${key}; Qodo has no merge authority`);
    }
  }
  if (settings.get("approve_pr_on_self_review") !== "false") {
    failures.push("Qodo config must explicitly set approve_pr_on_self_review = false");
  }
  return failures;
}

function contentFailures(combined) {
  // Governance prose wraps across lines, so compare on collapsed whitespace.
  const normalized = combined.replace(/\s+/gu, " ");
  const failures = [];
  for (const reference of requiredReferences) {
    if (!normalized.includes(reference))
      failures.push(`Qodo review guidance must reference ${reference}`);
  }
  for (const instruction of requiredInstructions) {
    if (!normalized.includes(instruction.replace(/\s+/gu, " ")))
      failures.push(`Qodo review guidance must include: ${instruction}`);
  }
  return failures;
}

export function validateQodoSources(sources) {
  const failures = [];
  if (sources.config === undefined) failures.push(`${configFile} is missing`);
  else failures.push(...autoApprovalFailures(sources.config));
  if (sources.bestPractices === undefined) failures.push(`${bestPracticesFile} is missing`);
  else if (sources.bestPractices.split("\n").length > bestPracticesMaxLines) {
    failures.push(`${bestPracticesFile} exceeds ${String(bestPracticesMaxLines)} lines`);
  }
  const combined = [sources.config, sources.bestPractices].filter(Boolean).join("\n");
  failures.push(...contentFailures(combined));
  return failures;
}

function main() {
  const failures = validateQodoSources(loadQodoSources());
  if (failures.length > 0) {
    const details = failures.map((failure) => `- ${failure}`).join("\n");
    console.error(`check:qodo-config FAILED\n${details}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "check:qodo-config PASS - .pr_agent.toml and best_practices.md validated (advisory, no merge authority).",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
