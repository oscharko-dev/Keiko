#!/usr/bin/env node
// Controlled local runner for the pattern algorithm and physical-line public-handler pins.
// Ordinary required Vitest retains their behavior and work assertions under ADR-0139; separate
// sequential child processes enforce the unchanged 1000 ms and 5000 ms budgets without a shell.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/is-main-module.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const GROUNDED_WORKSPACE_PATTERN_TEST =
  "packages/keiko-server/src/grounded-orchestrator.workspace-pattern.test.ts";
export const GROUNDED_WORKSPACE_PATTERN_PROCESS_TIMEOUT_MS = 30_000;
export const GROUNDED_SYMBOL_LINE_TEST =
  "packages/keiko-server/src/grounded-symbol-line.public-handler.test.ts";

export function resolveInstalledVitestEntry() {
  const packageJsonPath = findPackageJSON("vitest", import.meta.url);
  if (packageJsonPath === undefined) {
    throw new Error("Vitest package metadata is unavailable");
  }
  const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin = metadata.bin?.vitest;
  if (typeof bin !== "string" || bin.length === 0) {
    throw new Error("Vitest package metadata has no executable");
  }
  const packageRoot = dirname(packageJsonPath);
  const entry = resolve(packageRoot, bin);
  const packageRelativeEntry = relative(packageRoot, entry);
  if (packageRelativeEntry === ".." || packageRelativeEntry.startsWith(`..${sep}`)) {
    throw new Error("Vitest executable escapes its package root");
  }
  return entry;
}

export function controlledVitestInvocation(vitestEntry, environment = process.env) {
  return {
    command: process.execPath,
    args: [vitestEntry, "run", GROUNDED_WORKSPACE_PATTERN_TEST],
    options: {
      cwd: repoRoot,
      env: { ...environment, KEIKO_ENFORCE_WALL_CLOCK_BUDGETS: "1" },
      stdio: "inherit",
      timeout: GROUNDED_WORKSPACE_PATTERN_PROCESS_TIMEOUT_MS,
      killSignal: "SIGTERM",
    },
  };
}

function controlledLineVitestInvocation(vitestEntry, environment) {
  const invocation = controlledVitestInvocation(vitestEntry, environment);
  return {
    ...invocation,
    args: [
      vitestEntry,
      "run",
      "--config",
      "vitest.coverage.packages.config.ts",
      "--coverage",
      GROUNDED_SYMBOL_LINE_TEST,
      "--coverage.reportsDirectory=coverage/grounded-line-performance",
    ],
    // Includes setup, the existing 60s operational test timeout and coverage serialization.
    // The measured handler budget remains exactly 5000 ms.
    options: { ...invocation.options, timeout: 90_000 },
  };
}

function processTimedOut(result) {
  return (
    result.error?.code === "ETIMEDOUT" || (result.signal !== null && result.signal !== undefined)
  );
}

function processFailed(result) {
  return result.error !== undefined || result.status !== 0;
}

export function runGroundedWorkspacePatternPerformance(options = {}) {
  const resolveEntry = options.resolveEntry ?? resolveInstalledVitestEntry;
  const execute = options.execute ?? spawnSync;
  let invocations;
  try {
    const entry = resolveEntry();
    invocations = [
      controlledVitestInvocation(entry, options.environment),
      controlledLineVitestInvocation(entry, options.environment),
    ];
  } catch {
    console.error("grounded-workspace-pattern performance check FAIL — Vitest is unavailable.");
    return 1;
  }
  for (const invocation of invocations) {
    const result = execute(invocation.command, invocation.args, invocation.options);
    if (processTimedOut(result)) {
      console.error("grounded local performance check FAIL — the focused pin timed out.");
      return 1;
    }
    if (processFailed(result)) {
      console.error("grounded local performance check FAIL — the focused pin failed.");
      return result.status ?? 1;
    }
  }
  console.log("grounded local performance check PASS — 1000 ms and 5000 ms pins enforced.");
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runGroundedWorkspacePatternPerformance();
}
