import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { URL, fileURLToPath } from "node:url";

import {
  RETRIEVAL_CONTEXT_BUDGETS,
  isCodingContextPurpose,
  tierForRetrievalContextSource,
  toCodingContextWirePack,
} from "@oscharko-dev/keiko-contracts";
import {
  LocalKnowledgeEval,
  evaluateFloors,
  runRegressionProbes,
} from "@oscharko-dev/keiko-evaluations";
import {
  ANN_INDEX_BUILD_TIMEOUT_MS,
  ANN_INDEX_QUERY_TIMEOUT_MS,
  getCapsule,
  openKnowledgeStore,
  resolveVectorIndexOptions,
  runLocalKnowledgeRetrieval,
  searchVectorIndex,
} from "@oscharko-dev/keiko-local-knowledge";
import {
  deterministicVector,
  scriptedAdapter,
  seedCapsuleWithVectors,
} from "@oscharko-dev/keiko-local-knowledge/testing";
import { verifyEmbeddingCapability } from "@oscharko-dev/keiko-model-gateway";
import {
  evaluateGroundedRetrievalBudget,
  runGroundedRetrievalQualityEval,
} from "@oscharko-dev/keiko-server";

import { runGroundedFaithfulnessGate } from "../check-grounded-faithfulness.mjs";
import { runGroundedRetrievalQualityGate } from "../check-grounded-retrieval-quality.mjs";
import {
  REGRESSION_PROBE_FIXTURE_IDS,
  runRetrievalQualityCheck,
} from "../check-retrieval-quality.mjs";
import { provisionedUsearchBinaryPath } from "../provision-usearch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE_PATH = join(ROOT, "docs/qa/knowledge-m2-substrate-evidence.md");
// Issue #2631: a companion characterization document for the recorded latency comparison. Kept
// separate from EVIDENCE_PATH because wall-clock milliseconds are not hash-comparable across
// hosts. This file is refreshed by `--write` runs and read only by humans; it is not part of the
// deterministic gate verdict.
const LATENCY_CHARACTERIZATION_PATH = join(
  ROOT,
  "docs/qa/knowledge-m2-ann-latency-characterization.md",
);
const WAVE_RECORD_PATH = join(ROOT, "docs/qa/knowledge-m2-wave.md");
const FACADE_PATH = "packages/keiko-server/src/grounded-rerank-facade.ts";
const VECTOR_ROWS = 20_001;
const EXACT_SCAN_CAP = 20_000;
const TOP_K = 10;
const VECTOR_DIMENSIONS = 4;
const VECTOR_MODEL_ID = "knowledge-m2-closeout-vector";
// Issue #2631 acceptance: the latency claim needs a realistic embedding space and diverse held-out
// queries. The 4-dim correctness fixture stays deterministic and cheap; this 384-dim fixture proves
// that the shared service selects exact search below its crossover and genuine USearch HNSW above
// it, while comparing the warm HNSW query against an independently computed exact top-K.
const LATENCY_VECTOR_DIMENSIONS = 384;
const LATENCY_MODEL_ID = "knowledge-m2-closeout-latency-vector";
const LATENCY_LARGE_ROWS = 50_000;
const LATENCY_SMALL_ROWS = 500;
const LATENCY_QUERY_COUNT = 10;
const ANN_RECALL_FLOOR = 0.95;
const MAX_QUALIFIED_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_QUALIFIED_INDEX_RSS_DELTA_BYTES = 512 * 1024 * 1024;
const EXPECTED_WIRE_SNAPSHOT_HASH =
  "9ee38880de5f349e56f27724dd35c7472c661629a79541434dde5ca27036b8a9";
export const EXPECTED_EVALUATION_SCORECARD_HASH =
  "8c0b19e097f39cba61fbe588c64996db64c8b676c3f4b8b401ecd0c84bf0986b";
const QUERY_VECTORS = [
  new Float32Array([1, 0, 0, 0]),
  new Float32Array([0, 1, 0, 0]),
  new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0, 0]),
];

export const PROOF_IDS = [
  "ann-active",
  "reranker-facade",
  "eval-harness",
  "retrieval-context-wire",
  "repository-pod",
  "program-bookkeeping",
];

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    const pairs = entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function proof(id, failures, metrics) {
  return { id, ok: failures.length === 0, failures, metrics };
}

function appendFailure(failures, failed, message) {
  if (failed) failures.push(message);
}

function narrowedCandidateCount(candidateCount, rowCount) {
  return Number.isSafeInteger(candidateCount) && candidateCount > 0 && candidateCount < rowCount;
}

function qualifiedIndexBytes(estimatedIndexBytes) {
  return (
    Number.isSafeInteger(estimatedIndexBytes) &&
    estimatedIndexBytes > 0 &&
    estimatedIndexBytes <= MAX_QUALIFIED_INDEX_BYTES
  );
}

function recallsMeetFloor(recalls) {
  return recalls.every((recall) => Number.isFinite(recall) && recall >= ANN_RECALL_FLOOR);
}

// Extracted from `evaluateAnnProof` so each concern stays under the complexity/line ceiling: the
// original correctness fixture, the ADR-0153 encrypted-store boundary, the Issue #2631 latency
// comparison, and the Issue #2631 injected-regression proof. Each helper appends to a shared
// `failures` array so the assertion order stays reader-visible.
function annCorrectnessFailures(input) {
  const failures = [];
  appendFailure(failures, input.vectorRows <= input.exactScanCap, "corpus-not-above-exact-cap");
  appendFailure(failures, input.activeStatus !== "available", `ann-status:${input.activeStatus}`);
  appendFailure(failures, input.provider !== "usearch", `ann-provider:${input.provider}`);
  appendFailure(failures, input.searchMode !== "ann", `ann-search-mode:${input.searchMode}`);
  appendFailure(
    failures,
    !narrowedCandidateCount(input.examinedCandidateCount, input.vectorRows),
    "ann-did-not-narrow-candidates",
  );
  appendFailure(
    failures,
    !qualifiedIndexBytes(input.estimatedIndexBytes),
    "ann-index-bytes-over-bound",
  );
  appendFailure(failures, !recallsMeetFloor(input.recalls), "ann-recall-below-0.95");
  appendFailure(failures, input.loadFailureReason !== "runtime-unavailable", "load-fallback");
  appendFailure(failures, input.disabledStatus !== "disabled", "disabled-negative-control");
  appendFailure(failures, input.partitionViolations !== 0, "capsule-partition-crossed");
  return failures;
}

// The native graph is rebuilt only from vectors decrypted inside the store boundary. SQLite never
// receives extension authority, and the reviewed runtime path may not call persistence APIs; these
// assertions jointly prove encryption reachability plus the no-spill design.
function annEncryptedBoundaryFailures(input) {
  const failures = [];
  if (input.encryptedAnnStatus !== "available")
    failures.push(`encrypted-ann:${input.encryptedAnnStatus}`);
  if (input.sqliteExtensionDenied !== true) failures.push("sqlite-extension-authority-open");
  if (input.persistenceApiReferences !== 0) failures.push("usearch-persistence-api-referenced");
  return failures;
}

// Raw milliseconds are host-specific, but their within-run ordering is not: at 50k x 384 the warm
// HNSW median must beat an independently computed exact median while retaining recall. The build
// and RSS checks qualify the cost that query-only measurements intentionally exclude.
function annLatencyBeatsExact(input) {
  return (
    Number.isFinite(input.latencyLargeAnnMedianMs) &&
    Number.isFinite(input.latencyLargeExactMedianMs) &&
    input.latencyLargeAnnMedianMs < input.latencyLargeExactMedianMs
  );
}

