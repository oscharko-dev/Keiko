// Resolves the installed dependency-cruiser CLI entry point (#3607).
//
// dependency-cruiser has renamed its own CLI entry point before: `bin/dependency-cruise.mjs`
// became `bin/dependency-cruiser.mjs` between 18.2.0 and 18.3.0 — a plain git rename
// (https://github.com/sverweij/dependency-cruiser/compare/v18.2.0...v18.3.0), undocumented in the
// 18.3.0 release notes. Two call sites (scripts/arch-check-negative.mjs and
// scripts/lib/bare-specifier-visibility-probe.mjs) hardcoded the pre-rename filename and invoked it
// directly through `node` to stay hermetic (no npm/npx shell shims). Once the lockfile moved past
// 18.2.0, `node <hardcoded path>` failed with MODULE_NOT_FOUND before dependency-cruiser ever ran:
// the bare-specifier visibility probe read that as `reason=rule-not-fired`, which looked like a
// rule regression but was really an absent process. Reading the entry point from the installed
// package's own `bin` map — the same place `npm` itself reads to build `node_modules/.bin` shims —
// keeps this resolution correct across any future rename without this repository having to know the
// filename in advance, and is exactly as correct on 18.2.0 (`bin/dependency-cruise.mjs`) as on
// 18.3.0+ (`bin/dependency-cruiser.mjs`).

import { join } from "node:path";

import { readJsonFile } from "./json.mjs";

const PACKAGE_NAME = "dependency-cruiser";
const BIN_NAME = "dependency-cruiser";

/**
 * Resolves the absolute path to the installed dependency-cruiser CLI entry point (an .mjs file)
 * by reading it from the package's own `package.json` `bin` map, instead of hardcoding a filename
 * dependency-cruiser is free to rename between releases.
 *
 * @param {string} repoRoot Absolute path to the repository root.
 * @returns {string} Absolute path to the dependency-cruiser CLI entry point.
 */
export function resolveDependencyCruiserEntrypoint(repoRoot) {
  const packageDirectory = join(repoRoot, "node_modules", PACKAGE_NAME);
  const manifest = readJsonFile(join(packageDirectory, "package.json"));
  const binEntry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[BIN_NAME];
  if (typeof binEntry !== "string" || binEntry.length === 0) {
    throw new Error(`${PACKAGE_NAME} package.json declares no "${BIN_NAME}" bin entry`);
  }
  return join(packageDirectory, binEntry);
}
