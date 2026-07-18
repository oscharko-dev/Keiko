#!/usr/bin/env node
// Dead-code / unused-export gate (knip, config in knip.json). Invokes knip through its own bin
// entry directly rather than node_modules/.bin or npx, so the gate is hermetic and independent of
// platform-specific shim shape (mirrors scripts/arch-check-negative.mjs's dependency-cruiser call).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const MAX_KNIP_OUTPUT_BYTES = 16 * 1024 * 1024;

function declaredBin(metadata) {
  if (typeof metadata?.bin === "string") {
    return metadata.bin;
  }
  if (typeof metadata?.bin?.knip === "string") {
    return metadata.bin.knip;
  }
  throw new Error("knip package metadata does not declare a knip executable");
}

export function resolveDeclaredKnipEntry(packageJsonPath, metadata) {
  const packageRoot = dirname(packageJsonPath);
  const bin = declaredBin(metadata);
  if (bin.length === 0) {
    throw new Error("knip package metadata declares an empty executable path");
  }
  const entry = resolve(packageRoot, bin);
  const packageRelativeEntry = relative(packageRoot, entry);
  if (
    packageRelativeEntry === ".." ||
    packageRelativeEntry.startsWith(`..${sep}`) ||
    isAbsolute(packageRelativeEntry)
  ) {
    throw new Error("knip package metadata declares an executable outside its package root");
  }
  return entry;
}

function resolveInstalledKnipEntry() {
  const packageJsonPath = findPackageJSON("knip", import.meta.url);
  if (packageJsonPath === undefined) {
    throw new Error("knip package metadata could not be found");
  }
  const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return resolveDeclaredKnipEntry(packageJsonPath, metadata);
}

function spawnKnip(knipEntry) {
  return spawnSync(process.execPath, [knipEntry, "--no-progress"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: MAX_KNIP_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function replayOutput(result) {
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
}

export function run(spawn = spawnKnip, resolveEntry = resolveInstalledKnipEntry) {
  let knipEntry;
  try {
    knipEntry = resolveEntry();
  } catch {
    console.error("check:knip FAILED — could not resolve knip's declared executable.");
    return 1;
  }
  const result = spawn(knipEntry);
  replayOutput(result);
  if (result.error !== undefined) {
    console.error(`check:knip FAILED — could not launch knip: ${result.error.message}`);
    return 1;
  }
  if (typeof result.stderr === "string" && /(?:^|\n)ERROR:/u.test(result.stderr)) {
    console.error("check:knip FAILED — knip reported an internal error despite status zero.");
    return 1;
  }
  const code = result.status ?? 1;
  if (code === 0) {
    console.log("check:knip PASS — no unused files, exports, dependencies, or binaries.");
  } else {
    console.error(
      "check:knip FAILED — knip reported unresolved findings above. Remove the dead code, or if a " +
        "finding is a verified false positive, add a narrow, justified exception to knip.json " +
        "(entry/ignore/ignoreDependencies/ignoreBinaries) — never widen it to silence a real finding.",
    );
  }
  return code;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = run();
}