// KEIKO-0362: the checks above are all RELATIVE — "ANN beat exact", "the build took some positive
// time". A build that consumed 100s of its own 120s production timeout satisfies both while having
// no headroom left for a real corpus, a slower machine, or growth; the proof would have called that
// closed. These ceilings add the absolute half.
//
// Calibration, stated openly because this gate runs on required CI (ci.yml) and a false RED costs
// a full cycle. Measured on an Apple-silicon dev machine at 50k x 384: build 38.8s, ANN query
// median 14ms. The build fraction is 0.75 (90s) rather than something tighter: at 0.5 the ceiling
// would sit at 60s, only 1.5x the local measurement, and a hosted runner roughly 2x slower would
// false-RED. 90s still means what it says — a build past three quarters of its own production
// timeout has drifted into that timeout's territory and should stop the proof. The query fraction
// is 0.5 (15s) because the observed median is three orders of magnitude below it; there is no
// tension to trade there. Neither number is a performance target, and tightening them with real
// CI-runner data is a calibration decision for the ADR-0164 D6 owner. The timeouts themselves are
// imported, never re-declared, so the gate and production can never disagree.
const ANN_BUILD_LATENCY_HEADROOM = 0.75;
const ANN_QUERY_LATENCY_HEADROOM = 0.5;
const MAX_QUALIFIED_BUILD_MS = ANN_INDEX_BUILD_TIMEOUT_MS * ANN_BUILD_LATENCY_HEADROOM;
const MAX_QUALIFIED_ANN_QUERY_MS = ANN_INDEX_QUERY_TIMEOUT_MS * ANN_QUERY_LATENCY_HEADROOM;

function qualifiedBuildLatency(latencyLargeBuildMs) {
  return (
    Number.isFinite(latencyLargeBuildMs) &&
    latencyLargeBuildMs > 0 &&
    latencyLargeBuildMs <= MAX_QUALIFIED_BUILD_MS
  );
}

function qualifiedAnnQueryLatency(latencyLargeAnnMedianMs) {
  return (
    Number.isFinite(latencyLargeAnnMedianMs) &&
    latencyLargeAnnMedianMs > 0 &&
    latencyLargeAnnMedianMs <= MAX_QUALIFIED_ANN_QUERY_MS
  );
}

function qualifiedRssDelta(latencyLargeRssDeltaBytes) {
  return (
    Number.isFinite(latencyLargeRssDeltaBytes) &&
    latencyLargeRssDeltaBytes >= 0 &&
    latencyLargeRssDeltaBytes <= MAX_QUALIFIED_INDEX_RSS_DELTA_BYTES
  );
}

function annLatencyFailures(input) {
  const failures = [];
  appendFailure(
    failures,
    input.latencyLargeRows !== LATENCY_LARGE_ROWS,
    `latency-large-rows:${String(input.latencyLargeRows)}`,
  );
  appendFailure(
    failures,
    input.latencySmallRows !== LATENCY_SMALL_ROWS,
    `latency-small-rows:${String(input.latencySmallRows)}`,
  );
  appendFailure(
    failures,
    !Number.isFinite(input.latencyLargeMinRecall) || input.latencyLargeMinRecall < ANN_RECALL_FLOOR,
    "latency-large-recall-below-0.95",
  );
  appendFailure(failures, input.latencyLargeSearchMode !== "ann", "latency-large-not-ann");
  appendFailure(failures, input.latencySmallSearchMode !== "exact", "latency-small-not-exact");
  appendFailure(
    failures,
    !narrowedCandidateCount(input.latencyLargeExaminedCandidateCount, input.latencyLargeRows),
    "latency-large-did-not-narrow-candidates",
  );
  appendFailure(
    failures,
    !qualifiedIndexBytes(input.latencyLargeEstimatedIndexBytes),
    "latency-large-index-bytes-over-bound",
  );
  appendFailure(failures, !annLatencyBeatsExact(input), "latency-large-ann-not-faster");
  appendFailure(
    failures,
    !qualifiedAnnQueryLatency(input.latencyLargeAnnMedianMs),
    `latency-large-query-near-timeout:${String(input.latencyLargeAnnMedianMs)}>${String(MAX_QUALIFIED_ANN_QUERY_MS)}`,
  );
  appendFailure(
    failures,
    !qualifiedBuildLatency(input.latencyLargeBuildMs),
    `latency-large-build-not-measured-or-near-timeout:${String(input.latencyLargeBuildMs)}>${String(MAX_QUALIFIED_BUILD_MS)}`,
  );
  appendFailure(
    failures,
    !qualifiedRssDelta(input.latencyLargeRssDeltaBytes),
    "latency-large-rss-over-bound",
  );
  return failures;
}

// Issue #2631 acceptance: an injected-regression proof — swapping the ANN index for a degenerate
// one must drop retrieval below the floors. The healthy control lives in `input.recalls`; the
// degenerate branch fails if a future change reverts the injection to the healthy index, so both
// the assertion and its falsification live in the same proof.
function annDegenerateInjectionFailures(input) {
  if (
    input.degenerateInjectionRecalls === undefined ||
    input.degenerateInjectionRecalls.length === 0
  )
    return ["degenerate-injection-not-measured"];
  if (input.degenerateInjectionRecalls.some((recall) => !Number.isFinite(recall) || recall >= 0.95))
    return ["degenerate-injection-still-above-floor"];
  return [];
}

export function evaluateAnnProof(input) {
  const failures = [
    ...annCorrectnessFailures(input),
    ...annEncryptedBoundaryFailures(input),
    ...annLatencyFailures(input),
    ...annDegenerateInjectionFailures(input),
  ];
  return proof("ann-active", failures, input);
}

export function evaluateFacadeProof(input) {
  const failures = [];
  if (input.importers.length !== 1 || input.importers[0] !== FACADE_PATH) {
    failures.push(`transport-importers:${input.importers.join(",")}`);
  }
  if (input.missingDiagnosticFields.length > 0) failures.push("diagnostics-contract-incomplete");
  return proof("reranker-facade", failures, input);
}

export function evaluateEvalProof(input) {
  const failures = [];
  if (input.actualScorecardHash !== input.expectedScorecardHash)
    failures.push("scorecards-not-golden-identical");
  if (!input.regressionProbesLive) failures.push("regression-probes-not-live");
  if (!input.tautologyDetected) failures.push("tautology-control-not-detected");
  if (!input.groundedGateOk) failures.push("grounded-retrieval-gate");
  if (!input.faithfulnessGateOk) failures.push("grounded-faithfulness-gate");
  return proof("eval-harness", failures, input);
}

export function evaluateWireProof(input) {
  const failures = [];
  if (input.wireHash !== input.expectedWireHash) failures.push("wire-snapshot-drift");
  if (input.neutralPurpose !== "chat-grounding") failures.push("neutral-assembly-purpose");
  if (!input.editorRejectedNeutralPurpose) failures.push("editor-purpose-accepted-neutral");
  return proof("retrieval-context-wire", failures, input);
}

export function evaluateRepositoryPodProof(input) {
  const failures = [];
  if (!input.scorecardOk) failures.push("grounded-retrieval-scorecard");
  if (input.providerName !== "configured-repo-semantic-search") failures.push("provider-name");
  if (input.askTimeDocumentEmbeddingCount !== 0) failures.push("ask-time-document-embedding");
  if (input.fingerprintCount !== input.caseCount) failures.push("repository-fingerprint-coverage");
  if (input.indexedPathCount !== input.caseCount) failures.push("repository-index-coverage");
  if (input.alignedVectorCount !== input.caseCount) failures.push("repository-vector-alignment");
  // `editorProviderStatus` is deliberately NOT a verdict input: the editor repo-search provider runs
  // on the keystroke-sensitive path where embedding-cost providers are excluded by design, so both
  // of its producer's two values are legitimate. It is carried as informational characterization.
  return proof("repository-pod", failures, input);
}

export function evaluateBookkeepingProof(input) {
  const required = new Set(["hs6-window-closure", "matrix-a-substrate-delta"]);
  const ready = new Set(
    input.items.filter((item) => item.status === "ready").map((item) => item.id),
  );
  const missing = [...required].filter((id) => !ready.has(id));
  return proof(
    "program-bookkeeping",
    missing.map((id) => `not-ready:${id}`),
    input,
  );
}

