// Retrieval evaluation runner (Epic #189, Issue #268). Materialises a `RetrievalEvalFixture`
// into a fresh temporary SQLite store on disk, runs every query through `runLocalKnowledgeRetrieval`
// (#199) UNCHANGED, scores each query against the deterministic guardrail dimensions, and returns an immutable
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
// Seeding is implemented in `runner-seed.ts` so each file stays under the 400-LOC budget.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CapsuleSetId,
  ChunkId,
  DocumentId,
  KnowledgeCapsuleId,
  KnowledgeSourceId,
  RetrievalReference,
} from "@oscharko-dev/keiko-contracts";
import {
  embedChunkBatch,
  openKnowledgeStore,
  resolveVectorIndexOptions,
  runLocalKnowledgeRetrieval,
  type KnowledgeStore,
  type RetrievalDiagnostics,
  type RetrievalNoEvidenceReason,
  type VectorIndexOptions,
} from "@oscharko-dev/keiko-local-knowledge";

import { mean } from "../metrics.js";
import { evaluateFloors } from "../quality-helpers.js";

import {
  scoreCitationQuality,
  scoreContextBudgetFit,
  scoreMeanReciprocalRank,
  scoreNdcg,
  scoreNoEvidenceAccuracy,
  scorePrecision,
  scoreRecall,
  scoreSourceIsolation,
} from "./dimensions.js";
import { seedFixture, type SeededFixture } from "./runner-seed.js";
import { createScriptedEmbeddingAdapter, withTopicMarker } from "./scripted-embedding-adapter.js";
import type {
  EvalCapsuleSpec,
  ModelJudgedRetrievalEvalJudge,
  ModelJudgedRetrievalEvalScores,
  RetrievalEvalOutcomeSummary,
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
  // Optional hook for non-CI model-judged evaluation. The offline deterministic harness
  // does not enable this by default; callers must opt in explicitly.
  readonly modelJudge?: ModelJudgedRetrievalEvalJudge;
  readonly vectorIndex?: VectorIndexOptions;
  // Evaluation-only mutation seam for non-tautology probes. The production retriever still runs
  // unchanged; the returned references are replaced immediately before the owning scorer consumes
  // them, so a gate can prove that genuinely bad retrieval output falls below the same floors.
  readonly transformReferences?: (
    references: readonly RetrievalReference[],
    query: RetrievalEvalQuery,
  ) => readonly RetrievalReference[];
}

// ─── Vector embedding (post-seed) ────────────────────────────────────────────
// After every chunk row exists, we run the embedding batcher once per capsule. The
// batcher inserts vector rows keyed to the chunks. We feed the scripted adapter the
// topic-marked text so each chunk's vector is dominated by its declared topic.

