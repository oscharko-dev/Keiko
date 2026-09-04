#!/usr/bin/env node

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile } from "./lib/json.mjs";

export const EXPECTED_NODE_ENGINE = ">=24.18.0 <25 || >=26.3.0 <27";
export const EXPECTED_NPM_ENGINE_RANGE = ">=11.16.0 <12";
// Exported for the same reason as EXPECTED_PACKAGE_MANAGER below: a workflow-parity test compares
// its setup-node pins against THIS constant, so a fixture cannot restate the version and go on
// passing while the governed baseline moves and the workflows stay behind.
export const EXPECTED_NODE_BASELINE = "24.18.0";
export const EXPECTED_NODE_COMPATIBILITY_BASELINE = "26.8.1";
// Exported for the same reason as the Node baseline: three perf-evidence scripts hard-compared
// this value and would have started rejecting valid runs on the next npm bump, with nothing to
// point the person doing the bump at them (#3304).
export const EXPECTED_NPM_ENGINE = "11.16.0";
export const EXPECTED_NPM_COMPATIBILITY_BASELINE = "11.19.0";
// Exported: release.yml pins its publish npm to this exact governed version, and the lockstep
// test compares the workflow line against THIS constant — the 0.3.1 CI publish died on a drifted
// hand-maintained pin (11.18.0) that the tag then froze forever.
export const EXPECTED_PACKAGE_MANAGER = "npm@11.16.0";
export const EXPECTED_EXACT_TOOLCHAINS = Object.freeze([
  Object.freeze({ node: EXPECTED_NODE_BASELINE, npm: EXPECTED_NPM_ENGINE }),
  Object.freeze({
    node: EXPECTED_NODE_COMPATIBILITY_BASELINE,
    npm: EXPECTED_NPM_COMPATIBILITY_BASELINE,
  }),
]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function versionParts(value) {
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

function isSupportedNodeVersion(value) {
  const parts = versionParts(value);
  if (parts === undefined) return false;
  const [major, minor, patch] = parts;
  const isSupported24 = major === 24 && (minor > 18 || (minor === 18 && patch !== undefined));
  const isSupported26 = major === 26 && (minor > 3 || (minor === 3 && patch !== undefined));
  return isSupported24 || isSupported26;
}

function isSupportedNpmVersion(value) {
  const parts = versionParts(value);
  if (parts === undefined) return false;
  const [major, minor, patch] = parts;
  return major === 11 && (minor > 16 || (minor === 16 && patch !== undefined));
}

function isApprovedExactToolchain(nodeVersion, npmVersion) {
  return EXPECTED_EXACT_TOOLCHAINS.some(
    (toolchain) => toolchain.node === nodeVersion && toolchain.npm === npmVersion,
  );
}

function evaluateDeclaredToolchain(input) {
  const problems = [];
  if (input.rootNodeEngine !== EXPECTED_NODE_ENGINE) {
    problems.push("root Node.js engine policy does not match the governed Node.js 24/26 lines");
  }
  if (input.rootNpmEngine !== EXPECTED_NPM_ENGINE_RANGE) {
    problems.push("root npm engine policy does not match the governed npm 11 range");
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
  // `evaluateRuntimeToolchain` is exported; a caller written against the previous input shape must
  // not crash on a field it never knew about.
  for (const workspace of input.workspaceNpmEngines ?? []) {
    if (workspace.value !== EXPECTED_NPM_ENGINE_RANGE) {
      problems.push(`${workspace.name}: npm engine policy is stale`);
    }
  }
  return problems;
}

function evaluateExecutedToolchain(input, options) {
  const problems = [];
  if (!isSupportedNodeVersion(input.runtimeNodeVersion)) {
    problems.push("executed Node.js version is outside the supported Node.js 24/26 lines");
  }
  if (!isSupportedNpmVersion(input.runtimeNpmVersion)) {
    problems.push("executed npm version is outside the supported npm 11 range");
  }
  if (
    options.exactNode &&
    !isApprovedExactToolchain(input.runtimeNodeVersion, input.runtimeNpmVersion)
  ) {
    problems.push("exact runtime mode requires an approved Node.js/npm pair");
  }
  return problems;
}

export function evaluateRuntimeToolchain(input, options) {
  return [...evaluateDeclaredToolchain(input), ...evaluateExecutedToolchain(input, options)];
}

function readWorkspaceEngines(root, engineKey) {
  const packagesRoot = join(root, "packages");
  const engines = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesRoot, entry.name, "package.json");
    // A directory without a manifest is outside the workspace package graph and is skipped. A
    // manifest that exists but cannot be read or parsed is a different thing entirely: swallowing
    // it would drop that workspace out of the engine policy silently, and the gate would report a
    // pass over a package it never examined. That one fails closed.
    if (!existsSync(manifestPath)) continue;
    const manifest = readJsonFile(manifestPath);
    engines.push({ name: manifest.name ?? entry.name, value: manifest.engines?.[engineKey] });
  }
  return engines.sort((left, right) => left.name.localeCompare(right.name));
}

export function readWorkspaceNodeEngines(root) {
  return readWorkspaceEngines(root, "node");
}

// Only workspaces that actually declare `engines.npm` are reported: a silent workspace inherits the
// root npm policy, so an absent declaration is not drift. A declared one is governed exactly — the
// UI workspace pinned 11.16.0 while nothing compared it against the governed constant.
export function readWorkspaceNpmEngines(root) {
  return readWorkspaceEngines(root, "npm").filter((workspace) => workspace.value !== undefined);
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
      const version = readJsonFile(manifestPath).version;
      if (typeof version === "string" && VERSION_PATTERN.test(version)) return version;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function runtimeInput(root) {
  const manifest = readJsonFile(join(root, "package.json"));
  const approvals = readJsonFile(join(root, "portable-runtime-approvals.json"));
  return {
    rootNodeEngine: manifest.engines?.node,
    rootNpmEngine: manifest.engines?.npm,
    packageManager: manifest.packageManager,
    portableNodeVersion: approvals.node?.version,
    runtimeNodeVersion: process.versions.node,
    runtimeNpmVersion: readNpmVersionFromPath(process.env.PATH ?? ""),
    workspaceNodeEngines: readWorkspaceNodeEngines(root),
    workspaceNpmEngines: readWorkspaceNpmEngines(root),
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