// docs/qa/knowledge-m2-wave.md is the wave's coordination state. The bookkeeping proof reads the
// real `- [x]` / `- [ ]` state out of it rather than asserting a constant: an unsettled HS-6
// single-writer block or an open M2.8 wave-closeout row must keep the closeout gate red.
export const HS6_SINGLE_WRITER_FILE_COUNT = 11;
const HS6_SECTION_HEADING = "## HS-6 single-writer files";
const WAVE_CLOSEOUT_ROW = /^- \[([ x])\] M2\.8 owns wave closeout evidence/mu;

function sectionBody(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const rest = markdown.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

function checkboxStates(body) {
  return [...body.matchAll(/^- \[([ x])\]/gmu)].map((match) => match[1] === "x");
}

export function parseWaveBookkeepingItems(markdown) {
  const hs6 = checkboxStates(sectionBody(markdown, HS6_SECTION_HEADING));
  // An emptied block must not read as settled, so the file count is asserted alongside the state.
  const hs6Ready = hs6.length === HS6_SINGLE_WRITER_FILE_COUNT && hs6.every(Boolean);
  const closeout = WAVE_CLOSEOUT_ROW.exec(markdown);
  return [
    { id: "hs6-window-closure", status: hs6Ready ? "ready" : "pending" },
    { id: "matrix-a-substrate-delta", status: closeout?.[1] === "x" ? "ready" : "pending" },
  ];
}

export function readWaveBookkeepingItems() {
  return parseWaveBookkeepingItems(readFileSync(WAVE_RECORD_PATH, "utf8"));
}

export function evaluateProofSet(results) {
  const failedProofs = results.filter((result) => !result.ok).map((result) => result.id);
  return { ok: failedProofs.length === 0, failedProofs };
}

function vectorAdapter(queryVector) {
  return scriptedAdapter({
    responder: (request) => ({
      ok: true,
      value: {
        vector:
          request.input === "ping" || request.input.startsWith("Keiko embedding space probe:")
            ? deterministicVector(request.input, VECTOR_DIMENSIONS)
            : queryVector,
        modelId: VECTOR_MODEL_ID,
      },
    }),
  });
}

async function verifiedVectorIdentity() {
  const result = await verifyEmbeddingCapability(vectorAdapter(QUERY_VECTORS[0]), {
    modelId: VECTOR_MODEL_ID,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: VECTOR_DIMENSIONS,
    normalization: "l2",
    instructionVersion: "keiko-embedding-input-v1",
    includeSpaceFingerprint: true,
  });
  if (!result.ok) throw new Error(`embedding identity verification failed:${result.reason}`);
  return result.identity;
}

function corpusVector(ordinal) {
  if (ordinal < TOP_K) {
    const offset = (ordinal + 1) * 0.03;
    const length = Math.hypot(1, offset);
    return new Float32Array([1 / length, offset / length, 0, 0]);
  }
  if (ordinal < TOP_K * 2) {
    const offset = (ordinal - TOP_K + 1) * 0.03;
    const length = Math.hypot(offset, 1);
    return new Float32Array([offset / length, 1 / length, 0, 0]);
  }
  if (ordinal < TOP_K * 3) {
    const angle = Math.PI / 4 + (ordinal - TOP_K * 2 + 1) * 0.01;
    return new Float32Array([Math.cos(angle), Math.sin(angle), 0, 0]);
  }
  return new Float32Array([-1, 0, 0, 0]);
}

function float32Bytes(vector) {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}

function cloneChunkStatement(store) {
  return store._internal.db.prepare(
    [
      "INSERT INTO chunks (",
      "  id, capsule_id, source_id, document_id, parsed_unit_id, order_index, token_count,",
      "  safe_excerpt_hash, chunking_strategy_version, character_start, character_end,",
      "  contextual_retrieval_key, context_prefix, augmented_text, context_status, context_updated_at",
      ") SELECT :id, capsule_id, source_id, document_id, parsed_unit_id, :order_index, token_count,",
      "  safe_excerpt_hash, chunking_strategy_version, character_start, character_end,",
      "  contextual_retrieval_key, context_prefix, augmented_text, context_status, context_updated_at",
      "FROM chunks WHERE id = :template_id",
    ].join(" "),
  );
}

async function vectorPersistModule() {
  return import(
    new URL("../../packages/keiko-local-knowledge/dist/indexing/vector-persist.js", import.meta.url)
  );
}

async function seedSyntheticVectorCorpus(store, seeded, identity, options) {
  const { deleteVectorsForCapsule, insertVectorRow, invalidateVectorIndexStateForCapsules } =
    await vectorPersistModule();
  const templateId = seeded.chunkIds[0];
  if (templateId === undefined) throw new Error("missing synthetic template chunk");
  deleteVectorsForCapsule(store._internal.db, seeded.capsuleId);
  const clone = cloneChunkStatement(store);
  store._internal.db.exec("BEGIN IMMEDIATE");
  try {
    for (let ordinal = 0; ordinal < options.rowCount; ordinal += 1) {
      const chunkId = `${options.chunkIdPrefix}-${String(ordinal).padStart(6, "0")}`;
      clone.run({ id: chunkId, order_index: ordinal + 1, template_id: String(templateId) });
      insertVectorRow(
        store._internal.db,
        store._internal.contentCipher,
        {
          id: `vec:${chunkId}`,
          capsuleId: seeded.capsuleId,
          sourceId: seeded.sourceId,
          documentId: seeded.documentId,
          chunkId,
          embedding: float32Bytes(options.vector(ordinal)),
          identity,
          storageReference: `synthetic-${String(ordinal)}`,
          createdAt: 1_700_000_000_000 + ordinal,
        },
        { invalidateIndexState: false },
      );
    }
    invalidateVectorIndexStateForCapsules(store._internal.db, [seeded.capsuleId]);
    store._internal.db.exec("COMMIT");
  } catch (cause) {
    store._internal.db.exec("ROLLBACK");
    throw cause;
  }
}

async function seedLargeVectorCorpus(store, seeded, identity) {
  await seedSyntheticVectorCorpus(store, seeded, identity, {
    rowCount: VECTOR_ROWS,
    chunkIdPrefix: "m2-ann",
    vector: corpusVector,
  });
}

// A pseudo-random L2-unit vector for `dimensions`-dim latency measurements. Deterministic in
// `ordinal` so a rerun measures the same corpus; the spread across the unit sphere gives HNSW
// meaningful neighbourhood structure rather than identical-distance tie breaking.
function latencyVector(ordinal, dimensions) {
  const values = new Float32Array(dimensions);
  let sumOfSquares = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const raw = Math.sin((ordinal + 1) * (index + 1) * 0.017) + Math.cos((ordinal + 1) * 0.031);
    values[index] = raw;
    sumOfSquares += raw * raw;
  }
  const scale = 1 / Math.sqrt(Math.max(sumOfSquares, Number.EPSILON));
  for (let index = 0; index < dimensions; index += 1) {
    values[index] = (values[index] ?? 0) * scale;
  }
  return values;
}

function perturbedLatencyVector(center, seed, amplitude) {
  const values = new Float32Array(center.length);
  let sumOfSquares = 0;
  for (let index = 0; index < center.length; index += 1) {
    const noise = Math.sin((seed + 1) * (index + 3) * 0.019) * amplitude;
    const value = (center[index] ?? 0) + noise;
    values[index] = value;
    sumOfSquares += value * value;
  }
  const scale = 1 / Math.sqrt(Math.max(sumOfSquares, Number.EPSILON));
  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] ?? 0) * scale;
  }
  return values;
}

function latencyCorpusVector(ordinal) {
  const cluster = Math.floor(ordinal / 50);
  const center = latencyVector(100_000 + cluster * 97, LATENCY_VECTOR_DIMENSIONS);
  return perturbedLatencyVector(center, ordinal, 0.025);
}

function latencyQueryVector(queryIndex) {
  const cluster = queryIndex * 67;
  const center = latencyVector(100_000 + cluster * 97, LATENCY_VECTOR_DIMENSIONS);
  return perturbedLatencyVector(center, -queryIndex - 1, 0.02);
}

