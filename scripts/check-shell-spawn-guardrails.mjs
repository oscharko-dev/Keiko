import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const MARKER = "SECURITY-SHELL-OK:";
const MARKER_LOOKBACK_LINES = 8;
// ADR-0137 D5: the negative lookahead sits directly behind the colon so backtracking through
// the whitespace quantifier cannot bypass it — `shell: false` never matches in any spacing,
// while every other shell option value still requires a nearby SECURITY-SHELL-OK justification.
const SHELL_OPTION_RE = /\bshell\s*:(?!\s*false\b)\s*[^,}\n]+/u;

function isScannedScript(path) {
  return /\.(?:mjs|js)$/u.test(path) && !/(?:^|\/)__tests__\//u.test(path);
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        files.push(...collectFiles(full));
      }
      continue;
    }
    if (entry.isFile() && isScannedScript(full)) {
      files.push(full);
    }
  }
  return files;
}

function hasNearbyMarker(lines, index) {
  const start = Math.max(0, index - MARKER_LOOKBACK_LINES);
  for (let i = start; i <= index; i += 1) {
    if (lines[i]?.includes(MARKER) === true) {
      return true;
    }
  }
  return false;
}

export function scanSource(text, displayPath) {
  const lines = text.split(/\r?\n/u);
  const failures = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (SHELL_OPTION_RE.test(lines[index] ?? "") && !hasNearbyMarker(lines, index)) {
      failures.push(
        `${displayPath}:${String(index + 1)} uses a shell spawn option without ${MARKER}`,
      );
    }
  }
  return failures;
}

function scanFile(path) {
  return scanSource(readFileSync(path, "utf8"), relative(ROOT, path));
}

function main() {
  const failures = [];
  if (!statSync(SCRIPTS_DIR).isDirectory()) {
    throw new Error("scripts directory is missing");
  }
  for (const file of collectFiles(SCRIPTS_DIR)) {
    failures.push(...scanFile(file));
  }
  if (failures.length > 0) {
    console.error("Shell spawn guardrail check failed:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log("Shell spawn guardrail check passed.");
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
