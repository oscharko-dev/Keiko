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
import { codingIssueJourneyScenarioArtifactErrors } from "./lib/coding-issue-journey-scenario-evidence.mjs";
import {
  inspectCodingIssueJourneySourceBinding,
  readCodingIssueJourneyEvidenceAtLanding,
} from "./lib/coding-issue-journey-source-binding.mjs";
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

function readScenarioArtifactEvidence(scenarioId, artifactBytes) {
  const ownedErrors = codingIssueJourneyScenarioArtifactErrors(undefined, scenarioId);
  if (ownedErrors === null) return { artifactValidationErrors: null };
  try {
    const artifact = JSON.parse(artifactBytes.toString("utf8"));
    return {
      artifactValidationErrors: codingIssueJourneyScenarioArtifactErrors(artifact, scenarioId),
      artifactIdentity: {
        scenarioId: artifact?.scenarioId,
        sourceCommitSha: artifact?.sourceCommitSha,
        platformTarget: artifact?.platformTarget,
        result: artifact?.result,
        flowBinding: artifact?.flowBinding,
      },
    };
  } catch {
    return { artifactValidationErrors: ["artifact is not valid JSON"] };
  }
}

/**
 * Reads every `<scenarioId>.receipt.json` + `.artifact` pair from a receipts directory, keyed by
 * scenario id. Exported so both this checker and the manifest producer
 * (scripts/generate-coding-issue-journey-manifest.mjs) share the one reader instead of each
 * growing its own copy (AGENTS.md §5). `recordedAt`/`provenance` are only consumed by the
 * producer -- this checker never reads them back off a receipt, since a scenario's declared
 * `recordedAt`/`provenance` are cross-referenced through the manifest itself, not the receipt.
 */
function bytesForPath(path, contentByPath) {
  if (contentByPath === undefined) return readFileSync(path);
  const bytes = contentByPath.get(resolve(path));
  if (bytes === undefined) throw new TypeError("Qualified evidence Git blob is missing");
  return bytes;
}

function receiptEntries(receiptsDir, contentByPath) {
  if (contentByPath === undefined) return readdirSync(receiptsDir);
  const canonicalReceiptsDir = resolve(receiptsDir);
  return [...contentByPath.keys()]
    .filter((path) => dirname(path) === canonicalReceiptsDir)
    .map((path) => basename(path));
}

function hasEvidencePath(path, contentByPath) {
  return contentByPath === undefined ? existsSync(path) : contentByPath.has(resolve(path));
}

export function readReceipts(receiptsDir, { observeArtifact, contentByPath } = {}) {
  const receipts = new Map();
  if (contentByPath === undefined && !existsSync(receiptsDir)) return receipts;
  for (const entry of receiptEntries(receiptsDir, contentByPath)) {
    if (!entry.endsWith(RECEIPT_SUFFIX)) continue;
    const receiptKey = basename(entry, RECEIPT_SUFFIX);
    const artifactPath = resolve(receiptsDir, `${receiptKey}.artifact`);
    const receiptPath = resolve(receiptsDir, entry);
    if (!hasEvidencePath(artifactPath, contentByPath)) continue;
    const meta = JSON.parse(bytesForPath(receiptPath, contentByPath).toString("utf8"));
    const scenarioId = meta.scenarioId;
    // A consumer that validates a structured artifact must inspect the same bytes whose digest
    // is retained. A separate read can race with an artifact writer and bind different content.
    const artifactBytes = bytesForPath(artifactPath, contentByPath);
    const digest = sha256(artifactBytes);
    observeArtifact?.(receiptKey, artifactBytes);
    const artifactEvidence = readScenarioArtifactEvidence(scenarioId, artifactBytes);
    receipts.set(receiptKey, {
      receiptKey,
      scenarioId,
      commitSha: meta.commitSha,
      platform: meta.platform,
      testStatus: meta.testStatus,
      recordedAt: meta.recordedAt,
      provenance: meta.provenance,
      digest,
      ...artifactEvidence,
    });
  }
  return receipts;
}

/** Reads the five distinct flow artifacts and hashes both the artifact bytes and the metadata
 * bytes. The artifact is parsed from those same bytes, so generation and verification cannot
 * validate one version while retaining a digest for another. */
