#!/usr/bin/env node
import { compareStrings } from "./lib/compare-strings.mjs";
// check:tool-catalog-performance — #3415 closeout.
//
// Measures the ONE producer every consumer compiles against
// (@oscharko-dev/keiko-tool-catalog, loaded through its built dist so this gate always exercises
// the same artifact CI ships) rather than restating its formulas. Reuses #2952's
// measurement/verdict-separation convention (scripts/coding-runtime-performance-evidence.mjs):
// `measureToolCatalogPerformance` only records samples and throws on incomplete/invalid work; it
// never decides pass/fail on wall-clock numbers. Threshold *interpretation* for any wall-clock
// figures this document carries belongs to the reader (#3415 owns calibrating them against the
// D12 reference environment, ADR-0156 D6 — a developer-class container, never a hosted runner).
//
// Two measured cases, not one:
//   - "legacy-native-6-tool": the real, shipped `createInitialToolCatalog()` (unchanged pin).
//   - "synthetic-<N>-tool": a synthetic catalog built from the SAME producer functions
//     (`createToolRef`/`createToolDescriptor`/`createKeikoToolCatalog`), scaled to the largest
//     size the producer's own bound accepts.
//
// Why not literally "thousands of tools": `createToolCatalog` copies its entire
// {descriptors, profiles, compatibility} snapshot through `copyCatalogJson`, which enforces
// `TOOL_CATALOG_LIMITS.maxArgumentBytes` (262_144 bytes, packages/keiko-tool-catalog/src/json.ts)
// as a hitherto-unmeasured HARD ceiling on total catalog size — not merely on one argument. That
// bound was reached empirically at build time (`buildSyntheticRegistrationSet` below): a minimal
// synthetic descriptor already binds it well under 1000 entries. Enlarging that bound is an
// owning-package decision (packages/keiko-tool-catalog, out of this gate's write scope) and
// bypassing the shared budget check to reach a bigger number would defeat the exact fail-closed
// guarantee this gate exists to prove. So "bounded construction" is proven two ways instead:
// measuring the largest catalog the real bound accepts (TOOL_CATALOG_SYNTHETIC_TOOL_COUNT), and
// asserting a catalog past that bound is REJECTED, never silently truncated or slow-accepted
// (see `measureToolCatalogOverflowRejection`).
//
// All pass/fail assertions here are bounded by OPERATION COUNTS, never wall-clock thresholds:
// `validateToolCatalogPerformanceSamples` checks sample completeness and internal consistency
// (same tool count, same digests across every sample of one run); lookup iteration counts are
// derived from a fixed total-comparison budget (`LOOKUP_OPERATION_BUDGET`) divided by catalog
// size, not a wall-clock duration, so this gate cannot flake on a slow or shared CI runner.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isMainModule } from "./lib/is-main-module.mjs";
import { hashHelperSourceTree } from "./stage-dev-coding-runtime.mjs";
import {
  canonicalD12ArtifactBytes,
  computeD12NearestRankPercentile,
} from "./check-perf-evidence.mjs";
import {
  CODING_PERFORMANCE_BUDGET_POLICY,
  CODING_PERFORMANCE_PROCEDURE,
} from "./coding-runtime-performance-evidence.mjs";
import { loadToolCatalogProducer } from "./check-tool-catalog-conformance.mjs";

