#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_CATALOG_REFERENCE_IMAGE } from "./check-tool-catalog-performance.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MEASUREMENT_FILE = "docs/release/3415-tool-catalog-perf-evidence.json";
const CALIBRATION_FILES = [
  "docs/release/3415-tool-catalog-calibration.json",
  "scripts/tool-catalog-performance-budget.json",
];

function migrationCommandFor({ recalibrate, rebindCaseIdentity }) {
  if (recalibrate && rebindCaseIdentity)
    throw new TypeError("choose one tool-catalog performance evidence migration");
  if (rebindCaseIdentity)
    return "node scripts/check-tool-catalog-performance.mjs --rebind-case-identity";
  if (recalibrate) return "node scripts/check-tool-catalog-performance.mjs --recalibrate";
  return undefined;
}

function containerScript(options) {
  const migrationCommand = migrationCommandFor(options);
  const measurementCommands = [
    ...(migrationCommand === undefined ? [] : [migrationCommand]),
    "node scripts/check-tool-catalog-performance.mjs --write-measurement",
  ];
  return [
    "set -euo pipefail",
    "npm ci --ignore-scripts --no-audit --no-fund",
    "npm run build:packages",
    ...measurementCommands,
    "npm run check:tool-catalog-performance",
  ].join("\n");
}

export function regenerateArguments(
  clone,
  { image = TOOL_CATALOG_REFERENCE_IMAGE, recalibrate = false, rebindCaseIdentity = false } = {},
) {
  return [
    "run",
    "--rm",
    "--platform",
    "linux/arm64",
    "--cpus=16",
    "--memory=20g",
    "-v",
    `${clone}:/repo`,
    "-w",
    "/repo",
    "-e",
    `KEIKO_TOOL_CATALOG_REFERENCE_IMAGE=${image}`,
    image,
    "bash",
    "-lc",
    containerScript({ recalibrate, rebindCaseIdentity }),
  ];
}

function defaultDependencies() {
  return {
    copyFile: copyFileSync,
    makeWorkdir: () => mkdtempSync(join(tmpdir(), "keiko-tool-catalog-perf-")),
    run: (command, args, options = {}) =>
      execFileSync(resolveHostExecutable(command), args, { stdio: "inherit", ...options }),
    status: () =>
      execFileSync(
        resolveHostExecutable("git"),
        ["status", "--porcelain", "--untracked-files=all"],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      ).trim(),
  };
}

export function regenerateToolCatalogPerformanceEvidence(options = {}) {
  const { recalibrate = false, rebindCaseIdentity = false } = options;
  const deps = { ...defaultDependencies(), ...options };
  if (deps.status() !== "") {
    throw new TypeError("tool-catalog measurement requires a clean working tree");
  }
  const clone = join(deps.makeWorkdir(), "repo.noindex");
  deps.run("git", ["clone", "--no-local", "--quiet", repoRoot, clone]);
  deps.run("docker", regenerateArguments(clone, { recalibrate, rebindCaseIdentity }));
  const files =
    recalibrate || rebindCaseIdentity
      ? [...CALIBRATION_FILES, MEASUREMENT_FILE]
      : [MEASUREMENT_FILE];
  for (const file of files) deps.copyFile(join(clone, file), join(repoRoot, file));
  return { clone, files, recalibrate, rebindCaseIdentity };
}

export function regenerationOptions(arguments_) {
  const acceptedArguments = new Set(["--recalibrate", "--rebind-case-identity"]);
  const unknown = arguments_.filter((argument) => !acceptedArguments.has(argument));
  if (unknown.length > 0) throw new TypeError(`unknown argument: ${unknown.join(", ")}`);
  return {
    recalibrate: arguments_.includes("--recalibrate"),
    rebindCaseIdentity: arguments_.includes("--rebind-case-identity"),
  };
}

if (isMainModule(import.meta.url)) {
  regenerateToolCatalogPerformanceEvidence(regenerationOptions(process.argv.slice(2)));
}
