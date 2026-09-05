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
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveGateVerdict, evidenceGateFailures } from "./lib/coding-issue-journey-evidence.mjs";
import { sha256File } from "./lib/digest.mjs";
import { readJsonFile } from "./lib/json.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const RECEIPT_SUFFIX = ".receipt.json";

function gitHeadShas(root) {
  const sourceCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const sourceTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { sourceCommitSha, sourceTreeSha };
}

function readReceipts(receiptsDir) {
  const receipts = new Map();
  if (!existsSync(receiptsDir)) return receipts;
  for (const entry of readdirSync(receiptsDir)) {
    if (!entry.endsWith(RECEIPT_SUFFIX)) continue;
    const scenarioId = basename(entry, RECEIPT_SUFFIX);
    const artifactPath = resolve(receiptsDir, `${scenarioId}.artifact`);
    if (!existsSync(artifactPath)) continue; // surfaced as "missing receipt" by the pure gate
    const meta = readJsonFile(resolve(receiptsDir, entry));
    receipts.set(scenarioId, {
      scenarioId,
      commitSha: meta.commitSha,
      platform: meta.platform,
      testStatus: meta.testStatus,
      digest: sha256File(artifactPath),
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
    pathToFileURL(
      resolve(root, "packages/keiko-server/dist/coding-runtime/opencodeToolSchemas.js"),
    ).href
  );
}

export async function checkCodingIssueJourneyEvidence({
  manifestPath,
  receiptsDir,
  binding,
  root = REPO_ROOT,
  headShas,
  contracts,
  toolCatalog,
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
  const resolvedBinding = { ...binding, sourceCommitSha: headCommitSha };
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
    modelVisibleToolNames,
  });
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
  return {
    manifestPath: resolve(requiredArgument(argv, "manifest")),
    receiptsDir: resolve(requiredArgument(argv, "receipts")),
    binding: {
      epicIssue: Number(requiredArgument(argv, "epic")),
      childIssue: Number(requiredArgument(argv, "child")),
      registeredScenarioIds: registered,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { manifestPath, receiptsDir, binding } = parseArgs(process.argv.slice(2));
  const { verdict, failures } = await checkCodingIssueJourneyEvidence({
    manifestPath,
    receiptsDir,
    binding,
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
