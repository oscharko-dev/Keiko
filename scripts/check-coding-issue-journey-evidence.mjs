// Machine validator for the #3390 qualification manifest (issue #3390 correction 6). SHA-binds
// the manifest to the qualified git head, cross-references its scenarios against the receipts
// found on disk, and reports the derived qualified/blocked/failed verdict. Follows the pattern of
// scripts/check-git-delivery-evidence.mjs (a testable exported check function plus a thin CLI
// runner) and scripts/lib/code-task-acceptance.mjs (a dependency-free pure module backing it); the
// pure cross-referencing logic lives in scripts/lib/coding-issue-journey-evidence.mjs.
//
// A receipt is a `<scenarioId>.receipt.json` (`{ scenarioId, commitSha, platform, testStatus }`,
// content-free) paired with a `<scenarioId>.artifact` file whose bytes back the scenario's
// `receiptDigest` -- the digest is recomputed from the artifact here, never trusted from the
// manifest or the receipt metadata, so a manifest cannot claim a digest for evidence that does not
// exist or does not match.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveGateVerdict, evidenceGateFailures } from "./lib/coding-issue-journey-evidence.mjs";
import { sha256 } from "./lib/digest.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { readJsonFile } from "./lib/json.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const RECEIPT_SUFFIX = ".receipt.json";
const FLOW_RECEIPT_KEYS = new Set([
  "flowId",
  "commitSha",
  "platform",
  "testStatus",
  "recordedAt",
  "provenance",
]);

function flowReceiptMetadataErrors(meta) {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    return ["metadata must be an object"];
  }
  const errors = Object.keys(meta)
    .filter((key) => !FLOW_RECEIPT_KEYS.has(key))
    .map(() => "metadata has an unknown field");
  for (const key of FLOW_RECEIPT_KEYS) {
    if (!Object.hasOwn(meta, key)) errors.push(`metadata is missing ${key}`);
  }
  return errors;
}