export function readFlowReceipts(receiptsDir, flowIds, { contentByPath } = {}) {
  const receipts = new Map();
  for (const flowId of flowIds) {
    const artifactPath = resolve(receiptsDir, `${flowId}.artifact`);
    const receiptPath = resolve(receiptsDir, `${flowId}.receipt.json`);
    if (
      !hasEvidencePath(artifactPath, contentByPath) ||
      !hasEvidencePath(receiptPath, contentByPath)
    ) {
      continue;
    }
    const artifactBytes = bytesForPath(artifactPath, contentByPath);
    const receiptBytes = bytesForPath(receiptPath, contentByPath);
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

function validatedFlowReceipts(
  receiptsDir,
  registeredQualificationFlows,
  contractsModule,
  contentByPath,
) {
  const flowReceiptsById = readFlowReceipts(
    receiptsDir,
    registeredQualificationFlows.map((flow) => flow.flowId),
    { contentByPath },
  );
  for (const receipt of flowReceiptsById.values()) {
    receipt.artifactValidation = contractsModule.validateCodeTaskQualificationFlowArtifact(
      receipt.artifact,
    );
  }
  return flowReceiptsById;
}

export function qualificationBinding(binding, headCommitSha, descriptor) {
  const registeredProductionFunctionalScenarioIds = Array.isArray(descriptor?.scenarios)
    ? descriptor.scenarios
        .filter((scenario) => scenario?.evidenceClass === "production-functional")
        .map((scenario) => scenario.scenarioId)
    : [];
  return {
    ...binding,
    sourceCommitSha: headCommitSha,
    registeredProductionFunctionalScenarioIds,
    registeredQualificationFlows: Array.isArray(descriptor?.flows) ? descriptor.flows : [],
  };
}

function qualificationDescriptorFailures(descriptor) {
  return Array.isArray(descriptor?.flows) && descriptor.flows.length === 5
    ? []
    : ["qualification descriptor must declare exactly five flows"];
}

function resolveSourceBinding({
  root,
  headShas,
  landingHead,
  manifestValidation,
  manifestPath,
  receiptsDir,
  descriptorPath,
  descriptor,
}) {
  const { sourceCommitSha: landingCommitSha, sourceTreeSha: landingTreeSha } =
    landingHead ?? headShas ?? gitHeadShas(root);
  if (headShas !== undefined || !manifestValidation.ok) {
    return {
      failures: [],
      sourceCommitSha: landingCommitSha,
      sourceTreeSha: landingTreeSha,
      landingCommitSha,
    };
  }
  return inspectCodingIssueJourneySourceBinding({
    root,
    sourceCommitSha: manifestValidation.value.sourceCommitSha,
    sourceTreeSha: manifestValidation.value.sourceTreeSha,
    landingCommitSha,
    manifestPath,
    receiptsDir,
    descriptorPath,
    descriptor,
  });
}

function evaluateEvidence({
  contractsModule,
  toolCatalogModule,
  manifestValidation,
  sourceBinding,
  receiptsDir,
  binding,
  descriptor,
  contentByPath,
}) {
  const modelVisibleToolNames = new Set(
    toolCatalogModule.OPENCODE_MODEL_VISIBLE_TOOLS.map((tool) => tool.name),
  );
  const resolvedBinding = qualificationBinding(binding, sourceBinding.sourceCommitSha, descriptor);
  const flowReceiptsById = validatedFlowReceipts(
    receiptsDir,
    resolvedBinding.registeredQualificationFlows,
    contractsModule,
    contentByPath,
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
    headCommitSha: sourceBinding.sourceCommitSha,
    headTreeSha: sourceBinding.sourceTreeSha,
    receiptsByScenarioId: readReceipts(receiptsDir, { contentByPath }),
    flowReceiptsById,
    modelVisibleToolNames,
  });
  failures.push(...sourceBinding.failures, ...qualificationDescriptorFailures(descriptor));
  const contractVerdict = manifestValidation.ok
    ? contractsModule.codeTaskQualificationVerdictFor(manifestValidation.value, resolvedBinding)
    : "blocked";
  return {
    verdict: deriveGateVerdict({ contractVerdict, failures, manifestValidation }),
    failures,
    sourceCommitSha: sourceBinding.sourceCommitSha,
    landingCommitSha: sourceBinding.landingCommitSha,
  };
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
  descriptorPath,
}) {
  const inputs = resolveLandingInputs({
    root,
    headShas,
    manifestPath,
    receiptsDir,
    descriptorPath,
    descriptor,
  });
  if (inputs.failures.length > 0) return blockedLandingResult(inputs);
  const contractsModule = contracts ?? (await loadContracts(root));
  const toolCatalogModule = toolCatalog ?? (await loadToolCatalog(root));
  const manifestValidation = contractsModule.validateCodeTaskQualificationManifest(inputs.manifest);
  const sourceBinding = resolveSourceBinding({
    root,
    headShas,
    landingHead: inputs.landingHead,
    manifestValidation,
    manifestPath,
    receiptsDir,
    descriptorPath,
    descriptor: inputs.descriptor,
  });
  return evaluateEvidence({
    contractsModule,
    toolCatalogModule,
    manifestValidation,
    sourceBinding,
    receiptsDir,
    binding,
    descriptor: inputs.descriptor,
    contentByPath: inputs.contentByPath,
  });
}