function decodedVector(bytes) {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

function dotProduct(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function exactTopK(rows, queryVector) {
  return rows
    .map((row) => ({
      chunkId: row.chunk_id,
      score: dotProduct(decodedVector(row.embedding), queryVector),
    }))
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId))
    .slice(0, TOP_K);
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latencyBucket(value) {
  const ceilings = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];
  const ceiling = ceilings.find((candidate) => value <= candidate);
  return ceiling === undefined ? ">30000ms" : `<=${String(ceiling)}ms`;
}

function measure(run) {
  const started = performance.now();
  const value = run();
  return { value, elapsedMs: performance.now() - started };
}

async function measureAsync(run) {
  const started = performance.now();
  const value = await run();
  return { value, elapsedMs: performance.now() - started };
}

function recallAtK(actual, expected) {
  const expectedIds = new Set(expected.map((candidate) => candidate.chunkId));
  return actual.filter((candidate) => expectedIds.has(candidate.chunkId)).length / TOP_K;
}

function sqliteExtensionAuthorityDenied(store) {
  try {
    store._internal.db.enableLoadExtension(true);
    return false;
  } catch {
    return true;
  }
}

function usearchPersistenceApiReferences() {
  const paths = [
    join(ROOT, "packages/keiko-local-knowledge/src/retrieval/usearch-ann-index.ts"),
    join(ROOT, "packages/keiko-local-knowledge/src/retrieval/usearch-index-worker.ts"),
  ];
  return paths.reduce((count, path) => {
    const source = readFileSync(path, "utf8");
    return count + [...source.matchAll(/\bindex\.(?:load|save|view)\s*\(/gu)].length;
  }, 0);
}

async function annMeasurements(store, capsule, rows, vectorIndex) {
  const recalls = [];
  const annLatency = [];
  const exactLatency = [];
  let partitionViolations = 0;
  for (const queryVector of QUERY_VECTORS) {
    const exact = measure(() => exactTopK(rows, queryVector));
    const ann = await measureAsync(() =>
      searchVectorIndex({ store, capsule, queryVector, candidateLimit: TOP_K }, vectorIndex),
    );
    if (!ann.value.ok) throw new Error(`ANN query failed:${ann.value.diagnostics.reason}`);
    recalls.push(recallAtK(ann.value.candidates, exact.value));
    partitionViolations += ann.value.candidates.filter(
      (candidate) => String(candidate.capsuleId) !== String(capsule.id),
    ).length;
    annLatency.push(ann.elapsedMs);
    exactLatency.push(exact.elapsedMs);
  }
  return { recalls, annLatency, exactLatency, partitionViolations };
}

// Issue #2631 acceptance: injected-regression proof. The adapter returns a FIXED candidate set that
// bears no relation to the query, so recall drops to zero against every query in the fixture; if a
// future change makes the adapter return the healthy top-K, recall recovers, the assertion in
// `evaluateAnnProof.degenerateInjectionRecalls` fails, and the proof fails. That is the intended
// dependency — the assertion here is exactly the one that fails when the injection is reverted.
function degenerateVectorIndexAdapter(fixedChunkIds, capsuleId) {
  return {
    searchCapsule: async () => ({
      ok: true,
      candidates: fixedChunkIds.map((chunkId) => ({ chunkId, capsuleId, score: 0.5 })),
      sawDimensionCompatible: true,
      sawIdentityIncompatible: false,
      diagnostics: {
        provider: "usearch",
        status: "available",
        indexName: "m2-ann-degenerate-injection",
        vectorCount: fixedChunkIds.length,
        searchMode: "ann",
        examinedCandidateCount: fixedChunkIds.length,
        estimatedIndexBytes: 1,
      },
    }),
  };
}

async function measureDegenerateInjection(store, capsule, rows) {
  // Pick K chunks from the END of the corpus (ordinals >= TOP_K * 3), which corpusVector maps to
  // [-1, 0, 0, 0] — antipodal to every QUERY_VECTORS entry. These CANNOT be in any healthy top-K, so
  // if `evaluateAnnProof.degenerateInjectionRecalls` observes any recall >= 0.95, the injection has
  // been silently converted into the healthy path. Fixed decoys, chosen once, make the proof stable.
  const decoyChunkIds = rows.slice(rows.length - TOP_K).map((row) => row.chunk_id);
  const adapter = degenerateVectorIndexAdapter(decoyChunkIds, capsule.id);
  const recalls = [];
  for (const queryVector of QUERY_VECTORS) {
    const exact = exactTopK(rows, queryVector);
    const result = await searchVectorIndex(
      { store, capsule, queryVector, candidateLimit: TOP_K },
      { mode: "auto", adapter },
    );
    if (!result.ok) throw new Error(`degenerate injection failed:${result.diagnostics.reason}`);
    recalls.push(recallAtK(result.candidates, exact));
  }
  return { recalls, decoyChunkCount: decoyChunkIds.length };
}

function latencyAdapter(queryVector) {
  return scriptedAdapter({
    responder: (request) => ({
      ok: true,
      value: {
        vector:
          request.input === "ping" || request.input.startsWith("Keiko embedding space probe:")
            ? deterministicVector(request.input, LATENCY_VECTOR_DIMENSIONS)
            : queryVector,
        modelId: LATENCY_MODEL_ID,
      },
    }),
  });
}

async function verifiedLatencyIdentity() {
  const probeVector = latencyVector(0, LATENCY_VECTOR_DIMENSIONS);
  const result = await verifyEmbeddingCapability(latencyAdapter(probeVector), {
    modelId: LATENCY_MODEL_ID,
    provider: "openai",
    vectorMetric: "cosine",
    expectedDimensions: LATENCY_VECTOR_DIMENSIONS,
    normalization: "l2",
    instructionVersion: "keiko-embedding-input-v1",
    includeSpaceFingerprint: true,
  });
  if (!result.ok) throw new Error(`latency identity verification failed:${result.reason}`);
  return result.identity;
}

async function measuredIndexBuild(store, capsule, vectorIndex, queryVector) {
  const rssBefore = process.memoryUsage().rss;
  const built = await measureAsync(() =>
    searchVectorIndex({ store, capsule, queryVector, candidateLimit: TOP_K }, vectorIndex),
  );
  if (!built.value.ok) {
    throw new Error(`latency index build failed:${built.value.diagnostics.reason}`);
  }
  return {
    buildMs: built.elapsedMs,
    rssDeltaBytes: Math.max(0, process.memoryUsage().rss - rssBefore),
    diagnostics: built.value.diagnostics,
  };
}

async function measureLatencyOnRows(store, capsule, rows, vectorIndex, queryVectors) {
  const firstQuery = queryVectors[0];
  if (firstQuery === undefined) throw new Error("missing latency query");
  const build = await measuredIndexBuild(store, capsule, vectorIndex, firstQuery);
  const annLatency = [];
  const exactLatency = [];
  const recalls = [];
  let examinedCandidateCount = 0;
  for (const queryVector of queryVectors) {
    const exact = measure(() => exactTopK(rows, queryVector));
    const ann = await measureAsync(() =>
      searchVectorIndex({ store, capsule, queryVector, candidateLimit: TOP_K }, vectorIndex),
    );
    if (!ann.value.ok) throw new Error(`latency ANN query failed:${ann.value.diagnostics.reason}`);
    annLatency.push(ann.elapsedMs);
    exactLatency.push(exact.elapsedMs);
    recalls.push(recallAtK(ann.value.candidates, exact.value));
    examinedCandidateCount = Math.max(
      examinedCandidateCount,
      ann.value.diagnostics.examinedCandidateCount ?? 0,
    );
  }
  return {
    annMedianMs: percentile(annLatency, 0.5),
    exactMedianMs: percentile(exactLatency, 0.5),
    minRecall: Math.min(...recalls),
    buildMs: build.buildMs,
    rssDeltaBytes: build.rssDeltaBytes,
    searchMode: build.diagnostics.searchMode,
    examinedCandidateCount,
    estimatedIndexBytes: build.diagnostics.estimatedIndexBytes,
  };
}

async function measureLatencyAt(vectorIndex, identity, rowCount, capsuleId, chunkIdPrefix) {
  // A separate store per size keeps the shared service cache isolated, so both sizes measure an
  // independent build and the configured exact/HNSW crossover.
  const store = openKnowledgeStore({ dbPath: ":memory:", vectorIndex });
  try {
    const seeded = await seedCapsuleWithVectors(store, {
      capsuleId,
      sourceId: `${capsuleId}-source`,
      documentId: `${capsuleId}-document`,
      identity,
      text: "latency",
    });
    await seedSyntheticVectorCorpus(store, seeded, identity, {
      rowCount,
      chunkIdPrefix,
      vector: latencyCorpusVector,
    });
    const capsule = getCapsule(store, seeded.capsuleId);
    if (capsule === undefined) throw new Error("missing latency capsule");
    const rows = store._internal.db
      .prepare(
        "SELECT chunk_id, embedding FROM vectors WHERE capsule_id = :capsule ORDER BY chunk_id",
      )
      .all({ capsule: String(seeded.capsuleId) });
    // Queries are noisy held-out vectors around distinct corpus clusters.
    const queryVectors = Array.from({ length: LATENCY_QUERY_COUNT }, (_, index) =>
      latencyQueryVector(index),
    );
    const measured = await measureLatencyOnRows(store, capsule, rows, vectorIndex, queryVectors);
    return { rows: rows.length, ...measured };
  } finally {
    store.close();
  }
}

async function runLatencyBenchmark(vectorIndex) {
  const identity = await verifiedLatencyIdentity();
  const large = await measureLatencyAt(
    vectorIndex,
    identity,
    LATENCY_LARGE_ROWS,
    "m2-latency-large",
    "m2-lat-lg",
  );
  const small = await measureLatencyAt(
    vectorIndex,
    identity,
    LATENCY_SMALL_ROWS,
    "m2-latency-small",
    "m2-lat-sm",
  );
  return { large, small };
}

async function seedAnnProofStore(store, identity) {
  const seeded = await seedCapsuleWithVectors(store, {
    capsuleId: "m2-ann",
    sourceId: "m2-ann-source",
    documentId: "m2-ann-document",
    identity,
    text: "alpha",
  });
  await seedCapsuleWithVectors(store, {
    capsuleId: "m2-partition",
    sourceId: "m2-partition-source",
    documentId: "m2-partition-document",
    identity,
    text: "beta",
  });
  await seedLargeVectorCorpus(store, seeded, identity);
  return seeded;
}

// The reviewed native addon is provisioned outside npm. With no verified target binary the proof
// fails closed instead of certifying the exact fallback as though HNSW had run.
function resolvedUsearchBinaryPath() {
  const configured = process.env.KEIKO_USEARCH_BINARY_PATH;
  if (typeof configured === "string" && configured.length > 0 && existsSync(configured)) {
    return configured;
  }
  const candidate = provisionedUsearchBinaryPath(ROOT);
  return existsSync(candidate) ? candidate : undefined;
}

function resolveAnnProofVectorIndex() {
  const binaryPath = resolvedUsearchBinaryPath();
  return resolveVectorIndexOptions(undefined, {
    KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "usearch",
    ...(binaryPath === undefined ? {} : { KEIKO_USEARCH_BINARY_PATH: binaryPath }),
  });
}

function annStoreVectorRows(store, capsuleId) {
  const encryptedRows = store._internal.db
    .prepare(
      "SELECT chunk_id, embedding FROM vectors WHERE capsule_id = :capsule ORDER BY chunk_id",
    )
    .all({ capsule: String(capsuleId) });
  return encryptedRows.map((row) => ({
    chunk_id: row.chunk_id,
    embedding: store._internal.contentCipher.openVector(
      row.embedding,
      VECTOR_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT,
    ),
  }));
}

// Fallback-diagnostic probes that establish `load-fallback` and `disabled-negative-control` for
// `evaluateAnnProof`. Both are cheap `searchVectorIndex` calls that never actually run ANN.
async function annFallbackDiagnostics(store, capsule) {
  const missing = await searchVectorIndex(
    { store, capsule, queryVector: QUERY_VECTORS[0], candidateLimit: TOP_K },
    { mode: "usearch", usearchBinaryPath: "/missing/keiko/m2-usearch.node" },
  );
  const disabled = await searchVectorIndex(
    { store, capsule, queryVector: QUERY_VECTORS[0], candidateLimit: TOP_K },
    { mode: "disabled" },
  );
  return {
    loadFailureReason: missing.diagnostics.reason,
    disabledStatus: disabled.diagnostics.status,
  };
}

function annLatencyMetrics(measured, latency) {
  return {
    annMedianLatency: latencyBucket(percentile(measured.annLatency, 0.5)),
    annP95Latency: latencyBucket(percentile(measured.annLatency, 0.95)),
    exactMedianLatency: latencyBucket(percentile(measured.exactLatency, 0.5)),
    exactP95Latency: latencyBucket(percentile(measured.exactLatency, 0.95)),
    annMedianMs: percentile(measured.annLatency, 0.5),
    exactMedianMs: percentile(measured.exactLatency, 0.5),
    // Issue #2631 acceptance: recorded latency comparison at a realistic embedding-space fixture
    // (LATENCY_VECTOR_DIMENSIONS-dim). The 4-dim correctness fixture stays deliberately toy for
    // hermetic recall/encryption assertions; the realistic-dim fixture proves both execution modes
    // and requires warm HNSW to beat the independently computed exact baseline at 50k rows.
    latencyVectorDimensions: LATENCY_VECTOR_DIMENSIONS,
    latencyLargeRows: latency.large.rows,
    latencyLargeAnnMedianMs: latency.large.annMedianMs,
    latencyLargeExactMedianMs: latency.large.exactMedianMs,
    latencyLargeMinRecall: latency.large.minRecall,
    latencyLargeBuildMs: latency.large.buildMs,
    latencyLargeRssDeltaBytes: latency.large.rssDeltaBytes,
    latencyLargeSearchMode: latency.large.searchMode,
    latencyLargeExaminedCandidateCount: latency.large.examinedCandidateCount,
    latencyLargeEstimatedIndexBytes: latency.large.estimatedIndexBytes,
    latencySmallRows: latency.small.rows,
    latencySmallServiceMedianMs: latency.small.annMedianMs,
    latencySmallExactMedianMs: latency.small.exactMedianMs,
    latencySmallSearchMode: latency.small.searchMode,
    productionExactScanCap: EXACT_SCAN_CAP,
  };
}

function requiredAnnCapsule(store, capsuleId) {
  const capsule = getCapsule(store, capsuleId);
  if (capsule === undefined) throw new Error("missing ANN capsule");
  return capsule;
}

function valueOrFallback(value, fallback) {
  return value ?? fallback;
}

function annPipelineMetrics(pipeline) {
  const vectorIndex = pipeline.diagnostics?.vectorIndex;
  if (vectorIndex === undefined) {
    return {
      activeStatus: "missing",
      provider: "missing",
      searchMode: "missing",
      examinedCandidateCount: 0,
      estimatedIndexBytes: 0,
    };
  }
  return {
    activeStatus: valueOrFallback(vectorIndex.status, "missing"),
    provider: valueOrFallback(vectorIndex.provider, "missing"),
    searchMode: valueOrFallback(vectorIndex.searchMode, "missing"),
    examinedCandidateCount: valueOrFallback(vectorIndex.examinedCandidateCount, 0),
    estimatedIndexBytes: valueOrFallback(vectorIndex.estimatedIndexBytes, 0),
  };
}

async function evaluateAnnProofStore(store, identity, vectorIndex) {
  const seeded = await seedAnnProofStore(store, identity);
  const pipeline = await runLocalKnowledgeRetrieval(
    { store, embeddingAdapter: vectorAdapter(QUERY_VECTORS[0]), vectorIndex },
    { text: "m2-ann-query", capsuleId: seeded.capsuleId, topK: TOP_K },
  );
  const capsule = requiredAnnCapsule(store, seeded.capsuleId);
  const rows = annStoreVectorRows(store, seeded.capsuleId);
  const measured = await annMeasurements(store, capsule, rows, vectorIndex);
  const degenerateInjection = await measureDegenerateInjection(store, capsule, rows);
  const latency = await runLatencyBenchmark(vectorIndex);
  const pipelineMetrics = annPipelineMetrics(pipeline);
  return evaluateAnnProof({
    vectorRows: rows.length,
    exactScanCap: EXACT_SCAN_CAP,
    ...pipelineMetrics,
    recalls: measured.recalls,
    partitionViolations: measured.partitionViolations,
    ...annLatencyMetrics(measured, latency),
    degenerateInjectionRecalls: degenerateInjection.recalls,
    degenerateInjectionDecoyCount: degenerateInjection.decoyChunkCount,
    encryptedAnnStatus: pipelineMetrics.activeStatus,
    sqliteExtensionDenied: sqliteExtensionAuthorityDenied(store),
    persistenceApiReferences: usearchPersistenceApiReferences(),
    ...(await annFallbackDiagnostics(store, capsule)),
  });
}

async function runAnnProof() {
  const identity = await verifiedVectorIdentity();
  const vectorIndex = resolveAnnProofVectorIndex();
  const store = openKnowledgeStore({
    dbPath: ":memory:",
    protection: {
      mode: "encrypted-key-provider",
      keyProvider: {
        providerId: "m2-closeout",
        resolveKey: () => new Uint8Array(32).fill(17),
      },
    },
  });
  try {
    return await evaluateAnnProofStore(store, identity, vectorIndex);
  } finally {
    store.close();
  }
}

function sourceFilesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

export function rerankerImportProofFromEntries(entries) {
  const transportImport =
    /import\s*\{[^}]*\brequestLiteLLMRerank\b[^}]*\}\s*from\s*["']@oscharko-dev\/keiko-model-gateway["']/su;
  const importers = entries
    .filter((entry) => transportImport.test(entry.source))
    .map((entry) => entry.path)
    .sort();
  return { importers };
}

