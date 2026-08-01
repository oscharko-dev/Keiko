#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODSPEED_ACTION = "CodSpeedHQ/action@88472375d0a4572cf70a9f1fe3a4e0ab8da1b924 # v5.0.1";
const CODERABBIT_POLICY_DIGEST = "17fdcd6d9fdfd12b243835de3965644f9f3fc8e1cc08eaff46b862a733d5d554";
const GREPTILE_CONFIG_POLICY_DIGEST =
  "9b91b199db0bbc311ea037449ebafebf57c789cdb24a4721c2145e1751795e00";
const GREPTILE_FILES_POLICY_DIGEST =
  "3f4c83ab4cb2755028d2c6455475bff05f3eb43e1dd997106b300004cdf58179";
const REQUIRED_GREPTILE_FILES = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/qa/review-standards.md",
  "docs/adr/ADR-0019-modular-package-architecture.md",
  "docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md",
  "docs/adr/ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md",
  "docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md",
  "docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md",
  "docs/adr/ADR-0168-quota-tolerant-review-settlement.md",
  "docs/qa/autonomous-quality-gates.md",
];
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
  ["auto_review:\n    enabled: true", "CodeRabbit automatic review must remain enabled"],
  ["auto_incremental_review: true", "CodeRabbit must review pull request updates"],
  ["auto_pause_after_reviewed_commits: 0", "CodeRabbit must not silently pause after head updates"],
  ["drafts: false", "CodeRabbit draft auto-review must remain disabled"],
  ['base_branches:\n      - "dev"', "CodeRabbit must review every pull request targeting dev"],
  ["ignore_usernames: []", "CodeRabbit must not omit bot-authored pull requests"],
  ["web_search:\n    enabled: false", "CodeRabbit must not add untrusted web context to review"],
  [
    "allow_non_org_members: false",
    "CodeRabbit commands must remain restricted to organization members",
  ],
  ["automatic_repository_linking: false", "CodeRabbit must not widen review context automatically"],
  [
    "override_requested_reviewers_only: true",
    "CodeRabbit pre-merge failures must not be overridable by the pull-request author",
  ],
  [
    'docstrings:\n      mode: "off"',
    "CodeRabbit must not impose a foreign docstring convention on TypeScript",
  ],
  ['title:\n      mode: "warning"', "CodeRabbit title feedback must remain advisory"],
  ['description:\n      mode: "warning"', "CodeRabbit description feedback must remain advisory"],
  [
    'issue_assessment:\n      mode: "off"',
    "CodeRabbit must leave issue-scope enforcement to deterministic repository delivery",
  ],
  [
    'files: "AGENTS.md,CONTRIBUTING.md,docs/qa/review-standards.md"',
    "CodeRabbit must consume repository governance",
  ],
  [
    'files: "docs/adr/ADR-0019-modular-package-architecture.md,docs/adr/ADR-0129-product-wide-authority-and-autonomy-model.md,docs/adr/ADR-0131-ci-based-sonarcloud-analysis-and-banking-grade-gate.md,docs/adr/ADR-0135-deterministic-dev-delivery-and-keiko-for-quality.md,docs/adr/ADR-0167-zero-cost-autonomous-quality-gates.md,docs/adr/ADR-0168-quota-tolerant-review-settlement.md"',
    "CodeRabbit must consume canonical architecture, authority, Sonar, and delivery decisions",
  ],
];

const IGNORED_SCAN_DIRECTORIES = new Set([".git"]);
const ALLOWED_ROOT_GREPTILE_FILES = new Set([".greptile/config.json", ".greptile/files.json"]);
const GREPTILE_INVENTORY_FAILURE = ".greptile/inventory-unavailable";

