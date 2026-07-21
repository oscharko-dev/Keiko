// The clean-checkout demo CLI's testable core (Issue #2634). The entry point at
// `scripts/knowledge-m2-clean-checkout-demo.mjs` is a two-line shim that imports `main()` from
// here — the heavy lifting (env parsing, extension resolution, mock server orchestration, evidence
// validation, exit-code discipline) lives in this module so unit tests can drive every branch
// directly without a subprocess boundary.
//
// A subprocess test would have exercised the same code paths but v8 coverage does not follow into
// spawned processes, so lcov (and Sonar) would see the CLI as unreachable dead code. Splitting the
// logic out is the same pattern `scripts/lib/knowledge-m2-closeout.mjs` uses.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assetFor, extensionPathFor } from "../provision-sqlite-vec.mjs";
import { startCleanCheckoutMockServer } from "./clean-checkout-demo-mock-server.mjs";
import {
  ACCEPTANCE_CRITERIA,
  evaluateAcceptanceCriteria,
  evidenceRedactionFailures,
  renderAcceptanceReport,
  resolveProvisionedSqliteVecPath,
  runCleanCheckoutDemo,
  validateEvidenceContract,
} from "./clean-checkout-demo.mjs";

// Two-levels-up from this file lands on the repo root (`scripts/lib/<file>.mjs` → repo root).
const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DIMENSIONS = 32;

// Labelled error so a top-level catch can distinguish "we chose to fail loudly" from an unhandled
// runtime crash. Both map to `exitCode = 1`; the tests only need the identity.
export class CleanCheckoutDemoFailure extends Error {}

function throwFailure(message) {
  throw new CleanCheckoutDemoFailure(message);
}

// Everything a test needs to inject into the CLI's runtime seams: env, argv, stdout/stderr, and
// the sub-runner. Defaults are the ambient globals for direct invocation.
function resolveEnv(env) {
  return env ?? process.env;
}

function resolveArgv(argv) {
  return argv ?? process.argv;
}

function resolveOutputs(stderr, stdout) {
  return {
    stderr: stderr ?? ((message) => process.stderr.write(message)),
    stdout: stdout ?? ((message) => process.stdout.write(message)),
  };
}

export function requestedDimensions({
  env,
  defaultDimensions = DEFAULT_DIMENSIONS,
  fail = throwFailure,
} = {}) {
  const raw = resolveEnv(env).KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS;
  if (raw === undefined || raw.length === 0) return defaultDimensions;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 8 || parsed > 4_096) {
    fail(`KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS must be an integer in 8..4096, got '${raw}'`);
  }
  return parsed;
}

export function shouldPrettyPrint({ argv } = {}) {
  return resolveArgv(argv).includes("--pretty");
}

// The vec0 loadable extension is operator-provisioned (see `scripts/provision-sqlite-vec.mjs`).
// This helper turns any missing-extension state into an actionable failure — the reader gets a
// path hint AND the fix command, and the process exits non-zero before wasting time booting the
// mock server. Tests substitute the platform/arch to exercise the "unsupported host" branch.
export function requireProvisionedExtension({
  repoRoot = REPO_ROOT_DEFAULT,
  platform = process.platform,
  arch = process.arch,
  resolveExtensionPath = resolveProvisionedSqliteVecPath,
  fail = throwFailure,
} = {}) {
  const provisioned = resolveExtensionPath(repoRoot);
  if (provisioned !== undefined) return provisioned;
  const asset = assetFor(platform, arch);
  if (asset === undefined) {
    fail(
      `sqlite-vec has no published loadable extension for ${platform}-${arch}; the ANN diagnostic cannot reach 'available' on this host.`,
    );
    return "";
  }
  const expected = extensionPathFor(resolve(repoRoot, ".sqlite-vec", "0.1.9"), platform);
  fail(
    [
      "sqlite-vec loadable extension is not provisioned.",
      `  expected: ${expected}`,
      "  fix:      npm run provision:sqlite-vec",
    ].join("\n"),
  );
  return "";
}