function gitHeadShas(root) {
  const git = resolveHostExecutable("git");
  const sourceCommitSha = execFileSync(git, ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const sourceTreeSha = execFileSync(git, ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { sourceCommitSha, sourceTreeSha };
}

/**
 * Reads every `<scenarioId>.receipt.json` + `.artifact` pair from a receipts directory, keyed by
 * scenario id. Exported so both this checker and the manifest producer
 * (scripts/generate-coding-issue-journey-manifest.mjs) share the one reader instead of each
 * growing its own copy (AGENTS.md §5). `recordedAt`/`provenance` are only consumed by the
 * producer -- this checker never reads them back off a receipt, since a scenario's declared
 * `recordedAt`/`provenance` are cross-referenced through the manifest itself, not the receipt.
 */
export function readReceipts(receiptsDir, { observeArtifact } = {}) {
  const receipts = new Map();
  if (!existsSync(receiptsDir)) return receipts;
  for (const entry of readdirSync(receiptsDir)) {
    if (!entry.endsWith(RECEIPT_SUFFIX)) continue;
    const scenarioId = basename(entry, RECEIPT_SUFFIX);
    const artifactPath = resolve(receiptsDir, `${scenarioId}.artifact`);
    if (!existsSync(artifactPath)) continue; // surfaced as "missing receipt" by the pure gate
    const meta = readJsonFile(resolve(receiptsDir, entry));
    // A consumer that validates a structured artifact must inspect the same bytes whose digest
    // is retained. A separate read can race with an artifact writer and bind different content.
    const artifactBytes = readFileSync(artifactPath);
    const digest = sha256(artifactBytes);
    observeArtifact?.(scenarioId, artifactBytes);
    receipts.set(scenarioId, {
      scenarioId,
      commitSha: meta.commitSha,
      platform: meta.platform,
      testStatus: meta.testStatus,
      recordedAt: meta.recordedAt,
      provenance: meta.provenance,
      digest,
    });
  }
  return receipts;
}

/** Reads the five distinct flow artifacts and hashes both the artifact bytes and the metadata
 * bytes. The artifact is parsed from those same bytes, so generation and verification cannot
 * validate one version while retaining a digest for another. */
export function readFlowReceipts(receiptsDir, flowIds) {
  const receipts = new Map();
  for (const flowId of flowIds) {
    const artifactPath = resolve(receiptsDir, `${flowId}.artifact`);
    const receiptPath = resolve(receiptsDir, `${flowId}.receipt.json`);
    if (!existsSync(artifactPath) || !existsSync(receiptPath)) continue;
    const artifactBytes = readFileSync(artifactPath);
    const receiptBytes = readFileSync(receiptPath);
    const meta = JSON.parse(receiptBytes.toString("utf8"));
    receipts.set(flowId, {
      artifact: JSON.parse(artifactBytes.toString("utf8")),
      artifactDigest: sha256(artifactBytes),
      receiptDigest: sha256(receiptBytes),
      commitSha: meta.commitSha,
      platform: meta.platform,
      testStatus: meta.testStatus,
      recordedAt: meta.recordedAt,
      provenance: meta.provenance,
      flowId: meta.flowId,
      metadataErrors: flowReceiptMetadataErrors(meta),
    });
  }
  return receipts;
}

/**
 * Loads the contracts module used to validate the manifest. Exposed so tests can inject a fixture
 * double instead of depending on the built package.
 */
async function loadContracts(root) {
  return import(
    pathToFileURL(resolve(root, "packages/keiko-contracts/dist/code-task-acceptance.js")).href
  );
}

/**
 * Loads the server package's model-visible OpenCode tool catalog (#3390 audit F10), the same
 * built-dist import pattern as `loadContracts` above. Exposed so tests can inject a fixture double
 * instead of depending on the built server package.
 */
async function loadToolCatalog(root) {
  return import(
    pathToFileURL(resolve(root, "packages/keiko-server/dist/coding-runtime/opencodeToolSchemas.js"))
      .href
  );
}

function validatedFlowReceipts(receiptsDir, registeredQualificationFlows, contractsModule) {
  const flowReceiptsById = readFlowReceipts(
    receiptsDir,
    registeredQualificationFlows.map((flow) => flow.flowId),
  );
  for (const receipt of flowReceiptsById.values()) {
    receipt.artifactValidation = contractsModule.validateCodeTaskQualificationFlowArtifact(
      receipt.artifact,
    );
  }
  return flowReceiptsById;
}

function qualificationBinding(binding, headCommitSha, descriptor) {
  return {
    ...binding,
    sourceCommitSha: headCommitSha,
    registeredQualificationFlows: Array.isArray(descriptor?.flows) ? descriptor.flows : [],
  };
}

function qualificationDescriptorFailures(descriptor) {
  return Array.isArray(descriptor?.flows) && descriptor.flows.length === 5
    ? []
    : ["qualification descriptor must declare exactly five flows"];
}

export async function checkCodingIssueJourneyEvidence({
  manifestPath,
  receiptsDir,
  binding,
  root = REPO_ROOT,
  headShas,
  contracts,
  toolCatalog,
  descriptor,
}) {
  const { sourceCommitSha: headCommitSha, sourceTreeSha: headTreeSha } =
    headShas ?? gitHeadShas(root);
  const contractsModule = contracts ?? (await loadContracts(root));
  const toolCatalogModule = toolCatalog ?? (await loadToolCatalog(root));
  const modelVisibleToolNames = new Set(
    toolCatalogModule.OPENCODE_MODEL_VISIBLE_TOOLS.map((tool) => tool.name),
  );
  const manifestValidation = contractsModule.validateCodeTaskQualificationManifest(
    readJsonFile(manifestPath),
  );
  const resolvedBinding = qualificationBinding(binding, headCommitSha, descriptor);
  const registeredQualificationFlows = resolvedBinding.registeredQualificationFlows;
  const flowReceiptsById = validatedFlowReceipts(
    receiptsDir,
    registeredQualificationFlows,
    contractsModule,
  );
  const manifestFailures = manifestValidation.ok
    ? contractsModule.codeTaskQualificationManifestFailures(
        manifestValidation.value,
        resolvedBinding,
      )
    : [];
  const failures = evidenceGateFailures({
    manifestValidation,
    manifestFailures,
    headCommitSha,
    headTreeSha,
    receiptsByScenarioId: readReceipts(receiptsDir),
    flowReceiptsById,
    modelVisibleToolNames,
  });
  failures.push(...qualificationDescriptorFailures(descriptor));
  const contractVerdict = manifestValidation.ok
    ? contractsModule.codeTaskQualificationVerdictFor(manifestValidation.value, resolvedBinding)
    : "blocked";
  const verdict = deriveGateVerdict({ contractVerdict, failures, manifestValidation });
  return { verdict, failures };
}

function requiredArgument(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || argv[index + 1] === undefined) {
    throw new Error(`missing --${name}`);
  }
  return argv[index + 1];
}

function parseArgs(argv) {
  const registered = requiredArgument(argv, "registered")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const descriptor = readJsonFile(resolve(requiredArgument(argv, "descriptor")));
  return {
    manifestPath: resolve(requiredArgument(argv, "manifest")),
    receiptsDir: resolve(requiredArgument(argv, "receipts")),
    binding: {
      epicIssue: Number(requiredArgument(argv, "epic")),
      childIssue: Number(requiredArgument(argv, "child")),
      registeredScenarioIds: registered,
    },
    descriptor,
  };
}

async function runCli(argv) {
  const { manifestPath, receiptsDir, binding, descriptor } = parseArgs(argv);
  const { verdict, failures } = await checkCodingIssueJourneyEvidence({
    manifestPath,
    receiptsDir,
    binding,
    descriptor,
  });
  if (failures.length > 0) {
    console.error(`Coding-issue journey evidence check failed (${failures.length}):`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Coding-issue journey evidence check passed. Verdict: ${verdict}.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