function resolveLandingInputs({
  root,
  headShas,
  manifestPath,
  receiptsDir,
  descriptorPath,
  descriptor,
}) {
  if (headShas !== undefined) {
    return {
      landingHead: headShas,
      failures: [],
      manifest: readJsonFile(manifestPath),
      descriptor,
      contentByPath: undefined,
    };
  }
  return resolveGitLandingInputs({ root, manifestPath, receiptsDir, descriptorPath });
}

function resolveGitLandingInputs({ root, manifestPath, receiptsDir, descriptorPath }) {
  const landingHead = gitHeadShas(root);
  const landingEvidence = readCodingIssueJourneyEvidenceAtLanding({
    root,
    landingCommitSha: landingHead.sourceCommitSha,
    manifestPath,
    receiptsDir,
    descriptorPath,
  });
  if (landingEvidence.failures.length > 0) {
    return {
      landingHead,
      failures: landingEvidence.failures,
      manifest: undefined,
      descriptor: undefined,
      contentByPath: undefined,
    };
  }
  const manifestBytes = landingEvidence.contentByPath.get(resolve(manifestPath));
  return {
    landingHead,
    failures: [],
    manifest: JSON.parse(manifestBytes.toString("utf8")),
    descriptor: landingEvidence.descriptor,
    contentByPath: landingEvidence.contentByPath,
  };
}

function blockedLandingResult(inputs) {
  return {
    verdict: "blocked",
    failures: inputs.failures,
    sourceCommitSha: inputs.landingHead.sourceCommitSha,
    landingCommitSha: inputs.landingHead.sourceCommitSha,
  };
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
  const descriptorPath = resolve(requiredArgument(argv, "descriptor"));
  return {
    manifestPath: resolve(requiredArgument(argv, "manifest")),
    receiptsDir: resolve(requiredArgument(argv, "receipts")),
    binding: {
      epicIssue: Number(requiredArgument(argv, "epic")),
      childIssue: Number(requiredArgument(argv, "child")),
      registeredScenarioIds: registered,
    },
    descriptorPath,
  };
}

async function runCli(argv) {
  const { manifestPath, receiptsDir, binding, descriptor, descriptorPath } = parseArgs(argv);
  if (!existsSync(manifestPath)) throw new Error(`missing manifest: ${manifestPath}`);
  if (!existsSync(receiptsDir)) throw new Error(`missing receipts directory: ${receiptsDir}`);
  if (!existsSync(descriptorPath)) throw new Error(`missing descriptor: ${descriptorPath}`);
  const { verdict, failures, sourceCommitSha, landingCommitSha } =
    await checkCodingIssueJourneyEvidence({
      manifestPath,
      receiptsDir,
      binding,
      descriptor,
      descriptorPath,
    });
  if (failures.length > 0) {
    console.error(`Coding-issue journey evidence check failed (${failures.length}):`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Coding-issue journey evidence check passed. Verdict: ${verdict}; ` +
        `source=${sourceCommitSha}; landing=${landingCommitSha}.`,
    );
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
