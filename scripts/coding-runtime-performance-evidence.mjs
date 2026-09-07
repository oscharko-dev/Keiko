import { compareStrings } from "./lib/compare-strings.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalD12ArtifactBytes,
  computeD12NearestRankPercentile,
} from "./check-perf-evidence.mjs";

export const CODING_PERFORMANCE_METRICS = Object.freeze([
  "coldStartMs",
  "readinessMs",
  "sseFirstByteMs",
  "boundedThroughputMs",
]);
export const CODING_PERFORMANCE_PROCEDURE = Object.freeze({
  warmups: 2,
  batches: 3,
  samplesPerBatch: 10,
  freshSidecarPerSample: true,
  osCacheFlushed: false,
  streamChunks: 64,
  streamChars: 2048,
  gatewayCalls: 1,
  deadlineMs: 60_000,
  terminalPollIntervalMs: 5,
});
const SHA256 = /^[a-f\d]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const CLASS = "functional-performance-not-platform-qualified";
export const CODING_PERFORMANCE_BUDGET_POLICY = "observed-maximum-plus-full-range-v1";

function assert(condition, reason) {
  if (!condition) throw new TypeError(reason);
}

function exact(value, keys, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert(
    isDeepStrictEqual(Object.keys(value).sort(compareStrings), [...keys].sort(compareStrings)),
    `${label} has unexpected fields`,
  );
}

function positive(value, label) {
  assert(
    typeof value === "number" && Number.isFinite(value) && value > 0,
    `${label} must be finite and positive`,
  );
}

function validateSamples(samples) {
  assert(Array.isArray(samples) && samples.length === 30, "exactly thirty samples are required");
  for (const sample of samples) validateCodingPerformanceSample(sample);
}

export function validateCodingPerformanceSample(sample) {
  exact(
    sample,
    [
      ...CODING_PERFORMANCE_METRICS,
      "observedChunks",
      "observedChars",
      "gatewayCalls",
      "observedOutputChars",
    ],
    "sample",
  );
  for (const metric of CODING_PERFORMANCE_METRICS) positive(sample[metric], "sample timing");
  assert(
    sample.observedChunks === 64 && sample.observedChars === 2048,
    "bounded stream input differs",
  );
  assert(
    sample.gatewayCalls === 1 && sample.observedOutputChars === 2048,
    "bounded stream output is incomplete",
  );
}

function aggregates(samples) {
  return Object.fromEntries(
    CODING_PERFORMANCE_METRICS.map((metric) => {
      const values = samples.map((sample) => sample[metric]);
      return [
        metric,
        {
          minimum: Math.min(...values),
          maximum: Math.max(...values),
          p50: computeD12NearestRankPercentile(values, 50),
          p95: computeD12NearestRankPercentile(values, 95),
        },
      ];
    }),
  );
}

export function sealCodingPerformanceDocument(document) {
  const body = { ...document };
  delete body.documentSha256;
  const documentSha256 = createHash("sha256").update(canonicalD12ArtifactBytes(body)).digest("hex");
  return { ...body, documentSha256 };
}

function validateSubject(subject) {
  exact(subject, ["commit", "sourceTreeSha256", "lockfileSha256"], "subject");
  assert(/^[a-f\d]{40}$/u.test(subject.commit), "invalid source commit");
  assert(
    SHA256.test(subject.sourceTreeSha256) && SHA256.test(subject.lockfileSha256),
    "invalid subject digest",
  );
}

function validateEnvironment(environment) {
  exact(
    environment,
    [
      "platform",
      "architecture",
      "osRelease",
      "logicalCores",
      "totalMemoryBytes",
      "cpuModelSha256",
      "nodeVersion",
      "npmVersion",
      "gitVersion",
      "runtimeVersion",
      "payloadSha256",
      "secureReadSha256",
    ],
    "environment",
  );
  assert(
    environment.platform === "darwin" && environment.architecture === "arm64",
    "native macOS arm64 reference required",
  );
  for (const key of ["osRelease", "nodeVersion", "npmVersion", "gitVersion", "runtimeVersion"]) {
    assert(
      typeof environment[key] === "string" && VERSION.test(environment[key]),
      "invalid environment version",
    );
  }
  for (const key of ["cpuModelSha256", "payloadSha256", "secureReadSha256"]) {
    assert(
      typeof environment[key] === "string" && SHA256.test(environment[key]),
      "invalid environment digest",
    );
  }
  for (const key of ["logicalCores", "totalMemoryBytes"]) {
    assert(
      Number.isSafeInteger(environment[key]) && environment[key] > 0,
      "invalid hardware aggregate",
    );
  }
}