// The reranker orchestration deleted by 46323c4d must not return through a second call site. The
// structural guard is the importer set itself: exactly one file under packages/keiko-server/src may
// import the LiteLLM rerank transport, and it must be the facade.
export const REQUIRED_RERANKER_DIAGNOSTIC_FIELDS = [
  "status",
  "mode",
  "candidateCount",
  "documentCount",
  "keptCount",
  "failureKind",
  "latencyMs",
];

function namedInterfaceBody(source, name) {
  const opening = `export interface ${name} {`;
  const start = source.indexOf(opening);
  if (start < 0) return undefined;
  const bodyStart = start + opening.length;
  const end = source.indexOf("\n}", bodyStart);
  return end < 0 ? undefined : source.slice(bodyStart, end);
}

export function missingRerankerDiagnosticFields(source) {
  const body = namedInterfaceBody(source, "GroundedRerankerDiagnostics");
  if (body === undefined) return [...REQUIRED_RERANKER_DIAGNOSTIC_FIELDS];
  return REQUIRED_RERANKER_DIAGNOSTIC_FIELDS.filter(
    (field) => !new RegExp(String.raw`readonly\s+${field}[?:]`, "u").test(body),
  );
}

function runFacadeProof() {
  const serverRoot = join(ROOT, "packages/keiko-server/src");
  const entries = sourceFilesUnder(serverRoot).map((path) => ({
    path: relative(ROOT, path),
    source: readFileSync(path, "utf8"),
  }));
  const importProof = rerankerImportProofFromEntries(entries);
  const contract = readFileSync(join(ROOT, "packages/keiko-contracts/src/bff-wire.ts"), "utf8");
  return evaluateFacadeProof({
    ...importProof,
    missingDiagnosticFields: missingRerankerDiagnosticFields(contract),
    importerHash: sha256(stableStringify(importProof.importers)),
  });
}

