#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReportPath = resolve(repoRoot, ".agent", "pre-pr-report.json");
const nodeHeapFlag = "--max-old-space-size=8192";

// ADR-0139 D4: content-addressed step cache. Each step declares a conservative input scope;
// a step is skipped as "cached" only when every file inside its scope (tracked or untracked,
// working-tree content) hashes to the same digest that last saw the step pass. Groups skip or
// run as one unit so artifact producers and their consumers can never diverge. The cache is
// versioned, keyed on the exact command line and Node major, disabled in CI, and bypassed
// with --no-cache.
const CACHE_SCHEMA_VERSION = 2;
const defaultCacheFileName = join(".agent", "pre-pr-cache.json");
// Root configuration that changes what a step ENFORCES: editing these must bust the cached
// verdict of the steps that consume them, or a local run could report a false green bar.
const ROOT_TS_CONFIG = [
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "tsconfig.packages.json",
  "package.json",
];
const ROOT_LINT_CONFIG = ["eslint.config.js", "package.json"];
const SCOPE_SOURCES = ["packages/", "src/", "tests/", "scripts/"];
const SCOPE_TYPECHECK = [...SCOPE_SOURCES, ...ROOT_TS_CONFIG];
const SCOPE_LINT = [...SCOPE_SOURCES, ...ROOT_LINT_CONFIG];
const SCOPE_PRODUCT = [
  "packages/",
  "src/",
  "scripts/",
  "tests/e2e/",
  "docs/release/",
  ...ROOT_TS_CONFIG,
];
const SCOPE_COVERAGE = [...SCOPE_SOURCES, ...ROOT_TS_CONFIG, "docs/qa/"];

function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function appendNodeOption(current, option) {
  if (current?.split(/\s+/u).includes(option)) return current;
  return [current, option].filter(Boolean).join(" ");
}

function npmStep(id, args, options = {}) {
  return {
    args,
    cacheGroup: options.cacheGroup,
    cacheScope: options.cacheScope,
    command: npmCommand(options.platform),
    env: options.env ?? {},
    id,
    required: true,
    requiredArtifacts: options.requiredArtifacts ?? [],
  };
}

function skippedNpmStep(id, args, reason, platform) {
  return {
    args,
    command: npmCommand(platform),
    id,
    required: false,
    skipReason: reason,
  };
}

function lintEnvironment(env) {
  return {
    NODE_OPTIONS: appendNodeOption(env.NODE_OPTIONS, nodeHeapFlag),
  };
}

function editorReleaseEvidenceStep(platform) {
  if (platform === "linux") {
    return npmStep("editor-release-evidence", ["run", "check:editor-release-evidence"], {
      cacheGroup: "product",
      cacheScope: SCOPE_PRODUCT,
      platform,
      requiredArtifacts: ["dist/ui/static"],
    });
  }
  return skippedNpmStep(
    "editor-release-evidence",
    ["run", "check:editor-release-evidence"],
    "Skipped on non-Linux hosts because Keiko editor release evidence is Linux-authoritative.",
    platform,
  );
}

function editorDebuggingE2eStep(platform) {
  if (platform === "linux") {
    return npmStep("editor-debugging-e2e", ["run", "test:e2e:editor-debugging-2348"], {
      cacheGroup: "product",
      cacheScope: SCOPE_PRODUCT,
      platform,
      requiredArtifacts: ["dist/ui/static"],
    });
  }
  return skippedNpmStep(
    "editor-debugging-e2e",
    ["run", "test:e2e:editor-debugging-2348"],
    "Skipped on non-Linux hosts because the governed debugging E2E requires the Linux Bubblewrap qualification boundary; required Linux CI executes it.",
    platform,
  );
}

function installSmokeStep(platform) {
  if (platform === "linux") {
    return npmStep("install-smoke", ["run", "smoke:install"], {
      cacheGroup: "product",
      cacheScope: SCOPE_PRODUCT,
      platform,
      requiredArtifacts: ["dist"],
    });
  }
  return skippedNpmStep(
    "install-smoke",
    ["run", "smoke:install"],
    "Skipped on non-Linux hosts because the pack prepack chain validates Linux-authoritative release evidence; required Linux CI and the container path execute it.",
    platform,
  );
}