function read(repoRoot, path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function isGreptilePath(path) {
  return path.split("/").includes(".greptile");
}

function findFilesystemPaths(repoRoot, relativeDirectory = "") {
  const paths = [];
  for (const entry of readdirSync(join(repoRoot, relativeDirectory), { withFileTypes: true })) {
    if (IGNORED_SCAN_DIRECTORIES.has(entry.name)) continue;
    const relativePath = join(relativeDirectory, entry.name);
    const normalized = relativePath.split("\\").join("/");
    if (entry.isSymbolicLink()) {
      if (isGreptilePath(normalized)) paths.push(normalized);
      continue;
    }
    if (entry.isDirectory()) {
      paths.push(...findFilesystemPaths(repoRoot, relativePath));
      continue;
    }
    paths.push(normalized);
  }
  return paths;
}

function listGitRepositoryPaths(repoRoot) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter((path) => path.length > 0);
  } catch {
    return [GREPTILE_INVENTORY_FAILURE];
  }
}

function isReviewedRootGreptileFile(repoRoot, path) {
  return ALLOWED_ROOT_GREPTILE_FILES.has(path) && isRegularRepositoryFile(repoRoot, path);
}

export function findUnreviewedGreptilePaths(repoRoot) {
  const paths = listGitRepositoryPaths(repoRoot) ?? findFilesystemPaths(repoRoot);
  return paths.filter(
    (path) => isGreptilePath(path) && !isReviewedRootGreptileFile(repoRoot, path),
  );
}

export function loadExternalQualitySources(repoRoot = REPO_ROOT) {
  return {
    packageJson: read(repoRoot, "package.json"),
    codspeedConfig: read(repoRoot, "codspeed.yml"),
    codspeedPolicy: read(repoRoot, ".codspeed-policy.json"),
    codspeedPolicyWorkflow: read(repoRoot, ".github/workflows/codspeed-policy.yml"),
    codspeedWorkflow: read(repoRoot, ".github/workflows/codspeed.yml"),
    ciWorkflow: read(repoRoot, ".github/workflows/ci.yml"),
    codeRabbitConfig: read(repoRoot, ".coderabbit.yaml"),
    greptileConfig: read(repoRoot, ".greptile/config.json"),
    greptileFiles: read(repoRoot, ".greptile/files.json"),
    unreviewedGreptilePaths: findUnreviewedGreptilePaths(repoRoot),
  };
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
  const disabledMutations = [
    "docstrings",
    "unit_tests",
    "simplify",
    "autofix",
    "fix_ci",
    "resolve_merge_conflict",
  ];
  for (const feature of disabledMutations) {
    const pattern = new RegExp(String.raw`${feature}:\n\s+enabled: false`, "u");
    if (!pattern.test(source)) problems.push(`CodeRabbit ${feature} mutation must remain disabled`);
  }
  if (semanticDigest(parsed.value) !== CODERABBIT_POLICY_DIGEST) {
    problems.push("CodeRabbit semantic review policy must match the reviewed configuration");
  }
  return problems;
}

function missingText(source, expected, finding) {
  return source.includes(expected) ? [] : [finding];
}

function isJsonObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function semanticDigest(value) {
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

function validateCodSpeedDependencies(parsed) {
  const problems = [];
  if (parsed.devDependencies?.["@codspeed/tinybench-plugin"] !== undefined) {
    problems.push(
      "CodSpeed must not add its telemetry-capable npm runtime to the dependency graph",
    );
  }
  if (parsed.devDependencies?.tinybench !== undefined) {
    problems.push("CodSpeed CLI mode must not retain an unused Tinybench dependency");
  }
  return problems;
}

function validatePackage(packageJson) {
  const parsedResult = parseJsonObject(packageJson, "packageJson");
  if (parsedResult.value === undefined) return parsedResult.problems;
  const parsed = parsedResult.value;
  const duplicationCommand =
    "fallow dupes --mode semantic --min-tokens 100 --min-lines 10 --ignore-imports --format compact --fail-on-issues";
  const checks = [
    [parsed.devDependencies?.fallow, "2.104.0", "fallow must be pinned to 2.104.0"],
    [
      parsed.devDependencies?.yaml,
      "2.9.0",
      "yaml must be pinned to 2.9.0 for semantic reviewer-policy validation",
    ],
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
      parsed.scripts?.["check:review-bot-suppression"],
      "node scripts/check-review-bot-suppression.mjs",
      "check:review-bot-suppression script is missing or redirected",
    ],
    [
      parsed.scripts?.["check:codspeed-policy"],
      "node scripts/check-codspeed-policy.mjs",
      "check:codspeed-policy script is missing or redirected",
    ],
    [
      parsed.scripts?.["check:semantic-duplication"],
      duplicationCommand,
      "semantic duplication must fail on every changed clone group",
    ],
  ];
  const problems = checks
    .filter(([actual, expected]) => actual !== expected)
    .map(([, , finding]) => finding);
  return [...problems, ...validateCodSpeedDependencies(parsed)];
}

