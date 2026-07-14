#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ESLint } from "eslint";
import sonarjs from "eslint-plugin-sonarjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiPrefix = "packages/keiko-ui/";
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

export const sonarNewCodeRules = Object.freeze({
  "sonarjs/cognitive-complexity": ["error", 15],
  "sonarjs/no-identical-functions": "error",
  "sonarjs/use-type-alias": "error",
});

export function gitPaths(args, cwd, execute = execFileSync) {
  const output = execute("git", args, { cwd, encoding: "buffer" });
  return output.toString("utf8").split("\0").filter(Boolean);
}

export function changedPaths(
  cwd = repoRoot,
  base = process.env.KEIKO_SONAR_BASE ?? "origin/dev",
  execute = execFileSync,
) {
  return [
    ...gitPaths(
      ["diff", "--name-only", "--diff-filter=ACMR", "-z", `${base}...HEAD`],
      cwd,
      execute,
    ),
    ...gitPaths(["diff", "--name-only", "--diff-filter=ACMR", "-z", "HEAD"], cwd, execute),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"], cwd, execute),
  ];
}

export function selectSonarFiles(paths, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const exists = options.exists ?? existsSync;
  return [...new Set(paths)]
    .filter((path) => sourcePattern.test(path) && exists(resolve(cwd, path)))
    .toSorted((left, right) => left.localeCompare(right));
}

function sonarOverride() {
  return { plugins: { sonarjs }, rules: sonarNewCodeRules };
}

async function lintRootFiles(files, cwd) {
  if (files.length === 0) return [];
  const eslint = new ESLint({ cwd, overrideConfig: [sonarOverride()] });
  return eslint.lintFiles(files);
}

async function lintUiFiles(files, cwd) {
  if (files.length === 0) return [];
  const uiRoot = resolve(cwd, "packages", "keiko-ui");
  const eslint = new ESLint({
    cwd: uiRoot,
    overrideConfig: [sonarOverride()],
    overrideConfigFile: resolve(uiRoot, "eslint.config.mjs"),
  });
  return eslint.lintFiles(files.map((path) => path.slice(uiPrefix.length)));
}

export async function lintSonarNewCode(files, cwd = repoRoot) {
  const uiFiles = files.filter((path) => path.startsWith(uiPrefix));
  const rootFiles = files.filter((path) => !path.startsWith(uiPrefix));
  const [rootResults, uiResults] = await Promise.all([
    lintRootFiles(rootFiles, cwd),
    lintUiFiles(uiFiles, cwd),
  ]);
  return [...rootResults, ...uiResults];
}

export async function runSonarNewCodePreflight(options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const files = selectSonarFiles(options.paths ?? changedPaths(cwd), {
    cwd,
    exists: options.exists,
  });
  if (files.length === 0) {
    (options.log ?? console.log)("sonar-new-code-preflight: PASS - no changed source files.");
    return;
  }
  const results = await (options.lint ?? lintSonarNewCode)(files, cwd);
  const errors = results.filter(
    (result) => (result.errorCount ?? 0) > 0 || (result.fatalErrorCount ?? 0) > 0,
  );
  if (errors.length === 0) {
    (options.log ?? console.log)(
      `sonar-new-code-preflight: PASS - ${String(files.length)} changed source file(s).`,
    );
    return;
  }
  const formatted =
    options.format === undefined
      ? (await new ESLint({ cwd }).loadFormatter("stylish")).format(errors)
      : await options.format(errors);
  throw new Error(`Local Sonar parity failed.\n${formatted}`);
}

export async function executeSonarNewCodeCli(options = {}) {
  try {
    await (options.run ?? runSonarNewCodePreflight)();
  } catch (error) {
    (options.error ?? console.error)(error instanceof Error ? error.message : String(error));
    (options.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await executeSonarNewCodeCli();
