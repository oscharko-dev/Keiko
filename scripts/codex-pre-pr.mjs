#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultReportPath = resolve(repoRoot, ".codex", "pre-pr-report.json");
const nodeHeapFlag = "--max-old-space-size=8192";

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
    command: npmCommand(options.platform),
    env: options.env ?? {},
    id,
    required: true,
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
      platform,
    });
  }
  return skippedNpmStep(
    "editor-release-evidence",
    ["run", "check:editor-release-evidence"],
    "Skipped on non-Linux hosts because Keiko editor release evidence is Linux-authoritative.",
    platform,
  );
}

export function commandText(step) {
  return [step.command, ...step.args].join(" ");
}

export function createPrePrSteps(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const lintEnv = lintEnvironment(env);
  return [
    npmStep("typecheck", ["run", "typecheck"], { platform }),
    npmStep("lint", ["run", "lint"], { env: lintEnv, platform }),
    npmStep("format", ["run", "format:check"], { platform }),
    npmStep("ui-typecheck", ["run", "typecheck", "--workspace", "@oscharko-dev/keiko-ui"], {
      platform,
    }),
    npmStep("ui-lint", ["run", "lint", "--workspace", "@oscharko-dev/keiko-ui"], {
      env: lintEnv,
      platform,
    }),
    npmStep("unit-tests", ["test"], { platform }),
    npmStep("coverage-quality", ["run", "test:coverage:quality"], { platform }),
    npmStep("lcov-source-mapping", ["run", "check:lcov-source-mapping"], { platform }),
    npmStep("architecture", ["run", "arch:check"], { platform }),
    npmStep("architecture-negative", ["run", "arch:check:negative"], { platform }),
    npmStep("adr-index", ["run", "check:adr-index"], { platform }),
    npmStep("dependency-hygiene", ["run", "check:dependency-hygiene"], { platform }),
    npmStep("clean", ["run", "clean"], { platform }),
    npmStep("build", ["run", "build"], { platform }),
    npmStep("prepare-bin", ["run", "prepare:bin"], { platform }),
    npmStep("build-ui", ["run", "build:ui"], { platform }),
    editorReleaseEvidenceStep(platform),
    npmStep("prune-package-build-artifacts", ["run", "prune:package-build-artifacts"], {
      platform,
    }),
    npmStep("package-surface", ["run", "check:package-surface"], { platform }),
    npmStep(
      "editor-bundle-size",
      ["run", "check:editor-bundle-size", "--", "--require-static-export"],
      { platform },
    ),
    npmStep("e2e-smoke", ["run", "test:e2e:smoke"], { platform }),
  ];
}

function emptySummary() {
  return { failed: 0, passed: 0, planned: 0, skipped: 0 };
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
  for (const step of steps) {
    console.log(`\n[codex:pre-pr] ${step.id}: ${commandText(step)}`);
    const result = await runStep(step, options);
    results.push(result);
    if (result.status === "failed") break;
  }
  return results;
}

export async function writePrePrReport(report, reportPath = defaultReportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function runPrePrGate(options = {}) {
  const steps = createPrePrSteps(options);
  const dryRun = options.dryRun ?? false;
  const results = dryRun
    ? steps.map((step) => resultForPlanned(step))
    : await runLiveSteps(steps, {
        cwd: options.cwd ?? repoRoot,
        env: options.env ?? process.env,
      });
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
  console.log("\n[codex:pre-pr] Local gate report");
  for (const result of report.results) {
    const suffix = result.durationMs === undefined ? "" : ` (${formatDuration(result.durationMs)})`;
    const reason = result.skipReason === undefined ? "" : ` - ${result.skipReason}`;
    console.log(`- ${result.status}: ${result.id} :: ${result.command}${suffix}${reason}`);
  }
  console.log(`[codex:pre-pr] Report written to ${reportPath}`);
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const reportIndex = argv.indexOf("--report");
  return {
    dryRun,
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
