#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { assertD12BundleMeasurementFingerprint } from "./build-d12-bundle-input.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import {
  canonicalD12ArtifactBytes,
  computeD12RawInputSha256,
  computePerformanceSubjectDigest,
  computePerformanceSubjectDigestAtCommit,
  deriveD12CapRawArtifact,
  deriveD12CommonRawArtifact,
  evaluateD12Comparison,
  evaluateEditorEvidence,
  evaluateFreshness,
  isPerformanceSubjectPath,
  listDirtyPerformanceSubjectPaths,
} from "./check-perf-evidence.mjs";
import { computeD12MeasurementToolchainDigest } from "./d12-measurement-toolchain.mjs";

const BASELINE_COMMIT = "18750d079e2a61c7d7044f3f6ec977a104b9884f";
const AGGREGATE_RULE = "median-run-level-percentile";
const MIN_PERF_RUNS = 10;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const REVISIONS = ["baseline", "candidate"];
const VALUE_OPTIONS = new Set([
  "--manifest",
  "--baseline-bundle",
  "--candidate-bundle",
  "--baseline-root",
  "--candidate-root",
  "--output",
]);
const MEDIAN_FIELDS = [
  "b1Bytes",
  "b2Bytes",
  "b3Bytes",
  "b10Bytes",
  "b4P50Ms",
  "b4P95Ms",
  "b5IdleDebugP95Ms",
  "b6P75Ms",
  "b11PeakBytes",
  "b11ResidualBytes",
];

function parseNullSeparated(value) {
  return value.split("\0").filter((item) => item.length > 0);
}

