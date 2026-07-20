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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION_SUFFIX_BY_PLATFORM = { darwin: "dylib", win32: "dll" };
const EVIDENCE_PATH = join(ROOT, "docs/qa/knowledge-m2-substrate-evidence.md");
const WAVE_RECORD_PATH = join(ROOT, "docs/qa/knowledge-m2-wave.md");
const FACADE_PATH = "packages/keiko-server/src/grounded-rerank-facade.ts";
const VECTOR_ROWS = 20_001;
const EXACT_SCAN_CAP = 20_000;
const TOP_K = 10;
const VECTOR_DIMENSIONS = 4;
const VECTOR_MODEL_ID = "knowledge-m2-closeout-vector";
const EXPECTED_WIRE_SNAPSHOT_HASH =
  "9ee38880de5f349e56f27724dd35c7472c661629a79541434dde5ca27036b8a9";
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

export function evaluateAnnProof(input) {
  const failures = [];
  if (input.vectorRows <= input.exactScanCap) failures.push("corpus-not-above-exact-cap");
  if (input.activeStatus !== "available") failures.push(`ann-status:${input.activeStatus}`);
  if (input.recalls.some((recall) => recall < 0.95)) failures.push("ann-recall-below-0.95");
  if (input.encryptedStatus !== "fallback-encrypted-store") failures.push("encrypted-fallback");
  if (input.loadFailureReason !== "sqlite-vec-extension-load-failed")
    failures.push("load-fallback");
  if (input.disabledStatus !== "disabled") failures.push("disabled-negative-control");
  if (input.partitionViolations !== 0) failures.push("capsule-partition-crossed");
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
  if (input.firstHash !== input.secondHash) failures.push("scorecards-not-byte-identical");
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

async function seedLargeVectorCorpus(store, seeded, identity) {
  const { deleteVectorsForCapsule, insertVectorRow, invalidateVectorIndexStateForCapsules } =
    await vectorPersistModule();
  const templateId = seeded.chunkIds[0];
  if (templateId === undefined) throw new Error("missing synthetic template chunk");
  deleteVectorsForCapsule(store._internal.db, seeded.capsuleId);
  const clone = cloneChunkStatement(store);
  store._internal.db.exec("BEGIN IMMEDIATE");
  try {
    for (let ordinal = 0; ordinal < VECTOR_ROWS; ordinal += 1) {
      const chunkId = `m2-ann-${String(ordinal).padStart(5, "0")}`;
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
          embedding: float32Bytes(corpusVector(ordinal)),
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

function recallAtK(actual, expected) {
  const expectedIds = new Set(expected.map((candidate) => candidate.chunkId));
  return actual.filter((candidate) => expectedIds.has(candidate.chunkId)).length / TOP_K;
}

async function encryptedFallback(identity, vectorIndex) {
  const store = openKnowledgeStore({
    dbPath: ":memory:",
    vectorIndex,
    protection: {
      mode: "encrypted-key-provider",
      keyProvider: { providerId: "m2-closeout", resolveKey: () => new Uint8Array(32).fill(17) },
    },
  });
  try {
    const seeded = await seedCapsuleWithVectors(store, { capsuleId: "m2-encrypted", identity });
    const capsule = getCapsule(store, seeded.capsuleId);
    if (capsule === undefined) throw new Error("missing encrypted capsule");
    return searchVectorIndex(
      { store, capsule, queryVector: QUERY_VECTORS[0], candidateLimit: TOP_K },
      vectorIndex,
    ).diagnostics.status;
  } finally {
    store.close();
  }
}

async function annMeasurements(store, capsule, rows, vectorIndex) {
  const recalls = [];
  const annLatency = [];
  const exactLatency = [];
  let partitionViolations = 0;
  for (const queryVector of QUERY_VECTORS) {
    const exact = measure(() => exactTopK(rows, queryVector));
    const ann = measure(() =>
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

// The extension is operator-provisioned rather than an npm dependency (see
// scripts/provision-sqlite-vec.mjs for why), so the ANN proof drives the provisioned binary. This
// stays a real proof: with nothing provisioned the gate FAILS rather than quietly certifying a
// fallback as if ANN had been exercised.
function provisionedSqliteVecPath() {
  const configured = process.env.KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH;
  if (typeof configured === "string" && configured.length > 0 && existsSync(configured)) {
    return configured;
  }
  const suffix = EXTENSION_SUFFIX_BY_PLATFORM[process.platform] ?? "so";
  const candidate = join(ROOT, ".sqlite-vec", "0.1.9", `vec0.${suffix}`);
  return existsSync(candidate) ? candidate : undefined;
}

async function runAnnProof() {
  const identity = await verifiedVectorIdentity();
  const extensionPath = provisionedSqliteVecPath();
  const vectorIndex = resolveVectorIndexOptions(undefined, {
    KEIKO_LOCAL_KNOWLEDGE_VECTOR_INDEX: "auto",
    ...(extensionPath === undefined
      ? {}
      : { KEIKO_LOCAL_KNOWLEDGE_SQLITE_VEC_EXTENSION_PATH: extensionPath }),
  });
  const store = openKnowledgeStore({ dbPath: ":memory:", vectorIndex });
  try {
    const seeded = await seedAnnProofStore(store, identity);
    const pipeline = await runLocalKnowledgeRetrieval(
      { store, embeddingAdapter: vectorAdapter(QUERY_VECTORS[0]), vectorIndex },
      { text: "m2-ann-query", capsuleId: seeded.capsuleId, topK: TOP_K },
    );
    const capsule = getCapsule(store, seeded.capsuleId);
    if (capsule === undefined) throw new Error("missing ANN capsule");
    const rows = store._internal.db
      .prepare(
        "SELECT chunk_id, embedding FROM vectors WHERE capsule_id = :capsule ORDER BY chunk_id",
      )
      .all({ capsule: String(seeded.capsuleId) });
    const measured = await annMeasurements(store, capsule, rows, vectorIndex);
    const missing = searchVectorIndex(
      { store, capsule, queryVector: QUERY_VECTORS[0], candidateLimit: TOP_K },
      { mode: "auto", sqliteVecExtensionPath: "/missing/keiko/m2-vec0" },
    );
    const disabled = searchVectorIndex(
      { store, capsule, queryVector: QUERY_VECTORS[0], candidateLimit: TOP_K },
      { mode: "disabled" },
    );
    return evaluateAnnProof({
      vectorRows: rows.length,
      exactScanCap: EXACT_SCAN_CAP,
      activeStatus: pipeline.diagnostics?.vectorIndex?.status ?? "missing",
      recalls: measured.recalls,
      annMedianLatency: latencyBucket(percentile(measured.annLatency, 0.5)),
      annP95Latency: latencyBucket(percentile(measured.annLatency, 0.95)),
      exactMedianLatency: latencyBucket(percentile(measured.exactLatency, 0.5)),
      exactP95Latency: latencyBucket(percentile(measured.exactLatency, 0.95)),
      encryptedStatus: await encryptedFallback(identity, vectorIndex),
      loadFailureReason: missing.diagnostics.reason,
      disabledStatus: disabled.diagnostics.status,
      partitionViolations: measured.partitionViolations,
    });
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
  const first = await runRetrievalQualityCheck(options);
  const second = await runRetrievalQualityCheck(options);
  const grounded = await runGroundedRetrievalQualityGate(options);
  const faithfulness = runGroundedFaithfulnessGate(options);
  return evaluateEvalProof({
    firstHash: qualityScorecardHash(first),
    secondHash: qualityScorecardHash(second),
    fixtureCount: first.localKnowledge.scorecards.length,
    regressionProbeCount: first.regression.probed,
    regressionProbesLive:
      first.regression.ok && first.regression.probed === REGRESSION_PROBE_FIXTURE_IDS.length,
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

function evidenceRows(results) {
  const byId = new Map(results.map((result) => [result.id, result.metrics]));
  const ann = byId.get("ann-active");
  const facade = byId.get("reranker-facade");
  const evaluation = byId.get("eval-harness");
  const wire = byId.get("retrieval-context-wire");
  const pod = byId.get("repository-pod");
  const bookkeeping = byId.get("program-bookkeeping");
  return [
    ["Proof", "Metric", "Value"],
    ["ANN", "vector rows", String(ann.vectorRows)],
    ["ANN", "exact scan cap", String(ann.exactScanCap)],
    ["ANN", `minimum recall@${String(TOP_K)}`, Math.min(...ann.recalls).toFixed(3)],
    ["ANN", "encrypted diagnostic", ann.encryptedStatus],
    ["ANN", "load diagnostic", ann.loadFailureReason],
    ["ANN", "partition violations", String(ann.partitionViolations)],
    ["Reranker", "facade importer count", String(facade.importers.length)],
    ["Reranker", "importer-set hash", facade.importerHash],
    ["Evaluation", "fixture count", String(evaluation.fixtureCount)],
    ["Evaluation", "live probe count", String(evaluation.regressionProbeCount)],
    ["Evaluation", "scorecard hash", evaluation.firstHash],
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
    `knowledge-m2-closeout: latency-characterization ann-median=${ann.annMedianLatency} ` +
      `ann-p95=${ann.annP95Latency} exact-median=${ann.exactMedianLatency} ` +
      `exact-p95=${ann.exactP95Latency}`,
  );
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
  const evidenceHash = sha256(evidence);
  onLog(`knowledge-m2-closeout: PASS evidence-sha256=${evidenceHash}`);
  return { ok: true, results, evidenceHash };
}
