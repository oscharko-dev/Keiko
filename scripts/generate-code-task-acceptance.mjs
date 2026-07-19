import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const receiptByScenario = new Map(receipts.map((receipt) => [receipt.scenarioId, receipt]));

const scenarios = descriptor.scenarios.map((scenario) => {
  const receipt = receiptByScenario.get(scenario.scenarioId);
  if (receipt === undefined) throw new Error(`missing receipt for ${scenario.scenarioId}`);
  return {
    ...scenario,
    outcome: receipt.outcome,
    recordedAt: receipt.recordedAt,
    artifactDigests: [receipt.digest],
    receiptDigest: { outcome: "known", value: receipt.digest },
  };
});

const contribution = {
  kind: "code-task-acceptance-contribution",
  schemaVersion: 1,
  epicIssue: descriptor.epicIssue,
  childIssue: descriptor.childIssue,
  sourceCommitSha,
  sourceTreeSha,
  scenarios,
  salvage: descriptor.salvage.map((row) => ({ ...row, verifiedAtSha: sourceCommitSha })),
  knownLimitations: descriptor.knownLimitations,
  cleanup: existsSync(cleanupRoot)
    ? { state: "incomplete", residueCount: 1 }
    : { state: "complete" },
};

const contracts = await import(
  pathToFileURL(resolve("packages/keiko-contracts/dist/index.js")).href
);
const validated = contracts.validateCodeTaskAcceptanceContribution(contribution);
if (!validated.ok) throw new Error(validated.errors.join("; "));
writeFileSync(output, `${JSON.stringify(validated.value, null, 2)}\n`, { mode: 0o600 });