function validateDocument(document) {
  const base = [
    "schemaVersion",
    "target",
    "evidenceClass",
    "role",
    "measuredAtIso",
    "subject",
    "environment",
    "measurementHarnessSha256",
    "procedure",
    "samples",
    "aggregates",
    "documentSha256",
  ];
  exact(
    document,
    document?.role === "measurement" ? [...base, "calibrationSha256"] : base,
    "evidence",
  );
  assert(
    document.schemaVersion === 1 && document.target === "coding-runtime",
    "invalid evidence version or target",
  );
  assert(document.evidenceClass === CLASS, "invalid evidence class");
  assert(
    document.role === "measurement" || document.role === "calibration",
    "invalid evidence role",
  );
  assert(
    typeof document.measuredAtIso === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(document.measuredAtIso) &&
      !Number.isNaN(Date.parse(document.measuredAtIso)) &&
      new Date(document.measuredAtIso).toISOString() === document.measuredAtIso,
    "invalid measurement timestamp",
  );
  assert(SHA256.test(document.measurementHarnessSha256), "invalid measurement ruler digest");
  validateDocumentContent(document);
}

function validateDocumentContent(document) {
  validateSubject(document.subject);
  validateEnvironment(document.environment);
  assert(
    isDeepStrictEqual(document.procedure, CODING_PERFORMANCE_PROCEDURE),
    "measurement procedure differs",
  );
  validateSamples(document.samples);
  assert(
    isDeepStrictEqual(document.aggregates, aggregates(document.samples)),
    "aggregates differ from recorded samples",
  );
  assert(
    document.documentSha256 === sealCodingPerformanceDocument(document).documentSha256,
    "evidence digest mismatch",
  );
  if (document.role === "measurement")
    assert(SHA256.test(document.calibrationSha256), "invalid calibration digest");
}

export function buildCodingPerformanceEvidence(input) {
  validateSamples(input.samples);
  const document = sealCodingPerformanceDocument({
    schemaVersion: 1,
    target: "coding-runtime",
    evidenceClass: CLASS,
    ...input,
    procedure: CODING_PERFORMANCE_PROCEDURE,
    aggregates: aggregates(input.samples),
  });
  validateDocument(document);
  return document;
}

export function calibrationBudgets(calibration) {
  validateDocument(calibration);
  assert(calibration.role === "calibration", "budget input must be calibration");
  return {
    schemaVersion: 1,
    target: "coding-runtime",
    policy: CODING_PERFORMANCE_BUDGET_POLICY,
    calibrationSha256: calibration.documentSha256,
    maximumP95Ms: Object.fromEntries(
      CODING_PERFORMANCE_METRICS.map((metric) => {
        const { maximum, minimum } = calibration.aggregates[metric];
        const ceiling = maximum + (maximum - minimum);
        positive(ceiling, "calibrated ceiling");
        return [metric, ceiling];
      }),
    ),
  };
}

function validatePair(evidence, calibration, budget, defects) {
  if (evidence.role !== "measurement" || calibration.role !== "calibration")
    defects.push("evidence roles differ");
  if (calibration.documentSha256 !== budget.calibrationSha256)
    defects.push("calibration anchor differs from reviewed budget");
  if (!isDeepStrictEqual(budget, calibrationBudgets(calibration)))
    defects.push("budgets differ from measured calibration");
  if (evidence.calibrationSha256 !== calibration.documentSha256)
    defects.push("measurement calibration binding differs");
  if (evidence.measurementHarnessSha256 !== calibration.measurementHarnessSha256)
    defects.push("measurement ruler differs from calibration");
  if (!isDeepStrictEqual(evidence.environment, calibration.environment))
    defects.push("reference environment differs from calibration");
}

export function evaluateCodingPerformanceEvidence(evidence, calibration, budget) {
  const defects = [];
  const verdicts = [];
  try {
    validateDocument(evidence);
    validateDocument(calibration);
    validatePair(evidence, calibration, budget, defects);
  } catch (error) {
    defects.push(error instanceof TypeError ? error.message : "invalid evidence document");
    return { defects, verdicts };
  }
  // A valid slow sample is evidence, not a producer failure. Integrity defects remain separate
  // discriminants and cannot be downgraded by resembling a performance-verdict message.
  for (const metric of CODING_PERFORMANCE_METRICS) {
    if (evidence.aggregates[metric].p95 > calibrationBudgets(calibration).maximumP95Ms[metric]) {
      verdicts.push(`${metric} exceeds the calibrated p95 budget`);
    }
  }
  return { defects, verdicts };
}