function nativeQualityStep(platform) {
  if (platform === "darwin") {
    return npmStep("native-quality", ["run", "check:native:macos"], { platform });
  }
  if (platform === "win32") {
    return npmStep("native-quality", ["run", "check:native:windows"], { platform });
  }
  return skippedNpmStep(
    "native-quality",
    ["run", "check:native:macos"],
    "Skipped on Linux because the required native evidence is produced on Windows and macOS.",
    platform,
  );
}

export function commandText(step) {
  return [step.command, ...step.args].join(" ");
}

function listScopedFiles(cwd, scope) {
  const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--"];
  const output = execFileSync(resolveHostExecutable("git"), [...args, ...(scope ?? ["."])], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter((path) => path.length > 0);
}

function hashWorkingFile(cwd, path) {
  try {
    return createHash("sha256")
      .update(readFileSync(join(cwd, path)))
      .digest("hex");
  } catch {
    return "absent";
  }
}

export function computeStepInputDigest(step, { cwd = repoRoot, fileDigest } = {}) {
  const digest = createHash("sha256");
  digest.update(`schema:${String(CACHE_SCHEMA_VERSION)}\0`);
  digest.update(`node:${process.version.split(".")[0] ?? ""}\0`);
  digest.update(`command:${commandText(step)}\0`);
  const resolveDigest = fileDigest ?? ((path) => hashWorkingFile(cwd, path));
  for (const path of listScopedFiles(cwd, step.cacheScope).sort(compareStrings)) {
    digest.update(`${path}\0${resolveDigest(path)}\0`);
  }
  return digest.digest("hex");
}

async function readStepCache(cachePath) {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8"));
    return parsed?.schemaVersion === CACHE_SCHEMA_VERSION && typeof parsed.steps === "object"
      ? parsed.steps
      : {};
  } catch {
    return {};
  }
}