function qualityScorecardHash(result) {
  return sha256(
    stableStringify({
      workspace: result.summary,
      localKnowledge: result.localKnowledge.scorecards,
      comparison: result.localKnowledge.comparison,
    }),
  );
}

async function proveTautologyDetection() {
  const fixture = LocalKnowledgeEval.ALL_FIXTURES[0];
  if (fixture === undefined) throw new Error("missing Local Knowledge fixture");
  const result = await runRegressionProbes({
    fixtures: [fixture],
    probeFixtureIds: [fixture.id],
    fixtureId: (item) => item.id,
    regressFixture: (item) => structuredClone(item),
    runFixture: LocalKnowledgeEval.runRetrievalEval,
    droppedBelowFloors: (card) =>
      !evaluateFloors(card.dimensions, LocalKnowledgeEval.PASS_THRESHOLDS).ok,
  });
  return !result.ok && result.tautological.includes(fixture.id);
}

function failingGate(message) {
  throw new Error(message);
}

async function runEvalProof() {
  const options = { log: () => undefined, fail: failingGate };
  const current = await runRetrievalQualityCheck(options);
  const grounded = await runGroundedRetrievalQualityGate(options);
  const faithfulness = runGroundedFaithfulnessGate(options);
  return evaluateEvalProof({
    actualScorecardHash: qualityScorecardHash(current),
    expectedScorecardHash: EXPECTED_EVALUATION_SCORECARD_HASH,
    fixtureCount: current.localKnowledge.scorecards.length,
    regressionProbeCount: current.regression.probed,
    regressionProbesLive:
      current.regression.ok && current.regression.probed === REGRESSION_PROBE_FIXTURE_IDS.length,
    tautologyDetected: await proveTautologyDetection(),
    groundedGateOk: grounded.ok,
    faithfulnessGateOk: faithfulness.ok,
  });
}

function codingWireFixture() {
  return {
    schemaVersion: "1",
    purpose: "completion",
    excerpts: [
      {
        citation: {
          sourceKind: "repo-search",
          sourceTier: "first-party-workspace",
          id: "m2-wire-fixture",
          score: 0.75,
          rank: 0,
          citationRef: "fixture.ts",
          byteCount: 7,
          truncated: false,
        },
        text: "private",
      },
    ],
    usedBytes: 7,
    budgetBytes: 32_768,
    droppedForBudget: 0,
    omissions: [{ sourceKind: "memory", reason: "unavailable" }],
  };
}

async function runWireProof() {
  const { assembleRetrievalContext } = await import(
    new URL("../../packages/keiko-server/dist/retrieval/contextAssembly.js", import.meta.url)
  );
  const neutral = await assembleRetrievalContext({
    purpose: "chat-grounding",
    budget: RETRIEVAL_CONTEXT_BUDGETS["chat-grounding"],
    allowEmbeddingProviders: true,
    signal: new globalThis.AbortController().signal,
    providers: [
      {
        sourceKind: "graph-relations",
        order: 1,
        requiresEmbedding: false,
        run: () => ({
          excerpts: [
            {
              sourceKind: "graph-relations",
              id: "m2-neutral-proof",
              score: 1,
              citationRef: "graph:m2",
              text: "synthetic",
              truncated: false,
            },
          ],
          omission: undefined,
        }),
      },
    ],
    tierForSourceKind: tierForRetrievalContextSource,
  });
  const wireHash = sha256(stableStringify(toCodingContextWirePack(codingWireFixture())));
  return evaluateWireProof({
    wireHash,
    expectedWireHash: EXPECTED_WIRE_SNAPSHOT_HASH,
    neutralPurpose: neutral.purpose,
    editorRejectedNeutralPurpose: !isCodingContextPurpose(neutral.purpose),
  });
}

async function runRepositoryPodProof() {
  const scorecard = await runGroundedRetrievalQualityEval("baseline");
  const editorSource = readFileSync(
    join(ROOT, "packages/keiko-server/src/editor/codingContextProviders.ts"),
    "utf8",
  );
  const editorProviderStatus = editorSource.includes("configuredRepoSemanticSearchProvider")
    ? "pod-backed"
    : "lexical-only";
  return evaluateRepositoryPodProof({
    scorecardOk: evaluateGroundedRetrievalBudget(scorecard).ok,
    providerName: scorecard.semanticProviderName,
    askTimeDocumentEmbeddingCount: scorecard.askTimeDocumentEmbeddingCount,
    caseCount: scorecard.cases,
    fingerprintCount: scorecard.fingerprintCount,
    indexedPathCount: scorecard.indexedPathCount,
    alignedVectorCount: scorecard.alignedVectorCount,
    retrievalModeHash: sha256(stableStringify(scorecard.retrievalModeCounts)),
    editorProviderStatus,
  });
}

