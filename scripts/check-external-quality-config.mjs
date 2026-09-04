#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODERABBIT_POLICY_DIGEST = "7749a565faf0018c24c275ecace8ce0515725fb13f301774d1a7e7dba4ff1cb5";
const CODERABBIT_TEXT_CHECKS = [
  ['profile: "assertive"', "CodeRabbit must keep its assertive review profile"],
  [
    "  request_changes_workflow: true",
    "CodeRabbit findings must request changes until their conversations are resolved",
  ],
  ["  commit_status: false", "CodeRabbit must not emit a quota-dependent merge status"],
  ["  fail_commit_status: false", "CodeRabbit failure status must remain advisory"],
  ["  review_status: false", "CodeRabbit review state must remain advisory"],
  ["review_details: true", "CodeRabbit must disclose incomplete or suppressed review scope"],
  ["high_level_summary: false", "CodeRabbit must not mutate the pull-request description"],
  ["auto_incremental_review: true", "CodeRabbit must review pull request updates"],
  ["auto_pause_after_reviewed_commits: 0", "CodeRabbit must not pause after head updates"],
  ["drafts: false", "CodeRabbit draft auto-review must remain disabled"],
  ['base_branches:\n      - "dev"', "CodeRabbit must review every pull request targeting dev"],
  ["ignore_usernames: []", "CodeRabbit must not omit bot-authored pull requests"],
  ["web_search:\n    enabled: false", "CodeRabbit must not add untrusted web context"],
  [
    "allow_non_org_members: false",
    "CodeRabbit commands must remain restricted to organization members",
  ],
  ["automatic_repository_linking: false", "CodeRabbit must not widen review context"],
  [
    "override_requested_reviewers_only: true",
    "CodeRabbit failures must not be overridable by the pull-request author",
  ],
  ['docstrings:\n      mode: "off"', "CodeRabbit must not impose a foreign docstring convention"],
  ['title:\n      mode: "warning"', "CodeRabbit title feedback must remain advisory"],
  ['description:\n      mode: "warning"', "CodeRabbit description feedback must remain advisory"],
  [
    'issue_assessment:\n      mode: "off"',
    "CodeRabbit must leave issue-scope enforcement to deterministic gates",
  ],
  [
    'files: "AGENTS.md,CONTRIBUTING.md,docs/qa/review-standards.md"',
    "CodeRabbit must consume repository governance",
  ],
  [
    'files: "docs/adr/ADR-0019-modular-package-architecture.md,docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md,docs/adr/ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md,docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md,docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md,docs/adr/ADR-0168-quota-tolerant-review-settlement.md,docs/adr/ADR-0169-*.md,docs/adr/ADR-0170-keiko-for-quality-as-an-external-reviewer.md"',
    "CodeRabbit must consume canonical architecture, authority, Sonar, and delivery decisions",
  ],
];

function read(repoRoot, path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

export function loadExternalQualitySources(repoRoot = REPO_ROOT) {
  return {
    ciWorkflow: read(repoRoot, ".github/workflows/ci.yml"),
    codeRabbitConfig: read(repoRoot, ".coderabbit.yaml"),
    packageJson: read(repoRoot, "package.json"),
  };
}

function isJsonObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : Number(left > right)))
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function semanticDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function parseYamlObject(source, label) {
  try {
    const value = parseYaml(source, { maxAliasCount: 0 });
    if (!isJsonObject(value)) throw new Error("parsed value is not a YAML object");
    return { problems: [], value };
  } catch {
    return { problems: [`${label} must contain a valid alias-free YAML object`] };
  }
}

function parseJsonObject(source, label) {
  try {
    const value = JSON.parse(source);
    if (!isJsonObject(value)) throw new Error("parsed value is not a JSON object");
    return { problems: [], value };
  } catch {
    return { problems: [`${label} must contain a valid JSON object`] };
  }
}

function missingText(source, expected, finding) {
  return source.includes(expected) ? [] : [finding];
}

