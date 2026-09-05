#!/usr/bin/env node
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
  lookupIterations: 1000,
});
function measure(producer, clock) {
  const start = clock();
  const catalog = producer.createInitialToolCatalog();
  const projection = producer.compileToolProjection(catalog, { id: "legacy-native", version: 1 });
  const coldCompileMs = clock() - start;
  const lookupStart = clock();
  let lookups = 0;
  for (let index = 0; index < TOOL_CATALOG_PERFORMANCE_PROCEDURE.lookupIterations; index += 1)
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
  for (const sample of samples) {
    if (
      ![sample.coldCompileMs, sample.lookupBatchMs].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      errors.push("invalid catalog timing");
    if (
      sample.toolCount !== 6 ||
      sample.lookups !== TOOL_CATALOG_PERFORMANCE_PROCEDURE.lookupIterations * sample.toolCount
    )
      errors.push("incomplete catalog fixture work");
    for (const key of ["catalogRevision", "projectionDigest"])
      if (!/^[a-f0-9]{64}$/u.test(sample[key]) || sample[key] !== samples[0][key])
        errors.push("catalog performance identity mismatch");
  }
  return errors;
}
export async function measureToolCatalogPerformance(
  root = process.cwd(),
  clock = () => performance.now(),
) {
  const producer = await loadToolCatalogProducer(root);
  for (let index = 0; index < TOOL_CATALOG_PERFORMANCE_PROCEDURE.warmups; index += 1)
    measure(producer, clock);
  const samples = [];
  for (let batch = 0; batch < TOOL_CATALOG_PERFORMANCE_PROCEDURE.batches; batch += 1)
    for (let index = 0; index < TOOL_CATALOG_PERFORMANCE_PROCEDURE.samplesPerBatch; index += 1)
      samples.push(measure(producer, clock));
  const errors = validateToolCatalogPerformanceSamples(samples);
  if (errors.length > 0) throw new TypeError(errors.join("; "));
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
  return {
    schemaVersion: 1,
    evidenceClass: "functional-performance-not-platform-qualified",
    role: "development-measurement",
    thresholdOwnerIssue: 3415,
    procedure: TOOL_CATALOG_PERFORMANCE_PROCEDURE,
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
    samples,
    aggregates,
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
  console.log(
    `tool-catalog-performance: PASS — thirty measured compiler/lookup samples; threshold calibration belongs to #3415; ${JSON.stringify(evidence.aggregates)}`,
  );
}