export function runBookkeepingProof() {
  return evaluateBookkeepingProof({ items: readWaveBookkeepingItems() });
}

function annEvidenceRows(ann) {
  return [
    ["ANN", "vector rows", String(ann.vectorRows)],
    ["ANN", "exact scan cap", String(ann.exactScanCap)],
    ["ANN", "provider", ann.provider],
    ["ANN", "search mode", ann.searchMode],
    ["ANN", "examined candidate ceiling", `<${String(ann.vectorRows)}`],
    ["ANN", "index byte ceiling", "<=268435456"],
    ["ANN", `minimum recall@${String(TOP_K)}`, Math.min(...ann.recalls).toFixed(3)],
    ["ANN", "encrypted ANN diagnostic", ann.encryptedAnnStatus],
    ["ANN", "SQLite extension authority denied", String(ann.sqliteExtensionDenied)],
    ["ANN", "native persistence API references", String(ann.persistenceApiReferences)],
    ["ANN", "load diagnostic", ann.loadFailureReason],
    ["ANN", "partition violations", String(ann.partitionViolations)],
    // Issue #2631 additions. Each field is deterministic per successful gate run: constants when a
    // constant is the source of truth, and floor-derived values when an assertion in
    // `evaluateAnnProof` GUARANTEES the value on any passing run. Raw milliseconds stay out (they are
    // not reproducible across hosts) and live in the characterization document referenced below.
    ["ANN", "latency vector dimensions", String(ann.latencyVectorDimensions)],
    ["ANN", "latency large rows", String(ann.latencyLargeRows)],
    ["ANN", "latency small rows", String(ann.latencySmallRows)],
    ["ANN", "latency large search mode", ann.latencyLargeSearchMode],
    ["ANN", "latency small search mode", ann.latencySmallSearchMode],
    ["ANN", "qualified RSS delta ceiling", "<=536870912"],
    ["ANN", `latency large minimum recall@${String(TOP_K)}`, ann.latencyLargeMinRecall.toFixed(3)],
    [
      "ANN",
      "degenerate injection max recall",
      Math.max(...ann.degenerateInjectionRecalls).toFixed(3),
    ],
    ["ANN", "degenerate decoy chunk count", String(ann.degenerateInjectionDecoyCount)],
    [
      "ANN",
      "latency characterization document",
      "docs/qa/knowledge-m2-ann-latency-characterization.md",
    ],
  ];
}

function otherEvidenceRows(facade, evaluation, wire, pod, bookkeeping) {
  return [
    ["Reranker", "facade importer count", String(facade.importers.length)],
    ["Reranker", "importer-set hash", facade.importerHash],
    ["Evaluation", "fixture count", String(evaluation.fixtureCount)],
    ["Evaluation", "live probe count", String(evaluation.regressionProbeCount)],
    ["Evaluation", "scorecard hash", evaluation.actualScorecardHash],
    ["Wire", "snapshot hash", wire.wireHash],
    ["Wire", "neutral purpose id", wire.neutralPurpose],
    ["Repository pod", "provider id", pod.providerName],
    ["Repository pod", "fingerprint count", String(pod.fingerprintCount)],
    ["Repository pod", "indexed path count", String(pod.indexedPathCount)],
    ["Repository pod", "aligned vector count", String(pod.alignedVectorCount)],
    ["Repository pod", "retrieval-mode hash", pod.retrievalModeHash],
    [
      "Repository pod",
      "ask-time document embedding count",
      String(pod.askTimeDocumentEmbeddingCount),
    ],
    ["Repository pod", "editor provider status (informational)", pod.editorProviderStatus],
    [
      "Bookkeeping",
      "ready item count",
      String(bookkeeping.items.filter((item) => item.status === "ready").length),
    ],
  ];
}

function evidenceRows(results) {
  const byId = new Map(results.map((result) => [result.id, result.metrics]));
  return [
    ["Proof", "Metric", "Value"],
    ...annEvidenceRows(byId.get("ann-active")),
    ...otherEvidenceRows(
      byId.get("reranker-facade"),
      byId.get("eval-harness"),
      byId.get("retrieval-context-wire"),
      byId.get("repository-pod"),
      byId.get("program-bookkeeping"),
    ),
  ];
}

function evidenceLines(results) {
  return [
    "# Knowledge M2 unified-substrate evidence",
    "",
    "This record is body-free and deterministic. It contains only counts, rates, hashes, statuses, and proof identifiers.",
    "",
    "Wall-clock latency buckets are characterization, not a deterministic fact — the closeout run",
    "reports them on stdout and deliberately keeps them out of this document.",
    "",
    ...markdownTable(evidenceRows(results)),
    "",
    "Verify with `npm run check:knowledge-m2-closeout`, which compares this committed artifact",
    "against a freshly rendered one and fails closed on drift. Regenerate with",
    "`npm run check:knowledge-m2-closeout -- --write`.",
    "",
  ];
}

function markdownTable(rows) {
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? "").length)),
  );
  const cells = (row) =>
    `| ${(row[0] ?? "").padEnd(widths[0])} | ${(row[1] ?? "").padEnd(widths[1])} | ${(row[2] ?? "").padStart(widths[2])} |`;
  const separator = `| ${"-".repeat(widths[0])} | ${"-".repeat(widths[1])} | ${"-".repeat(Math.max(3, widths[2] - 1))}: |`;
  return [cells(rows[0]), separator, ...rows.slice(1).map(cells)];
}

export function renderKnowledgeM2Evidence(results) {
  return evidenceLines(results).join("\n");
}