export const TOOL_CATALOG_PERFORMANCE_PROCEDURE = Object.freeze({
  warmups: CODING_PERFORMANCE_PROCEDURE.warmups,
  batches: CODING_PERFORMANCE_PROCEDURE.batches,
  samplesPerBatch: CODING_PERFORMANCE_PROCEDURE.samplesPerBatch,
  freshCatalogPerSample: true,
  // Fixed total-comparison budget per sample, divided across a case's tool count below — bounds
  // work by operation count instead of a wall-clock duration (no flakiness on a slow runner).
  lookupOperationBudget: 6_000,
});
// The largest synthetic catalog `createKeikoToolCatalog` accepts before
// TOOL_CATALOG_LIMITS.maxArgumentBytes (262_144 bytes) rejects the snapshot, minus a safety
// margin (empirically the ceiling for this fixture's minimal descriptor shape sits at 310-314;
// see the header comment). Kept well clear of the ceiling so a future, slightly heavier
// descriptor shape does not flip this case from "accepted" to "rejected".
export const TOOL_CATALOG_SYNTHETIC_TOOL_COUNT = 300;
// Deliberately past the real ceiling — used only to prove the bound still rejects, never measured.
export const TOOL_CATALOG_OVERFLOW_TOOL_COUNT = 320;
const SYNTHETIC_HANDLER_ID = "tool-catalog-performance-fixture";
const SHA256 = /^[a-f0-9]{64}$/u;
const TOOL_CATALOG_PERFORMANCE_CLASS = "functional-performance-reference-container";
const TOOL_CATALOG_PERFORMANCE_METRICS = ["coldCompileMs", "lookupBatchMs"];
const LEGACY_PERFORMANCE_CASE_ID = "legacy-native-6-tool";
const SYNTHETIC_PERFORMANCE_CASE_ID = `synthetic-${String(TOOL_CATALOG_SYNTHETIC_TOOL_COUNT)}-tool`;
const TOOL_CATALOG_REFERENCE_IMAGE =
  "node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const TOOL_CATALOG_RULER_PATHS = [
  "scripts/check-perf-evidence.mjs",
  "scripts/check-tool-catalog-conformance.mjs",
  "scripts/check-tool-catalog-performance.mjs",
  "scripts/coding-runtime-performance-evidence.mjs",
  "scripts/stage-dev-coding-runtime.mjs",
];
export const TOOL_CATALOG_PERFORMANCE_FILES = Object.freeze({
  calibration: "docs/release/3415-tool-catalog-calibration.json",
  measurement: "docs/release/3415-tool-catalog-perf-evidence.json",
  budget: "scripts/tool-catalog-performance-budget.json",
});