async function writeStepCache(cachePath, steps) {
  await mkdir(dirname(cachePath), { recursive: true });
  const payload = { schemaVersion: CACHE_SCHEMA_VERSION, steps };
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function hasRequiredArtifacts(step, cwd) {
  return step.requiredArtifacts.every((artifact) => existsSync(join(cwd, artifact)));
}

function stepCacheHit(step, digests, cache, cwd) {
  if (step.skipReason !== undefined) return false;
  const entry = cache[step.id];
  return (
    entry?.verdict === "passed" &&
    entry.inputsDigest === digests.get(step.id) &&
    hasRequiredArtifacts(step, cwd)
  );
}

// Groups skip or run as one unit: if any member of a cache group must run (changed inputs,
// missing artifacts, or a prior failure), every member of the group runs, so artifact
// producers and their consumers can never diverge.
export function planCacheDecisions(steps, cache, { cwd = repoRoot } = {}) {
  const digests = new Map(
    steps
      .filter((step) => step.skipReason === undefined)
      .map((step) => [step.id, computeStepInputDigest(step, { cwd })]),
  );
  const groupInvalidated = new Set();
  for (const step of steps) {
    if (step.cacheGroup !== undefined && !stepCacheHit(step, digests, cache, cwd)) {
      groupInvalidated.add(step.cacheGroup);
    }
  }
  const cached = new Set();
  for (const step of steps) {
    const groupBlocked = step.cacheGroup !== undefined && groupInvalidated.has(step.cacheGroup);
    if (!groupBlocked && stepCacheHit(step, digests, cache, cwd)) cached.add(step.id);
  }
  return { cached, digests };
}

function resultForCached(step) {
  return {
    command: commandText(step),
    id: step.id,
    required: step.required,
    status: "cached",
  };
}

function staticQualitySteps(platform, lintEnv) {
  return [
    npmStep("typecheck", ["run", "typecheck"], { cacheScope: SCOPE_TYPECHECK, platform }),
    npmStep("lint", ["run", "lint"], { cacheScope: SCOPE_LINT, env: lintEnv, platform }),
    npmStep("format", ["run", "format:check"], { platform }),
    npmStep("qodo-config", ["run", "check:qodo-config"], { platform }),
    npmStep("ui-i18n", ["run", "check:ui-i18n"], {
      cacheScope: ["packages/keiko-ui/", "scripts/"],
      platform,
    }),
    npmStep("sonar-scope", ["run", "check:sonar-scope"], { platform }),
    npmStep("shell-spawn-guardrails", ["run", "check:shell-spawn-guardrails"], {
      cacheScope: ["scripts/"],
      platform,
    }),
    nativeQualityStep(platform),
    npmStep("ui-typecheck", ["run", "typecheck", "--workspace", "@oscharko-dev/keiko-ui"], {
      cacheScope: ["packages/", ...ROOT_TS_CONFIG],
      platform,
    }),
    npmStep("ui-lint", ["run", "lint", "--workspace", "@oscharko-dev/keiko-ui"], {
      cacheScope: ["packages/", ...ROOT_LINT_CONFIG],
      env: lintEnv,
      platform,
    }),
  ];
}

function testAndArchitectureSteps(platform) {
  return [
    npmStep("unit-tests", ["test"], { cacheScope: SCOPE_SOURCES, platform }),
    npmStep("coverage-quality", ["run", "test:coverage:quality"], {
      cacheGroup: "coverage",
      cacheScope: SCOPE_COVERAGE,
      platform,
    }),
    npmStep("lcov-source-mapping", ["run", "check:lcov-source-mapping"], {
      cacheGroup: "coverage",
      cacheScope: SCOPE_COVERAGE,
      platform,
    }),
    npmStep("architecture", ["run", "arch:check"], { cacheScope: SCOPE_SOURCES, platform }),
    npmStep("architecture-negative", ["run", "arch:check:negative"], {
      cacheScope: SCOPE_SOURCES,
      platform,
    }),
    npmStep("adr-index", ["run", "check:adr-index"], { cacheScope: ["docs/adr/"], platform }),
    npmStep("dependency-hygiene", ["run", "check:dependency-hygiene"], {
      cacheScope: ["packages/", "scripts/"],
      platform,
    }),
    npmStep("knip", ["run", "check:knip"], {
      cacheScope: ["."],
      platform,
    }),
  ];
}

function productBuildAndReleaseSteps(platform) {
  const product = { cacheGroup: "product", cacheScope: SCOPE_PRODUCT, platform };
  return [
    npmStep("clean", ["run", "clean"], product),
    npmStep("build", ["run", "build"], { ...product, requiredArtifacts: ["dist"] }),
    npmStep("prepare-bin", ["run", "prepare:bin"], product),
    npmStep("build-ui", ["run", "build:ui"], { ...product, requiredArtifacts: ["dist/ui/static"] }),
    editorReleaseEvidenceStep(platform),
    npmStep("editor-performance-evidence", ["run", "check:perf-evidence:editor"], product),
    npmStep("prune-package-build-artifacts", ["run", "prune:package-build-artifacts"], product),
    npmStep("prune-package-native-optionals", ["run", "prune:package-native-optionals"], product),
    npmStep("package-surface", ["run", "check:package-surface"], product),
    npmStep(
      "editor-bundle-size",
      ["run", "check:editor-bundle-size", "--", "--require-static-export"],
      { ...product, requiredArtifacts: ["dist/ui/static"] },
    ),
    editorDebuggingE2eStep(platform),
    installSmokeStep(platform),
    npmStep("e2e-smoke", ["run", "test:e2e:smoke"], {
      ...product,
      requiredArtifacts: ["dist/ui/static"],
    }),
  ];
}

export function createPrePrSteps(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const lintEnv = lintEnvironment(env);
  return [
    ...staticQualitySteps(platform, lintEnv),
    ...testAndArchitectureSteps(platform),
    ...productBuildAndReleaseSteps(platform),
  ];
}

function emptySummary() {
  return { cached: 0, failed: 0, passed: 0, planned: 0, skipped: 0 };
}

function summarize(results) {
  return results.reduce((summary, result) => {
    summary[result.status] += 1;
    return summary;
  }, emptySummary());
}

function resultForPlanned(step) {
  return {
    command: commandText(step),
    id: step.id,
    required: step.required,
    status: step.skipReason === undefined ? "planned" : "skipped",
    skipReason: step.skipReason,
  };
}

function resultForSkipped(step) {
  return {
    command: commandText(step),
    id: step.id,
    required: step.required,
    skipReason: step.skipReason,
    status: "skipped",
  };
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function runProcess(step, cwd, env) {
  return new Promise((resolveRun) => {
    const child = spawn(step.command, step.args, {
      cwd,
      env: { ...env, ...step.env },
      stdio: "inherit",
    });
    child.once("error", (error) => resolveRun({ code: 1, error }));
    child.once("close", (code) => resolveRun({ code: code ?? 1 }));
  });
}

async function runStep(step, options) {
  if (step.skipReason !== undefined) return resultForSkipped(step);
  const startedAt = Date.now();
  const outcome = await runProcess(step, options.cwd, options.env);
  const durationMs = Date.now() - startedAt;
  return {
    command: commandText(step),
    durationMs,
    error: outcome.error?.message,
    exitCode: outcome.code,
    id: step.id,
    required: step.required,
    status: outcome.code === 0 ? "passed" : "failed",
  };
}

async function runLiveSteps(steps, options) {
  const results = [];
  const cachePlan = options.cachePlan ?? { cached: new Set(), digests: new Map() };
  for (const step of steps) {
    if (cachePlan.cached.has(step.id)) {
      console.log(`\n[agent:pre-pr] ${step.id}: cached (inputs unchanged)`);
      results.push(resultForCached(step));
      continue;
    }
    console.log(`\n[agent:pre-pr] ${step.id}: ${commandText(step)}`);
    const result = await runStep(step, options);
    results.push(result);
    if (result.status === "failed") break;
  }
  return results;
}

function cacheEntriesAfterRun(results, cachePlan, previous) {
  const failed = new Set(
    results.filter((result) => result.status === "failed").map((result) => result.id),
  );
  const steps = Object.fromEntries(Object.entries(previous).filter(([id]) => !failed.has(id)));
  for (const result of results) {
    const inputsDigest = cachePlan.digests.get(result.id);
    if (inputsDigest === undefined) continue;
    if (result.status === "passed" || result.status === "cached") {
      steps[result.id] = { inputsDigest, verdict: "passed" };
    }
  }
  return steps;
}

export async function writePrePrReport(report, reportPath = defaultReportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function cacheEnabled(options, env, dryRun) {
  if (dryRun || options.noCache === true) return false;
  return typeof env.CI !== "string" || env.CI.length === 0;
}

const disabledCache = () => ({ active: false, cached: new Set(), digests: new Map() });

async function resolveCachePlan(steps, options, cwd, env, dryRun) {
  if (!cacheEnabled(options, env, dryRun)) return { ...disabledCache(), previous: {} };
  try {
    const previous = await readStepCache(options.cachePath ?? join(cwd, defaultCacheFileName));
    return { active: true, previous, ...planCacheDecisions(steps, previous, { cwd }) };
  } catch {
    // Digest computation requires a git worktree; outside one the cache silently disables
    // instead of failing the gate.
    return { ...disabledCache(), previous: {} };
  }
}

export async function runPrePrGate(options = {}) {
  const steps = createPrePrSteps(options);
  const dryRun = options.dryRun ?? false;
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? process.env;
  const cachePlan = await resolveCachePlan(steps, options, cwd, env, dryRun);
  const results = dryRun
    ? steps.map((step) => resultForPlanned(step))
    : await runLiveSteps(steps, { cachePlan, cwd, env });
  if (cachePlan.active) {
    await writeStepCache(
      options.cachePath ?? join(cwd, defaultCacheFileName),
      cacheEntriesAfterRun(results, cachePlan, cachePlan.previous),
    );
  }
  const report = {
    dryRun,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: options.platform ?? process.platform,
    results,
    summary: summarize(results),
  };
  await writePrePrReport(report, options.reportPath);
  return report;
}

function printReport(report, reportPath = defaultReportPath) {
  console.log("\n[agent:pre-pr] Local gate report");
  for (const result of report.results) {
    const suffix = result.durationMs === undefined ? "" : ` (${formatDuration(result.durationMs)})`;
    const reason = result.skipReason === undefined ? "" : ` - ${result.skipReason}`;
    console.log(`- ${result.status}: ${result.id} :: ${result.command}${suffix}${reason}`);
  }
  console.log(`[agent:pre-pr] Report written to ${reportPath}`);
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const noCache = argv.includes("--no-cache");
  const reportIndex = argv.indexOf("--report");
  return {
    dryRun,
    noCache,
    reportPath:
      reportIndex === -1 || argv[reportIndex + 1] === undefined
        ? defaultReportPath
        : resolve(argv[reportIndex + 1]),
  };
}

async function executeCli() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPrePrGate(options);
  printReport(report, options.reportPath);
  if (report.summary.failed > 0) process.exitCode = 1;
}

function isCliEntrypoint() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliEntrypoint()) await executeCli();
