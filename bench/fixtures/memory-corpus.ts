// Deterministic MemoriaViva corpus used by bench/memory-retrieval.bench.ts.
//
// Benchmarks must measure the code, not the input: every value below is derived from a fixed
// seed through a linear congruential generator, so the corpus, the semantic scores, and the
// embeddings are byte-identical on every machine and every run. No clock, no randomness, no
// IO — the same invariants the retrieval package itself holds.

import type {
  MemoryEdge,
  MemoryEdgeId,
  MemoryEdgeKind,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemorySourceKind,
  MemoryType,
  ProjectId,
  UserId,
  WorkspaceId,
} from "@oscharko-dev/keiko-contracts/memory";
import { makeMemoryRecord } from "@oscharko-dev/keiko-contracts/memory-fixtures";

export const NOW_MS = 1_760_000_000_000;
export const DAY_MS = 86_400_000;
export const CORPUS_SIZE = 120;
export const EMBEDDING_DIMS = 32;

export const QUERY_TEXT =
  "which deployment pipeline settings did the reviewer accept for the release branch";

export const USER_SCOPE: MemoryScope = { kind: "user", userId: "u-bench" as UserId };
export const PROJECT_SCOPE: MemoryScope = { kind: "project", projectId: "p-bench" as ProjectId };
export const WORKSPACE_SCOPE: MemoryScope = {
  kind: "workspace",
  workspaceId: "w-bench" as WorkspaceId,
};
export const SCOPES: readonly MemoryScope[] = [USER_SCOPE, PROJECT_SCOPE, WORKSPACE_SCOPE];

const TOPICS: readonly string[] = [
  "deployment pipeline settings for the release branch",
  "reviewer accepted the sandbox egress policy",
  "dark mode is the preferred desktop theme",
  "model gateway timeouts stay at thirty seconds",
  "the workspace trust prompt appears once per root",
  "local knowledge indexing runs on a bounded worker pool",
  "evidence bundles are written before the audit event",
  "the editor keeps language servers per workspace root",
];

const TYPES: readonly MemoryType[] = [
  "semantic-fact",
  "preference",
  "correction",
  "decision",
  "procedural",
  "episodic",
];

const SOURCE_KINDS: readonly MemorySourceKind[] = [
  "explicit-user-instruction",
  "accepted-correction",
  "workflow-outcome",
  "consolidation",
  "system-default",
];

const EDGE_KINDS: readonly MemoryEdgeKind[] = ["related", "derived-from", "corrects"];

// 32-bit LCG (Numerical Recipes constants). Deterministic and dependency-free.
function unitAt(seed: number): number {
  return ((Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0) / 0x1_00_00_00_00;
}

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) throw new Error("bench fixture: empty lookup table");
  return value;
}

export const memoryId = (value: string): MemoryId => value as MemoryId;

export function corpusRecord(index: number): MemoryRecord {
  return makeMemoryRecord({
    id: memoryId(`m-${String(index)}`),
    scope: pick(SCOPES, index),
    type: pick(TYPES, index),
    body: `${pick(TOPICS, index)}; recorded during review ${String(index)} — ${pick(TOPICS, index + 3)}`,
    tags: [pick(TOPICS, index + 1).slice(0, 12)],
    pinned: index % 17 === 0,
    provenance: {
      sourceKind: pick(SOURCE_KINDS, index),
      capturedAt: NOW_MS - index * DAY_MS,
      confidence: 0.4 + unitAt(index + 1) * 0.6,
      sensitivity: index % 5 === 0 ? "confidential" : "public",
    },
    validity: { validFrom: NOW_MS - (index + 1) * DAY_MS },
    createdAt: NOW_MS - (index + 1) * DAY_MS,
    updatedAt: NOW_MS - index * (DAY_MS / 4),
  });
}

export const CORPUS: readonly MemoryRecord[] = Array.from(
  { length: CORPUS_SIZE },
  (_unused, index) => corpusRecord(index),
);

export function corpusForScope(scope: MemoryScope): readonly MemoryRecord[] {
  return CORPUS.filter((record) => record.scope.kind === scope.kind);
}

export function buildEdgesByMemory(): ReadonlyMap<MemoryId, readonly MemoryEdge[]> {
  const edges = new Map<MemoryId, MemoryEdge[]>();
  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    const from = memoryId(`m-${String(index)}`);
    const edge: MemoryEdge = {
      id: `e-${String(index)}` as MemoryEdgeId,
      schemaVersion: "1",
      fromMemoryId: from,
      toMemoryId: memoryId(`m-${String((index * 7 + 3) % CORPUS_SIZE)}`),
      kind: pick(EDGE_KINDS, index),
      createdAt: NOW_MS - index * DAY_MS,
      confidence: 0.5 + unitAt(index + 2) * 0.5,
    };
    const bucket = edges.get(from);
    if (bucket === undefined) edges.set(from, [edge]);
    else bucket.push(edge);
  }
  return edges;
}

function buildScoreMap(offset: number): ReadonlyMap<MemoryId, number> {
  const scores = new Map<MemoryId, number>();
  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    scores.set(memoryId(`m-${String(index)}`), unitAt(index + offset));
  }
  return scores;
}

export function buildSemanticById(): ReadonlyMap<MemoryId, number> {
  return buildScoreMap(11);
}

export function buildStrengthById(): ReadonlyMap<MemoryId, number> {
  return buildScoreMap(29);
}

// Embeddings are clustered on purpose: neighbouring records share most of their vector, so the
// MMR re-ordering has real near-duplicates to push apart, as it does in production.
export function buildEmbeddingById(): ReadonlyMap<MemoryId, Float32Array> {
  const embeddings = new Map<MemoryId, Float32Array>();
  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    const vector = new Float32Array(EMBEDDING_DIMS);
    const cluster = index % 8;
    for (let dim = 0; dim < EMBEDDING_DIMS; dim += 1) {
      vector[dim] =
        Math.sin((cluster + 1) * (dim + 1) * 0.13) + unitAt(index * EMBEDDING_DIMS + dim) * 0.05;
    }
    embeddings.set(memoryId(`m-${String(index)}`), vector);
  }
  return embeddings;
}