function paddedIndex(index) {
  return String(index).padStart(6, "0");
}
/** Built from the real producer's own descriptor/composer functions — never a restated shape. */
export function buildSyntheticRegistrationSet(producer, toolCount) {
  const entries = Array.from({ length: toolCount }, (_unused, index) => {
    const suffix = paddedIndex(index);
    const alias = `synthetic_tool_${suffix}`;
    return {
      alias,
      descriptor: producer.createToolDescriptor({
        toolRef: producer.createToolRef(`keiko.synthetic.tool${suffix}`, 1),
        description: "Synthetic performance-fixture tool.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        resultSchema: { type: "string", maxLength: 64 },
        effects: ["workspace-read"],
        actionMapping: [{ action: alias, effects: ["workspace-read"] }],
        policyReferences: ["workspace-read"],
        handlerRequirement: { id: SYNTHETIC_HANDLER_ID, contractVersion: 1 },
        bounds: {
          maxArgumentBytes: 1024,
          maxResultBytes: 1024,
          maxResultCount: 1,
          maxDurationMs: 1000,
        },
        idempotency: "read-only",
        cancellation: "cooperative",
      }),
    };
  });
  return {
    profile: { id: "performance-synthetic", version: 1 },
    adapterDialect: { id: "legacy-json-schema", version: 1 },
    adapterRuntime: { id: "keiko", version: "0.3.17" },
    nativeExtensions: [],
    compatibility: [],
    entries,
  };
}
function toolCatalogCases(producer) {
  return [
    {
      id: LEGACY_PERFORMANCE_CASE_ID,
      profile: { id: "legacy-native", version: 1 },
      buildCatalog: () => producer.createInitialToolCatalog(),
    },
    {
      id: SYNTHETIC_PERFORMANCE_CASE_ID,
      profile: { id: "performance-synthetic", version: 1 },
      buildCatalog: () =>
        producer.createKeikoToolCatalog([
          buildSyntheticRegistrationSet(producer, TOOL_CATALOG_SYNTHETIC_TOOL_COUNT),
        ]),
    },
  ];
}
/** Comparisons per sample are fixed by this budget, not by wall-clock duration. */
export function deriveLookupIterations(toolCount) {
  return Math.max(
    1,
    Math.floor(TOOL_CATALOG_PERFORMANCE_PROCEDURE.lookupOperationBudget / toolCount),
  );
}
function measure(producer, testCase, clock) {
  const start = clock();
  const catalog = testCase.buildCatalog();
  const projection = producer.compileToolProjection(catalog, testCase.profile);
  const coldCompileMs = clock() - start;
  const iterations = deriveLookupIterations(projection.tools.length);
  const lookupStart = clock();
  let lookups = 0;
  for (let index = 0; index < iterations; index += 1)
    for (const tool of projection.tools) {
      if (
        producer.lookupCatalogTool(catalog, tool.toolRef)?.descriptorDigest !==
        tool.descriptorDigest
      )
        throw new TypeError("catalog lookup fixture mismatch");
      lookups += 1;
    }
  return {
    coldCompileMs,
    lookupBatchMs: clock() - lookupStart,
    lookups,
    toolCount: projection.tools.length,
    catalogRevision: catalog.catalogRevision,
    projectionDigest: projection.projectionDigest,
  };
}
function sampleErrors(sample, first) {
  const errors = [];
  if (
    ![sample.coldCompileMs, sample.lookupBatchMs].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    errors.push("invalid catalog timing");
  // Never a hardcoded tool count: every sample of one measurement run must agree with the
  // FIRST sample's own toolCount (self-consistency), not with a number restated here. A
  // producer that grows the legacy profile (new native extensions, more legacy tools) or adds
  // a profile this script measures moves `first.toolCount` with it automatically.
  if (
    !Number.isSafeInteger(sample.toolCount) ||
    sample.toolCount <= 0 ||
    sample.toolCount !== first.toolCount
  )
    errors.push("catalog tool count is not self-consistent across samples");
  if (sample.lookups !== deriveLookupIterations(sample.toolCount) * sample.toolCount)
    errors.push("incomplete catalog fixture work");
  for (const key of ["catalogRevision", "projectionDigest"])
    if (!/^[a-f0-9]{64}$/u.test(sample[key]) || sample[key] !== first[key])
      errors.push("catalog performance identity mismatch");
  return errors;
}
export function validateToolCatalogPerformanceSamples(samples) {
  const count =
    TOOL_CATALOG_PERFORMANCE_PROCEDURE.batches * TOOL_CATALOG_PERFORMANCE_PROCEDURE.samplesPerBatch;
  if (!Array.isArray(samples) || samples.length !== count)
    return ["catalog performance requires thirty samples"];
  const [first] = samples;
  return samples.flatMap((sample) => sampleErrors(sample, first));
}
function performanceAggregates(samples) {
  return Object.fromEntries(
    TOOL_CATALOG_PERFORMANCE_METRICS.map((metric) => {
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
function measureCase(producer, testCase, clock) {
  for (let index = 0; index < TOOL_CATALOG_PERFORMANCE_PROCEDURE.warmups; index += 1)
    measure(producer, testCase, clock);
  const samples = [];
  for (let batch = 0; batch < TOOL_CATALOG_PERFORMANCE_PROCEDURE.batches; batch += 1)
    for (let index = 0; index < TOOL_CATALOG_PERFORMANCE_PROCEDURE.samplesPerBatch; index += 1)
      samples.push(measure(producer, testCase, clock));
  const errors = validateToolCatalogPerformanceSamples(samples);
  if (errors.length > 0) throw new TypeError(`${testCase.id}: ${errors.join("; ")}`);
  return {
    toolCount: samples[0].toolCount,
    samples,
    aggregates: performanceAggregates(samples),
  };
}
/** Proves the byte-budget bound rejects an oversized catalog rather than accepting or hanging. */
export function measureToolCatalogOverflowRejection(producer) {
  try {
    producer.createKeikoToolCatalog([
      buildSyntheticRegistrationSet(producer, TOOL_CATALOG_OVERFLOW_TOOL_COUNT),
    ]);
    return { attemptedToolCount: TOOL_CATALOG_OVERFLOW_TOOL_COUNT, rejected: false, reason: null };
  } catch (error) {
    const reason = error instanceof Error && "reason" in error ? String(error.reason) : "unknown";
    return { attemptedToolCount: TOOL_CATALOG_OVERFLOW_TOOL_COUNT, rejected: true, reason };
  }
}
export async function measureToolCatalogPerformance(
  root = process.cwd(),
  clock = () => performance.now(),
) {
  const producer = await loadToolCatalogProducer(root);
  const cases = Object.fromEntries(
    toolCatalogCases(producer).map((testCase) => [
      testCase.id,
      measureCase(producer, testCase, clock),
    ]),
  );
  const overflow = measureToolCatalogOverflowRejection(producer);
  if (!overflow.rejected || overflow.reason !== "input-bound")
    throw new TypeError("catalog overflow fixture was not rejected closed by the producer's bound");
  return {
    schemaVersion: 2,
    evidenceClass: "functional-performance-not-platform-qualified",
    role: "development-measurement",
    thresholdOwnerIssue: 3415,
    procedure: TOOL_CATALOG_PERFORMANCE_PROCEDURE,
    overflow,
    subject: toolCatalogPerformanceSubject(root),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    },
    cases,
  };
}

const FRESH_MEASUREMENT_SOURCE = `
const moduleUrl = process.argv[2];
const root = process.argv[3];
if (!moduleUrl || !root) throw new TypeError("catalog measurement child arguments are missing");
const { measureToolCatalogPerformance } = await import(moduleUrl);
process.stdout.write(JSON.stringify(await measureToolCatalogPerformance(root)));
`;

/**
 * Runs one complete measurement in a new VM and heap. Calibration's synthetic-catalog allocation
 * therefore cannot perturb the candidate through retained JIT or garbage-collector state.
 */
export async function measureToolCatalogPerformanceInFreshProcess(root = process.cwd()) {
  const moduleUrl = pathToFileURL(join(root, "scripts/check-tool-catalog-performance.mjs")).href;
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      FRESH_MEASUREMENT_SOURCE,
      "tool-catalog-measurement-child",
      moduleUrl,
      root,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

export function toolCatalogPerformanceSubject(root = process.cwd()) {
  return {
    sourceTreeSha256: hashHelperSourceTree(join(root, "packages/keiko-tool-catalog/src")),
    lockfileSha256: createHash("sha256")
      .update(readFileSync(join(root, "package-lock.json")))
      .digest("hex"),
  };
}

export function toolCatalogPerformanceRulerDigest(root = process.cwd()) {
  const digest = createHash("sha256").update("keiko-tool-catalog-performance-ruler-v1\0");
  for (const path of TOOL_CATALOG_RULER_PATHS)
    digest
      .update(path)
      .update("\0")
      .update(
        createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex"),
      )
      .update("\0");
  return digest.digest("hex");
}

function assertEvidence(condition, reason) {
  if (!condition) throw new TypeError(reason);
}

function exactKeys(value, expected, label) {
  assertEvidence(value !== null && typeof value === "object", `${label} must be an object`);
  assertEvidence(
    isDeepStrictEqual(Object.keys(value).sort(compareStrings), [...expected].sort(compareStrings)),
    `${label} has unexpected fields`,
  );
}

function sealToolCatalogPerformanceDocument(document) {
  const body = { ...document };
  delete body.documentSha256;
  const documentSha256 = createHash("sha256").update(canonicalD12ArtifactBytes(body)).digest("hex");
  return { ...body, documentSha256 };
}

function validateReferenceEnvironment(environment) {
  exactKeys(
    environment,
    [
      "platform",
      "architecture",
      "nodeVersion",
      "logicalCores",
      "totalMemoryBytes",
      "containerImage",
    ],
    "catalog performance environment",
  );
  assertEvidence(
    environment.platform === "linux" && environment.architecture === "arm64",
    "catalog performance requires the Linux arm64 reference",
  );
  assertEvidence(environment.nodeVersion === "v24.18.0", "catalog performance Node differs");
  assertEvidence(environment.logicalCores >= 14, "catalog performance requires fourteen cores");
  assertEvidence(
    Number.isSafeInteger(environment.totalMemoryBytes) && environment.totalMemoryBytes > 0,
    "catalog performance memory aggregate is invalid",
  );
  assertEvidence(
    environment.containerImage === TOOL_CATALOG_REFERENCE_IMAGE,
    "catalog performance container image differs",
  );
}

function validatePerformanceCase(testCase) {
  exactKeys(testCase, ["toolCount", "samples", "aggregates"], "catalog performance case");
  assertEvidence(
    validateToolCatalogPerformanceSamples(testCase.samples).length === 0,
    "catalog performance samples are invalid",
  );
  assertEvidence(
    isDeepStrictEqual(testCase.aggregates, performanceAggregates(testCase.samples)),
    "catalog performance aggregates differ",
  );
  assertEvidence(
    testCase.toolCount === testCase.samples[0].toolCount,
    "catalog performance case tool count differs from its samples",
  );
}

function expectedPerformanceCaseIds() {
  return [LEGACY_PERFORMANCE_CASE_ID, SYNTHETIC_PERFORMANCE_CASE_ID];
}

function validatePerformanceDocumentHeader(document) {
  const base = [
    "schemaVersion",
    "target",
    "evidenceClass",
    "role",
    "thresholdOwnerIssue",
    "measuredAtIso",
    "subject",
    "environment",
    "procedure",
    "overflow",
    "cases",
    "documentSha256",
  ];
  exactKeys(
    document,
    document?.role === "measurement" ? [...base, "calibrationSha256"] : base,
    "catalog performance evidence",
  );
  assertEvidence(
    document.schemaVersion === 1 && document.target === "tool-catalog",
    "invalid catalog performance version",
  );
  assertEvidence(
    document.evidenceClass === TOOL_CATALOG_PERFORMANCE_CLASS,
    "invalid catalog performance class",
  );
  assertEvidence(
    document.role === "calibration" || document.role === "measurement",
    "invalid catalog performance role",
  );
  assertEvidence(document.thresholdOwnerIssue === 3415, "invalid catalog performance owner");
  assertEvidence(
    new Date(document.measuredAtIso).toISOString() === document.measuredAtIso,
    "invalid catalog performance timestamp",
  );
}

function validatePerformanceDocumentContent(document) {
  exactKeys(
    document.subject,
    ["sourceTreeSha256", "lockfileSha256", "measurementHarnessSha256"],
    "catalog performance subject",
  );
  assertEvidence(
    Object.values(document.subject).every((value) => SHA256.test(value)),
    "invalid catalog performance subject digest",
  );
  validateReferenceEnvironment(document.environment);
  assertEvidence(
    isDeepStrictEqual(document.procedure, TOOL_CATALOG_PERFORMANCE_PROCEDURE),
    "catalog performance procedure differs",
  );
  assertEvidence(
    document.overflow?.rejected === true && document.overflow.reason === "input-bound",
    "catalog overflow evidence is invalid",
  );
  exactKeys(
    document.overflow,
    ["attemptedToolCount", "rejected", "reason"],
    "catalog overflow evidence",
  );
  assertEvidence(
    document.overflow.attemptedToolCount === TOOL_CATALOG_OVERFLOW_TOOL_COUNT,
    "catalog overflow fixture count differs",
  );
  exactKeys(document.cases, expectedPerformanceCaseIds(), "catalog performance cases");
  for (const testCase of Object.values(document.cases)) validatePerformanceCase(testCase);
  if (document.role === "measurement")
    assertEvidence(SHA256.test(document.calibrationSha256), "invalid catalog calibration binding");
  assertEvidence(
    document.documentSha256 === sealToolCatalogPerformanceDocument(document).documentSha256,
    "catalog performance evidence digest mismatch",
  );
}

function validateToolCatalogPerformanceDocument(document) {
  validatePerformanceDocumentHeader(document);
  validatePerformanceDocumentContent(document);
}

export function buildToolCatalogPerformanceDocument(raw, input) {
  const document = sealToolCatalogPerformanceDocument({
    schemaVersion: 1,
    target: "tool-catalog",
    evidenceClass: TOOL_CATALOG_PERFORMANCE_CLASS,
    role: input.role,
    thresholdOwnerIssue: 3415,
    measuredAtIso: input.measuredAtIso,
    subject: { ...raw.subject, measurementHarnessSha256: input.measurementHarnessSha256 },
    environment: input.environment,
    procedure: raw.procedure,
    overflow: raw.overflow,
    cases: raw.cases,
    ...(input.calibrationSha256 === undefined
      ? {}
      : { calibrationSha256: input.calibrationSha256 }),
  });
  validateToolCatalogPerformanceDocument(document);
  return document;
}

export function toolCatalogPerformanceBudgets(calibration) {
  validateToolCatalogPerformanceDocument(calibration);
  assertEvidence(calibration.role === "calibration", "catalog budget input must be calibration");
  return {
    schemaVersion: 1,
    target: "tool-catalog",
    policy: CODING_PERFORMANCE_BUDGET_POLICY,
    calibrationSha256: calibration.documentSha256,
    maximumP95Ms: Object.fromEntries(
      Object.entries(calibration.cases).map(([id, testCase]) => [
        id,
        Object.fromEntries(
          TOOL_CATALOG_PERFORMANCE_METRICS.map((metric) => {
            const aggregate = testCase.aggregates[metric];
            return [metric, aggregate.maximum + (aggregate.maximum - aggregate.minimum)];
          }),
        ),
      ]),
    ),
  };
}

function performancePairDefects(measurement, calibration, budget) {
  return [
    ...(!isDeepStrictEqual(budget, toolCatalogPerformanceBudgets(calibration))
      ? ["catalog performance budget differs from calibration"]
      : []),
    ...(measurement.calibrationSha256 !== calibration.documentSha256
      ? ["catalog performance calibration binding differs"]
      : []),
    ...(!isDeepStrictEqual(measurement.subject, calibration.subject)
      ? ["catalog performance subject differs from calibration"]
      : []),
    ...(!isDeepStrictEqual(measurement.environment, calibration.environment)
      ? ["catalog performance environment differs from calibration"]
      : []),
    ...(measurement.role !== "measurement" || calibration.role !== "calibration"
      ? ["catalog performance evidence roles differ"]
      : []),
    ...(Date.parse(measurement.measuredAtIso) < Date.parse(calibration.measuredAtIso)
      ? ["catalog performance measurement predates calibration"]
      : []),
    ...performanceCaseIdentityDefects(measurement, calibration),
  ];
}

function performanceCaseIdentityDefects(measurement, calibration) {
  return expectedPerformanceCaseIds().flatMap((id) => {
    const measured = measurement.cases[id];
    const calibrated = calibration.cases[id];
    const measuredSample = measured.samples[0];
    const calibratedSample = calibrated.samples[0];
    const matches =
      measured.toolCount === calibrated.toolCount &&
      measuredSample.catalogRevision === calibratedSample.catalogRevision &&
      measuredSample.projectionDigest === calibratedSample.projectionDigest;
    return matches ? [] : [`${id} case identity differs from calibration`];
  });
}

function performanceVerdicts(measurement, budget) {
  const verdicts = [];
  for (const [id, testCase] of Object.entries(measurement.cases))
    for (const metric of TOOL_CATALOG_PERFORMANCE_METRICS)
      if (testCase.aggregates[metric].p95 > budget.maximumP95Ms[id][metric])
        verdicts.push(`${id} ${metric} exceeds the calibrated p95 budget`);
  return verdicts;
}

export function evaluateToolCatalogPerformanceEvidence(measurement, calibration, budget) {
  try {
    validateToolCatalogPerformanceDocument(measurement);
    validateToolCatalogPerformanceDocument(calibration);
    const defects = performancePairDefects(measurement, calibration, budget);
    return {
      defects,
      verdicts: defects.length === 0 ? performanceVerdicts(measurement, budget) : [],
    };
  } catch (error) {
    const defects = [
      error instanceof TypeError ? error.message : "invalid catalog performance evidence",
    ];
    return { defects, verdicts: [] };
  }
}

function referenceEnvironment() {
  assertEvidence(
    process.env.KEIKO_TOOL_CATALOG_REFERENCE_IMAGE === TOOL_CATALOG_REFERENCE_IMAGE,
    "catalog performance reference image was not attested",
  );
  const environment = {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    logicalCores: cpus().length,
    totalMemoryBytes: totalmem(),
    containerImage: TOOL_CATALOG_REFERENCE_IMAGE,
  };
  validateReferenceEnvironment(environment);
  return environment;
}

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function writeJson(root, path, value) {
  writeFileSync(join(root, path), canonicalD12ArtifactBytes(value));
}

export async function writeToolCatalogPerformanceReference(root = process.cwd()) {
  const environment = referenceEnvironment();
  const measurementHarnessSha256 = toolCatalogPerformanceRulerDigest(root);
  const calibrationRaw = await measureToolCatalogPerformanceInFreshProcess(root);
  const calibration = buildToolCatalogPerformanceDocument(calibrationRaw, {
    role: "calibration",
    measuredAtIso: new Date().toISOString(),
    measurementHarnessSha256,
    environment,
  });
  const budget = toolCatalogPerformanceBudgets(calibration);
  const measurementRaw = await measureToolCatalogPerformanceInFreshProcess(root);
  const measurement = buildToolCatalogPerformanceDocument(measurementRaw, {
    role: "measurement",
    measuredAtIso: new Date().toISOString(),
    measurementHarnessSha256,
    calibrationSha256: calibration.documentSha256,
    environment,
  });
  const result = evaluateToolCatalogPerformanceEvidence(measurement, calibration, budget);
  writeJson(root, TOOL_CATALOG_PERFORMANCE_FILES.calibration, calibration);
  writeJson(root, TOOL_CATALOG_PERFORMANCE_FILES.measurement, measurement);
  writeJson(root, TOOL_CATALOG_PERFORMANCE_FILES.budget, budget);
  return { calibration, measurement, budget, result };
}

function currentIdentityDefects(document, current) {
  const defects = [];
  for (const id of expectedPerformanceCaseIds()) {
    const recorded = document.cases[id];
    const expected = current.cases[id];
    const recordedSample = recorded.samples[0];
    const expectedSample = expected.samples[0];
    if (recorded.toolCount !== expected.toolCount)
      defects.push(`${id} tool count differs from the current producer`);
    if (
      recordedSample.catalogRevision !== expectedSample.catalogRevision ||
      recordedSample.projectionDigest !== expectedSample.projectionDigest
    )
      defects.push(`${id} identity differs from the current producer`);
  }
  return defects;
}

export async function checkToolCatalogPerformanceReference(
  root = process.cwd(),
  current = undefined,
) {
  try {
    const calibration = readJson(root, TOOL_CATALOG_PERFORMANCE_FILES.calibration);
    const measurement = readJson(root, TOOL_CATALOG_PERFORMANCE_FILES.measurement);
    const budget = readJson(root, TOOL_CATALOG_PERFORMANCE_FILES.budget);
    const result = evaluateToolCatalogPerformanceEvidence(measurement, calibration, budget);
    const currentSubject = {
      ...toolCatalogPerformanceSubject(root),
      measurementHarnessSha256: toolCatalogPerformanceRulerDigest(root),
    };
    if (!isDeepStrictEqual(measurement.subject, currentSubject))
      result.defects.push("catalog performance evidence does not describe the current producer");
    const currentEvidence = current ?? (await measureToolCatalogPerformance(root));
    result.defects.push(
      ...currentIdentityDefects(calibration, currentEvidence),
      ...currentIdentityDefects(measurement, currentEvidence),
    );
    return result;
  } catch (error) {
    return {
      defects: [
        error instanceof Error ? error.message : "catalog performance evidence is unreadable",
      ],
      verdicts: [],
    };
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--write-reference")) {
    const { result } = await writeToolCatalogPerformanceReference();
    if (result.defects.length > 0 || result.verdicts.length > 0)
      throw new TypeError([...result.defects, ...result.verdicts].join("; "));
    console.log("tool-catalog-performance: PASS — calibrated reference evidence written");
  } else {
    const evidence = await measureToolCatalogPerformance();
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex !== -1) {
      const output = process.argv[outputIndex + 1];
      if (!output) throw new TypeError("Missing catalog performance output path");
      writeFileSync(output, canonicalD12ArtifactBytes(evidence));
    }
    const result = await checkToolCatalogPerformanceReference(process.cwd(), evidence);
    if (result.defects.length > 0 || result.verdicts.length > 0)
      throw new TypeError([...result.defects, ...result.verdicts].join("; "));
    const summary = Object.fromEntries(
      Object.entries(evidence.cases).map(([id, value]) => [id, value.aggregates]),
    );
    console.log(
      "tool-catalog-performance: PASS — deterministic fresh work and calibrated reference " +
        `verdict (${Object.keys(evidence.cases).join(", ")}); overflow rejected closed at ` +
        `${String(evidence.overflow.attemptedToolCount)} tools; ${JSON.stringify(summary)}`,
    );
  }
}
