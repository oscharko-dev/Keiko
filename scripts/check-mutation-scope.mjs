#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const criticalPrefixes = [
  "packages/keiko-evidence/src/",
  "packages/keiko-memory-vault/src/",
  "packages/keiko-model-gateway/src/",
  "packages/keiko-sandbox/src/",
  "packages/keiko-security/src/",
  "packages/keiko-workflows/src/",
];
const criticalServerTerms = /\/(coding-runtime|qualityIntelligence)\//u;

function isProductionTypeScript(path) {
  return (
    /^[A-Za-z0-9_./-]+$/u.test(path) &&
    path.endsWith(".ts") &&
    !/\.(?:test|spec)\.ts$/u.test(path) &&
    !path.endsWith(".d.ts")
  );
}

export function requiresSecurityMutation(files) {
  return securityMutationFiles(files).length > 0;
}

export function securityMutationFiles(files) {
  return files.filter(
    (path) =>
      isProductionTypeScript(path) &&
      (criticalPrefixes.some((prefix) => path.startsWith(prefix)) ||
        (path.startsWith("packages/keiko-server/src/") && criticalServerTerms.test(path))),
  );
}

export function mutationScope(base, head, execute = execFileSync) {
  const files = parseChangedFiles(
    execute("/usr/bin/git", ["diff", "--name-status", "--diff-filter=ACMR", `${base}...${head}`], {
      encoding: "utf8",
    }),
  );
  return securityMutationFiles(files);
}

export function parseChangedFiles(output) {
  return output
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const fields = entry.split("\t");
      if (/^[ACMR]/u.test(fields[0] ?? "") === false) return undefined;
      return fields[0]?.startsWith("R") === true ? fields[2] : fields[1];
    })
    .filter((entry) => entry !== undefined);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

export function runMutationScope(input = {}) {
  const argv = input.argv ?? process.argv;
  const base = option(argv, "--base");
  const head = option(argv, "--head");
  if (base === undefined || head === undefined) throw new Error("--base and --head are required.");
  const mutationFiles = mutationScope(base, head, input.execute);
  const required = mutationFiles.length > 0;
  const outputPath = input.outputPath ?? process.env.GITHUB_OUTPUT;
  if (outputPath !== undefined) {
    const append = input.append ?? appendFileSync;
    append(outputPath, `required=${String(required)}\n`);
    append(outputPath, `files=${mutationFiles.join(",")}\n`);
  }
  (input.log ?? console.log)(`mutation-scope: ${required ? "required" : "not applicable"}.`);
  return { mutationFiles, required };
}

export function runMutationScopeCli(input = {}) {
  try {
    runMutationScope(input);
  } catch (error) {
    (input.error ?? console.error)(
      `mutation-scope: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    (input.setExitCode ?? ((value) => (process.exitCode = value)))(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) runMutationScopeCli();
