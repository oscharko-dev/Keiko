#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/is-main-module.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strykerBin = resolve(repoRoot, "node_modules/@stryker-mutator/core/bin/stryker.js");

export const securityMutationSteps = Object.freeze([
  Object.freeze({
    args: [strykerBin, "run", "stryker.security.conf.json"],
    command: process.execPath,
    label: "general security mutation run",
  }),
  Object.freeze({
    args: [strykerBin, "run", "stryker.debug-launch.security.conf.json"],
    command: process.execPath,
    label: "debug-launch security mutation run",
  }),
  Object.freeze({
    args: ["scripts/check-mutation-quality.mjs"],
    command: process.execPath,
    label: "general security mutation baseline ratchet",
  }),
  Object.freeze({
    args: [
      "scripts/check-mutation-quality.mjs",
      "--strict",
      "--report",
      "reports/mutation/debug-launch-security/mutation-report.json",
      "--minimum-score",
      "100",
      "--maximum-survived",
      "0",
      "--maximum-no-coverage",
      "0",
    ],
    command: process.execPath,
    label: "debug-launch security mutation strict ratchet",
  }),
]);

function runStep(step, spawn, log) {
  log(`mutation-security: RUN - ${step.label}`);
  const result = spawn(step.command, step.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  const status = typeof result.status === "number" ? result.status : 1;
  if (status === 0) log(`mutation-security: PASS - ${step.label}`);
  return status;
}

export function runSecurityMutationSuite(input = {}) {
  const spawn = input.spawn ?? spawnSync;
  const log = input.log ?? console.log;
  const error = input.error ?? console.error;
  const failures = [];
  for (const step of securityMutationSteps) {
    if (runStep(step, spawn, log) !== 0) failures.push(step.label);
  }
  if (failures.length === 0) return 0;
  error(`mutation-security: FAIL - ${failures.join("; ")}`);
  return 1;
}

if (isMainModule(import.meta.url)) process.exitCode = runSecurityMutationSuite();
