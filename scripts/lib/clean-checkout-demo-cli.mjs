// The clean-checkout demo CLI's testable core (Issue #2634). The entry point at
// `scripts/knowledge-m2-clean-checkout-demo.mjs` is a two-line shim that imports `main()` from
// here — the heavy lifting (env/config parsing, USearch resolution, evidence
// validation, exit-code discipline) lives in this module so unit tests can drive every branch
// directly without a subprocess boundary.
//
// A subprocess test would have exercised the same code paths but v8 coverage does not follow into
// spawned processes, so lcov (and Sonar) would see the CLI as unreachable dead code. Splitting the
// logic out is the same pattern `scripts/lib/knowledge-m2-closeout.mjs` uses.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfigFromFile } from "@oscharko-dev/keiko-model-gateway";

import {
  USEARCH_RUNTIME_MANIFEST,
  usearchRuntimeTargetKey,
} from "../../packages/keiko-local-knowledge/src/retrieval/usearch-runtime-manifest.ts";
import { provisionedUsearchBinaryPath } from "../provision-usearch.mjs";
import {
  ACCEPTANCE_CRITERIA,
  CLEAN_CHECKOUT_EXECUTION_MODES,
  evaluateAcceptanceCriteria,
  evidenceRedactionFailures,
  renderAcceptanceReport,
  resolveProvisionedUsearchPath,
  runCleanCheckoutDemo,
  validateEvidenceContract,
} from "./clean-checkout-demo.mjs";

// Two-levels-up from this file lands on the repo root (`scripts/lib/<file>.mjs` → repo root).
const REPO_ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DIMENSIONS = 32;
const CONFIG_PATH_ENV = "KEIKO_CONFIG_FILE";
const EMBEDDING_MODEL_ENV = "KEIKO_CLEAN_CHECKOUT_DEMO_EMBEDDING_MODEL_ID";
const ANSWER_MODEL_ENV = "KEIKO_CLEAN_CHECKOUT_DEMO_ANSWER_MODEL_ID";

// Labelled error so a top-level catch can distinguish "we chose to fail loudly" from an unhandled
// runtime crash. Both map to `exitCode = 1`; the tests only need the identity.
export class CleanCheckoutDemoFailure extends Error {}

function throwFailure(message) {
  throw new CleanCheckoutDemoFailure(message);
}

function failClosed(fail, message) {
  fail(message);
  throwFailure(message);
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

function defaultOrRequiredDimensions({ required, defaultDimensions, fail }) {
  if (required) {
    return failClosed(fail, "KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS is required in acceptance mode");
  }
  return defaultDimensions;
}

export function requestedDimensions({
  env,
  defaultDimensions = DEFAULT_DIMENSIONS,
  required = false,
  fail = throwFailure,
} = {}) {
  const raw = resolveEnv(env).KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS;
  if (raw === undefined || raw.length === 0) {
    return defaultOrRequiredDimensions({ required, defaultDimensions, fail });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 8 || parsed > 4_096) {
    return failClosed(
      fail,
      `KEIKO_CLEAN_CHECKOUT_DEMO_DIMENSIONS must be an integer in 8..4096, got '${raw}'`,
    );
  }
  return parsed;
}

export function shouldPrettyPrint({ argv } = {}) {
  return resolveArgv(argv).includes("--pretty");
}

function requireApprovedUsearchTarget(platform, arch, fail) {
  const target = usearchRuntimeTargetKey(platform, arch);
  if (target !== undefined) return target;
  return failClosed(
    fail,
    `USearch has no approved Keiko runtime for ${platform}-${arch}; the vector provider cannot reach 'available' on this host.`,
  );
}

function requireVerifiedProvisionedPath({
  provisioned,
  expectedSha256,
  verifyRuntime,
  expectedPath,
  fail,
}) {
  if (provisioned !== undefined) {
    if (verifyRuntime(provisioned, expectedSha256)) return provisioned;
    return failClosed(
      fail,
      "USearch native runtime failed its platform-pinned SHA-256 verification",
    );
  }
  return failClosed(
    fail,
    [
      "USearch native runtime is not provisioned.",
      `  expected: ${expectedPath}`,
      `  version:  ${USEARCH_RUNTIME_MANIFEST.version}`,
      "  fix:      npm run provision:usearch",
    ].join("\n"),
  );
}

export function requireProvisionedUsearchRuntime({
  repoRoot = REPO_ROOT_DEFAULT,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  resolveRuntimePath = resolveProvisionedUsearchPath,
  verifyRuntime = verifyUsearchRuntime,
  fail = throwFailure,
} = {}) {
  const target = requireApprovedUsearchTarget(platform, arch, fail);
  const provisioned = resolveRuntimePath({ repoRoot, env, platform, arch });
  return requireVerifiedProvisionedPath({
    provisioned,
    expectedSha256: USEARCH_RUNTIME_MANIFEST.targets[target].binarySha256,
    verifyRuntime,
    expectedPath: provisionedUsearchBinaryPath(repoRoot, platform, arch),
    fail,
  });
}

function verifyUsearchRuntime(path, expectedSha256) {
  try {
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    return actual === expectedSha256;
  } catch {
    return false;
  }
}

function requiredEnv(env, name, fail) {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    return failClosed(fail, `${name} is required in acceptance mode`);
  }
  return value;
}