export function listExactDirtyPerformanceSubjectPaths(root) {
  const tracked = listDirtyPerformanceSubjectPaths(root);
  const untracked = parseNullSeparated(
    execFileSync(
      resolveHostExecutable("git"),
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  ).filter((path) => isPerformanceSubjectPath(path));
  return [...new Set([...tracked, ...untracked])].sort(compareStrings);
}

function checkoutHead(root) {
  return execFileSync(resolveHostExecutable("git"), ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

export function commitIsAncestor(root, ancestor, descendant) {
  try {
    execFileSync(
      resolveHostExecutable("git"),
      ["merge-base", "--is-ancestor", ancestor, descendant],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  throw new Error(`D12 performance comparison: ${message}`);
}

function object(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  const record = object(value, label);
  const actual = Object.keys(record).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label} contains a non-canonical or unknown field`);
  }
  return record;
}

function finiteSamples(value, minimum, label) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(`${label} requires at least ${minimum} raw samples`);
  }
  if (
    value.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0)
  ) {
    fail(`${label} contains a non-positive or invalid sample`);
  }
  return [...value];
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function positiveFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive finite number`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentileValue / 100) * sorted.length);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function validateWarmUp(value) {
  const warmUp = object(value, "warm-up metadata");
  return {
    runs: positiveInteger(warmUp.runs, "warm-up runs"),
    procedure: requiredString(warmUp.procedure, "warm-up procedure"),
  };
}

function validateProvisioningCommand(value, expectedKeys, label) {
  const provisioning = assertExactKeys(value, expectedKeys, label);
  if (provisioning.command !== "npm") fail("dependency provisioning command must be npm");
  if (!isDeepStrictEqual(provisioning.args, ["ci", "--ignore-scripts"])) {
    fail("dependency provisioning arguments must equal npm ci --ignore-scripts");
  }
  return provisioning;
}

function validateLockfileSha256(value, label) {
  if (!SHA_256.test(value ?? "")) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function validateBundleDependencyProvisioning(value) {
  const provisioning = validateProvisioningCommand(
    value,
    ["args", "command", "lockfileSha256"],
    "bundle dependency provisioning",
  );
  return {
    command: "npm",
    args: ["ci", "--ignore-scripts"],
    lockfileSha256: validateLockfileSha256(
      provisioning.lockfileSha256,
      "bundle dependency provisioning lockfileSha256",
    ),
  };
}

function validateDependencyProvisioning(value) {
  const provisioning = validateProvisioningCommand(
    value,
    ["args", "command", "lockfileSha256ByRevision"],
    "dependency provisioning",
  );
  const digests = assertExactKeys(
    provisioning.lockfileSha256ByRevision,
    ["baseline", "candidate"],
    "dependency provisioning lockfileSha256ByRevision",
  );
  return {
    command: "npm",
    args: ["ci", "--ignore-scripts"],
    lockfileSha256ByRevision: Object.fromEntries(
      REVISIONS.map((revision) => [
        revision,
        validateLockfileSha256(
          digests[revision],
          `dependency provisioning ${revision} lockfileSha256`,
        ),
      ]),
    ),
  };
}

function validateHardware(value) {
  const hardware = object(value, "provenance hardware");
  return {
    cpuModel: requiredString(hardware.cpuModel, "provenance hardware cpuModel"),
    logicalCores: positiveInteger(hardware.logicalCores, "provenance hardware logicalCores"),
    memoryBytes: positiveInteger(hardware.memoryBytes, "provenance hardware memoryBytes"),
  };
}

function validateProvenance(value, warmUp) {
  const provenance = object(value, "provenance");
  if (provenance.platform !== "linux") fail("provenance platform must be linux");
  if (provenance.nodeVersion !== "24.18.0") fail("provenance Node.js version must be 24.18.0");
  if (provenance.npmVersion !== "11.16.0") fail("provenance npm version must be 11.16.0");
  if (!SHA_256.test(provenance.lockfileSha256 ?? "")) {
    fail("provenance lockfileSha256 must be a lowercase SHA-256 digest");
  }
  return {
    platform: "linux",
    architecture: requiredString(provenance.architecture, "provenance architecture"),
    osRelease: requiredString(provenance.osRelease, "provenance osRelease"),
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    lockfileSha256: provenance.lockfileSha256,
    playwrightVersion: requiredString(provenance.playwrightVersion, "provenance playwrightVersion"),
    chromiumVersion: requiredString(provenance.chromiumVersion, "provenance chromiumVersion"),
    zlibVersion: requiredString(provenance.zlibVersion, "provenance zlibVersion"),
    hardware: validateHardware(provenance.hardware),
    warmUp,
  };
}

function bundleRuntimeFromProvenance(provenance) {
  return {
    architecture: provenance.architecture,
    nodeVersion: provenance.nodeVersion,
    npmVersion: provenance.npmVersion,
    osRelease: provenance.osRelease,
    platform: provenance.platform,
    zlibVersion: provenance.zlibVersion,
  };
}

function validateBundleRuntime(value, label) {
  const runtime = assertExactKeys(
    value,
    ["architecture", "nodeVersion", "npmVersion", "osRelease", "platform", "zlibVersion"],
    `${label} bundle runtime`,
  );
  if (runtime.platform !== "linux") fail(`${label} bundle runtime platform must be linux`);
  if (runtime.nodeVersion !== "24.18.0") {
    fail(`${label} bundle runtime Node.js version must be 24.18.0`);
  }
  if (runtime.npmVersion !== "11.16.0") {
    fail(`${label} bundle runtime npm version must be 11.16.0`);
  }
  return {
    architecture: requiredString(runtime.architecture, `${label} bundle runtime architecture`),
    nodeVersion: "24.18.0",
    npmVersion: "11.16.0",
    osRelease: requiredString(runtime.osRelease, `${label} bundle runtime osRelease`),
    platform: "linux",
    zlibVersion: requiredString(runtime.zlibVersion, `${label} bundle runtime zlibVersion`),
  };
}

function validateCommit(value, expected, label) {
  if (!FULL_COMMIT.test(value ?? "")) fail(`${label} commit must be a full lowercase commit SHA`);
  if (value !== expected) fail(`${label} commit ${value} does not match ${expected}`);
}

function validateBundleBindings(bundle, expectedBindings, label) {
  validateCommit(
    bundle.producerCommit,
    expectedBindings.producerCommit,
    `${label} bundle producer`,
  );
  if (bundle.sourceTreeSha256 !== expectedBindings.sourceTreeSha256) {
    fail(`${label} bundle sourceTreeSha256 does not match its checkout`);
  }
  if (bundle.measurementHarnessSha256 !== expectedBindings.measurementHarnessSha256) {
    fail(`${label} bundle measurementHarnessSha256 differs from the common toolchain`);
  }
  const provisioning = validateBundleDependencyProvisioning(bundle.dependencyProvisioning);
  if (provisioning.lockfileSha256 !== expectedBindings.lockfileSha256) {
    fail(`${label} bundle dependency lockfile differs from the current checkout`);
  }
  const runtime = validateBundleRuntime(bundle.runtime, label);
  if (!isDeepStrictEqual(runtime, expectedBindings.runtime)) {
    fail(`${label} bundle runtime differs from the common browser provenance`);
  }
  return { provisioning, runtime };
}

function readBundleBudgetMeasurements(bundle, label) {
  const b1 = assertExactKeys(bundle.b1, ["monacoMarkersInFirstLoad", "ok"], `${label} bundle B1`);
  const markers = nonNegativeInteger(b1.monacoMarkersInFirstLoad, `${label} bundle B1 markers`);
  if (b1.ok !== true || markers !== 0) fail(`${label} bundle B1 does not prove zero editor bytes`);
  const b2 = assertExactKeys(bundle.b2, ["ok", "shipsTotalBytes"], `${label} bundle B2`);
  const b3 = assertExactKeys(bundle.b3, ["largestWorkerBytes", "ok"], `${label} bundle B3`);
  const b10 = assertExactKeys(
    bundle.b10,
    ["ceilingBytes", "fileCount", "ok", "totalGzipBytes"],
    `${label} bundle B10`,
  );
  if (b2.ok !== true || b3.ok !== true || b10.ok !== true) {
    fail(`${label} bundle evidence contains a failed byte budget`);
  }
  positiveInteger(b10.fileCount, `${label} bundle B10 fileCount`);
  const b10Bytes = nonNegativeInteger(b10.totalGzipBytes, `${label} bundle B10 bytes`);
  const b10Ceiling = positiveInteger(b10.ceilingBytes, `${label} bundle B10 ceilingBytes`);
  if (b10Bytes > b10Ceiling) fail(`${label} bundle B10 bytes exceed its recorded ceiling`);
  const bytes = {
    b1: 0,
    b2: nonNegativeInteger(b2.shipsTotalBytes, `${label} bundle B2 bytes`),
    b3: nonNegativeInteger(b3.largestWorkerBytes, `${label} bundle B3 bytes`),
    b10: b10Bytes,
  };
  return {
    b1: { monacoMarkersInFirstLoad: markers, ok: true },
    b2: { shipsTotalBytes: bytes.b2, ok: true },
    b3: { largestWorkerBytes: bytes.b3, ok: true },
    b10: {
      ceilingBytes: b10Ceiling,
      fileCount: b10.fileCount,
      ok: true,
      totalGzipBytes: bytes.b10,
    },
    bytes,
  };
}

function readBundleBytes(value, expectedCommit, expectedBindings, label) {
  const bundle = assertExactKeys(
    value,
    [
      "b1",
      "b10",
      "b2",
      "b3",
      "commit",
      "dependencyProvisioning",
      "measurementHarnessSha256",
      "measurementSha256",
      "producerCommit",
      "runtime",
      "sourceTreeSha256",
    ],
    `${label} bundle evidence`,
  );
  assertD12BundleMeasurementFingerprint(bundle);
  validateCommit(bundle.commit, expectedCommit, `${label} bundle evidence`);
  const bindings = validateBundleBindings(bundle, expectedBindings, label);
  if (!SHA_256.test(bundle.measurementSha256 ?? "")) {
    fail(`${label} bundle evidence measurementSha256 must be a lowercase SHA-256 digest`);
  }
  const measurements = readBundleBudgetMeasurements(bundle, label);
  return {
    ...measurements,
    commit: bundle.commit,
    dependencyProvisioning: bindings.provisioning,
    measurementHarnessSha256: bundle.measurementHarnessSha256,
    measurementSha256: bundle.measurementSha256,
    producerCommit: bundle.producerCommit,
    runtime: bindings.runtime,
    sourceTreeSha256: bundle.sourceTreeSha256,
  };
}

function validateMeasuredAt(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`${label} measuredAtIso must be parseable`);
  }
  return value;
}

function buildB4(raw, perfRuns, label) {
  const metric = object(raw.b4ColdStartMs, `${label} B4`);
  const samples = finiteSamples(metric.samples, perfRuns, `${label} B4`);
  return { samples, p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

function baselineB5(raw, perfRuns, label) {
  const metric = object(raw.d12BaselineMeasuredWork, `${label} baseline measured-work B5`);
  if (metric.captured !== true || metric.traceCaptured !== true) {
    fail(`${label} baseline measured-work trace was not captured`);
  }
  const samples = finiteSamples(
    metric.processingSamples,
    perfRuns,
    `${label} baseline measured-work B5`,
  );
  const matchedEvents = buildMatchedInputEvents(metric, samples, `${label} baseline measured-work`);
  return {
    captured: true,
    expectedSampleCount: matchedEvents.expectedSampleCount,
    samples,
    p95: percentile(samples, 95),
    longTaskCount: nonNegativeInteger(metric.longTaskCount, `${label} B5 longTaskCount`),
    matchedInputEventCounts: matchedEvents.matchedInputEventCounts,
    maxLongTaskMs: nonNegativeInteger(metric.maxLongTaskMs, `${label} B5 maxLongTaskMs`),
    processingSamples: [...samples],
    totalMatchedInputEvents: matchedEvents.totalMatchedInputEvents,
    traceCaptured: true,
  };
}

function buildMatchedInputEvents(metric, samples, label) {
  const expectedSampleCount = positiveInteger(
    metric.expectedSampleCount,
    `${label} B5 expectedSampleCount`,
  );
  if (samples.length !== expectedSampleCount) fail(`${label} B5 sample count is invalid`);
  const matchedInputEventCounts = finiteSamples(
    metric.matchedInputEventCounts,
    expectedSampleCount,
    `${label} B5 matched input events`,
  ).map((count) => positiveInteger(count, `${label} B5 matched input event count`));
  if (matchedInputEventCounts.length !== expectedSampleCount) {
    fail(`${label} B5 matched input event count is invalid`);
  }
  const totalMatchedInputEvents = matchedInputEventCounts.reduce(
    (total, count) => total + count,
    0,
  );
  if (metric.totalMatchedInputEvents !== totalMatchedInputEvents) {
    fail(`${label} B5 totalMatchedInputEvents is invalid`);
  }
  return { expectedSampleCount, matchedInputEventCounts, totalMatchedInputEvents };
}

function candidateB5(raw, perfRuns, label) {
  const metric = object(raw.b5IdleDebugSession, `${label} candidate idle-debug B5`);
  if (metric.captured !== true || metric.traceCaptured !== true) {
    fail(`${label} candidate idle-debug measured-work trace was not captured`);
  }
  const samples = finiteSamples(
    metric.processingSamples,
    perfRuns,
    `${label} candidate idle-debug B5`,
  );
  const status = metric.sessionStatus;
  if (status !== "paused" && status !== "running") fail(`${label} candidate session is not active`);
  const outputAcceptedBytes = nonNegativeInteger(
    metric.outputAcceptedBytes,
    `${label} B5 outputAcceptedBytes`,
  );
  if (outputAcceptedBytes !== 0) fail(`${label} candidate idle-debug accepted visible output`);
  const matchedEvents = buildMatchedInputEvents(metric, samples, label);
  return {
    attempted: true,
    budgetMax: positiveFinite(metric.budgetMax, `${label} B5 budgetMax`),
    captured: true,
    expectedSampleCount: matchedEvents.expectedSampleCount,
    idleIntervalMs: positiveFinite(metric.idleIntervalMs, `${label} B5 idleIntervalMs`),
    samples,
    p95: percentile(samples, 95),
    longTaskCount: nonNegativeInteger(metric.longTaskCount, `${label} B5 longTaskCount`),
    matchedInputEventCounts: matchedEvents.matchedInputEventCounts,
    maxLongTaskMs: nonNegativeInteger(metric.maxLongTaskMs, `${label} B5 maxLongTaskMs`),
    processingSamples: [...samples],
    traceCaptured: true,
    outputAcceptedBytes,
    sessionStatus: status,
    totalMatchedInputEvents: matchedEvents.totalMatchedInputEvents,
  };
}

function buildB6(raw, perfRuns, label) {
  const metric = object(raw.b6InteractionMs, `${label} B6`);
  if (metric.captured !== true) fail(`${label} B6 was not captured`);
  const samples = finiteSamples(metric.samples, perfRuns, `${label} B6`);
  return { samples, p75: percentile(samples, 75) };
}

function buildB11(raw, label) {
  const metric = object(raw.b11Memory, `${label} B11`);
  if (metric.supported !== true) fail(`${label} B11 was not measured`);
  const b11 = {
    baselineBytes: nonNegativeInteger(metric.baselineBytes, `${label} B11 baselineBytes`),
    peakBytes: nonNegativeInteger(metric.peakBytes, `${label} B11 peakBytes`),
    residualBytes: nonNegativeInteger(metric.residualBytes, `${label} B11 residualBytes`),
    cycles: positiveInteger(metric.cycles, `${label} B11 cycles`),
  };
  if (b11.peakBytes < b11.baselineBytes) fail(`${label} B11 peakBytes is below baselineBytes`);
  return b11;
}

function nonNegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative finite number`);
  }
  return value;
}

function createRawInput(value) {
  return {
    artifact: value,
    schemaVersion: "2",
    sha256: computeD12RawInputSha256(value),
  };
}

function validateCapArtifactBindings(raw, record, label) {
  if (raw.sourceTreeSha256 !== record.sourceTreeSha256) {
    fail(`${label} cap evidence sourceTreeSha256 does not match its record`);
  }
  if (raw.measurementHarnessSha256 !== record.measurementHarnessSha256) {
    fail(`${label} cap evidence measurementHarnessSha256 does not match its record`);
  }
  if (!isDeepStrictEqual(raw.provenance, record.provenance)) {
    fail(`${label} cap evidence provenance does not match its record`);
  }
}

function validateCapRecordBindings(record, run, label) {
  if (
    record.checkoutHead !== run.checkoutHead ||
    record.sourceTreeSha256 !== run.sourceTreeSha256 ||
    record.measurementHarnessSha256 !== run.measurementHarnessSha256 ||
    !isDeepStrictEqual(record.provenance, run.provenance)
  ) {
    fail(`${label} cap evidence is not bound to its candidate repetition`);
  }
}

function validateCapMeasuredAt(raw, record, label) {
  const measuredAtIso = validateMeasuredAt(raw.measuredAtIso, `${label} cap evidence`);
  const measuredAt = Date.parse(measuredAtIso);
  if (
    measuredAt < Date.parse(record.startedAtIso) ||
    measuredAt > Date.parse(record.completedAtIso)
  ) {
    fail(`${label} cap evidence measuredAtIso falls outside its execution interval`);
  }
  return measuredAtIso;
}

function buildCapScenarios(rawValue, record, run, commit, label) {
  const raw = object(rawValue, `${label} cap evidence`);
  validateCommit(raw.commit, commit, `${label} cap evidence`);
  validateCapArtifactBindings(raw, record, label);
  validateCapRecordBindings(record, run, label);
  const measuredAtIso = validateCapMeasuredAt(raw, record, label);
  const derived = deriveD12CapRawArtifact(raw, { label });
  if (derived.failures.length > 0) fail(derived.failures.join("; "));
  const normalized = {
    artifactSha256: record.artifactSha256,
    commit,
    completedAtIso: record.completedAtIso,
    measuredAtIso,
    measurementHarnessSha256: record.measurementHarnessSha256,
    outputFlood: derived.outputFlood,
    sequence: record.sequence,
    sourceTreeSha256: record.sourceTreeSha256,
    startedAtIso: record.startedAtIso,
    stoppedProjection: derived.stoppedProjection,
  };
  return {
    ...normalized,
    rawInput: createRawInput(raw),
  };
}

function copyProvenance(provenance) {
  return {
    ...provenance,
    hardware: { ...provenance.hardware },
    warmUp: { ...provenance.warmUp },
  };
}

function buildCommonRawInput(raw) {
  return createRawInput(raw);
}

function validateRunBinding(raw, run, revision, commit, label) {
  validateCommit(raw.commit, commit, label);
  if (raw.sourceTreeSha256 !== run.sourceTreeSha256) {
    fail(`${label} sourceTreeSha256 does not match its execution record`);
  }
  if (raw.measurementHarnessSha256 !== run.measurementHarnessSha256) {
    fail(`${label} measurementHarnessSha256 does not match its execution record`);
  }
  if (!isDeepStrictEqual(raw.provenance, run.provenance)) {
    fail(`${label} provenance does not match its execution record`);
  }
  const measuredAt = Date.parse(validateMeasuredAt(raw.measuredAtIso, label));
  if (
    measuredAt < Date.parse(run.startedAtIso) ||
    measuredAt > Date.parse(run.commonCompletedAtIso)
  ) {
    fail(`${label} measuredAtIso falls outside its execution interval`);
  }
  if (run.checkoutHead !== commit) fail(`${label} checkout HEAD does not match ${revision} commit`);
}

function buildCommonMetrics(raw, revision, bytes, perfRuns, label) {
  return {
    bytes: { ...bytes },
    b4: buildB4(raw, perfRuns, label),
    b5IdleDebug:
      revision === "baseline"
        ? baselineB5(raw, perfRuns, label)
        : candidateB5(raw, perfRuns, label),
    b6: buildB6(raw, perfRuns, label),
    b11: buildB11(raw, label),
  };
}

function buildMeasurement(rawValue, capRawValue, run, revision, commit, { bytes, warmUp, label }) {
  const raw = object(rawValue, label);
  validateRunBinding(raw, run, revision, commit, label);
  const perfRuns = finiteSamples(raw.b4ColdStartMs?.samples, MIN_PERF_RUNS, `${label} B4`).length;
  const provenance = validateProvenance(raw.provenance, warmUp);
  const metrics = buildCommonMetrics(raw, revision, bytes, perfRuns, label);
  const derived = deriveD12CommonRawArtifact(raw, {
    bytes,
    label,
    revision,
    warmUp,
  });
  if (derived.failures.length > 0) fail(derived.failures.join("; "));
  if (
    !isDeepStrictEqual(derived.metrics, metrics) ||
    !isDeepStrictEqual(derived.provenance, provenance)
  ) {
    fail(`${label} producer derivation differs from the independent checker derivation`);
  }
  return {
    complete: true,
    commit,
    scenario: revision === "baseline" ? "baseline-editor" : "idle-debug-session",
    measuredAtIso: raw.measuredAtIso,
    sequence: run.sequence,
    startedAtIso: run.startedAtIso,
    commonCompletedAtIso: run.commonCompletedAtIso,
    completedAtIso: run.completedAtIso,
    sourceTreeSha256: run.sourceTreeSha256,
    measurementHarnessSha256: run.measurementHarnessSha256,
    artifactSha256: run.artifactSha256,
    perfRuns,
    provenance: copyProvenance(provenance),
    rawInput: buildCommonRawInput(raw),
    metrics: {
      ...metrics,
      ...(revision === "candidate"
        ? {
            capScenarios: buildCapScenarios(capRawValue, run.capEvidence, run, commit, label),
          }
        : {}),
    },
  };
}

function validateTimestamp(value, label) {
  const timestamp = validateMeasuredAt(value, label);
  return { timestamp, milliseconds: Date.parse(timestamp) };
}

function validateBindingIdentity(record, label) {
  if (!SHA_256.test(record.artifactSha256 ?? "")) fail(`${label} artifactSha256 is invalid`);
  if (!SHA_256.test(record.sourceTreeSha256 ?? "")) fail(`${label} sourceTreeSha256 is invalid`);
  if (!SHA_256.test(record.measurementHarnessSha256 ?? "")) {
    fail(`${label} measurementHarnessSha256 is invalid`);
  }
  if (!FULL_COMMIT.test(record.checkoutHead ?? "")) fail(`${label} checkoutHead is invalid`);
}

function validateRunInterval(run, label) {
  const started = validateTimestamp(run.startedAtIso, `${label} startedAtIso`);
  const completed = validateTimestamp(run.completedAtIso, `${label} completedAtIso`);
  const commonCompleted = validateTimestamp(
    run.commonCompletedAtIso,
    `${label} commonCompletedAtIso`,
  );
  if (completed.milliseconds <= started.milliseconds) {
    fail(`${label} completedAtIso must be after startedAtIso`);
  }
  if (
    commonCompleted.milliseconds <= started.milliseconds ||
    commonCompleted.milliseconds > completed.milliseconds
  ) {
    fail(`${label} commonCompletedAtIso is outside the run interval`);
  }
  return { commonCompleted, completed, started };
}

function validateRunRecord(value, label) {
  const run = object(value, label);
  const interval = validateRunInterval(run, label);
  validateBindingIdentity(run, label);
  return {
    artifact: requiredString(run.artifact, `${label} artifact`),
    artifactSha256: run.artifactSha256,
    checkoutHead: run.checkoutHead,
    commonCompletedAtIso: interval.commonCompleted.timestamp,
    completedAtIso: interval.completed.timestamp,
    measurementHarnessSha256: run.measurementHarnessSha256,
    provenance: object(run.provenance, `${label} provenance`),
    sequence: positiveInteger(run.sequence, `${label} sequence`),
    sourceTreeSha256: run.sourceTreeSha256,
    startedAtIso: interval.started.timestamp,
  };
}

function validateCapRecord(value, label) {
  const record = object(value, label);
  const started = validateTimestamp(record.startedAtIso, `${label} startedAtIso`);
  const completed = validateTimestamp(record.completedAtIso, `${label} completedAtIso`);
  if (completed.milliseconds <= started.milliseconds) {
    fail(`${label} completedAtIso must be after startedAtIso`);
  }
  validateBindingIdentity(record, label);
  return {
    artifact: requiredString(record.artifact, `${label} artifact`),
    artifactSha256: record.artifactSha256,
    checkoutHead: record.checkoutHead,
    completedAtIso: completed.timestamp,
    measurementHarnessSha256: record.measurementHarnessSha256,
    provenance: object(record.provenance, `${label} provenance`),
    sequence: positiveInteger(record.sequence, `${label} sequence`),
    sourceTreeSha256: record.sourceTreeSha256,
    startedAtIso: started.timestamp,
  };
}

function validateCandidateCapOrder(run, label) {
  const cap = run.capEvidence;
  if (cap.sequence !== run.sequence) fail(`${label} sequence does not match candidate run`);
  if (Date.parse(cap.startedAtIso) < Date.parse(run.commonCompletedAtIso)) {
    fail(`${label} started before the common measurement completed`);
  }
  if (cap.completedAtIso !== run.completedAtIso) {
    fail(`${label} completion does not close the candidate run interval`);
  }
}

function validateManifestRepetition(entryValue, index, state) {
  const entry = object(entryValue, `order manifest repetition ${index + 1}`);
  const order = entry.order;
  if (
    !Array.isArray(order) ||
    !isDeepStrictEqual([...order].sort(compareStrings), [...REVISIONS])
  ) {
    fail(`order manifest repetition ${index + 1} must order baseline and candidate exactly once`);
  }
  if (order[0] === state.priorFirst) {
    fail(`order manifest repetition ${index + 1} does not alternate`);
  }
  const normalizedEntry = { order: [...order] };
  let priorCompleted = state.priorCompleted;
  let expectedSequence = state.expectedSequence;
  for (const revision of order) {
    const run = validateRunRecord(entry[revision], `repetition ${index + 1} ${revision}`);
    expectedSequence += 1;
    if (run.sequence !== expectedSequence) {
      fail(`repetition ${index + 1} ${revision} sequence does not match actual order`);
    }
    if (revision === "candidate") {
      run.capEvidence = validateCapRecord(
        entry[revision].capEvidence,
        `repetition ${index + 1} candidate cap evidence`,
      );
      validateCandidateCapOrder(run, `repetition ${index + 1} candidate cap evidence`);
    } else if (run.commonCompletedAtIso !== run.completedAtIso) {
      fail(`repetition ${index + 1} baseline run contains unbound post-common execution`);
    }
    if (Date.parse(run.startedAtIso) < priorCompleted) {
      fail(`repetition ${index + 1} ${revision} overlaps or precedes the prior run`);
    }
    priorCompleted = Date.parse(run.completedAtIso);
    if (state.seen.has(run.artifact)) fail(`order manifest reuses raw input ${run.artifact}`);
    state.seen.add(run.artifact);
    normalizedEntry[revision] = run;
  }
  return {
    entry: normalizedEntry,
    expectedSequence,
    priorCompleted,
    priorFirst: order[0],
    seen: state.seen,
  };
}

function validateOrderManifest(value) {
  const manifest = object(value, "order manifest");
  if (manifest.schemaVersion !== "4") fail("order manifest schemaVersion must be 4");
  if (!Array.isArray(manifest.repetitions) || manifest.repetitions.length !== 3) {
    fail("order manifest must contain exactly three paired repetitions");
  }
  const warmUp = validateWarmUp(manifest.warmUp);
  const dependencyProvisioning = validateDependencyProvisioning(manifest.dependencyProvisioning);
  const normalized = [];
  let state = {
    expectedSequence: 0,
    priorCompleted: -Infinity,
    priorFirst: undefined,
    seen: new Set(),
  };
  for (const [index, entryValue] of manifest.repetitions.entries()) {
    state = validateManifestRepetition(entryValue, index, state);
    normalized.push(state.entry);
  }
  return { dependencyProvisioning, repetitions: normalized, warmUp };
}

function summarize(measurement) {
  const metrics = measurement.metrics;
  return {
    b1Bytes: metrics.bytes.b1,
    b2Bytes: metrics.bytes.b2,
    b3Bytes: metrics.bytes.b3,
    b10Bytes: metrics.bytes.b10,
    b4P50Ms: metrics.b4.p50,
    b4P95Ms: metrics.b4.p95,
    b5IdleDebugP95Ms: metrics.b5IdleDebug.p95,
    b5IdleDebugLongTaskCount: metrics.b5IdleDebug.longTaskCount,
    b5IdleDebugMaxLongTaskMs: metrics.b5IdleDebug.maxLongTaskMs,
    b6P75Ms: metrics.b6.p75,
    b11PeakBytes: metrics.b11.peakBytes,
    b11ResidualBytes: metrics.b11.residualBytes,
  };
}

function aggregate(repetitions, revision) {
  const summaries = repetitions.map((repetition) => summarize(repetition[revision]));
  const result = {};
  for (const field of MEDIAN_FIELDS) result[field] = median(summaries.map((item) => item[field]));
  result.b5IdleDebugLongTaskCount = summaries.reduce(
    (total, item) => total + item.b5IdleDebugLongTaskCount,
    0,
  );
  result.b5IdleDebugMaxLongTaskMs = Math.max(
    ...summaries.map((item) => item.b5IdleDebugMaxLongTaskMs),
  );
  return result;
}

function deltas(baseline, candidate) {
  return Object.fromEntries(
    Object.keys(baseline).map((field) => [field, candidate[field] - baseline[field]]),
  );
}

function buildRepetition(entry, index, context) {
  const measurements = {};
  for (const revision of REVISIONS) {
    const run = entry[revision];
    if (run.checkoutHead !== context.expectedHeads[revision]) {
      fail(`repetition ${index + 1} ${revision} checkout HEAD does not match live HEAD`);
    }
    if (run.sourceTreeSha256 !== context.expectedSourceDigests[revision]) {
      fail(`repetition ${index + 1} ${revision} sourceTreeSha256 does not match live checkout`);
    }
    if (run.measurementHarnessSha256 !== context.referenceHarness) {
      fail(`repetition ${index + 1} ${revision} measurement harness digest differs`);
    }
    if (!isDeepStrictEqual(run.provenance, context.referenceProvenanceByRevision[revision])) {
      fail(`repetition ${index + 1} ${revision} provenance differs`);
    }
    measurements[revision] = buildMeasurement(
      context.rawInputs.get(run.artifact),
      revision === "candidate" ? context.rawInputs.get(run.capEvidence.artifact) : undefined,
      run,
      revision,
      context.commits[revision],
      {
        bytes: context.bytes[revision],
        warmUp: context.warmUp,
        label: `repetition ${index + 1} ${revision}`,
      },
    );
  }
  return { order: [...entry.order], ...measurements };
}

function readComparisonBundleBytes({
  baselineBundle,
  candidateBundle,
  commits,
  expectedSourceDigests,
  lockfileSha256ByRevision,
  referenceHarness,
  referenceProvenance,
}) {
  const bindings = (revision, sourceTreeSha256) => ({
    lockfileSha256: lockfileSha256ByRevision[revision],
    measurementHarnessSha256: referenceHarness,
    producerCommit: commits.candidate,
    runtime: bundleRuntimeFromProvenance(referenceProvenance),
    sourceTreeSha256,
  });
  return {
    baseline: readBundleBytes(
      baselineBundle,
      commits.baseline,
      bindings("baseline", expectedSourceDigests.baseline),
      "baseline",
    ),
    candidate: readBundleBytes(
      candidateBundle,
      commits.candidate,
      bindings("candidate", expectedSourceDigests.candidate),
      "candidate",
    ),
  };
}

function buildComparisonContext({
  bundles,
  entries,
  expectedHeads,
  expectedSourceDigests,
  rawInputs,
  warmUp,
}) {
  const referenceProvenanceByRevision = Object.fromEntries(
    REVISIONS.map((revision) => [revision, entries[0][revision].provenance]),
  );
  return {
    bytes: {
      baseline: bundles.baseline.bytes,
      candidate: bundles.candidate.bytes,
    },
    commits: { baseline: BASELINE_COMMIT, candidate: expectedHeads.candidate },
    expectedHeads,
    expectedSourceDigests,
    rawInputs,
    referenceHarness: entries[0].baseline.measurementHarnessSha256,
    referenceProvenanceByRevision,
    warmUp,
  };
}

function provenanceWithoutLockfile(provenance) {
  const shared = { ...provenance };
  delete shared.lockfileSha256;
  return shared;
}

function validateRevisionProvenance(entries, dependencyProvisioning) {
  const references = Object.fromEntries(
    REVISIONS.map((revision) => [revision, entries[0][revision].provenance]),
  );
  for (const revision of REVISIONS) {
    if (
      references[revision].lockfileSha256 !==
      dependencyProvisioning.lockfileSha256ByRevision[revision]
    ) {
      fail(`${revision} dependency provisioning lockfile digest differs from measured provenance`);
    }
  }
  if (
    !isDeepStrictEqual(
      provenanceWithoutLockfile(references.baseline),
      provenanceWithoutLockfile(references.candidate),
    )
  ) {
    fail("baseline and candidate provenance differs outside revision-specific lockfile digest");
  }
}

function validateManifestLockfiles(dependencyProvisioning, expectedLockfileSha256ByRevision) {
  if (
    !isDeepStrictEqual(
      dependencyProvisioning.lockfileSha256ByRevision,
      expectedLockfileSha256ByRevision,
    )
  ) {
    fail("dependency provisioning lockfile digests differ from current package-lock.json files");
  }
}

export function buildD12Comparison({
  manifest,
  rawInputs,
  baselineBundle,
  candidateBundle,
  expectedHeads,
  expectedLockfileSha256ByRevision,
  expectedSourceDigests,
}) {
  const { dependencyProvisioning, repetitions: entries, warmUp } = validateOrderManifest(manifest);
  validateManifestLockfiles(dependencyProvisioning, expectedLockfileSha256ByRevision);
  validateRevisionProvenance(entries, dependencyProvisioning);
  const commits = { baseline: BASELINE_COMMIT, candidate: expectedHeads.candidate };
  const referenceHarness = entries[0].baseline.measurementHarnessSha256;
  const referenceProvenance = entries[0].baseline.provenance;
  const bundles = readComparisonBundleBytes({
    baselineBundle,
    candidateBundle,
    commits,
    expectedSourceDigests,
    lockfileSha256ByRevision: expectedLockfileSha256ByRevision,
    referenceHarness,
    referenceProvenance,
  });
  const context = buildComparisonContext({
    bundles,
    entries,
    expectedHeads,
    expectedSourceDigests,
    rawInputs,
    warmUp,
  });
  const repetitions = entries.map((entry, index) => buildRepetition(entry, index, context));
  const aggregates = {
    baseline: aggregate(repetitions, "baseline"),
    candidate: aggregate(repetitions, "candidate"),
  };
  return buildComparisonResult({
    aggregates,
    baselineSourceTreeSha256: expectedSourceDigests.baseline,
    bundles,
    commits,
    dependencyProvisioning,
    referenceHarness,
    repetitions,
    warmUp,
  });
}

function buildComparisonResult({
  aggregates,
  baselineSourceTreeSha256,
  bundles,
  commits,
  dependencyProvisioning,
  referenceHarness,
  repetitions,
  warmUp,
}) {
  return {
    schemaVersion: "2",
    baselineCommit: commits.baseline,
    baselineSourceTreeSha256,
    bundles,
    candidateCommit: commits.candidate,
    candidateSourceTreeSha256: bundles.candidate.sourceTreeSha256,
    measurementHarnessSha256: referenceHarness,
    dependencyProvisioning,
    aggregateRule: AGGREGATE_RULE,
    repetitions,
    warmUp,
    aggregates,
    deltas: deltas(aggregates.baseline, aggregates.candidate),
  };
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} file is missing: ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} file is not valid JSON: ${path} (${String(error)})`);
  }
}

function readBoundRawInput({
  declaredPath,
  digest,
  label,
  manifestDirectory,
  rawInputs,
  resolvedDigests,
  resolvedInputs,
}) {
  const path = resolve(manifestDirectory, declaredPath);
  const pathFromManifest = relative(manifestDirectory, path);
  if (pathFromManifest.startsWith("..") || isAbsolute(pathFromManifest)) {
    fail(`${label} path escapes the order manifest directory`);
  }
  if (resolvedInputs.has(path)) fail(`order manifest reuses raw input ${declaredPath}`);
  resolvedInputs.add(path);
  if (!existsSync(path)) fail(`${label} file is missing: ${path}`);
  const contents = readFileSync(path);
  const actualDigest = createHash("sha256").update(contents).digest("hex");
  if (actualDigest !== digest) fail(`${label} artifactSha256 does not match ${declaredPath}`);
  if (resolvedDigests.has(actualDigest))
    fail(`order manifest reuses artifact bytes ${declaredPath}`);
  resolvedDigests.add(actualDigest);
  let value;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    fail(`${label} file is not valid JSON: ${path} (${String(error)})`);
  }
  if (!contents.equals(canonicalD12ArtifactBytes(value))) {
    fail(`${label} file is not canonical JSON: ${path}`);
  }
  rawInputs.set(declaredPath, value);
}

