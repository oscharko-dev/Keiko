import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalD12ArtifactBytes } from "./check-perf-evidence.mjs";
import { EXPECTED_NODE_BASELINE, EXPECTED_NPM_ENGINE } from "./check-runtime-toolchain.mjs";
import {
  buildCodingPerformanceEvidence,
  calibrationBudgets,
  CODING_PERFORMANCE_PROCEDURE,
  evaluateCodingPerformanceEvidence,
  validateCodingPerformanceSample,
} from "./coding-runtime-performance-evidence.mjs";
import { measureCodingRuntimeSample } from "./coding-runtime-performance-harness.mjs";
import {
  codingPerformanceSource,
  codingPerformanceToolchainDigest,
  dirtyCodingPerformanceInputs,
} from "./coding-runtime-performance-toolchain.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = resolve(import.meta.dirname, "..");
export const CODING_PERFORMANCE_FILES = Object.freeze({
  calibration: "docs/release/2952-coding-runtime-calibration.json",
  measurement: "docs/release/2952-coding-runtime-perf-evidence.json",
  budget: "scripts/coding-runtime-performance-budget.json",
});

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function codingPerformanceEnvironment(root = ROOT) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("native-macos-arm64-reference-required");
  const npmPackage = join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "package.json",
  );
  const npmVersion = JSON.parse(readFileSync(npmPackage, "utf8")).version;
  if (process.versions.node !== EXPECTED_NODE_BASELINE || npmVersion !== EXPECTED_NPM_ENGINE) {
    throw new Error("pinned-node-npm-toolchain-required");
  }
  const git = /[0-9]+(?:\.[0-9]+){2}/u.exec(
    execFileSync(resolveHostExecutable("git"), ["--version"], { encoding: "utf8" }),
  )?.[0];
  if (git === undefined) throw new Error("git-version-unavailable");
  const approval = JSON.parse(readFileSync(join(root, "portable-runtime-approvals.json"), "utf8"));
  const runtimeVersion = approval.sidecarRuntimes.find(
    (runtime) => runtime.name === "opencode-compatible",
  )?.upstream.version;
  const target = join(root, ".portable-sidecar-payloads", "macos-arm64");
  return {
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    cpuModelSha256: createHash("sha256")
      .update(JSON.stringify(cpus().map((cpu) => cpu.model)))
      .digest("hex"),
    nodeVersion: process.versions.node,
    npmVersion,
    gitVersion: git,
    runtimeVersion,
    payloadSha256: sha256(join(target, "opencode-compatible", "payload", "bin", "opencode")),
    secureReadSha256: sha256(join(target, "native", "keiko-secure-workspace-read")),
  };
}

export async function collectCodingPerformanceSamples(measure, progress = () => undefined) {
  const samples = [];
  const count = CODING_PERFORMANCE_PROCEDURE.batches * CODING_PERFORMANCE_PROCEDURE.samplesPerBatch;
  for (let index = 0; index < count + CODING_PERFORMANCE_PROCEDURE.warmups; index += 1) {
    const sample = await measure();
    validateCodingPerformanceSample(sample);
    if (index >= CODING_PERFORMANCE_PROCEDURE.warmups) samples.push(sample);
    progress({ completed: index + 1, total: count + CODING_PERFORMANCE_PROCEDURE.warmups });
  }
  return samples;
}

function readDocument(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function writeDocument(root, path, document) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), canonicalD12ArtifactBytes(document));
}

function assertClean(root) {
  if (dirtyCodingPerformanceInputs(root).length > 0)
    throw new Error("performance-subject-or-toolchain-is-dirty");
}

function assertOutputOwnership(root, calibrate) {
  if (
    calibrate &&
    [CODING_PERFORMANCE_FILES.calibration, CODING_PERFORMANCE_FILES.budget].some((path) =>
      existsSync(join(root, path)),
    )
  ) {
    throw new Error("calibration-is-immutable-remove-only-in-an-explicitly-reviewed-recalibration");
  }
}

function buildMeasuredDocument(input, calibrate, root) {
  if (calibrate) return buildCodingPerformanceEvidence({ ...input, role: "calibration" });
  const calibration = readDocument(root, CODING_PERFORMANCE_FILES.calibration);
  const budget = readDocument(root, CODING_PERFORMANCE_FILES.budget);
  const document = buildCodingPerformanceEvidence({
    ...input,
    role: "measurement",
    calibrationSha256: calibration.documentSha256,
  });
  const findings = evaluateCodingPerformanceEvidence(document, calibration, budget);
  if (findings.defects.length > 0)
    throw new Error(`untrustworthy-performance-measurement:${findings.defects.join(",")}`);
  for (const verdict of findings.verdicts)
    process.stderr.write(`[coding-performance] measured verdict: ${verdict}\n`);
  return document;
}

function compileMeasurementRuntime(root) {
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tests/e2e/servers/tsconfig.json",
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 120_000,
    },
  );
}

function measurementInputs(root) {
  assertClean(root);
  return {
    subject: codingPerformanceSource(root),
    measurementHarnessSha256: codingPerformanceToolchainDigest((path) =>
      readFileSync(join(root, path)),
    ),
    environment: codingPerformanceEnvironment(root),
  };
}

export function codingPerformanceFailureSummary(stage, error) {
  const allowed = new Set(["inputs", "compilation", "samples", "stability", "document", "write"]);
  const phase = allowed.has(stage) ? stage : "unknown";
  const diagnosticSha256 = createHash("sha256")
    .update(error instanceof Error ? error.message : typeof error)
    .digest("hex");
  return `measurement-${phase}-failed diagnosticSha256=${diagnosticSha256}`;
}

export async function produceCodingPerformanceEvidence({ calibrate = false } = {}) {
  const root = ROOT;
  let stage = "inputs";
  try {
    assertOutputOwnership(root, calibrate);
    const inputs = measurementInputs(root);
    stage = "compilation";
    compileMeasurementRuntime(root);
    stage = "samples";
    const samples = await collectCodingPerformanceSamples(
      measureCodingRuntimeSample,
      ({ completed, total }) => {
        process.stdout.write(
          `[coding-performance] samples ${String(completed)}/${String(total)}\n`,
        );
      },
    );
    stage = "stability";
    if (!isDeepStrictEqual(inputs, measurementInputs(root)))
      throw new Error("performance-inputs-changed-during-measurement");
    stage = "document";
    const document = buildMeasuredDocument(
      { ...inputs, samples, measuredAtIso: new Date().toISOString() },
      calibrate,
      root,
    );
    stage = "write";
    writeDocument(
      root,
      calibrate ? CODING_PERFORMANCE_FILES.calibration : CODING_PERFORMANCE_FILES.measurement,
      document,
    );
    if (calibrate)
      writeDocument(root, CODING_PERFORMANCE_FILES.budget, calibrationBudgets(document));
    return document;
  } catch (error) {
    throw new Error(codingPerformanceFailureSummary(stage, error), { cause: error });
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--calibrate")) {
    process.stderr.write("usage: coding-runtime-performance-producer.mjs [--calibrate]\n");
    process.exitCode = 2;
  } else {
    try {
      await produceCodingPerformanceEvidence({ calibrate: args[0] === "--calibrate" });
      process.stdout.write("coding-runtime performance evidence: WRITTEN\n");
    } catch (error) {
      process.stderr.write(
        `[coding-performance] generation failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
      );
      process.exitCode = 1;
    }
  }
}
