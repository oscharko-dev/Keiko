// CLI wrapper around the pure projection at scripts/lib/coding-issue-journey-manifest.mjs, the
// #3390 sibling of scripts/generate-code-task-acceptance.mjs. Reads the descriptor and the
// receipts directory the platform launch drivers and Playwright journey runs populate, derives
// each scenario's outcome from a receipt (or the descriptor's own closed reason for a blocked
// row), validates the assembled manifest against the contract, and writes it. Kept dependency-free
// like its sibling: node:fs/node:path/node:url only.
//
// docs/acceptance/README.md documents this pipeline and the operator invocation.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readFlowReceipts, readReceipts } from "./check-coding-issue-journey-evidence.mjs";
import { buildCodingIssueJourneyManifest } from "./lib/coding-issue-journey-manifest.mjs";
import { sha256File } from "./lib/digest.mjs";
import { readJsonFile } from "./lib/json.mjs";

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || process.argv[index + 1] === undefined) {
    if (required) throw new Error(`missing --${name}`);
    return undefined;
  }
  return process.argv[index + 1];
}

function numberArgument(name, { required = true } = {}) {
  const raw = argument(name, { required });
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function listArgument(name) {
  const raw = argument(name, { required: false });
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function loadContracts() {
  return import(
    pathToFileURL(resolve("packages/keiko-contracts/dist/code-task-acceptance.js")).href
  );
}

/** Reads the descriptor and joins it with the receipts directory into an unvalidated manifest. */
function projectManifest(receiptsDir) {
  const descriptor = readJsonFile(resolve(argument("descriptor")));
  const flowReceiptsById = readFlowReceipts(
    receiptsDir,
    (descriptor.flows ?? []).map((flow) => flow.flowId),
  );
  const finalFlowId = descriptor.flows?.at(-1)?.flowId;
  const finalFlow = finalFlowId === undefined ? undefined : flowReceiptsById.get(finalFlowId);
  const observedSpendUsd =
    finalFlow === undefined
      ? numberArgument("observed-spend-usd", { required: false })
      : finalFlow.artifact.spend.cumulativeChargedNanoUsd / 1_000_000_000;
  const rubricPath = resolve(argument("rubric"));
  return buildCodingIssueJourneyManifest({
    descriptor,
    receiptsByScenarioId: readReceipts(receiptsDir),
    flowReceiptsById,
    generatedAt: new Date().toISOString(),
    sourceCommitSha: argument("commit"),
    sourceTreeSha: argument("tree"),
    runtimeIdentity: argument("runtime-identity"),
    modelIdentity: argument("model-identity"),
    fixtureRevision: argument("fixture-revision"),
    rubricDigest: sha256File(rubricPath),
    issueReference: argument("issue-ref", { required: false }),
    pullRequestReference: argument("pr-ref", { required: false }),
    runReference: argument("run-ref", { required: false }),
    readinessSnapshotDigest: argument("readiness-digest", { required: false }),
    journeyOutcomeDigest: argument("journey-outcome-digest", { required: false }),
    auditReference: argument("audit-ref", { required: false }),
    auditDigest: argument("audit-digest", { required: false }),
    requiredTools: listArgument("required-tools"),
    spendBudgetUsd: numberArgument("spend-budget-usd"),
    observedSpendUsd,
  });
}

const receiptsDir = resolve(argument("receipts"));
const manifest = projectManifest(receiptsDir);
const contracts = await loadContracts();
const validated = contracts.validateCodeTaskQualificationManifest(manifest);
if (!validated.ok) throw new Error(validated.errors.join("; "));
writeFileSync(resolve(argument("output")), `${JSON.stringify(validated.value, null, 2)}\n`, {
  mode: 0o600,
});
