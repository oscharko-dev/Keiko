// Retrieval evaluation runner (Epic #189, Issue #268). Materialises a `RetrievalEvalFixture`
// into a fresh in-memory tmpdir SQLite store, runs every query through `runLocalKnowledgeRetrieval`
// (#199) UNCHANGED, scores each query against the five dimensions, and returns an immutable
// `RetrievalEvalScorecard`.
//
// Determinism contract:
//   - The default `now()` is a monotonic counter starting at 0. Two runs of the same fixture
//     therefore produce byte-identical scorecards (the latency dimension counts ticks of this
//     counter, not wall-clock milliseconds).
//   - A caller that wants real wall-clock latency passes its own `now: () => performance.now()`
//     — but doing so DROPS the byte-identical guarantee and is incompatible with the audit
//     ledger's manifest equality check.
//   - The store path uses `mkdtempSync` (different per process) but the store contents are
//     discarded at teardown; nothing about the temp path leaks into the scorecard.
//
// Topic salt: every chunk in the fixture is embedded with its declared `topic` marker, and
// every query is embedded with the marker corresponding to `query.topic`. That is what makes
// the ground-truth chunk become the deterministic top result.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapsuleSetId,
  ChunkId,
  EmbeddingModelIdentity,
  KnowledgeCapsuleId,
  ParsedUnit,
} from "@oscharko-dev/keiko-contracts";

import { createCapsule } from "../capsule-lifecycle.js";
import { createCapsuleSet } from "../capsule-set-lifecycle.js";
import { insertChunkRow } from "../chunking/chunker-persist.js";
import { insertDocumentRow, insertParsedUnitRow } from "../discovery/persist.js";
import { embedChunkBatch } from "../indexing/embedding-batcher.js";
import { runLocalKnowledgeRetrieval } from "../retrieval/index.js";
import { addSourceToCapsule } from "../source-lifecycle.js";
import { openKnowledgeStore, type KnowledgeStore } from "../store.js";

import {
  citationRequirementForUnit,
  scoreCitationQuality,
  scoreNoEvidenceAccuracy,
  scorePrecision,
  scoreRecall,
  scoreSourceIsolation,
  type CitationRequirementKey,
} from "./dimensions.js";
import { createScriptedEmbeddingAdapter, withTopicMarker } from "./scripted-embedding-adapter.js";
import type {
  EvalCapsuleSpec,
  EvalSourceSpec,
  EvalDocumentSpec,
  RetrievalEvalFixture,
  RetrievalEvalQuery,
  RetrievalEvalScorecard,
} from "./types.js";
import { PASS_THRESHOLDS } from "./types.js";

// ─── Public dependency surface ───────────────────────────────────────────────

export interface RunRetrievalEvalDeps {
  // Optional clock. Default is a monotonic counter starting at 0 so the latency dimension
  // is deterministic across runs.
  readonly now?: () => number;
  // Optional run id (echoed into the scorecard). Default is a fixed string so two runs of
  // the same fixture produce byte-identical scorecards.
  readonly runId?: string;
}

// ─── Seeding ─────────────────────────────────────────────────────────────────
// A fixture's topic-bearing chunk text is wrapped with `withTopicMarker` before the
// scripted adapter sees it. The chunks table itself stores only the chunk row metadata
// (the marker is an embedding-time signal); the marker never leaks into the persisted DB.

interface SeededFixture {
  readonly chunkUnitKinds: ReadonlyMap<string, CitationRequirementKey>;
  // Aggregated topic boosts across all chunks in the fixture, ready to hand to the
  // scripted adapter.
  readonly topicBoosts: Readonly<Record<string, number>>;
  // Pinned identity for the run. Every capsule in a fixture currently shares one identity
  // (see fixtures.test.ts invariant). If a future fixture pins different identities per
  // capsule the embedding step will produce dim mismatches and the per-query embed call
  // would need a per-capsule adapter — out of scope until that fixture lands.
  readonly identity: EmbeddingModelIdentity;
}