function validateCodeRabbitConfig(source) {
  const parsed = parseYamlObject(source, "codeRabbitConfig");
  if (parsed.value === undefined) return parsed.problems;
  const problems = CODERABBIT_TEXT_CHECKS.flatMap(([expected, finding]) =>
    missingText(source, expected, finding),
  );
  if (parsed.value.reviews?.auto_review?.enabled !== true) {
    problems.push("CodeRabbit automatic review must remain enabled");
  }
  for (const feature of [
    "docstrings",
    "unit_tests",
    "simplify",
    "autofix",
    "fix_ci",
    "resolve_merge_conflict",
  ]) {
    const pattern = new RegExp(String.raw`${feature}:\n\s+enabled: false`, "u");
    if (!pattern.test(source)) problems.push(`CodeRabbit ${feature} mutation must remain disabled`);
  }
  if (semanticDigest(parsed.value) !== CODERABBIT_POLICY_DIGEST) {
    problems.push("CodeRabbit semantic review policy must match the reviewed configuration");
  }
  return problems;
}

function validatePackage(packageJson) {
  const parsed = parseJsonObject(packageJson, "packageJson");
  if (parsed.value === undefined) return parsed.problems;
  const duplicationCommand =
    "fallow dupes --mode semantic --min-tokens 100 --min-lines 10 --ignore-imports --format compact --fail-on-issues";
  const checks = [
    [parsed.value.devDependencies?.fallow, "3.9.1", "fallow must be pinned to 3.9.1"],
    [
      parsed.value.devDependencies?.yaml,
      "2.9.0",
      "yaml must be pinned to 2.9.0 for semantic reviewer-policy validation",
    ],
    [
      parsed.value.scripts?.["check:external-quality-config"],
      "node scripts/check-external-quality-config.mjs",
      "check:external-quality-config script is missing or redirected",
    ],
    [
      parsed.value.scripts?.["check:review-bot-suppression"],
      "node scripts/check-review-bot-suppression.mjs",
      "check:review-bot-suppression script is missing or redirected",
    ],
    [
      parsed.value.scripts?.["check:semantic-duplication"],
      duplicationCommand,
      "semantic duplication must fail on every changed clone group",
    ],
  ];
  return checks.filter(([actual, expected]) => actual !== expected).map(([, , finding]) => finding);
}

function validateCiWorkflow(source) {
  const checks = [
    [
      "types: [opened, reopened, synchronize, ready_for_review]",
      "required ci must run only for pull-request code-head actions",
    ],
    ['GITLEAKS_VERSION: "8.30.1"', "Gitleaks must remain pinned to the reviewed OSS release"],
    ["--redact=100", "Gitleaks output must remain fully redacted"],
    [
      'npm run check:semantic-duplication -- --changed-since "$QUALITY_BASE_SHA"',
      "required ci must run diff-scoped semantic duplication",
    ],
    ["      - secret-scan", "required ci must aggregate the secret scan"],
    ["      - semantic-duplication", "required ci must aggregate semantic duplication"],
    [
      "npm run check:external-quality-config",
      "required ci must execute check:external-quality-config",
    ],
    [
      "npm run check:review-bot-suppression",
      "required ci must reject pull-request metadata that suppresses CodeRabbit",
    ],
  ];
  const problems = checks.flatMap(([expected, finding]) => missingText(source, expected, finding));
  const resolverCalls =
    source.match(/node scripts\/resolve-quality-range\.mjs >> "\$GITHUB_OUTPUT"/gu)?.length ?? 0;
  if (resolverCalls !== 2) {
    problems.push("quality gates must share exactly two immutable-range resolver calls");
  }
  return problems;
}

export function validateExternalQualitySources(sources) {
  return [
    ...validatePackage(sources.packageJson),
    ...validateCodeRabbitConfig(sources.codeRabbitConfig),
    ...validateCiWorkflow(sources.ciWorkflow),
  ];
}

export function main(
  qualitySources = loadExternalQualitySources(),
  log = console.log,
  error = console.error,
) {
  const problems = validateExternalQualitySources(qualitySources);
  if (problems.length > 0) {
    for (const problem of problems) error(`external-quality-config: ${problem}`);
    return 1;
  }
  log("external-quality-config: PASS — CodeRabbit and deterministic repository gates are bound");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
