// CLI wrapper around the pure projection at scripts/lib/code-task-acceptance.mjs. Reads the
// descriptor and receipts JSON, joins them into a CodeTaskAcceptanceContributionV1 payload,
// validates against the contract, and writes the result. docs/acceptance/README.md explains the
// pipeline; the pure projection is directly unit-tested at scripts/__tests__/code-task-acceptance.test.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCodeTaskAcceptanceContribution } from "./lib/code-task-acceptance.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined) {
    throw new Error(`missing --${name}`);
  }
  return process.argv[index + 1];
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const descriptor = readJson(argument("descriptor"));
const receipts = readJson(argument("receipts"));
const sourceCommitSha = argument("commit");
const sourceTreeSha = argument("tree");
const cleanupRoot = resolve(argument("cleanup-root"));
const output = resolve(argument("output"));

const contribution = buildCodeTaskAcceptanceContribution({
  descriptor,
  receipts,
  sourceCommitSha,
  sourceTreeSha,
  cleanupResidue: existsSync(cleanupRoot),
});

const contracts = await import(
  pathToFileURL(resolve("packages/keiko-contracts/dist/index.js")).href
);
const validated = contracts.validateCodeTaskAcceptanceContribution(contribution);
if (!validated.ok) throw new Error(validated.errors.join("; "));
writeFileSync(output, `${JSON.stringify(validated.value, null, 2)}\n`, { mode: 0o600 });
