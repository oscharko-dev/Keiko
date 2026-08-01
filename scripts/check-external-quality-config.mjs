#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODSPEED_ACTION = "CodSpeedHQ/action@88472375d0a4572cf70a9f1fe3a4e0ab8da1b924 # v5.0.1";
const REQUIRED_GREPTILE_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/qa/review-standards.md",
  "docs/adr/ADR-0019-modular-package-architecture.md",
  "docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md",
  "docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md",
  "docs/qa/autonomous-quality-gates.md",
];

function read(repoRoot, path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

export function loadExternalQualitySources(repoRoot = REPO_ROOT) {
  return {
    packageJson: read(repoRoot, "package.json"),
    codspeedWorkflow: read(repoRoot, ".github/workflows/codspeed.yml"),
    ciWorkflow: read(repoRoot, ".github/workflows/ci.yml"),
    codeRabbitConfig: read(repoRoot, ".coderabbit.yaml"),
    greptileConfig: read(repoRoot, ".greptile/config.json"),
    greptileFiles: read(repoRoot, ".greptile/files.json"),
  };
}

function validateCodeRabbitConfig(source) {
  const checks = [
    ['profile: "assertive"', "CodeRabbit must keep its assertive review profile"],
    ["request_changes_workflow: true", "CodeRabbit findings must block through review state"],
    ["fail_commit_status: true", "CodeRabbit review failures must remain observable"],
    ["review_details: true", "CodeRabbit must disclose incomplete or suppressed review scope"],
    ["auto_incremental_review: true", "CodeRabbit must review pull request updates"],
    [
      "auto_pause_after_reviewed_commits: 0",
      "CodeRabbit must not silently pause after head updates",
    ],
    ["drafts: false", "CodeRabbit draft auto-review must remain disabled"],
    ["ignore_usernames: []", "CodeRabbit must not omit bot-authored pull requests"],
    ["web_search:\n    enabled: false", "CodeRabbit must not add untrusted web context to review"],
    [
      "allow_non_org_members: false",
      "CodeRabbit commands must remain restricted to organization members",
    ],
    [
      "automatic_repository_linking: false",
      "CodeRabbit must not widen review context automatically",
    ],
    [
      "override_requested_reviewers_only: true",
      "CodeRabbit pre-merge failures must not be overridable by the pull-request author",
    ],
    [
      'files: "AGENTS.md,CONTRIBUTING.md,docs/qa/review-standards.md"',
      "CodeRabbit must consume repository governance",
    ],
  ];
  const problems = checks.flatMap(([expected, finding]) => missingText(source, expected, finding));
  const disabledMutations = [
    "docstrings",
    "unit_tests",
    "simplify",
    "autofix",
    "fix_ci",
    "resolve_merge_conflict",
  ];
  for (const feature of disabledMutations) {
    const pattern = new RegExp(`${feature}:\\n\\s+enabled: false`, "u");
    if (!pattern.test(source)) problems.push(`CodeRabbit ${feature} mutation must remain disabled`);
  }
  return problems;
}

function missingText(source, expected, finding) {
  return source.includes(expected) ? [] : [finding];
}

function validatePackage(packageJson) {
  const parsed = JSON.parse(packageJson);
  const duplicationCommand =
    "fallow dupes --mode semantic --min-tokens 100 --min-lines 10 --ignore-imports --format compact --fail-on-issues";
  const checks = [
    [
      parsed.devDependencies?.["@codspeed/tinybench-plugin"],
      "5.7.1",
      "@codspeed/tinybench-plugin must be pinned to 5.7.1",
    ],
    [parsed.devDependencies?.tinybench, "6.1.2", "tinybench must be pinned to 6.1.2"],
    [parsed.devDependencies?.fallow, "3.10.0", "fallow must be pinned to 3.10.0"],
    [
      parsed.scripts?.["bench:codspeed"],
      "node benchmarks/codspeed.mjs",
      "bench:codspeed must execute the repository-owned benchmark entry point",
    ],
    [
      parsed.scripts?.["check:external-quality-config"],
      "node scripts/check-external-quality-config.mjs",
      "check:external-quality-config script is missing or redirected",
    ],
    [
      parsed.scripts?.["check:semantic-duplication"],
      duplicationCommand,
      "semantic duplication must fail on every changed clone group",
    ],
  ];
  return checks.filter(([actual, expected]) => actual !== expected).map(([, , finding]) => finding);
}

function validateCodSpeedWorkflow(source) {
  const checks = [
    ["  pull_request:\n    branches:\n      - dev", "CodSpeed must run on dev pull requests"],
    ["  push:\n    branches:\n      - dev", "CodSpeed must establish baselines on dev pushes"],
    ["  workflow_dispatch:", "CodSpeed must support explicit baseline/backtest dispatch"],
    ["    timeout-minutes: 20", "CodSpeed must keep its 20-minute runtime bound"],
    ["      contents: read", "CodSpeed must grant only read access to repository contents"],
    ["      id-token: write", "CodSpeed must use OIDC instead of a long-lived upload token"],
    ["          persist-credentials: false", "CodSpeed checkout credentials must not persist"],
    ["        run: npm ci", "CodSpeed must install the committed dependency graph"],
    [
      "        run: npm run build:packages",
      "CodSpeed must benchmark built production entry points",
    ],
    [
      "        run: node scripts/check-runtime-toolchain.mjs --exact",
      "CodSpeed must verify the governed Node.js and npm toolchain",
    ],
    [`        uses: ${CODSPEED_ACTION}`, "CodSpeed action must use the reviewed immutable pin"],
    ["          mode: simulation", "CodSpeed must use deterministic CPU simulation"],
    ["          run: npm run bench:codspeed", "CodSpeed must run the owned benchmark suite"],
  ];
  const problems = checks.flatMap(([expected, finding]) => missingText(source, expected, finding));
  if (source.includes("CODSPEED_TOKEN")) {
    problems.push("CodSpeed must not introduce a long-lived repository upload token");
  }
  if (source.includes("continue-on-error")) {
    problems.push("CodSpeed execution must not be softened with continue-on-error");
  }
  return problems;
}

function equalStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function validateGreptileRule(rule, ids) {
  const problems = [];
  if (typeof rule.id !== "string" || rule.id.length === 0 || ids.has(rule.id)) {
    return ["Greptile rules must carry unique, non-empty ids"];
  }
  ids.add(rule.id);
  if (typeof rule.rule !== "string" || rule.rule.length === 0) {
    problems.push(`Greptile rule ${rule.id} has no instruction`);
  }
  if (rule.severity !== "high" && rule.severity !== "medium") {
    problems.push(`Greptile rule ${rule.id} must be high or medium severity`);
  }
  return problems;
}

function validateGreptileRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return ["Greptile rules must be non-empty"];
  const problems = [];
  const ids = new Set();
  for (const rule of rules) {
    problems.push(...validateGreptileRule(rule, ids));
  }
  return problems;
}