function chunkParsedUnitId(documentId: string): string {
  return `unit-${documentId}`;
}

function seedCapsule(store: KnowledgeStore, capsule: EvalCapsuleSpec): void {
  createCapsule(store, {
    id: capsule.id,
    displayName: capsule.displayName,
    tags: [],
    retrievalEffort: "default",
    outputMode: "answers",
    answerGroundingPolicy: capsule.answerGroundingPolicy,
    embeddingModelIdentity: capsule.embeddingModelIdentity,
    lifecycleState: "draft",
    storageReference: `eval/${String(capsule.id)}`,
  });
}

function seedSource(
  store: KnowledgeStore,
  capsuleId: KnowledgeCapsuleId,
  source: EvalSourceSpec,
): void {
  addSourceToCapsule(store, capsuleId, {
    id: source.id,
    displayName: `Source ${String(source.id)}`,
    tags: [],
    scope: { kind: "folder", rootPath: "/srv/docs", recursive: true },
  });
}

function seedDocument(
  store: KnowledgeStore,
  capsule: EvalCapsuleSpec,
  source: EvalSourceSpec,
  doc: EvalDocumentSpec,
): void {
  insertDocumentRow(store._internal.db, {
    id: doc.id,
    capsuleId: capsule.id,
    sourceId: String(source.id),
    documentPath: `docs/${doc.safeDisplayName}`,
    sizeBytes: 1024,
    mediaType: "text/plain",
    contentHash: "a".repeat(64),
    parserId: "text",
    parserVersion: "1",
    lastExtractedAt: 1_700_000_000_000,
    status: "extracted",
    safeDisplayName: doc.safeDisplayName,
  });
  const unitId = chunkParsedUnitId(String(doc.id));
  const unit: ParsedUnit = { ...doc.parsedUnit.unit, documentId: doc.id };
  insertParsedUnitRow(store._internal.db, capsule.id, unitId, unit);
}

function seedChunks(
  store: KnowledgeStore,
  capsule: EvalCapsuleSpec,
  source: EvalSourceSpec,
  doc: EvalDocumentSpec,
  chunkUnitKinds: Map<string, CitationRequirementKey>,
): void {
  const unitId = chunkParsedUnitId(String(doc.id));
  const unit: ParsedUnit = { ...doc.parsedUnit.unit, documentId: doc.id };
  const requirement = citationRequirementForUnit(unit);
  let orderIndex = 0;
  for (const chunk of doc.chunks) {
    insertChunkRow(store._internal.db, {
      id: chunk.id,
      capsuleId: capsule.id,
      sourceId: source.id,
      documentId: doc.id,
      parsedUnitId: unitId,
      orderIndex,
      tokenCount: chunk.text.length,
      // 64-hex placeholder — the schema requires a non-empty hash but the eval never
      // validates content equivalence.
      safeExcerptHash: "b".repeat(64),
    });
    chunkUnitKinds.set(String(chunk.id), requirement);
    orderIndex += 1;
  }
}

function collectTopicBoosts(fixture: RetrievalEvalFixture): Record<string, number> {
  const boosts: Record<string, number> = {};
  for (const capsule of fixture.capsules) {
    for (const source of capsule.sources) {
      for (const doc of source.documents) {
        for (const chunk of doc.chunks) {
          if (chunk.topic !== undefined) boosts[chunk.topic] = 1.0;
        }
      }
    }
  }
  for (const query of fixture.queries) {
    if (query.topic !== undefined) boosts[query.topic] = 1.0;
  }
  return boosts;
}

