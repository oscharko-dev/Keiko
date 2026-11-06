// Entry of the offline review gate (#4138, ADR-0182 D9):
//
//   node scripts/testing/review-quality/run.mjs --set development|holdout|seeds [--variant ...] ...
//
// It builds the packages, stages the dev coding runtime, compiles the gate composition in
// tests/review-quality/ and runs it with the arguments given here. It is a script rather than a
// root npm script because the root package.json is a pinned input of the #1300 design evidence.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { npmCommand, shouldShellNpmCommand } from "../../dev-start.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(scriptPath), "..", "..", "..");

/**
 * The gate's steps in order. Only the npm step may need a shell: Node starts a Windows `.cmd`
 * file only through one (CVE-2024-27980), and the other steps run the Node executable itself.
 */
export function gateSteps(gateArgs, platform = process.platform, nodePath = process.execPath) {
  const npm = npmCommand(platform);
  return [
    { command: npm, args: ["run", "build:packages"], shell: shouldShellNpmCommand(npm, platform) },
    { command: nodePath, args: ["scripts/stage-dev-coding-runtime.mjs"], shell: false },
    {
      command: nodePath,
      args: ["node_modules/@typescript/native/bin/tsc", "-p", "tests/review-quality/tsconfig.json"],
      shell: false,
    },
    {
      command: nodePath,
      args: ["tests/review-quality/dist/tests/review-quality/gate.js", ...gateArgs],
      shell: false,
    },
  ];
}

/** Runs the steps in order and returns the first non-zero exit status, or 0. */
export function runGateSteps(steps, spawn = spawnSync) {
  for (const { command, args, shell } of steps) {
    const result = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit", shell });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] === scriptPath) {
  process.exitCode = runGateSteps(gateSteps(process.argv.slice(2)));
}