export function loadAcceptanceRuntime({
  env = process.env,
  loadConfig = loadConfigFromFile,
  fail = throwFailure,
} = {}) {
  const configPath = requiredEnv(env, CONFIG_PATH_ENV, fail);
  const embeddingModelId = requiredEnv(env, EMBEDDING_MODEL_ENV, fail);
  const answerModelId = requiredEnv(env, ANSWER_MODEL_ENV, fail);
  let gatewayConfig;
  try {
    gatewayConfig = loadConfig(configPath, env);
  } catch {
    return failClosed(fail, "could not load or validate the configured model provider");
  }
  return { gatewayConfig, embeddingModelId, answerModelId };
}

function logLine(stderr, message) {
  stderr(`clean-checkout-demo: ${message}\n`);
}

function refuseFailedEvidence({ evidence, contractFailures, redactionFailures, acceptance, fail }) {
  if (redactionFailures.length > 0) {
    return failClosed(
      fail,
      `evidence carries redaction violations: ${redactionFailures.join(", ")}`,
    );
  }
  if (!acceptance.ok || contractFailures.length > 0) {
    const detail =
      contractFailures.length === 0 ? "acceptance-not-ok" : contractFailures.join(", ");
    return failClosed(fail, `evidence contract violations: ${detail}`);
  }
  return evidence;
}

async function collectEvidence({
  runtime,
  dimensions,
  usearchBinaryPath,
  repoRoot,
  runDemo,
  env,
  log,
}) {
  log(`configured providers: ready (dimensions=${String(dimensions)})`);
  return runDemo({
    repoRoot,
    executionMode: CLEAN_CHECKOUT_EXECUTION_MODES.acceptance,
    gatewayConfig: runtime.gatewayConfig,
    embeddingModelId: runtime.embeddingModelId,
    answerModelId: runtime.answerModelId,
    embeddingDimensions: dimensions,
    usearchBinaryPath,
    env,
  });
}

function emitAcceptanceAndEnforce({ evidence, log, fail }) {
  const contractFailures = validateEvidenceContract(evidence);
  const redactionFailures = evidenceRedactionFailures(evidence);
  const acceptance = evaluateAcceptanceCriteria(evidence);
  log("Acceptance report:");
  for (const line of renderAcceptanceReport(evidence)) {
    log(`  ${line}`);
  }
  if (
    evidence.executionMode !== CLEAN_CHECKOUT_EXECUTION_MODES.acceptance ||
    evidence.acceptanceEligible !== true
  ) {
    return failClosed(fail, "evidence is not acceptance-eligible");
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
  requireRuntime = requireProvisionedUsearchRuntime,
  loadRuntime = loadAcceptanceRuntime,
  parseDimensions = requestedDimensions,
  detectPretty = shouldPrettyPrint,
  fail = throwFailure,
} = {}) {
  const outputs = resolveOutputs(stderr, stdout);
  const log = (message) => logLine(outputs.stderr, message);
  const resolvedEnv = resolveEnv(env);
  const dimensions = parseDimensions({ env: resolvedEnv, required: true, fail });
  const usearchBinaryPath = requireRuntime({ repoRoot, env: resolvedEnv, fail });
  const runtime = loadRuntime({ env: resolvedEnv, fail });
  log("USearch runtime: resolved (platform-pinned SHA-256 verified)");
  const evidence = await collectEvidence({
    runtime,
    runDemo,
    dimensions,
    usearchBinaryPath,
    repoRoot,
    env: resolvedEnv,
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