function validateCodSpeedWorkflow(source) {
  const checks = [
    ["  pull_request:\n    branches:\n      - dev", "CodSpeed must run on dev pull requests"],
    ["  push:\n    branches:\n      - dev", "CodSpeed must establish baselines on dev pushes"],
    ["  workflow_dispatch:", "CodSpeed must support explicit baseline/backtest dispatch"],
    ["    timeout-minutes: 20", "CodSpeed must keep its 20-minute runtime bound"],
    ["      contents: read", "CodSpeed must grant only read access to repository contents"],
    ["          persist-credentials: false", "CodSpeed checkout credentials must not persist"],
    [
      "          ref: ${{ github.event.pull_request.head.sha || github.sha }}",
      "CodSpeed checkout must bind pull requests to the exact head",
    ],
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
  ];
  const problems = checks.flatMap(([expected, finding]) => missingText(source, expected, finding));
  if (source.includes("CODSPEED_TOKEN")) {
    problems.push("CodSpeed must not introduce a long-lived repository upload token");
  }
  if (source.includes("id-token: write")) {
    problems.push("CodSpeed pull-request benchmarks must not receive an OIDC credential grant");
  }
  if (source.includes("continue-on-error")) {
    problems.push("CodSpeed execution must not be softened with continue-on-error");
  }
  if (source.includes("check:codspeed-policy")) {
    problems.push("CodSpeed benchmarks must not execute a pull-request-controlled policy gate");
  }
  const actionStep = source.slice(source.indexOf(`        uses: ${CODSPEED_ACTION}`));
  if (/^\s{10}run:/mu.test(actionStep)) {
    problems.push("CodSpeed action must discover codspeed.yml instead of a framework plugin run");
  }
  return problems;
}

const CODSPEED_POLICY_WORKFLOW_CHECKS = [
  ["  pull_request_target:", "CodSpeed policy must use the base-trusted event"],
  [
    "types: [opened, reopened, synchronize, ready_for_review]",
    "CodSpeed policy must cover every reviewable head",
  ],
  ["timeout-minutes: 10", "CodSpeed policy must keep its ten-minute runtime bound"],
  ["contents: read", "CodSpeed policy must grant only read access to repository contents"],
  [
    "run: node scripts/check-runtime-toolchain.mjs --exact",
    "CodSpeed policy must verify the governed Node.js and npm toolchain",
  ],
  [
    "QUALITY_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
    "CodSpeed policy must bind execution to the immutable protected base",
  ],
  [
    'git fetch --no-tags --depth=1 origin "$QUALITY_BASE_SHA"',
    "CodSpeed policy must fetch only the immutable protected base",
  ],
  [
    'git checkout --detach "$QUALITY_BASE_SHA"',
    "CodSpeed policy must execute only the immutable protected base",
  ],
  [
    "QUALITY_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
    "CodSpeed policy input must bind the exact pull-request head",
  ],
  [
    "QUALITY_CODSPEED_POLICY_PATH: ${{ runner.temp }}/codspeed-policy.json",
    "CodSpeed policy data must use a fixed runner-temporary path",
  ],
  [
    '"repos/${QUALITY_REPOSITORY}/contents/.codspeed-policy.json?ref=${QUALITY_HEAD_SHA}"',
    "CodSpeed policy must fetch only the exact-head policy file",
  ],
  ['"" | *[!0-9a-f]* )', "CodSpeed policy must reject non-hexadecimal head references"],
  [
    'if [ "${#QUALITY_HEAD_SHA}" -ne 40 ]; then',
    "CodSpeed policy must reject non-SHA-length head references",
  ],
  [
    "run: test -f scripts/check-codspeed-policy.mjs",
    "CodSpeed policy must fail closed when the base gate is unavailable",
  ],
  [
    "run: node scripts/check-codspeed-policy.mjs",
    "CodSpeed policy must execute the base-owned validator",
  ],
];