function readRawInputs(manifest, manifestPath) {
  const rawInputs = new Map();
  const manifestDirectory = dirname(manifestPath);
  const resolvedDigests = new Set();
  const resolvedInputs = new Set();
  for (const entry of validateOrderManifest(manifest).repetitions) {
    for (const revision of REVISIONS) {
      const run = entry[revision];
      readBoundRawInput({
        declaredPath: run.artifact,
        digest: run.artifactSha256,
        label: `${revision} raw evidence`,
        manifestDirectory,
        rawInputs,
        resolvedDigests,
        resolvedInputs,
      });
      if (revision === "candidate") {
        readBoundRawInput({
          declaredPath: run.capEvidence.artifact,
          digest: run.capEvidence.artifactSha256,
          label: "candidate cap evidence",
          manifestDirectory,
          rawInputs,
          resolvedDigests,
          resolvedInputs,
        });
      }
    }
  }
  return rawInputs;
}

function candidateMeasurements(comparison) {
  return comparison.repetitions.map((item) => item.candidate);
}

function consistentCandidateValue(rawInputs, readValue, label, validate) {
  const values = rawInputs.map((raw, index) =>
    validate(readValue(object(raw, `candidate raw evidence ${index + 1}`)), label),
  );
  if (values.some((value) => !isDeepStrictEqual(value, values[0]))) {
    fail(`candidate ${label} differs across repetitions`);
  }
  return values[0];
}

