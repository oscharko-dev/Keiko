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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const STEPS = [
  [NPM, ["run", "build:packages"]],
  [process.execPath, ["scripts/stage-dev-coding-runtime.mjs"]],
  [
    process.execPath,
    ["node_modules/@typescript/native/bin/tsc", "-p", "tests/review-quality/tsconfig.json"],
  ],
  [
    process.execPath,
    ["tests/review-quality/dist/tests/review-quality/gate.js", ...process.argv.slice(2)],
  ],
];

for (const [command, args] of STEPS) {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
