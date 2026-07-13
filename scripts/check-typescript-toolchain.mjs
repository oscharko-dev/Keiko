#!/usr/bin/env node
// TypeScript 7.0 has no programmatic API. Keiko therefore uses its native compiler for root/package
// builds while retaining TypeScript 6 for typed ESLint and governed editor language services.
// This gate keeps those roles explicit and fails before compilation if dependency drift conflates
// them. See Epic #2266 and Issue #2267.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_SPEC = "npm:typescript@~7.0.2";
const API_SPEC_PATTERN = /^~6\.0\.\d+$/;
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MANIFEST_OBJECT_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const MANIFEST_BUNDLE_SECTIONS = ["bundleDependencies", "bundledDependencies"];

export const COMPILER_PROBE_OPTIONS = Object.freeze({ timeout: 10_000, maxBuffer: 1_024 });

function stableVersion(version) {
  if (typeof version !== "string") return null;
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isStableLane(version, expectedMajor, expectedMinor) {
  const parsed = stableVersion(version);
  return parsed?.major === expectedMajor && parsed.minor === expectedMinor;
}

function declaredManifestSections(manifest, packageName) {
  const objectSections = MANIFEST_OBJECT_SECTIONS.filter(
    (section) => manifest[section]?.[packageName] !== undefined,
  );
  const bundleSections = MANIFEST_BUNDLE_SECTIONS.filter((section) =>
    Array.isArray(manifest[section]) ? manifest[section].includes(packageName) : false,
  );
  return [...objectSections, ...bundleSections];
}

function nativeManifestFailures(manifest) {
  const failures = [];
  const nativeSpec = manifest.devDependencies?.["@typescript/native"];
  if (nativeSpec !== NATIVE_SPEC) {
    failures.push(`@typescript/native must be the devDependency "${NATIVE_SPEC}".`);
  }
  const misplaced = declaredManifestSections(manifest, "@typescript/native").filter(
    (section) => section !== "devDependencies",
  );
  if (misplaced.length > 0) {
    failures.push(`@typescript/native is forbidden in ${misplaced.join(", ")}.`);
  }
  return failures;
}

function apiManifestFailures(manifest) {
  const failures = [];
  const apiSpec = manifest.dependencies?.typescript;
  if (typeof apiSpec !== "string" || !API_SPEC_PATTERN.test(apiSpec)) {
    failures.push("typescript must remain a ~6.0.x runtime dependency during the 7.0 transition.");
  }
  const misplaced = declaredManifestSections(manifest, "typescript").filter(
    (section) => section !== "dependencies",
  );
  if (misplaced.length > 0) {
    failures.push(`typescript API is forbidden in ${misplaced.join(", ")}.`);
  }
  return failures;
}

function manifestFailures(manifest) {
  return [...nativeManifestFailures(manifest), ...apiManifestFailures(manifest)];
}

function compilerExecutionReason(result) {
  const code = result.error?.code;
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ENOBUFS") return "output limit exceeded";
  if (code === "ENOENT") return "compiler executable unavailable";
  if (result.error !== undefined) return "spawn error";
  if (result.signal !== null && result.signal !== undefined) return "terminated by signal";
  return "non-zero exit status";
}

function compilerVersionFrom(result, failures) {
  if (result.status !== 0 || result.error !== undefined) {
    failures.push(`native compiler execution failed: ${compilerExecutionReason(result)}.`);
    return null;
  }
  if (result.stderr !== "") {
    failures.push("native compiler emitted unexpected diagnostic output.");
    return null;
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const match = /^Version (\S+)\s*$/.exec(stdout);
  if (match === null || stableVersion(match[1]) === null) {
    failures.push("native compiler returned malformed or prerelease version output.");
    return null;
  }
  if (!isStableLane(match[1], 7, 0)) {
    failures.push(`native compiler must remain on stable TypeScript 7.0.x, received ${match[1]}.`);
  }
  return match[1];
}

function installedVersionFailures(nativePackageVersion, compilerVersion, apiVersion) {
  const failures = [];
  if (!isStableLane(nativePackageVersion, 7, 0)) {
    failures.push(
      `@typescript/native must resolve to stable 7.0.x, received ${nativePackageVersion}.`,
    );
  }
  if (compilerVersion !== null && nativePackageVersion !== compilerVersion) {
    failures.push(
      `native package ${nativePackageVersion} does not match compiler ${compilerVersion}.`,
    );
  }
  if (!isStableLane(apiVersion, 6, 0)) {
    failures.push(`typescript API must resolve to stable 6.0.x, received ${apiVersion}.`);
  }
  return failures;
}

export function evaluateTypeScriptToolchain({
  manifest,
  compilerResult,
  nativePackageVersion,
  apiVersion,
}) {
  const failures = manifestFailures(manifest);
  const compilerVersion = compilerVersionFrom(compilerResult, failures);
  failures.push(...installedVersionFailures(nativePackageVersion, compilerVersion, apiVersion));
  return { compilerVersion, apiVersion, failures };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
  let apiModule;
  try {
    apiModule = await import("typescript");
  } catch {
    console.error(
      "typescript-toolchain: FAIL\n  - TypeScript 6 API package is unavailable; run npm ci.",
    );
    process.exit(1);
  }
  let manifest;
  let nativeManifest;
  try {
    manifest = readJson(join(repoRoot, "package.json"));
    nativeManifest = readJson(
      join(repoRoot, "node_modules", "@typescript", "native", "package.json"),
    );
  } catch {
    console.error(
      "typescript-toolchain: FAIL\n  - native compiler metadata is unavailable; run npm ci.",
    );
    process.exit(1);
  }
  const compilerResult = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules", "@typescript", "native", "bin", "tsc"), "--version"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, ...COMPILER_PROBE_OPTIONS },
  );
  const result = evaluateTypeScriptToolchain({
    manifest,
    compilerResult,
    nativePackageVersion: nativeManifest.version,
    apiVersion: apiModule.default?.version ?? apiModule.version,
  });
  if (result.failures.length > 0) {
    console.error("typescript-toolchain: FAIL");
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `typescript-toolchain: PASS — compiler ${result.compilerVersion}; API ${result.apiVersion}.`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