interface EmbedChunk {
  readonly id: ChunkId;
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sourceId: KnowledgeSourceId;
  readonly documentId: DocumentId;
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
  let storageCounter = 0;
  const idSource = (): string => {
    storageCounter += 1;
    return `eval-storage-${String(storageCounter)}`;
  };
  for (const capsule of fixture.capsules) {
    const adapter = createScriptedEmbeddingAdapter({
      identity: capsule.embeddingModelIdentity,
      topicBoosts: seeded.topicBoosts,
    });
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
  readonly meanReciprocalRank: number;
  readonly ndcg: number;
  readonly sourceIsolation: number;
  readonly citationQuality: number;
  readonly noEvidenceAccuracy: number;
  readonly contextBudgetFit: number;
  readonly latencyTicks: number;
}

interface QueryEvaluation {
  readonly query: RetrievalEvalQuery;
  readonly scores: QueryScores;
  readonly references: Awaited<ReturnType<typeof runLocalKnowledgeRetrieval>>["references"];
  readonly noEvidence: boolean;
  readonly reason?: RetrievalNoEvidenceReason;
  // The production `RetrievalDiagnostics.mode` for this query, when the search ran far
  // enough to report one. Threaded through unchanged from `runLocalKnowledgeRetrieval` —
  // this file adds no retrieval logic of its own.
  readonly retrievalMode?: RetrievalDiagnostics["mode"];
}

function scopeCapsuleIds(query: RetrievalEvalQuery): readonly KnowledgeCapsuleId[] {
  if (query.scope.kind === "capsule") return [query.scope.capsuleId];
  return query.scope.capsuleIds;
}

function buildRetrievalQuery(
  query: RetrievalEvalQuery,
  queryText: string,
): Parameters<typeof runLocalKnowledgeRetrieval>[1] {
  const baseQuery = {
    text: queryText,
    ...(query.topK !== undefined ? { topK: query.topK } : {}),
    ...(query.strategy !== undefined ? { strategy: query.strategy } : {}),
    // For the no-evidence fixture we apply a very high minScore so unrelated chunks are
    // dropped. The fixture's query carries no topic marker, so the cosine of its vector
    // with any topic-boosted chunk is far below 0.99.
    ...(query.expectedNoEvidence === true ? { minScore: 0.99 } : {}),
  };
  if (query.scope.kind === "capsule") {
    return { ...baseQuery, capsuleId: query.scope.capsuleId };
  }
  return { ...baseQuery, capsuleSetId: query.scope.capsuleSetId as CapsuleSetId };
}

// Prepends the query topic marker to the EMBEDDING input only. Inputs that already carry an
// inline marker pass through unchanged — chained-question fixtures mark each decomposed part
// in-text, and "first topic wins" must honour the part's own marker.
function topicRoutingAdapter(
  adapter: ReturnType<typeof createScriptedEmbeddingAdapter>,
  topic: string,
): ReturnType<typeof createScriptedEmbeddingAdapter> {
  return {
    ...adapter,
    request: async (req) =>
      adapter.request(
        req.input.includes("[[topic:") ? req : { ...req, input: withTopicMarker(req.input, topic) },
      ),
  };
}

async function runOneQuery(
  store: KnowledgeStore,
  query: RetrievalEvalQuery,
  seeded: SeededFixture,
  now: () => number,
  vectorIndex: VectorIndexOptions,
  transformReferences: RunRetrievalEvalDeps["transformReferences"],
): Promise<QueryEvaluation> {
  // Route the query embedding toward the declared topic WITHOUT putting the marker into the
  // searchable query text: production queries never contain harness markers, so the lexical
  // lane must not see them either (marker tokens like "topic"/the topic name are real FTS
  // terms and can lexically self-match a same-named chunk topic). The marker is injected at
  // the embedding boundary instead — the only place it has meaning.
  const baseAdapter = createScriptedEmbeddingAdapter({
    identity: query.queryEmbeddingIdentity ?? seeded.identity,
    topicBoosts: seeded.topicBoosts,
  });
  const adapter =
    query.topic === undefined ? baseAdapter : topicRoutingAdapter(baseAdapter, query.topic);
  const retrievalQuery = buildRetrievalQuery(query, query.text);
  const start = now();
  const result = await runLocalKnowledgeRetrieval(
    { store, embeddingAdapter: adapter, vectorIndex },
    retrievalQuery,
  );
  const references = transformReferences?.(result.references, query) ?? result.references;
  const expected = query.expectedChunkIds ?? [];
  return {
    query,
    references,
    noEvidence: result.noEvidence,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.diagnostics !== undefined ? { retrievalMode: result.diagnostics.mode } : {}),
    scores: {
      recall: scoreRecall(references, expected),
      precision: scorePrecision(references, expected),
      meanReciprocalRank: scoreMeanReciprocalRank(references, expected),
      ndcg: scoreNdcg(references, expected),
      sourceIsolation: scoreSourceIsolation(references, scopeCapsuleIds(query)),
      citationQuality: scoreCitationQuality(references, seeded.chunkUnitKinds),
      noEvidenceAccuracy: scoreNoEvidenceAccuracy(
        result.noEvidence,
        query.expectedNoEvidence === true,
        result.reason,
        query.expectedNoEvidenceReason,
      ),
      contextBudgetFit: scoreContextBudgetFit(
        references,
        seeded.chunkTokenCounts,
        query.contextBudgetTokens,
      ),
      latencyTicks: now() - start,
    },
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

async function runModelJudge(
  modelJudge: ModelJudgedRetrievalEvalJudge | undefined,
  fixture: RetrievalEvalFixture,
  perQuery: readonly QueryEvaluation[],
): Promise<ModelJudgedRetrievalEvalScores | undefined> {
  if (modelJudge === undefined) return undefined;
  const judged: ModelJudgedRetrievalEvalScores[] = [];
  for (const evaluation of perQuery) {
    judged.push(
      await modelJudge.judge({
        fixtureId: fixture.id,
        queryId: evaluation.query.id,
        queryText: evaluation.query.text,
        references: evaluation.references,
        noEvidence: evaluation.noEvidence,
        ...(evaluation.reason !== undefined ? { reason: evaluation.reason } : {}),
      }),
    );
  }
  return {
    groundedness: mean(judged.map((item) => item.groundedness)),
    faithfulness: mean(judged.map((item) => item.faithfulness)),
  };
}

function recordNoEvidenceReason(
  counts: Partial<Record<RetrievalNoEvidenceReason, number>>,
  reason: RetrievalNoEvidenceReason | undefined,
): void {
  if (reason === undefined) return;
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function recordRetrievalMode(
  counts: Partial<Record<RetrievalDiagnostics["mode"], number>>,
  mode: RetrievalDiagnostics["mode"] | undefined,
): void {
  if (mode === undefined) return;
  counts[mode] = (counts[mode] ?? 0) + 1;
}

function buildOutcomeSummary(perQuery: readonly QueryEvaluation[]): RetrievalEvalOutcomeSummary {
  const noEvidenceReasonCounts: Partial<Record<RetrievalNoEvidenceReason, number>> = {};
  const retrievalModeCounts: Partial<Record<RetrievalDiagnostics["mode"], number>> = {};
  let referenceCount = 0;
  let noEvidenceCount = 0;
  let expectedNoEvidenceCount = 0;
  for (const evaluation of perQuery) {
    referenceCount += evaluation.references.length;
    if (evaluation.noEvidence) noEvidenceCount += 1;
    if (evaluation.query.expectedNoEvidence === true) expectedNoEvidenceCount += 1;
    recordNoEvidenceReason(noEvidenceReasonCounts, evaluation.reason);
    recordRetrievalMode(retrievalModeCounts, evaluation.retrievalMode);
  }
  return {
    queryCount: perQuery.length,
    referenceCount,
    noEvidenceCount,
    expectedNoEvidenceCount,
    noEvidenceReasonCounts: Object.freeze({ ...noEvidenceReasonCounts }),
    retrievalModeCounts: Object.freeze({ ...retrievalModeCounts }),
  };
}

function buildScorecard(
  fixture: RetrievalEvalFixture,
  runId: string,
  perQuery: readonly QueryEvaluation[],
  modelJudged: ModelJudgedRetrievalEvalScores | undefined,
): RetrievalEvalScorecard {
  const dimensions = {
    recall: mean(perQuery.map((q) => q.scores.recall)),
    precision: mean(perQuery.map((q) => q.scores.precision)),
    meanReciprocalRank: mean(perQuery.map((q) => q.scores.meanReciprocalRank)),
    ndcg: mean(perQuery.map((q) => q.scores.ndcg)),
    sourceIsolation: mean(perQuery.map((q) => q.scores.sourceIsolation)),
    citationQuality: mean(perQuery.map((q) => q.scores.citationQuality)),
    noEvidenceAccuracy: mean(perQuery.map((q) => q.scores.noEvidenceAccuracy)),
    contextBudgetFit: mean(perQuery.map((q) => q.scores.contextBudgetFit)),
    latencyMs: perQuery.reduce((acc, q) => acc + q.scores.latencyTicks, 0),
  };
  const passed = evaluateFloors(dimensions, PASS_THRESHOLDS).ok;
  const outcomes = buildOutcomeSummary(perQuery);
  return modelJudged === undefined
    ? { fixtureId: fixture.id, runId, dimensions, outcomes, passed }
    : { fixtureId: fixture.id, runId, dimensions, outcomes, passed, modelJudged };
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

async function runFixture(
  fixture: RetrievalEvalFixture,
  deps: RunRetrievalEvalDeps,
): Promise<{
  readonly scorecard: RetrievalEvalScorecard;
  readonly perQuery: readonly QueryEvaluation[];
}> {
  const now = deps.now ?? defaultClock();
  const runId = deps.runId ?? `eval-${fixture.id}`;
  const dir = mkdtempSync(join(tmpdir(), "keiko-eval-"));
  const vectorIndex = resolveVectorIndexOptions(deps.vectorIndex);
  const store = openKnowledgeStore({ dbPath: join(dir, "eval.db"), vectorIndex });
  try {
    const seeded = seedFixture(store, fixture);
    await embedAllChunks(store, fixture, seeded, now);
    const perQuery: QueryEvaluation[] = [];
    for (const query of fixture.queries) {
      perQuery.push(
        await runOneQuery(store, query, seeded, now, vectorIndex, deps.transformReferences),
      );
    }
    const modelJudged = await runModelJudge(deps.modelJudge, fixture, perQuery);
    return { scorecard: buildScorecard(fixture, runId, perQuery, modelJudged), perQuery };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runRetrievalEval(
  fixture: RetrievalEvalFixture,
  deps: RunRetrievalEvalDeps = {},
): Promise<RetrievalEvalScorecard> {
  return (await runFixture(fixture, deps)).scorecard;
}

// Exposes the raw per-query `RetrievalReference[]` alongside the scorecard. The scorecard's
// aggregate dimensions (e.g. `citationQuality`) intentionally collapse per-query evidence
// shape into a single [0, 1] score, which is too coarse to assert a specific field (like a
// citation's `anchorId`) on a specific query's top reference. Tests that need to verify an
// exact evidence shape — not just that the aggregate dimension cleared its floor — use this.
export async function runRetrievalEvalReferences(
  fixture: RetrievalEvalFixture,
  deps: RunRetrievalEvalDeps = {},
): Promise<ReadonlyMap<string, readonly RetrievalReference[]>> {
  const { perQuery } = await runFixture(fixture, deps);
  return new Map(perQuery.map((evaluation) => [evaluation.query.id, evaluation.references]));
}