const CODSPEED_POLICY_WORKFLOW_FORBIDDEN = [
  "contents: write",
  "id-token: write",
  "ref: ${{ github.event.pull_request.head.sha }}",
  "QUALITY_BASE_SHA: ${{ github.event.pull_request.head.sha }}",
  "github.event.pull_request.head.ref",
  "github.head_ref",
  "refs/pull/",
  "run: npm",
  "uses: actions/checkout@",
];

function validateCodSpeedPolicyWorkflow(source) {
  const problems = CODSPEED_POLICY_WORKFLOW_CHECKS.flatMap(([expected, finding]) =>
    missingText(source, expected, finding),
  );
  if (CODSPEED_POLICY_WORKFLOW_FORBIDDEN.some((entry) => source.includes(entry))) {
    problems.push("CodSpeed policy must never grant writes or execute pull-request code");
  }
  return problems;
}

export function validateCodSpeedPolicy(source) {
  const parsed = parseJsonObject(source, "codspeedPolicy");
  if (parsed.value === undefined) return parsed.problems;
  const policy = parsed.value;
  const checks = [
    [policy.schemaVersion, 2, "CodSpeed policy schema version must remain 2"],
    [policy.project, "oscharko-dev/Keiko", "CodSpeed policy must bind the Keiko project"],
    [policy.regressionThresholdPercent, 5, "CodSpeed regression threshold must remain 5%"],
    [policy.failOnRegression, true, "CodSpeed regressions must fail their status check"],
    [policy.pullRequestReport, "always", "CodSpeed must report every pull-request head"],
  ];
  const problems = checks
    .filter(([actual, expected]) => actual !== expected)
    .map(([, , finding]) => finding);
  return problems;
}

function validateCodSpeedConfig(source) {
  const commands = [
    "node benchmarks/codspeed.mjs security-redact",
    "node benchmarks/codspeed.mjs security-prompt-injection",
    "node benchmarks/codspeed.mjs context-allocation",
    "node benchmarks/codspeed.mjs editor-text-edits",
  ];
  const problems = commands.flatMap((command) =>
    missingText(source, `    exec: ${command}`, `CodSpeed CLI manifest is missing ${command}`),
  );
  const benchmarkCount = source.match(/^\s{2}- name:/gmu)?.length ?? 0;
  if (benchmarkCount !== commands.length) {
    problems.push("CodSpeed CLI manifest must define exactly four governed benchmarks");
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
  if (!isJsonObject(rule)) {
    return ["Greptile rules must be JSON objects"];
  }
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
  if (config.fileChangeLimit !== 500) problems.push("Greptile fileChangeLimit must remain 500");
  return problems;
}

function validateGreptileBehavior(config) {
  const problems = [];
  if (config.triggerOnUpdates !== true) problems.push("Greptile must review every new head");
  if (config.triggerOnDrafts !== false)
    problems.push("Greptile draft auto-review must remain disabled");
  if (config.statusCheck !== true) problems.push("Greptile must emit an observable status check");
  if (config.statusCommentsEnabled !== false) {
    problems.push("Greptile status comments must remain disabled");
  }
  if (
    !isJsonObject(config.sequenceDiagramSection) ||
    config.sequenceDiagramSection.included !== false
  ) {
    problems.push("Greptile sequence diagrams must remain disabled");
  }
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
  const parsed = parseJsonObject(source, "greptileConfig");
  if (parsed.value === undefined) return parsed.problems;
  const config = parsed.value;
  const problems = [
    ...validateGreptileScope(config),
    ...validateGreptileBehavior(config),
    ...validateGreptileRules(config.rules),
  ];
  if (semanticDigest(config) !== GREPTILE_CONFIG_POLICY_DIGEST) {
    problems.push("Greptile semantic review policy must match the reviewed configuration");
  }
  return problems;
}

function isBoundedRepositoryPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 240 &&
    !path.includes("\\") &&
    !posix.isAbsolute(path) &&
    posix.normalize(path) === path &&
    path !== ".." &&
    !path.startsWith("../")
  );
}