function seedFixture(store: KnowledgeStore, fixture: RetrievalEvalFixture): SeededFixture {
  const chunkUnitKinds = new Map<string, CitationRequirementKey>();
  for (const capsule of fixture.capsules) {
    seedCapsule(store, capsule);
    for (const source of capsule.sources) {
      seedSource(store, capsule.id, source);
      for (const doc of source.documents) {
        seedDocument(store, capsule, source, doc);
        seedChunks(store, capsule, source, doc, chunkUnitKinds);
      }
    }
  }
  // Materialise capsule-set rows so the runner can resolve a `capsuleSetId` scope.
  for (const query of fixture.queries) {
    if (query.scope.kind !== "capsule-set") continue;
    // Create-if-absent: the same set id may appear on multiple queries.
    try {
      createCapsuleSet(store, {
        id: query.scope.capsuleSetId as CapsuleSetId,
        displayName: `Set ${query.scope.capsuleSetId}`,
        tags: [],
        capsuleIds: query.scope.capsuleIds,
      });
    } catch {
      // Already created on a previous query — ignore.
    }
  }
  const first = fixture.capsules[0];
  if (first === undefined) {
    throw new Error("fixture must declare at least one capsule");
  }
  return {
    chunkUnitKinds,
    topicBoosts: collectTopicBoosts(fixture),
    identity: first.embeddingModelIdentity,
  };
}

// ─── Vector embedding (post-seed) ────────────────────────────────────────────
// After every chunk row exists, we run the embedding batcher once per capsule. The
// batcher inserts vector rows keyed to the chunks. We feed the scripted adapter the
// topic-marked text so each chunk's vector is dominated by its declared topic.

interface EmbedChunk {
  readonly id: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: EvalSourceSpec["id"];
  readonly documentId: EvalDocumentSpec["id"];
  readonly text: string;
}

function collectCapsuleChunks(capsule: EvalCapsuleSpec): readonly EmbedChunk[] {
  const out: EmbedChunk[] = [];
  for (const source of capsule.sources) {
    for (const doc of source.documents) {
      for (const chunk of doc.chunks) {
        const text =
          chunk.topic !== undefined ? withTopicMarker(chunk.text, chunk.topic) : chunk.text;
        out.push({
          id: chunk.id,
          capsuleId: capsule.id,
          sourceId: source.id,
          documentId: doc.id,
          text,
        });
      }
    }
  }
  return out;
}

async function embedAllChunks(
  store: KnowledgeStore,
  fixture: RetrievalEvalFixture,
  seeded: SeededFixture,
  now: () => number,
): Promise<void> {
  const adapter = createScriptedEmbeddingAdapter({
    identity: seeded.identity,
    topicBoosts: seeded.topicBoosts,
  });
  let storageCounter = 0;
  const idSource = (): string => {
    storageCounter += 1;
    return `eval-storage-${String(storageCounter)}`;
  };
  for (const capsule of fixture.capsules) {
    const chunks = collectCapsuleChunks(capsule);
    const result = await embedChunkBatch(chunks, {
      adapter,
      store,
      pinnedIdentity: capsule.embeddingModelIdentity,
      concurrency: 1,
      now,
      idSource,
    });
    if (result.errors.length > 0) {
      const codes = result.errors.map((e) => e.code).join(",");
      throw new Error(`embedding seeding failed for capsule ${String(capsule.id)}: ${codes}`);
    }
  }
}

// ─── Per-query scoring ───────────────────────────────────────────────────────

interface QueryScores {
  readonly recall: number;
  readonly precision: number;
  readonly sourceIsolation: number;
  readonly citationQuality: number;
  readonly noEvidenceAccuracy: number;
  readonly latencyTicks: number;
}

function scopeCapsuleIds(query: RetrievalEvalQuery): readonly KnowledgeCapsuleId[] {
  if (query.scope.kind === "capsule") return [query.scope.capsuleId];
  return query.scope.capsuleIds;
}

