#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NODE_ENGINE = ">=24.18.0 <25";
const EXPECTED_NODE_BASELINE = "24.18.0";
const EXPECTED_NPM_ENGINE = "11.16.0";
const EXPECTED_PACKAGE_MANAGER = "npm@11.16.0";
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function versionParts(value) {
  const match = VERSION_PATTERN.exec(value);
  return match === null ? undefined : match.slice(1).map(Number);
}

function isSupportedNodeVersion(value) {
  const parts = versionParts(value);
  if (parts === undefined) return false;
  const [major, minor, patch] = parts;
  return major === 24 && (minor > 18 || (minor === 18 && patch !== undefined && patch >= 0));
}

function evaluateDeclaredToolchain(input) {
  const problems = [];
  if (input.rootNodeEngine !== EXPECTED_NODE_ENGINE) {
    problems.push("root Node.js engine policy does not match the governed Node.js 24 LTS line");
  }
  if (input.rootNpmEngine !== EXPECTED_NPM_ENGINE) {
    problems.push("root npm engine policy does not match the bundled governed npm version");
  }
  if (input.packageManager !== EXPECTED_PACKAGE_MANAGER) {
    problems.push("packageManager does not match the governed npm version");
  }
  if (input.portableNodeVersion !== EXPECTED_NODE_BASELINE) {
    problems.push("portable Node.js approval does not match the governed LTS patch");
  }
  for (const workspace of input.workspaceNodeEngines) {
    if (workspace.value !== EXPECTED_NODE_ENGINE) {
      problems.push(`${workspace.name}: Node.js engine policy is stale`);
    }
  }
  return problems;
}

function evaluateExecutedToolchain(input, options) {
  const problems = [];
  if (!isSupportedNodeVersion(input.runtimeNodeVersion)) {
    problems.push("executed Node.js version is outside the supported Node.js 24 LTS line");
  }
  if (options.exactNode && input.runtimeNodeVersion !== EXPECTED_NODE_BASELINE) {
    problems.push("exact runtime mode requires the approved Node.js patch");
  }
  if (input.runtimeNpmVersion !== EXPECTED_NPM_ENGINE) {
    problems.push("executed npm version does not match the governed bundled version");
  }
  return problems;
}

export function evaluateRuntimeToolchain(input, options) {
  return [...evaluateDeclaredToolchain(input), ...evaluateExecutedToolchain(input, options)];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readWorkspaceNodeEngines(root) {
  const packagesRoot = join(root, "packages");
  const engines = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = readJson(join(packagesRoot, entry.name, "package.json"));
      engines.push({ name: manifest.name ?? entry.name, value: manifest.engines?.node });
    } catch {
      // Directories without package manifests are outside the workspace package graph.
    }
  }
  return engines.sort((left, right) => left.name.localeCompare(right.name));
}

function npmManifestPath(pathEntry, platform) {
  const executable = join(pathEntry, platform === "win32" ? "npm.cmd" : "npm");
  if (!existsSync(executable)) return undefined;
  if (platform === "win32") {
    return join(pathEntry, "node_modules", "npm", "package.json");
  }
  const npmCliPath = realpathSync(executable);
  return resolve(dirname(npmCliPath), "..", "package.json");
}

export function readNpmVersionFromPath(pathValue, platform = process.platform) {
  for (const pathEntry of pathValue.split(delimiter).filter(Boolean)) {
    const manifestPath = npmManifestPath(pathEntry, platform);
    if (manifestPath === undefined || !existsSync(manifestPath)) continue;
    try {
      const version = readJson(manifestPath).version;
      if (typeof version === "string" && VERSION_PATTERN.test(version)) return version;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function runtimeInput(root) {
  const manifest = readJson(join(root, "package.json"));
  const approvals = readJson(join(root, "portable-runtime-approvals.json"));
  return {
    rootNodeEngine: manifest.engines?.node,
    rootNpmEngine: manifest.engines?.npm,
    packageManager: manifest.packageManager,
    portableNodeVersion: approvals.node?.version,
    runtimeNodeVersion: process.versions.node,
    runtimeNpmVersion: readNpmVersionFromPath(process.env.PATH ?? ""),
    workspaceNodeEngines: readWorkspaceNodeEngines(root),
  };
}

function main(argv) {
  const exactNode = argv.includes("--exact");
  const input = runtimeInput(repositoryRoot);
  const problems = evaluateRuntimeToolchain(input, { exactNode });
  if (problems.length > 0) {
    process.stderr.write(`runtime-toolchain: FAIL — ${problems.length} policy problem(s):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `runtime-toolchain: PASS — Node.js ${input.runtimeNodeVersion}; npm ${input.runtimeNpmVersion}; ${input.workspaceNodeEngines.length} workspaces.\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