export function isRegularRepositoryFile(repoRoot, path) {
  if (!isBoundedRepositoryPath(path)) return false;
  try {
    const repositoryRoot = realpathSync(repoRoot);
    const candidate = join(repositoryRoot, path);
    return (
      lstatSync(candidate).isFile() && realpathSync(candidate) === resolve(repositoryRoot, path)
    );
  } catch {
    return false;
  }
}

function validateGreptileFiles(source, pathExists) {
  const parsedResult = parseJsonObject(source, "greptileFiles");
  if (parsedResult.value === undefined) return parsedResult.problems;
  const parsed = parsedResult.value;
  if (!Array.isArray(parsed.files)) return [".greptile/files.json must carry a files array"];
  if (parsed.files.some((entry) => !isJsonObject(entry))) {
    return [".greptile/files.json entries must be JSON objects"];
  }
  const paths = new Set(parsed.files.map((entry) => entry.path));
  const problems = REQUIRED_GREPTILE_FILES.filter((path) => !paths.has(path)).map(
    (path) => `Greptile context is missing ${path}`,
  );
  for (const [index, entry] of parsed.files.entries()) {
    if (!isBoundedRepositoryPath(entry.path) || !pathExists(entry.path)) {
      problems.push(
        `Greptile context entry ${String(index)} must name an existing repository path`,
      );
    }
    if (typeof entry.description !== "string" || entry.description.length === 0) {
      problems.push(`Greptile context entry ${String(index)} must carry a description`);
    }
  }
  if (semanticDigest(parsed) !== GREPTILE_FILES_POLICY_DIGEST) {
    problems.push("Greptile context policy must match the reviewed governance inventory");
  }
  return problems;
}

function validateUnreviewedGreptilePaths(paths) {
  return Array.isArray(paths) && paths.length === 0
    ? []
    : [
        "Unreviewed Greptile files and nested controls are prohibited because provider rules cascade",
      ];
}

function validateCiWorkflow(source) {
  const checks = [
    [
      "types: [opened, reopened, synchronize, ready_for_review, edited]",
      "required ci must rerun when pull-request metadata changes",
    ],
    ['GITLEAKS_VERSION: "8.30.1"', "Gitleaks must remain pinned to the reviewed OSS release"],
    [
      'GITLEAKS_LINUX_X64_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"',
      "Gitleaks must remain bound to the reviewed Linux archive digest",
    ],
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
      "required ci must reject pull-request metadata that suppresses review bots",
    ],
  ];
  const problems = checks.flatMap(([expected, finding]) => missingText(source, expected, finding));
  const resolverCalls =
    source.match(/node scripts\/resolve-quality-range\.mjs >> "\$GITHUB_OUTPUT"/gu)?.length ?? 0;
  if (resolverCalls !== 2)
    problems.push("quality gates must share exactly two immutable-range resolver calls");
  return problems;
}

export function validateExternalQualitySources(
  sources,
  pathExists = (path) => isRegularRepositoryFile(REPO_ROOT, path),
) {
  return [
    ...validatePackage(sources.packageJson),
    ...validateCodSpeedConfig(sources.codspeedConfig),
    ...validateCodSpeedPolicy(sources.codspeedPolicy),
    ...validateCodSpeedPolicyWorkflow(sources.codspeedPolicyWorkflow),
    ...validateCodSpeedWorkflow(sources.codspeedWorkflow),
    ...validateCodeRabbitConfig(sources.codeRabbitConfig),
    ...validateGreptileConfig(sources.greptileConfig),
    ...validateGreptileFiles(sources.greptileFiles, pathExists),
    ...validateUnreviewedGreptilePaths(sources.unreviewedGreptilePaths),
    ...validateCiWorkflow(sources.ciWorkflow),
  ];
}

export function main(
  qualitySources = loadExternalQualitySources(),
  pathExists = undefined,
  log = console.log,
  error = console.error,
) {
  const problems = validateExternalQualitySources(qualitySources, pathExists);
  if (problems.length > 0) {
    for (const problem of problems) error(`external-quality-config: ${problem}`);
    return 1;
  }
  log("external-quality-config: PASS — CodSpeed, CodeRabbit, and Greptile configuration is bound");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
