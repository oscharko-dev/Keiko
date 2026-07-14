#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const requiredRuleFiles = [
  "architecture-and-public-surface.md",
  "governance-and-delivery.md",
  "security-boundary-review.md",
  "ui-and-release-evidence.md",
  "verification-and-coverage.md",
];
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
const requiredFrontmatter = ["title", "description", "when", "actions"];
const devIntegrationInvariant =
  "Assume every pull request targeting `dev` is a large, completed-epic integration PR";

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(join(directory, entry.name), "utf8"),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
  if (match === null) return undefined;
  const values = new Map();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (separator > 0 && /^[a-z][a-z-]*$/u.test(name) && value !== "")
      values.set(name, value.replace(/^"|"$/gu, ""));
  }
  return values;
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

function frontmatterFailures(rule, frontmatter) {
  const failures = [];
  for (const field of requiredFrontmatter) {
    if (!frontmatter.get(field))
      failures.push(`${rule.name} is missing frontmatter field ${field}`);
  }
  return failures;
}

function expectedActionPrefix(name) {
  if (name === "governance-and-delivery.md") return "Enable Auto-Apply";
  return name === "verification-and-coverage.md" ? "Auto-apply" : "Post a comment";
}

function actionFailures(rule, action) {
  if (action === undefined) return [];
  const failures = [];
  const prefix = expectedActionPrefix(rule.name);
  if (!action.startsWith(prefix)) {
    failures.push(`${rule.name} must start its action with ${prefix}`);
  }
  const guards = ["never unblock", "force-push", "push to dev", "bypass direct required checks"];
  if (
    rule.name === "governance-and-delivery.md" &&
    !guards.every((guard) => action.includes(guard))
  ) {
    failures.push(`${rule.name} must preserve autonomous-delivery hard denials`);
  }
  return failures;
}

function ruleFailures(rule) {
  const frontmatter = parseFrontmatter(rule.source);
  if (frontmatter === undefined) return [`${rule.name} has no valid YAML frontmatter`];
  const failures = [
    ...frontmatterFailures(rule, frontmatter),
    ...actionFailures(rule, frontmatter.get("actions")),
  ];
  if (frontmatter.has("integrations"))
    failures.push(`${rule.name} must not require an integration`);
  return failures;
}

export function validateGitarSources(sources) {
  const failures = [
    ...fileSetFailures(sources.rules, requiredRuleFiles, "Gitar rules"),
    ...fileSetFailures(sources.reviews, requiredReviewFiles, "Gitar review instructions"),
  ];
  if (sources.rules.length > 5) failures.push("Gitar Pro supports at most five custom rules");
  for (const rule of sources.rules) failures.push(...ruleFailures(rule));
  const reviewSource = sources.reviews.map((entry) => entry.source).join("\n");
  for (const include of requiredIncludes) {
    if (!reviewSource.includes(include))
      failures.push(`Gitar review instructions must include ${include}`);
  }
  if (!reviewSource.includes(devIntegrationInvariant)) {
    failures.push(
      "Gitar review instructions must treat every dev PR as a large completed-epic integration PR",
    );
  }
  if (!sources.approval.includes("Only auto-approve")) {
    failures.push("Gitar auto-approve criteria must define a positive allowlist");
  }
  if (!sources.approval.includes("Never auto-approve")) {
    failures.push("Gitar auto-approve criteria must define explicit exclusions");
  }
  for (const criterion of [
    "exact current head",
    "every finding at every severity",
    "direct app-bound required checks",
  ]) {
    if (!sources.approval.includes(criterion)) {
      failures.push(`Gitar auto-approve criteria must require ${criterion}`);
    }
  }
  return failures;
}

export function loadGitarSources(root = repoRoot) {
  const gitarRoot = join(root, ".gitar");
  return {
    approval: readFileSync(join(gitarRoot, "config", "approve.md"), "utf8"),
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
    "check:gitar-config PASS - 5 bounded Pro rules and 3 review instruction files validated.",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