function candidateBudgetMetadata(rawInputs) {
  return {
    b4P50: consistentCandidateValue(
      rawInputs,
      (raw) => raw.b4ColdStartMs?.budgetP50,
      "B4 budgetP50",
      positiveFinite,
    ),
    b4P95: consistentCandidateValue(
      rawInputs,
      (raw) => raw.b4ColdStartMs?.budgetP95,
      "B4 budgetP95",
      positiveFinite,
    ),
    b5Max: consistentCandidateValue(
      rawInputs,
      (raw) => raw.b5KeystrokeMs?.budgetMax,
      "B5 keystroke budgetMax",
      positiveFinite,
    ),
    b6P75: consistentCandidateValue(
      rawInputs,
      (raw) => raw.b6InteractionMs?.budgetP75,
      "B6 budgetP75",
      positiveFinite,
    ),
  };
}

function buildB5KeystrokeEvidence(rawInputs, budgetMax) {
  const metrics = rawInputs.map((raw, index) =>
    object(raw.b5KeystrokeMs, `candidate raw evidence ${index + 1} B5 keystroke`),
  );
  return {
    budgetMax,
    captured: metrics.every((metric) => metric.captured === true),
    longTaskCount: metrics.reduce(
      (total, metric, index) =>
        total + nonNegativeInteger(metric.longTaskCount, `candidate B5 ${index + 1} longTaskCount`),
      0,
    ),
    maxLongTaskMs: Math.max(
      ...metrics.map((metric, index) =>
        nonNegativeFinite(metric.maxLongTaskMs, `candidate B5 ${index + 1} maxLongTaskMs`),
      ),
    ),
  };
}

