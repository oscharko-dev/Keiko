#!/usr/bin/env node
// Knowledge M2 clean-checkout demo — CLI wrapper (Issue #2634 / Epic #2556 Definition of Done).
//
// This is the runnable side of the DoD:
//
//   1. Provision the sqlite-vec loadable extension so the ANN diagnostic can reach `available`
//      (see `scripts/provision-sqlite-vec.mjs` for why it is not an npm dependency).
//   2. Boot a loopback OpenAI-compatible mock server for embeddings and LiteLLM rerank
//      (`scripts/lib/clean-checkout-demo-mock-server.mjs`).
//   3. Drive the REAL production retrieval + rerank facade end-to-end
//      (`scripts/lib/clean-checkout-demo.mjs::runCleanCheckoutDemo`).
//   4. Validate the recorded evidence against the six DoD acceptance criteria and the content-free
//      redaction contract BEFORE printing it, so a run that fails the DoD exits non-zero rather
//      than emitting misleading evidence.
//
// Usage:
//
//   npm run demo:clean-checkout            # prints JSON evidence to stdout
//   npm run demo:clean-checkout -- --pretty
//
// Environment (all optional):
//
//   KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH   override the auto-resolved vec0 path
//   KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS              embedding vector dimensions (default 32)

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assetFor, extensionPathFor } from "./provision-sqlite-vec.mjs";
import { startCleanCheckoutMockServer } from "./lib/clean-checkout-demo-mock-server.mjs";
import {
  ACCEPTANCE_CRITERIA,
  evaluateAcceptanceCriteria,
  evidenceRedactionFailures,
  renderAcceptanceReport,
  resolveProvisionedSqliteVecPath,
  runCleanCheckoutDemo,
  validateEvidenceContract,
} from "./lib/clean-checkout-demo.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIMENSIONS = 32;

function log(message) {
  process.stderr.write(`clean-checkout-demo: ${message}\n`);
}

// `process.exit(1)` truncates a still-buffered `stderr.write` when stderr is redirected. Throwing
// a labelled `Error` lets `main()` bubble it up naturally, the runtime flushes stderr on the way
// out, and the top-level `.catch` maps to a non-zero exit code by writing the failure line then
// setting `process.exitCode = 1`. Same visible behaviour, no lost line on `2>>log`.
class CleanCheckoutDemoFailure extends Error {}
function fail(message) {
  throw new CleanCheckoutDemoFailure(message);
}

function requestedDimensions() {
  const raw = process.env.KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS;
  if (raw === undefined || raw.length === 0) return DEFAULT_DIMENSIONS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 8 || parsed > 4_096) {
    fail(`KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS must be an integer in 8..4096, got '${raw}'`);
  }
  return parsed;
}

function shouldPrettyPrint() {
  return process.argv.includes("--pretty");
}

// Helpful failure message when the vec0 extension is missing: the reader almost certainly needs
// `npm run provision:sqlite-vec` (offline hosts can copy the file manually) rather than any code
// change. We do not try to auto-run provisioning here — that would hide a broken host from the
// reader and quietly turn a red demo into a silent-network-fetch demo.
function requireProvisionedExtension() {
  const provisioned = resolveProvisionedSqliteVecPath(REPO_ROOT);
  if (provisioned !== undefined) return provisioned;
  const asset = assetFor(process.platform, process.arch);
  if (asset === undefined) {
    fail(
      `sqlite-vec has no published loadable extension for ${process.platform}-${process.arch}; the ANN diagnostic cannot reach 'available' on this host.`,
    );
  }
  const expected = extensionPathFor(resolve(REPO_ROOT, ".sqlite-vec", "0.1.9"), process.platform);
  fail(
    [
      "sqlite-vec loadable extension is not provisioned.",
      `  expected: ${expected}`,
      "  fix:      npm run provision:sqlite-vec",
    ].join("\n"),
  );
  return "";
}

async function main() {
  const dimensions = requestedDimensions();
  const sqliteVecExtensionPath = requireProvisionedExtension();
  // The stderr log line is what a reader sees while the demo is running. Loopback URLs and
  // absolute filesystem paths are not repository-content-level secrets, but the repository's
  // redaction discipline prefers status markers over raw endpoint / path strings, and the
  // acceptance validator explicitly rejects `http(s)://` inside the evidence — the stderr trail
  // should hold to the same bar. What matters here is "extension resolved" and "server up",
  // both binary; the exact port and path are already visible to whoever needs them (the process
  // owns the port, the disk owns the path).
  log("sqlite-vec extension: resolved (provisioned)");
  const mock = await startCleanCheckoutMockServer({ embeddingDimensions: dimensions });
  log(`mock server: ready on loopback (dimensions=${String(dimensions)})`);
  let evidence;
  try {
    evidence = await runCleanCheckoutDemo({
      repoRoot: REPO_ROOT,
      mockOrigin: mock.origin,
      embeddingDimensions: dimensions,
      sqliteVecExtensionPath,
    });
  } finally {
    await mock.close();
  }
  const contractFailures = validateEvidenceContract(evidence);
  const redactionFailures = evidenceRedactionFailures(evidence);
  const acceptance = evaluateAcceptanceCriteria(evidence);
  log("Acceptance report:");
  for (const line of renderAcceptanceReport(evidence)) log(`  ${line}`);
  if (redactionFailures.length > 0) {
    fail(`evidence carries redaction violations: ${redactionFailures.join(", ")}`);
  }
  if (!acceptance.ok || contractFailures.length > 0) {
    fail(
      `evidence contract violations: ${
        contractFailures.length === 0 ? "acceptance-not-ok" : contractFailures.join(", ")
      }`,
    );
  }
  process.stdout.write(
    shouldPrettyPrint()
      ? `${JSON.stringify(evidence, null, 2)}\n`
      : `${JSON.stringify(evidence)}\n`,
  );
  log(`PASS — six acceptance criteria satisfied (${String(ACCEPTANCE_CRITERIA.length)} of them).`);
}

const entryPoint = process.argv[1];
const isDirectInvocation =
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href &&
  existsSync(entryPoint);
if (isDirectInvocation) {
  main().catch((cause) => {
    const message = cause instanceof Error ? cause.message : "unknown failure";
    log(`FAIL — ${message}`);
    // Non-zero exit without `process.exit(1)` — Node flushes stderr at the natural end of the
    // event loop, so the FAIL line above is guaranteed to reach `2>>log` before the process
    // terminates. The prior `process.exit(1)` truncated it on redirection.
    process.exitCode = 1;
  });
}
