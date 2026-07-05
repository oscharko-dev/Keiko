#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const EN_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.en.ts";
export const DE_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.de.ts";

const UI_SOURCE_PREFIXES = ["packages/keiko-ui/src/app/"];
const I18N_USAGE_PATTERNS = [
  /\buseTranslate\s*\(/,
  /\buseI18n\s*\(/,
  /\bI18nTranslate\b/,
  /\btranslate\s*\(/,
  /["']@\/lib\/i18n["']/,
  /["'][./]+lib\/i18n["']/,
];

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isUiProductionSource(file) {
  const normalized = normalizePath(file);
  const name = basename(normalized);

  if (!/\.(tsx|ts)$/.test(normalized)) {
    return false;
  }

  if (
    normalized.endsWith(".d.ts") ||
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.(tsx|ts)$/.test(normalized)
  ) {
    return false;
  }

  if (normalized === EN_CATALOG || normalized === DE_CATALOG || name === "i18n.tsx") {
    return false;
  }

  return UI_SOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function extractCatalogKeys(source) {
  return new Set(Array.from(source.matchAll(/^\s*"([^"]+)":/gm), (match) => match[1]));
}

function readText(repoRoot, file) {
  return readFileSync(resolve(repoRoot, file), "utf8");
}

function hasI18nUsage(repoRoot, file) {
  const source = readText(repoRoot, file);
  return I18N_USAGE_PATTERNS.some((pattern) => pattern.test(source));
}

function diffNameOnly(repoRoot, range) {
  const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", range], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function changedFilesFromGit(repoRoot) {
  const baseRef = process.env.GITHUB_BASE_REF;
  const ranges = [
    ...(baseRef ? [`origin/${baseRef}...HEAD`, `${baseRef}...HEAD`] : []),
    "origin/dev...HEAD",
    "origin/dev",
    "HEAD^1...HEAD",
  ];

  for (const range of ranges) {
    const files = diffNameOnly(repoRoot, range);
    if (files.length > 0) {
      return files;
    }
  }

  return [];
}

function changedFilesFromInput(repoRoot) {
  const filesIndex = process.argv.indexOf("--files");
  if (filesIndex >= 0) {
    return process.argv.slice(filesIndex + 1);
  }

  if (process.env.KEIKO_I18N_GUARD_CHANGED_FILES) {
    return process.env.KEIKO_I18N_GUARD_CHANGED_FILES.split(/[,\n;]/);
  }

  return changedFilesFromGit(repoRoot);
}

function symmetricDifference(left, right) {
  return [
    ...Array.from(left).filter((key) => !right.has(key)),
    ...Array.from(right).filter((key) => !left.has(key)),
  ].sort();
}

export function checkUiI18nGuard({
  repoRoot = process.cwd(),
  changedFiles = changedFilesFromInput(repoRoot),
} = {}) {
  const normalizedChangedFiles = changedFiles
    .map((file) => normalizePath(file.trim()))
    .filter(Boolean);
  const changedFileSet = new Set(normalizedChangedFiles);
  const uiFiles = normalizedChangedFiles.filter(isUiProductionSource);
  const problems = [];

  if (uiFiles.length === 0) {
    return {
      ok: true,
      problems,
      uiFiles,
      changedFiles: normalizedChangedFiles,
    };
  }

  for (const catalog of [EN_CATALOG, DE_CATALOG]) {
    if (!changedFileSet.has(catalog)) {
      problems.push(
        `UI source changed, but ${catalog} was not updated. Add English and German catalog entries for UI-facing text.`,
      );
    }
  }

  if (!uiFiles.some((file) => hasI18nUsage(repoRoot, file))) {
    problems.push(
      "UI source changed, but no changed UI file uses the i18n API. Use useTranslate, I18nTranslate, or another existing i18n helper for user-facing text.",
    );
  }

  const enKeys = extractCatalogKeys(readText(repoRoot, EN_CATALOG));
  const deKeys = extractCatalogKeys(readText(repoRoot, DE_CATALOG));
  const keyMismatches = symmetricDifference(enKeys, deKeys);

  if (keyMismatches.length > 0) {
    problems.push(
      `English and German i18n catalogs must expose the same keys. Mismatched keys: ${keyMismatches.join(", ")}.`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    uiFiles,
    changedFiles: normalizedChangedFiles,
  };
}

function main() {
  const result = checkUiI18nGuard();

  if (result.ok) {
    console.log(
      `check:ui-i18n OK - ${result.uiFiles.length} changed UI source file(s) require no additional i18n action.`,
    );
    return;
  }

  console.error("check:ui-i18n FAIL");
  console.error("");
  console.error("Changed UI source files:");
  for (const file of result.uiFiles) {
    console.error(`- ${file}`);
  }
  console.error("");
  console.error("Required fixes:");
  for (const problem of result.problems) {
    console.error(`- ${problem}`);
  }
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