function buildWorkerLoadEvidence(rawInputs) {
  const captures = rawInputs.map((raw, index) =>
    object(raw.workerLoadCapture, `candidate raw evidence ${index + 1} workerLoadCapture`),
  );
  return {
    totalWorkerRequests: Math.max(
      ...captures.map((capture, index) =>
        nonNegativeInteger(
          capture.totalWorkerRequests,
          `candidate worker capture ${index + 1} totalWorkerRequests`,
        ),
      ),
    ),
    editorWorkerLoaded: captures.every((capture) => capture.editorWorkerLoaded === true),
    tsLanguageWorkerLoaded: captures.some((capture) => capture.tsLanguageWorkerLoaded === true),
    languageWorkerLoaded: captures.some((capture) => capture.languageWorkerLoaded === true),
  };
}

function latestMeasurementTimestamp(measurements) {
  return measurements.reduce(
    (latest, measurement) =>
      Date.parse(measurement.measuredAtIso) > Date.parse(latest)
        ? measurement.measuredAtIso
        : latest,
    measurements[0].measuredAtIso,
  );
}

function buildOverlay(comparison, sourceTreeSha256, candidateRawInputs) {
  const candidate = comparison.aggregates.candidate;
  const measurements = candidateMeasurements(comparison);
  const budgets = candidateBudgetMetadata(candidateRawInputs);
  const representativeB5 = measurements.find(
    (measurement) => measurement.metrics.b5IdleDebug.p95 === candidate.b5IdleDebugP95Ms,
  ).metrics.b5IdleDebug;
  return {
    commit: comparison.candidateCommit,
    measuredAtIso: latestMeasurementTimestamp(measurements),
    freshnessBinding: "source-tree-v1",
    sourceTreeSha256,
    b4ColdStartMs: {
      budgetP50: budgets.b4P50,
      budgetP95: budgets.b4P95,
      p50: candidate.b4P50Ms,
      p95: candidate.b4P95Ms,
    },
    b5KeystrokeMs: buildB5KeystrokeEvidence(candidateRawInputs, budgets.b5Max),
    b5IdleDebugSession: {
      ...representativeB5,
      p95: candidate.b5IdleDebugP95Ms,
      longTaskCount: candidate.b5IdleDebugLongTaskCount,
      maxLongTaskMs: candidate.b5IdleDebugMaxLongTaskMs,
    },
    b6InteractionMs: { budgetP75: budgets.b6P75, captured: true, p75: candidate.b6P75Ms },
    b11Memory: {
      baselineBytes: median(
        measurements.map((measurement) => measurement.metrics.b11.baselineBytes),
      ),
      peakBytes: candidate.b11PeakBytes,
      residualBytes: candidate.b11ResidualBytes,
      cycles: median(measurements.map((measurement) => measurement.metrics.b11.cycles)),
      supported: true,
    },
    workerLoadCapture: buildWorkerLoadEvidence(candidateRawInputs),
    d12Comparison: comparison,
  };
}

