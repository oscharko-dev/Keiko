import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const MARKER = "SECURITY-SHELL-OK:";
const MARKER_LOOKBACK_LINES = 8;
const SHELL_OPTION_RE = /\bshell\s*:\s*(?!false\b)[^,}\n]+/u;

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

function scanFile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/u);
  const failures = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (SHELL_OPTION_RE.test(lines[index] ?? "") && !hasNearbyMarker(lines, index)) {
      failures.push(
        `${relative(ROOT, path)}:${String(index + 1)} uses a shell spawn option without ${MARKER}`,
      );
    }
  }
  return failures;
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

main();