function validateGreptileScope(config) {
  const problems = [];
  if (config.strictness !== 2)
    problems.push("Greptile strictness must remain at high-signal level 2");
  if (!equalStrings(config.commentTypes, ["logic", "syntax"])) {
    problems.push("Greptile must leave deterministic style/info findings to repository gates");
  }
  if (!equalStrings(config.includeBranches, ["dev"])) {
    problems.push("Greptile must review pull requests targeting dev");
  }
  if (!equalStrings(config.excludeAuthors, [])) {
    problems.push("Greptile must not omit bot-authored dev pull requests by configuration");
  }
  if (config.fileChangeLimit !== 1000) problems.push("Greptile fileChangeLimit must remain 1000");
  return problems;
}

function validateGreptileBehavior(config) {
  const problems = [];
  if (config.triggerOnUpdates !== true) problems.push("Greptile must review every new head");
  if (config.triggerOnDrafts !== false)
    problems.push("Greptile draft auto-review must remain disabled");
  if (config.statusCheck !== true) problems.push("Greptile must emit an observable status check");
  if (config.fixWithAI !== false) problems.push("Greptile must not write pull-request code");
  if (config.shouldUpdateDescription !== false) {
    problems.push("Greptile must not mutate Keiko's load-bearing pull request template");
  }
  if (config.updateExistingSummaryComment !== true) {
    problems.push("Greptile must update one summary instead of creating comment churn");
  }
  return problems;
}

function validateGreptileConfig(source) {
  const config = JSON.parse(source);
  return [
    ...validateGreptileScope(config),
    ...validateGreptileBehavior(config),
    ...validateGreptileRules(config.rules),
  ];
}

function validateGreptileFiles(source, pathExists) {
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed.files)) return [".greptile/files.json must carry a files array"];
  const paths = parsed.files.map((entry) => entry.path);
  const problems = REQUIRED_GREPTILE_FILES.filter((path) => !paths.includes(path)).map(
    (path) => `Greptile context is missing ${path}`,
  );
  for (const entry of parsed.files) {
    if (typeof entry.path !== "string" || !pathExists(entry.path)) {
      problems.push(`Greptile context path does not exist: ${String(entry.path)}`);
    }
    if (typeof entry.description !== "string" || entry.description.length === 0) {
      problems.push(`Greptile context path lacks a description: ${String(entry.path)}`);
    }
  }
  return problems;
}

function validateCiWorkflow(source) {
  const checks = [
    ['GITLEAKS_VERSION: "8.30.1"', "Gitleaks must remain pinned to the reviewed OSS release"],
    [
      'GITLEAKS_LINUX_X64_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"',
      "Gitleaks must remain bound to the reviewed Linux archive digest",
    ],
    ["--redact=100", "Gitleaks output must remain fully redacted"],
    [
      'npm run check:semantic-duplication -- --changed-since "$base"',
      "required ci must run diff-scoped semantic duplication",
    ],
    ["      - secret-scan", "required ci must aggregate the secret scan"],
    ["      - semantic-duplication", "required ci must aggregate semantic duplication"],
    [
      "npm run check:external-quality-config",
      "required ci must execute check:external-quality-config",
    ],
  ];
  return checks.flatMap(([expected, finding]) => missingText(source, expected, finding));
}

export function validateExternalQualitySources(
  sources,
  pathExists = (path) => existsSync(join(REPO_ROOT, path)),
) {
  return [
    ...validatePackage(sources.packageJson),
    ...validateCodSpeedWorkflow(sources.codspeedWorkflow),
    ...validateCodeRabbitConfig(sources.codeRabbitConfig),
    ...validateGreptileConfig(sources.greptileConfig),
    ...validateGreptileFiles(sources.greptileFiles, pathExists),
    ...validateCiWorkflow(sources.ciWorkflow),
  ];
}

function main() {
  const problems = validateExternalQualitySources(loadExternalQualitySources());
  if (problems.length > 0) {
    for (const problem of problems) console.error(`external-quality-config: ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "external-quality-config: PASS — CodSpeed, CodeRabbit, and Greptile configuration is bound",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