function selectCandidateRawInputs(manifest, rawInputs) {
  return validateOrderManifest(manifest).repetitions.map((entry) =>
    rawInputs.get(entry.candidate.artifact),
  );
}

function parseArguments(argv) {
  const options = { selfCheck: true };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) fail(`duplicate option ${argument}`);
    if (argument === "--self-check") {
      seen.add(argument);
      options.selfCheck = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) fail(`unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) fail(`${argument} requires a value`);
    seen.add(argument);
    options[argument.slice(2)] = value;
    index += 1;
  }
  for (const name of [
    "manifest",
    "baseline-bundle",
    "candidate-bundle",
    "baseline-root",
    "candidate-root",
    "output",
  ]) {
    if (options[name] === undefined) fail(`--${name} is required`);
  }
  return options;
}

function validateCheckoutHeads(roots, expectedHeads, isAncestor) {
  validateCommit(expectedHeads.baseline, BASELINE_COMMIT, "baseline checkout HEAD");
  if (!FULL_COMMIT.test(expectedHeads.candidate ?? "")) {
    fail("candidate checkout HEAD must be a full lowercase commit SHA");
  }
  if (!isAncestor(roots.candidate, BASELINE_COMMIT, expectedHeads.candidate)) {
    fail("pinned baseline commit is not an ancestor of candidate HEAD");
  }
}

function computeCheckoutDigests(roots, listDirtyPaths, computeDigest) {
  const expectedSourceDigests = {};
  for (const revision of REVISIONS) {
    const dirtyPaths = listDirtyPaths(roots[revision]);
    if (dirtyPaths.length > 0) {
      fail(`${revision} performance subject is dirty: ${dirtyPaths.join(", ")}`);
    }
    const digest = computeDigest({ root: roots[revision] });
    if (!SHA_256.test(digest)) {
      fail(`shared performance-subject helper returned an invalid ${revision} digest`);
    }
    expectedSourceDigests[revision] = digest;
  }
  return expectedSourceDigests;
}

function computeCommittedMeasurementHarnessSha256(root, commit) {
  return computeD12MeasurementToolchainDigest((path) =>
    execFileSync(resolveHostExecutable("git"), ["show", `${commit}:${path}`], {
      cwd: root,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function computeLockfileSha256(root) {
  return createHash("sha256")
    .update(readFileSync(resolve(root, "package-lock.json")))
    .digest("hex");
}

function resolveCheckoutDependencies(dependencies) {
  return {
    computeBaselineDigest:
      dependencies.computeBaselineDigest ?? computePerformanceSubjectDigestAtCommit,
    computeDigest: dependencies.computeDigest ?? computePerformanceSubjectDigest,
    computeMeasurementHarnessSha256:
      dependencies.computeMeasurementHarnessSha256 ?? computeCommittedMeasurementHarnessSha256,
    getHead: dependencies.getHead ?? checkoutHead,
    getLockfileSha256: dependencies.computeLockfileSha256 ?? computeLockfileSha256,
    isAncestor: dependencies.isAncestor ?? commitIsAncestor,
    listDirtyPaths: dependencies.listDirtyPaths ?? listExactDirtyPerformanceSubjectPaths,
  };
}

function bindPinnedBaselineDigest(expectedSourceDigests, computeBaselineDigest, candidateRoot) {
  const pinnedBaselineDigest = computeBaselineDigest({
    commit: BASELINE_COMMIT,
    root: candidateRoot,
  });
  if (!SHA_256.test(pinnedBaselineDigest)) fail("pinned baseline source-tree digest is invalid");
  if (expectedSourceDigests.baseline !== pinnedBaselineDigest) {
    fail("baseline checkout performance subject differs from the exact pinned baseline commit");
  }
  expectedSourceDigests.baseline = pinnedBaselineDigest;
}

function lockfileSha256ByRevision(roots, getLockfileSha256) {
  return Object.fromEntries(
    REVISIONS.map((revision) => [revision, getLockfileSha256(roots[revision])]),
  );
}

function resolveCheckoutEvidence(options, dependencies) {
  const roots = {
    baseline: resolve(options["baseline-root"]),
    candidate: resolve(options["candidate-root"]),
  };
  const resolved = resolveCheckoutDependencies(dependencies);
  const {
    computeBaselineDigest,
    computeDigest,
    computeMeasurementHarnessSha256,
    getHead,
    getLockfileSha256,
    isAncestor,
    listDirtyPaths,
  } = resolved;
  const expectedHeads = Object.fromEntries(
    REVISIONS.map((revision) => [revision, getHead(roots[revision])]),
  );
  validateCheckoutHeads(roots, expectedHeads, isAncestor);
  const expectedSourceDigests = computeCheckoutDigests(roots, listDirtyPaths, computeDigest);
  bindPinnedBaselineDigest(expectedSourceDigests, computeBaselineDigest, roots.candidate);
  const expectedLockfileSha256ByRevision = lockfileSha256ByRevision(roots, getLockfileSha256);
  return {
    expectedHeads,
    expectedLockfileSha256ByRevision,
    expectedSourceDigests,
    getFreshnessOptions: () => ({
      computeBaselineSourceTreeSha256: () =>
        computeBaselineDigest({ commit: BASELINE_COMMIT, root: roots.candidate }),
      computeMeasurementHarnessSha256: () =>
        computeMeasurementHarnessSha256(roots.candidate, expectedHeads.candidate),
      computeLockfileSha256: () => getLockfileSha256(roots.candidate),
      computeSourceTreeSha256: () => computeDigest({ root: roots.candidate }),
      dirtySubjectPaths: listDirtyPaths(roots.candidate),
      isAncestor: (sha) => isAncestor(roots.candidate, sha, expectedHeads.candidate),
    }),
  };
}

function selfCheckFailureMessages(result, label) {
  if (result?.passed === true && Array.isArray(result.failures) && result.failures.length === 0) {
    return [];
  }
  if (!Array.isArray(result?.failures)) return [`${label} returned an invalid result`];
  return result.failures.map((failure) => `${label}: ${failure}`);
}

function runSelfCheck(output, checkout, dependencies) {
  const editorEvaluator = dependencies.evaluateEditorEvidence ?? evaluateEditorEvidence;
  const freshnessEvaluator = dependencies.evaluateFreshness ?? evaluateFreshness;
  const failures = [
    ...evaluateD12Comparison(output).map((failure) => `d12: ${failure}`),
    ...selfCheckFailureMessages(editorEvaluator(output), "editor"),
    ...selfCheckFailureMessages(
      freshnessEvaluator(output, checkout.getFreshnessOptions()),
      "freshness",
    ),
  ];
  if (failures.length > 0) fail(`validator self-check failed: ${failures.join("; ")}`);
}

export function runD12Builder(argv, dependencies = {}) {
  const options = parseArguments(argv);
  const checkout = resolveCheckoutEvidence(options, dependencies);
  const manifestPath = resolve(options.manifest);
  const manifest = readJson(manifestPath, "order manifest");
  const rawInputs = readRawInputs(manifest, manifestPath);
  const comparison = buildD12Comparison({
    manifest,
    rawInputs,
    baselineBundle: readJson(resolve(options["baseline-bundle"]), "baseline bundle evidence"),
    candidateBundle: readJson(resolve(options["candidate-bundle"]), "candidate bundle evidence"),
    expectedHeads: checkout.expectedHeads,
    expectedLockfileSha256ByRevision: checkout.expectedLockfileSha256ByRevision,
    expectedSourceDigests: checkout.expectedSourceDigests,
  });
  const output = buildOverlay(
    comparison,
    checkout.expectedSourceDigests.candidate,
    selectCandidateRawInputs(manifest, rawInputs),
  );
  if (options.selfCheck) runSelfCheck(output, checkout, dependencies);
  writeFileSync(resolve(options.output), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const output = runD12Builder(process.argv.slice(2));
    console.log(
      `Wrote D12 comparison for ${output.d12Comparison.candidateCommit} with source tree ${output.sourceTreeSha256}`,
    );
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
