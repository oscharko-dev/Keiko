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
  return path.endsWith(".ts") && !/\.(?:test|spec)\.ts$/u.test(path) && !path.endsWith(".d.ts");
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

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main() {
  const base = option("--base");
  const head = option("--head");
  if (base === undefined || head === undefined) throw new Error("--base and --head are required.");
  const files = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0);
  const mutationFiles = securityMutationFiles(files);
  const required = mutationFiles.length > 0;
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `required=${String(required)}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `files=${mutationFiles.join(",")}\n`);
  }
  console.log(`mutation-scope: ${required ? "required" : "not applicable"}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(
      `mutation-scope: FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