export function evidenceRedactionFailures(evidence) {
  const failures = [];
  if (/https?:\/\//iu.test(evidence)) failures.push("endpoint");
  if (/\b(?:api[_-]?key|secret|token)\b/iu.test(evidence)) failures.push("credential-label");
  if (/\b(?:excerpt|source text|raw body)\b/iu.test(evidence)) failures.push("body-material");
  return failures;
}

const DEFAULT_PROOF_RUNNERS = [
  runAnnProof,
  runFacadeProof,
  runEvalProof,
  runWireProof,
  runRepositoryPodProof,
  runBookkeepingProof,
];

async function executeProof(runner, index) {
  try {
    return await runner();
  } catch (cause) {
    const id = PROOF_IDS[index] ?? `proof-${String(index + 1)}`;
    const message = cause instanceof Error ? cause.message : "unknown failure";
    return proof(id, [`execution:${message}`], {});
  }
}

function logProofResult(onLog, result) {
  const failures = result.ok ? "" : ` failures=${result.failures.join("|")}`;
  onLog(
    `knowledge-m2-closeout: proof=${result.id} status=${result.ok ? "PASS" : "FAIL"}${failures}`,
  );
}

async function collectProofResults(proofRunners, onLog) {
  const results = [];
  for (let index = 0; index < proofRunners.length; index += 1) {
    const result = await executeProof(proofRunners[index], index);
    results.push(result);
    logProofResult(onLog, result);
  }
  return results;
}

function evidenceValidationFailure(evidence) {
  const redactionFailures = evidenceRedactionFailures(evidence);
  return redactionFailures.length === 0 ? undefined : redactionFailures.join(", ");
}

// House pattern from scripts/check-package-surface.mjs: the committed artifact is READ and compared
// by default, so a reviewer running the gate validates the evidence instead of silently rewriting
// it into a PASS. Regeneration happens only behind the explicit `--write` flag.
export function evidenceSettlementFailure(evidence, { write, readCommitted, writeCommitted }) {
  if (write) {
    writeCommitted(evidence);
    return undefined;
  }
  const committed = readCommitted();
  if (committed === undefined) return "evidence-missing";
  return committed === evidence ? undefined : "evidence-drift";
}

function defaultEvidenceSettlement(evidence) {
  return evidenceSettlementFailure(evidence, {
    write: process.argv.includes("--write"),
    readCommitted: () =>
      existsSync(EVIDENCE_PATH) ? readFileSync(EVIDENCE_PATH, "utf8") : undefined,
    writeCommitted: (value) => {
      writeFileSync(EVIDENCE_PATH, value, "utf8");
    },
  });
}

function logLatencyCharacterization(onLog, results) {
  const ann = results.find((result) => result.id === "ann-active")?.metrics;
  if (ann?.annMedianLatency === undefined) return;
  onLog(
    `knowledge-m2-closeout: latency-characterization correctness-fixture=${String(VECTOR_DIMENSIONS)}dim ` +
      `ann-median=${ann.annMedianLatency} ann-p95=${ann.annP95Latency} ` +
      `exact-median=${ann.exactMedianLatency} exact-p95=${ann.exactP95Latency}`,
  );
  if (ann.latencyLargeAnnMedianMs !== undefined) {
    onLog(
      `knowledge-m2-closeout: latency-characterization ` +
        `latency-fixture=${String(ann.latencyVectorDimensions)}dim ` +
        `large-rows=${String(ann.latencyLargeRows)} ` +
        `large-ann-median-ms=${ann.latencyLargeAnnMedianMs.toFixed(3)} ` +
        `large-exact-median-ms=${ann.latencyLargeExactMedianMs.toFixed(3)} ` +
        `large-build-ms=${ann.latencyLargeBuildMs.toFixed(3)} ` +
        `large-rss-delta-bytes=${String(ann.latencyLargeRssDeltaBytes)} ` +
        `small-rows=${String(ann.latencySmallRows)} ` +
        `small-service-median-ms=${ann.latencySmallServiceMedianMs.toFixed(3)} ` +
        `small-exact-median-ms=${ann.latencySmallExactMedianMs.toFixed(3)}`,
    );
  }
}

// Issue #2631 acceptance: a recorded latency comparison with row counts, milliseconds, and recall,
// stating "the size below which [ANN is] not [faster]". Kept content-free: no vector values, no
// bodies, no host details — only counts, milliseconds rounded to three decimals, and recall floors.
// The characterization is NOT a golden file: raw milliseconds vary across hosts, so this document
// is written whenever the gate runs with `--write` (alongside the main evidence) and is not
// compared against a committed baseline. `evaluateAnnProof` enforces the within-run claim; this
// document records the measurement.
export function categorizeLatencyWinner(annMs, exactMs) {
  const ratio = exactMs === 0 ? Number.POSITIVE_INFINITY : annMs / exactMs;
  if (ratio > 1.2) return "brute-force";
  if (ratio < 0.8) return "ann";
  return "tied";
}

export function breakEvenNarrative(smallWinner, largeWinner, smallRows, largeRows, exactScanCap) {
  const smallStr = String(smallRows);
  const largeStr = String(largeRows);
  const capStr = String(exactScanCap);
  return [
    `Measured winners: at ${smallStr} rows → ${smallWinner}; at ${largeStr} rows → ${largeWinner}.`,
    "",
    `The governed crossover is the production exact-scan cap`,
    `(\`DEFAULT_MAX_EXACT_VECTOR_SCAN_ROWS = ${capStr}\` in`,
    "`packages/keiko-local-knowledge/src/retrieval/scoped-vector-search.ts`). Below the cap,",
    "the shared service deliberately executes exact search; the small row therefore characterises",
    "service overhead rather than pretending that HNSW ran. Above the cap it executes USearch HNSW.",
    "The large row is a genuine within-run measurement: its warm HNSW median must be lower than an",
    "independently computed exact median, with recall@10 >= 0.95 and fewer examined candidates than",
    "the corpus. Build time and RSS delta are recorded separately so query latency cannot hide them.",
  ].join("\n");
}

function latencyCharacterizationRows(ann, smallWinner, largeWinner) {
  return [
    [
      "Corpus",
      "Rows",
      "Mode",
      "Service median (ms)",
      "Exact median (ms)",
      "Min recall@10",
      "Faster",
    ],
    [
      "Small",
      String(ann.latencySmallRows),
      ann.latencySmallSearchMode,
      ann.latencySmallServiceMedianMs.toFixed(3),
      ann.latencySmallExactMedianMs.toFixed(3),
      "n/a",
      smallWinner,
    ],
    [
      "Large",
      String(ann.latencyLargeRows),
      ann.latencyLargeSearchMode,
      ann.latencyLargeAnnMedianMs.toFixed(3),
      ann.latencyLargeExactMedianMs.toFixed(3),
      ann.latencyLargeMinRecall.toFixed(3),
      largeWinner,
    ],
  ];
}

function renderLatencyTable(rows) {
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (row) =>
    `| ${row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(Math.max(3, width))).join(" | ")} |`;
  return [line(rows[0]), separator, ...rows.slice(1).map(line)];
}

export function renderLatencyCharacterization(results) {
  const ann = results.find((result) => result.id === "ann-active")?.metrics;
  if (ann?.latencyLargeAnnMedianMs === undefined) return undefined;
  const smallWinner = categorizeLatencyWinner(
    ann.latencySmallServiceMedianMs,
    ann.latencySmallExactMedianMs,
  );
  const largeWinner = categorizeLatencyWinner(
    ann.latencyLargeAnnMedianMs,
    ann.latencyLargeExactMedianMs,
  );
  const rows = latencyCharacterizationRows(ann, smallWinner, largeWinner);
  const table = renderLatencyTable(rows);
  return [
    "# Knowledge M2 ANN latency characterization",
    "",
    "This is a characterization snapshot, not a golden file. It records the most recent local",
    "closeout measurement of the shared search service vs exact retrieval on a realistic-dimensional",
    `(${String(ann.latencyVectorDimensions)}-dim) fixture. Wall-clock milliseconds are not`,
    "reproducible across hosts, so the closeout gate does NOT compare this document against a",
    "committed baseline; the within-run claim (ANN faster than exact at the large corpus)",
    "is enforced by `evaluateAnnProof` instead.",
    "",
    "Content-free by construction: row counts, milliseconds, recall floors, and a categorical",
    "winner. No vector values, no source text, no host identifiers.",
    "",
    ...table,
    "",
    breakEvenNarrative(
      smallWinner,
      largeWinner,
      ann.latencySmallRows,
      ann.latencyLargeRows,
      ann.productionExactScanCap,
    ),
    "",
    "Regenerate with `npm run check:knowledge-m2-closeout -- --write`.",
    "",
  ].join("\n");
}

function writeLatencyCharacterization(results) {
  const rendered = renderLatencyCharacterization(results);
  if (rendered === undefined) return;
  writeFileSync(LATENCY_CHARACTERIZATION_PATH, rendered, "utf8");
}

export async function runKnowledgeM2CloseoutGate({
  log,
  fail,
  proofRunners = DEFAULT_PROOF_RUNNERS,
  settleEvidence = defaultEvidenceSettlement,
} = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail = fail ?? ((message) => console.error(`knowledge-m2-closeout failed: ${message}`));
  const results = await collectProofResults(proofRunners, onLog);
  logLatencyCharacterization(onLog, results);
  const verdict = evaluateProofSet(results);
  if (!verdict.ok) {
    onFail(verdict.failedProofs.join(", "));
    return { ok: false, results, evidenceHash: undefined };
  }
  const evidence = renderKnowledgeM2Evidence(results);
  const failure = evidenceValidationFailure(evidence) ?? settleEvidence(evidence);
  if (failure !== undefined) {
    onFail(failure);
    return { ok: false, results, evidenceHash: undefined };
  }
  if (process.argv.includes("--write")) writeLatencyCharacterization(results);
  const evidenceHash = sha256(evidence);
  onLog(`knowledge-m2-closeout: PASS evidence-sha256=${evidenceHash}`);
  return { ok: true, results, evidenceHash };
}
