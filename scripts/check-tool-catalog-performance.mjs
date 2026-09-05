#!/usr/bin/env node
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
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isMainModule } from "./lib/is-main-module.mjs";
import { hashHelperSourceTree } from "./stage-dev-coding-runtime.mjs";
import {
  canonicalD12ArtifactBytes,
  computeD12NearestRankPercentile,
} from "./check-perf-evidence.mjs";
import { CODING_PERFORMANCE_PROCEDURE } from "./coding-runtime-performance-evidence.mjs";
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
        bounds: { maxArgumentBytes: 1024, maxResultBytes: 1024, maxResultCount: 1, maxDurationMs: 1000 },
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
      id: "legacy-native-6-tool",
      profile: { id: "legacy-native", version: 1 },
      buildCatalog: () => producer.createInitialToolCatalog(),
    },
    {
      id: `synthetic-${String(TOOL_CATALOG_SYNTHETIC_TOOL_COUNT)}-tool`,
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
  return Math.max(1, Math.floor(TOOL_CATALOG_PERFORMANCE_PROCEDURE.lookupOperationBudget / toolCount));
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
export function validateToolCatalogPerformanceSamples(samples) {
  const errors = [];
  const count =
    TOOL_CATALOG_PERFORMANCE_PROCEDURE.batches * TOOL_CATALOG_PERFORMANCE_PROCEDURE.samplesPerBatch;
  if (!Array.isArray(samples) || samples.length !== count)
    return ["catalog performance requires thirty samples"];
  const [first] = samples;
  for (const sample of samples) {
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
  }
  return errors;
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
  const aggregates = Object.fromEntries(
    ["coldCompileMs", "lookupBatchMs"].map((metric) => {
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
  return { toolCount: samples[0].toolCount, samples, aggregates };
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
    toolCatalogCases(producer).map((testCase) => [testCase.id, measureCase(producer, testCase, clock)]),
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
    subject: {
      sourceTreeSha256: hashHelperSourceTree(join(root, "packages/keiko-tool-catalog/src")),
      lockfileSha256: createHash("sha256")
        .update(readFileSync(join(root, "package-lock.json")))
        .digest("hex"),
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    },
    cases,
  };
}
if (isMainModule(import.meta.url)) {
  const evidence = await measureToolCatalogPerformance();
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex !== -1) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new TypeError("Missing catalog performance output path");
    writeFileSync(output, canonicalD12ArtifactBytes(evidence));
  }
  const summary = Object.fromEntries(
    Object.entries(evidence.cases).map(([id, value]) => [id, value.aggregates]),
  );
  console.log(
    "tool-catalog-performance: PASS — thirty measured compiler/lookup samples per case " +
      `(${Object.keys(evidence.cases).join(", ")}); overflow rejected closed at ` +
      `${String(evidence.overflow.attemptedToolCount)} tools; threshold calibration belongs to ` +
      `#3415; ${JSON.stringify(summary)}`,
  );
}