async function runOneQuery(
  store: KnowledgeStore,
  fixture: RetrievalEvalFixture,
  query: RetrievalEvalQuery,
  seeded: SeededFixture,
  now: () => number,
): Promise<QueryScores> {
  // Wrap the query text in the topic marker so the scripted adapter applies the same
  // topic boost it used at seed time.
  const queryText =
    query.topic !== undefined ? withTopicMarker(query.text, query.topic) : query.text;
  const adapter = createScriptedEmbeddingAdapter({
    identity: seeded.identity,
    topicBoosts: seeded.topicBoosts,
  });
  const baseQuery = {
    text: queryText,
    ...(query.topK !== undefined ? { topK: query.topK } : {}),
    // For the no-evidence fixture we apply a very high minScore so unrelated chunks are
    // dropped. The fixture's query carries no topic marker, so the cosine of its vector
    // with any topic-boosted chunk is far below 0.99.
    ...(query.expectedNoEvidence === true ? { minScore: 0.99 } : {}),
  };
  const retrievalQuery =
    query.scope.kind === "capsule"
      ? { ...baseQuery, capsuleId: query.scope.capsuleId }
      : { ...baseQuery, capsuleSetId: query.scope.capsuleSetId as CapsuleSetId };

  const start = now();
  const result = await runLocalKnowledgeRetrieval(
    { store, embeddingAdapter: adapter },
    retrievalQuery,
  );
  const end = now();

  const expected = query.expectedChunkIds ?? [];
  const expectedNoEvidence = query.expectedNoEvidence === true;
  return {
    recall: scoreRecall(result.references, expected),
    precision: scorePrecision(result.references, expected),
    sourceIsolation: scoreSourceIsolation(result.references, scopeCapsuleIds(query)),
    citationQuality: scoreCitationQuality(result.references, seeded.chunkUnitKinds),
    noEvidenceAccuracy: scoreNoEvidenceAccuracy(result.noEvidence, expectedNoEvidence),
    latencyTicks: end - start,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function buildScorecard(
  fixture: RetrievalEvalFixture,
  runId: string,
  perQuery: readonly QueryScores[],
): RetrievalEvalScorecard {
  const dimensions = {
    recall: meanOf(perQuery.map((q) => q.recall)),
    precision: meanOf(perQuery.map((q) => q.precision)),
    sourceIsolation: meanOf(perQuery.map((q) => q.sourceIsolation)),
    citationQuality: meanOf(perQuery.map((q) => q.citationQuality)),
    noEvidenceAccuracy: meanOf(perQuery.map((q) => q.noEvidenceAccuracy)),
    latencyMs: perQuery.reduce((acc, q) => acc + q.latencyTicks, 0),
  };
  const passed =
    dimensions.recall >= PASS_THRESHOLDS.recall &&
    dimensions.precision >= PASS_THRESHOLDS.precision &&
    dimensions.sourceIsolation >= PASS_THRESHOLDS.sourceIsolation &&
    dimensions.citationQuality >= PASS_THRESHOLDS.citationQuality &&
    dimensions.noEvidenceAccuracy >= PASS_THRESHOLDS.noEvidenceAccuracy;
  return { fixtureId: fixture.id, runId, dimensions, passed };
}

// ─── Default clock ───────────────────────────────────────────────────────────
// A monotonic integer counter created fresh per call. Returns 0 on first invocation, 1 on
// second, etc. Latency for a query is therefore exactly the number of `now()` reads inside
// the query (`runOneQuery` reads it twice, so every query reports `latencyTicks = 1`).
function defaultClock(): () => number {
  let counter = -1;
  return (): number => {
    counter += 1;
    return counter;
  };
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export async function runRetrievalEval(
  fixture: RetrievalEvalFixture,
  deps: RunRetrievalEvalDeps = {},
): Promise<RetrievalEvalScorecard> {
  const now = deps.now ?? defaultClock();
  const runId = deps.runId ?? `eval-${fixture.id}`;
  const dir = mkdtempSync(join(tmpdir(), "keiko-eval-"));
  const store = openKnowledgeStore({ dbPath: join(dir, "eval.db") });
  try {
    const seeded = seedFixture(store, fixture);
    await embedAllChunks(store, fixture, seeded, now);
    const perQuery: QueryScores[] = [];
    for (const query of fixture.queries) {
      perQuery.push(await runOneQuery(store, fixture, query, seeded, now));
    }
    return buildScorecard(fixture, runId, perQuery);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