function logLine(stderr, message) {
  stderr(`clean-checkout-demo: ${message}\n`);
}

function refuseFailedEvidence({ evidence, contractFailures, redactionFailures, acceptance, fail }) {
  if (redactionFailures.length > 0) {
    fail(`evidence carries redaction violations: ${redactionFailures.join(", ")}`);
  }
  if (!acceptance.ok || contractFailures.length > 0) {
    const detail =
      contractFailures.length === 0 ? "acceptance-not-ok" : contractFailures.join(", ");
    fail(`evidence contract violations: ${detail}`);
  }
  return evidence;
}

async function runDemoWithMock({
  mockOrigin,
  dimensions,
  sqliteVecExtensionPath,
  repoRoot,
  runDemo,
}) {
  return runDemo({
    repoRoot,
    mockOrigin,
    embeddingDimensions: dimensions,
    sqliteVecExtensionPath,
  });
}

async function collectEvidence({
  bootMock,
  runDemo,
  dimensions,
  sqliteVecExtensionPath,
  repoRoot,
  log,
}) {
  const mock = await bootMock({ embeddingDimensions: dimensions });
  log(`mock server: ready on loopback (dimensions=${String(dimensions)})`);
  try {
    return await runDemoWithMock({
      mockOrigin: mock.origin,
      dimensions,
      sqliteVecExtensionPath,
      repoRoot,
      runDemo,
    });
  } finally {
    await mock.close();
  }
}

function emitAcceptanceAndEnforce({ evidence, log, fail }) {
  const contractFailures = validateEvidenceContract(evidence);
  const redactionFailures = evidenceRedactionFailures(evidence);
  const acceptance = evaluateAcceptanceCriteria(evidence);
  log("Acceptance report:");
  for (const line of renderAcceptanceReport(evidence)) {
    log(`  ${line}`);
  }
  refuseFailedEvidence({ evidence, contractFailures, redactionFailures, acceptance, fail });
}

function serialisedEvidence(evidence, detectPretty, argv) {
  return detectPretty({ argv })
    ? `${JSON.stringify(evidence, null, 2)}\n`
    : `${JSON.stringify(evidence)}\n`;
}

export async function main({
  env,
  argv,
  stderr,
  stdout,
  repoRoot = REPO_ROOT_DEFAULT,
  runDemo = runCleanCheckoutDemo,
  bootMock = startCleanCheckoutMockServer,
  requireExtension = requireProvisionedExtension,
  parseDimensions = requestedDimensions,
  detectPretty = shouldPrettyPrint,
  fail = throwFailure,
} = {}) {
  const outputs = resolveOutputs(stderr, stdout);
  const log = (message) => logLine(outputs.stderr, message);
  const dimensions = parseDimensions({ env, fail });
  const sqliteVecExtensionPath = requireExtension({ repoRoot, fail });
  log("sqlite-vec extension: resolved (provisioned)");
  const evidence = await collectEvidence({
    bootMock,
    runDemo,
    dimensions,
    sqliteVecExtensionPath,
    repoRoot,
    log,
  });
  emitAcceptanceAndEnforce({ evidence, log, fail });
  outputs.stdout(serialisedEvidence(evidence, detectPretty, argv));
  log(`PASS — six acceptance criteria satisfied (${String(ACCEPTANCE_CRITERIA.length)} of them).`);
  return evidence;
}

// Runs `main()` with production defaults and writes the classic top-level failure line to stderr
// on any thrown error. Sets `process.exitCode = 1` instead of `process.exit(1)` so a redirected
// stderr flushes the FAIL line before termination — CodeRabbit L52 discipline preserved.
export async function runCliFromEntryPoint({ mainImpl = main, stderr } = {}) {
  const emit = stderr ?? ((message) => process.stderr.write(message));
  try {
    await mainImpl();
    return { ok: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown failure";
    emit(`clean-checkout-demo: FAIL — ${message}\n`);
    process.exitCode = 1;
    return { ok: false, message };
  }
}
