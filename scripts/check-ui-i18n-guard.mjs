#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const EN_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.en.ts";
export const DE_CATALOG = "packages/keiko-ui/src/lib/i18n-messages.de.ts";

const UI_SOURCE_PREFIXES = ["packages/keiko-ui/src/app/"];
const I18N_USAGE_PATTERNS = [/\buseTranslate\s*\(/, /\buseI18n\s*\(/, /<\s*I18nTranslate\b/];

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

function nonCompliantUiFiles(repoRoot, uiFiles) {
  return uiFiles.filter((file) => !hasI18nUsage(repoRoot, file));
}

function isSafeGitSha(value) {
  return /^[0-9a-fA-F]{7,40}$/.test(value);
}

function isSafeGitRef(value) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes("..") && !value.includes("//")
  );
}

function diffNameOnly(repoRoot, range) {
  const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", range, "--"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    return {
      ok: false,
      error:
        (result.error instanceof Error ? result.error.message : "") ||
        String(result.stderr ?? "").trim() ||
        `git diff exited with status ${result.status ?? "unknown"}`,
      files: [],
    };
  }

  return {
    ok: true,
    error: "",
    files: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function isZeroSha(value) {
  return /^0{40}$/.test(value);
}

function validateBaseSha(baseSha) {
  if (baseSha !== undefined && baseSha !== "" && !isZeroSha(baseSha) && !isSafeGitSha(baseSha)) {
    throw new Error(`check:ui-i18n received an unsafe base SHA: ${baseSha}`);
  }
}

function validateBaseRef(baseRef) {
  if (baseRef !== undefined && baseRef !== "" && !isSafeGitRef(baseRef)) {
    throw new Error(`check:ui-i18n received an unsafe base ref: ${baseRef}`);
  }
}

function pushBaseShaRanges(ranges, baseSha) {
  if (baseSha && !isZeroSha(baseSha)) {
    ranges.push(`${baseSha}..HEAD`, `${baseSha}...HEAD`);
  }
}

function pushBaseRefRanges(ranges, baseRef) {
  if (baseRef) {
    ranges.push(`origin/${baseRef}...HEAD`, `${baseRef}...HEAD`);
  }
}

function diffRangesFromEnv(env) {
  const baseRef = env.KEIKO_I18N_GUARD_BASE_REF ?? env.GITHUB_BASE_REF;
  const baseSha = env.KEIKO_I18N_GUARD_BASE_SHA ?? env.GITHUB_EVENT_BEFORE;
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const ranges = [];

  validateBaseSha(baseSha);
  validateBaseRef(baseRef);
  pushBaseRefRanges(ranges, baseRef);
  pushBaseShaRanges(ranges, baseSha);

  if (ranges.length === 0 && eventName) {
    ranges.push("HEAD^1..HEAD");
  }

  if (ranges.length === 0) {
    ranges.push("origin/dev...HEAD", "HEAD^1..HEAD");
  }

  return ranges;
}

export function changedFilesFromGit(repoRoot, diffNameOnlyFn = diffNameOnly, env = process.env) {
  const ranges = diffRangesFromEnv(env);
  const errors = [];

  for (const range of ranges) {
    const result = diffNameOnlyFn(repoRoot, range);
    if (result.ok) {
      return result.files;
    }
    errors.push(`${range}: ${result.error}`);
  }

  throw new Error(
    `check:ui-i18n could not determine changed files from git. Tried ranges: ${errors.join("; ")}`,
  );
}

export function changedFilesFromInput(repoRoot, argv = process.argv, env = process.env) {
  const filesIndex = argv.indexOf("--files");
  if (filesIndex >= 0) {
    return argv.slice(filesIndex + 1);
  }

  if (env.KEIKO_I18N_GUARD_CHANGED_FILES) {
    return env.KEIKO_I18N_GUARD_CHANGED_FILES.split(/[,\n;]/)
      .map((file) => file.trim())
      .filter(Boolean);
  }

  return changedFilesFromGit(repoRoot, diffNameOnly, env);
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

  const nonCompliantFiles = nonCompliantUiFiles(repoRoot, uiFiles);

  if (nonCompliantFiles.length > 0) {
    problems.push(
      `UI source changed, but these changed UI files do not use the i18n API: ${nonCompliantFiles.join(", ")}. Use useTranslate, <I18nTranslate />, or another existing i18n helper for user-facing text.`,
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
  let result;
  try {
    result = checkUiI18nGuard();
  } catch (error) {
    console.error("check:ui-i18n FAIL");
    console.error("");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
