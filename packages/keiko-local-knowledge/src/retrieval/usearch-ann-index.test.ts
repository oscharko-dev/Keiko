import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";

import {
  __resetTargetRuntimeCacheForTests,
  clearUsearchAnnCacheForTests,
  searchUsearchAnnIndex,
  type UsearchAnnPartition,
  type UsearchVectorEntry,
} from "./usearch-ann-index.js";
import { USEARCH_RUNTIME_MANIFEST, usearchRuntimeTargetKey } from "./usearch-runtime-manifest.js";

// The fix under KEIKO-0409 removes the runtime-hash pre-check from the warm ANN-cache path.
// The pre-check reads the whole native USearch addon (multi-MB) synchronously on the event loop,
// so the regression test needs to observe readFileSync calls against the binary path. vi.mock on
// node:fs delegates every unchanged export to the real implementation and only wraps readFileSync
// to push the resolved path into a hoisted telemetry collector. Only the parent thread's
// targetRuntime() path reads the binary — Worker threads run in their own context and are not
// affected by this mock, so a bump here corresponds exactly to a parent-side hash operation.
const readFileSyncTelemetry = vi.hoisted<{ paths: string[] }>(() => ({ paths: [] }));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  const wrapped: typeof original.readFileSync = ((
    ...args: Parameters<typeof original.readFileSync>
  ) => {
    readFileSyncTelemetry.paths.push(String(args[0]));
    return original.readFileSync(...args);
  }) as typeof original.readFileSync;
  return { ...original, readFileSync: wrapped };
});

const IDENTITY: EmbeddingModelIdentity = {
  provider: "test",
  modelId: "deterministic-64",
  vectorDimensions: 64,
  vectorMetric: "cosine",
  normalization: "l2",
  instructionVersion: "v1",
  embeddingSpaceFingerprint: "space-v1",
};

function runtimePath(): string {
  const target = usearchRuntimeTargetKey(process.platform, process.arch);
  if (target === undefined) throw new Error("test host has no approved USearch runtime");
  return resolve(".usearch", USEARCH_RUNTIME_MANIFEST.version, target, "usearch.node");
}

function randomSource(seedValue: number): () => number {
  let seed = seedValue >>> 0;
  return (): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

function normalize(vector: Float32Array): Float32Array {
  let squared = 0;
  for (const value of vector) squared += value * value;
  const norm = Math.sqrt(squared);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

function randomVector(dimensions: number, random: () => number): Float32Array {
  return normalize(Float32Array.from({ length: dimensions }, () => random() * 2 - 1));
}

function clusteredCorpus(
  count: number,
  identity: EmbeddingModelIdentity,
): {
  readonly entries: readonly UsearchVectorEntry[];
  readonly centers: readonly Float32Array[];
  readonly random: () => number;
} {
  const random = randomSource(0x55_53_45_41);
  const clusterSize = 50;
  const centers = Array.from({ length: Math.ceil(count / clusterSize) }, () =>
    randomVector(identity.vectorDimensions, random),
  );
  const entries = Array.from({ length: count }, (_, row) => {
    const center = centers[Math.floor(row / clusterSize)];
    return {
      id: `chunk-${String(row).padStart(6, "0")}`,
      vector: normalize(
        Float32Array.from(
          { length: identity.vectorDimensions },
          (_, dimension) => (center?.[dimension] ?? 0) + (random() * 2 - 1) * 0.025,
        ),
      ),
    };
  });
  return { entries, centers, random };
}

function partition(
  entries: readonly UsearchVectorEntry[],
  revision = "revision-1",
): UsearchAnnPartition {
  return {
    cacheKey: "partition-a",
    cacheGroupKey: "partition-owner-a",
    revision,
    identity: IDENTITY,
    rowCount: entries.length,
    loadEntries: () => entries,
  };
}

function entriesWithThrowingLength(error: Error): readonly UsearchVectorEntry[] {
  return new Proxy([] as UsearchVectorEntry[], {
    get: (target, property, receiver): unknown => {
      if (property === "length") throw error;
      return Reflect.get(target, property, receiver);
    },
  });
}

function exactTop(
  entries: readonly UsearchVectorEntry[],
  query: Float32Array,
  limit: number,
): readonly string[] {
  return entries
    .map((entry) => {
      let score = 0;
      for (let dimension = 0; dimension < query.length; dimension += 1) {
        score += (query[dimension] ?? 0) * (entry.vector[dimension] ?? 0);
      }
      return { id: entry.id, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    })
    .slice(0, limit)
    .map((entry) => entry.id);
}

afterEach(() => {
  clearUsearchAnnCacheForTests();
  readFileSyncTelemetry.paths.length = 0;
});

describe("USearch ANN index", () => {
  it("keeps the small-corpus path exact and snapshots mutable caller vectors", async () => {
    const first = new Float32Array([1, 0]);
    const identity: EmbeddingModelIdentity = {
      ...IDENTITY,
      modelId: "deterministic-2",
      vectorDimensions: 2,
    };
    const entries: readonly UsearchVectorEntry[] = [
      { id: "b", vector: first },
      { id: "a", vector: new Float32Array([1, 0]) },
      { id: "c", vector: new Float32Array([0, 1]) },
    ];
    const request = {
      partition: {
        cacheKey: "small",
        cacheGroupKey: "small-owner",
        revision: "1",
        identity,
        rowCount: entries.length,
        loadEntries: (): readonly UsearchVectorEntry[] => entries,
      },
      queryVector: new Float32Array([1, 0]),
      candidateLimit: 3,
    };
    const beforeMutation = await searchUsearchAnnIndex(request);
    first.set([0, 1]);
    const afterMutation = await searchUsearchAnnIndex(request);
    expect(beforeMutation).toMatchObject({
      ok: true,
      mode: "exact",
      candidates: [
        { id: "a", score: 1 },
        { id: "b", score: 1 },
        { id: "c", score: 0 },
      ],
    });
    expect(afterMutation).toEqual(beforeMutation);
  });

  it("isolates otherwise-identical cached partitions by owning group", async () => {
    const identity: EmbeddingModelIdentity = {
      ...IDENTITY,
      modelId: "owner-scoped-2",
      vectorDimensions: 2,
    };
    const ownerA = [{ id: "owner-a", vector: new Float32Array([1, 0]) }] as const;
    const ownerB = [{ id: "owner-b", vector: new Float32Array([0, 1]) }] as const;
    const search = async (
      cacheGroupKey: string,
      entries: readonly UsearchVectorEntry[],
      queryVector: Float32Array,
    ): Promise<Awaited<ReturnType<typeof searchUsearchAnnIndex>>> =>
      await searchUsearchAnnIndex({
        partition: {
          cacheKey: "shared-partition",
          cacheGroupKey,
          revision: "shared-revision",
          identity,
          rowCount: entries.length,
          loadEntries: () => entries,
        },
        queryVector,
        candidateLimit: 1,
      });

    const first = await search("owner-a", ownerA, ownerA[0].vector);
    const second = await search("owner-b", ownerB, ownerB[0].vector);

    expect(first).toMatchObject({ ok: true, candidates: [{ id: "owner-a", score: 1 }] });
    expect(second).toMatchObject({ ok: true, candidates: [{ id: "owner-b", score: 1 }] });
  });

  it(
    "uses real HNSW for held-out noisy queries with bounded candidates and recall parity",
    { timeout: 60_000 },
    async () => {
      const corpus = clusteredCorpus(20_001, IDENTITY);
      let minimumRecall = 1;
      for (let queryIndex = 0; queryIndex < 6; queryIndex += 1) {
        const center = corpus.centers[queryIndex * 67];
        const query = normalize(
          Float32Array.from(
            { length: IDENTITY.vectorDimensions },
            (_, dimension) => (center?.[dimension] ?? 0) + (corpus.random() * 2 - 1) * 0.02,
          ),
        );
        const result = await searchUsearchAnnIndex({
          partition: partition(corpus.entries),
          queryVector: query,
          candidateLimit: 10,
          binaryPath: runtimePath(),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const expected = new Set(exactTop(corpus.entries, query, 10));
        const recalled = result.candidates.filter((candidate) => expected.has(candidate.id)).length;
        minimumRecall = Math.min(minimumRecall, recalled / expected.size);
        expect(result.mode).toBe("ann");
        expect(result.examinedCandidates).toBeLessThan(corpus.entries.length);
      }
      expect(minimumRecall).toBeGreaterThanOrEqual(0.95);
    },
  );

  it("fails closed on runtime tampering, malformed vectors, and memory bounds", async () => {
    const corpus = clusteredCorpus(64, IDENTITY);
    const queryVector = corpus.entries[0]?.vector;
    if (queryVector === undefined) throw new Error("test corpus must contain a query vector");
    const temp = mkdtempSync(join(tmpdir(), "keiko-usearch-invalid-"));
    try {
      const tampered = join(temp, "usearch.node");
      cpSync(runtimePath(), tampered);
      writeFileSync(tampered, "not the approved native runtime");
      const invalidRuntime = await searchUsearchAnnIndex({
        partition: partition(corpus.entries),
        queryVector,
        candidateLimit: 5,
        exactScanThreshold: 0,
        binaryPath: tampered,
      });
      expect(invalidRuntime).toEqual({ ok: false, reason: "runtime-integrity-failed" });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }

    const malformed = [
      ...corpus.entries.slice(0, -1),
      { id: "malformed", vector: new Float32Array([Number.NaN]) },
    ];
    expect(
      await searchUsearchAnnIndex({
        partition: partition(malformed),
        queryVector,
        candidateLimit: 5,
      }),
    ).toEqual({ ok: false, reason: "invalid-partition-entry" });
    expect(
      await searchUsearchAnnIndex({
        partition: partition(corpus.entries),
        queryVector,
        candidateLimit: 5,
        maxIndexBytes: 1,
      }),
    ).toEqual({ ok: false, reason: "index-bytes-over-bound" });
    expect(
      await searchUsearchAnnIndex({
        partition: partition(corpus.entries),
        queryVector,
        candidateLimit: 10_001,
      }),
    ).toEqual({ ok: false, reason: "invalid-query" });
    expect(
      await searchUsearchAnnIndex({
        partition: { ...partition(corpus.entries), cacheKey: "x".repeat(4_097) },
        queryVector,
        candidateLimit: 5,
      }),
    ).toEqual({ ok: false, reason: "invalid-partition" });
    expect(
      await searchUsearchAnnIndex({
        partition: { ...partition(corpus.entries), cacheGroupKey: "" },
        queryVector: corpus.entries[0]?.vector ?? new Float32Array(64),
        candidateLimit: 5,
      }),
    ).toEqual({ ok: false, reason: "invalid-partition" });
    expect(
      await searchUsearchAnnIndex({
        partition: {
          ...partition(corpus.entries),
          cacheGroupKey: undefined as unknown as string,
        },
        queryVector: corpus.entries[0]?.vector ?? new Float32Array(64),
        candidateLimit: 5,
      }),
    ).toEqual({ ok: false, reason: "invalid-partition" });
  });

  it("does not create an index file or temporary sidecar", async () => {
    const corpus = clusteredCorpus(128, IDENTITY);
    const temp = mkdtempSync(join(tmpdir(), "keiko-usearch-no-spill-"));
    try {
      const before = readdirSync(temp);
      const result = await searchUsearchAnnIndex({
        partition: partition(corpus.entries),
        queryVector: corpus.entries[0]?.vector ?? new Float32Array(64),
        candidateLimit: 5,
        exactScanThreshold: 0,
        binaryPath: runtimePath(),
      });
      expect(result.ok).toBe(true);
      expect(readdirSync(temp)).toEqual(before);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("releases the build queue after propagating a rejected operation", async () => {
    const corpus = clusteredCorpus(1, IDENTITY);
    const queryVector = corpus.entries[0]?.vector;
    if (queryVector === undefined) throw new Error("test corpus must contain a query vector");
    const failure = new Error("synthetic queue failure");

    await expect(
      searchUsearchAnnIndex({
        partition: {
          ...partition(corpus.entries, "rejected-build"),
          loadEntries: () => entriesWithThrowingLength(failure),
        },
        queryVector,
        candidateLimit: 1,
      }),
    ).rejects.toBe(failure);

    expect(
      await searchUsearchAnnIndex({
        partition: partition(corpus.entries, "recovered-build"),
        queryVector,
        candidateLimit: 1,
      }),
    ).toMatchObject({ ok: true, mode: "exact" });
  });

  it("does not re-hash the native runtime binary on a warm ANN cache hit (KEIKO-0409)", async () => {
    // Regression pin for KEIKO-0409: resolvedIndex still calls targetRuntime() first so a
    // swapped-out or missing native addon can never be masked by a stale in-memory cache
    // hit, but targetRuntime() now memoizes its result per (path, mtimeMs, size) — so a
    // warm search does NOT re-read + SHA-256 the multi-MB native addon on the Node.js event
    // loop. Fresh binaries or on-disk changes still trigger a full verification.
    const corpus = clusteredCorpus(64, IDENTITY);
    const queryVector = corpus.entries[0]?.vector;
    if (queryVector === undefined) throw new Error("test corpus must contain a query vector");
    const binary = runtimePath();
    const request = {
      partition: partition(corpus.entries, "warm-cache-runtime-hash"),
      queryVector,
      candidateLimit: 5,
      exactScanThreshold: 0,
      binaryPath: binary,
    };
    __resetTargetRuntimeCacheForTests();
    readFileSyncTelemetry.paths.length = 0;
    const first = await searchUsearchAnnIndex(request);
    expect(first.ok).toBe(true);
    const readsAfterCold = readFileSyncTelemetry.paths.filter((path) => path === binary).length;
    expect(readsAfterCold).toBeGreaterThan(0);
    const second = await searchUsearchAnnIndex(request);
    expect(second.ok).toBe(true);
    const readsAfterWarm = readFileSyncTelemetry.paths.filter((path) => path === binary).length;
    expect(readsAfterWarm).toBe(readsAfterCold);
  });

  // The "logs search.native-runtime-resolved on the cold path only, content-free" case moved to
  // ./usearch-runtime-resolved-logging.test.ts: it needs a mocked runtime-manifest approval to
  // run hermetically (no host-native USearch binary, no order dependency on this file's shared
  // TARGET_RUNTIME_CACHE), which would have required either a per-file vi.mock here — poisoning
  // every other real-binary test in this suite — or a scoped vi.doMock reimport that was harder
  // to reason about than a small dedicated file. Native-addon search correctness stays covered
  // right here by every other test in this file that already exercises the real binary via
  // runtimePath().

  it("serializes concurrent callers through queryQueue without cross-contaminating results (KEIKO-0360)", async () => {
    // KEIKO-0360: coverage pin for the ADR-0164 D2 single-Worker queryQueue serialization
    // at annSearch()/annSearchExclusive(). Twelve concurrent Promise.all searches against
    // one cached AnnIndex must each observe THEIR OWN nearest neighbour in the result set;
    // any cross-talk through the shared control/query/result buffers would land another
    // caller's top hit here.
    const corpus = clusteredCorpus(20_001, IDENTITY);
    const anchors = Array.from({ length: 12 }, (_, offset) => offset * 1_500);
    const queries = anchors.map((row) => {
      const entry = corpus.entries[row];
      if (entry === undefined) throw new Error("test corpus missing anchor entry");
      return { row, id: entry.id, vector: entry.vector };
    });
    const cachedPartition = partition(corpus.entries, "concurrent-queue-serialization");
    // Warm the ANN cache once so the shared partition ships through the queryQueue,
    // not through separate build phases racing to construct the index.
    await searchUsearchAnnIndex({
      partition: cachedPartition,
      queryVector: queries[0]?.vector ?? new Float32Array(IDENTITY.vectorDimensions),
      candidateLimit: 5,
      binaryPath: runtimePath(),
    });
    const results = await Promise.all(
      queries.map((query) =>
        searchUsearchAnnIndex({
          partition: cachedPartition,
          queryVector: query.vector,
          candidateLimit: 5,
          binaryPath: runtimePath(),
        }),
      ),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const query = queries[index];
      if (result === undefined || query === undefined) throw new Error("missing result or query");
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.mode).toBe("ann");
      expect(result.candidates.some((candidate) => candidate.id === query.id)).toBe(true);
    }
  }, 60_000);

  it("keeps the event loop responsive while the worker builds an ANN index", async () => {
    const corpus = clusteredCorpus(128, IDENTITY);
    const queryVector = corpus.entries[0]?.vector;
    if (queryVector === undefined) throw new Error("test corpus must contain a query vector");

    const eventLoopTurn = new Promise<"event-loop">((resolveTurn) => {
      setImmediate(() => {
        resolveTurn("event-loop");
      });
    });
    const search = searchUsearchAnnIndex({
      partition: partition(corpus.entries, "non-blocking-build"),
      queryVector,
      candidateLimit: 5,
      exactScanThreshold: 0,
      binaryPath: runtimePath(),
    });

    expect(await Promise.race([eventLoopTurn, search.then(() => "search" as const)])).toBe(
      "event-loop",
    );
    expect(await search).toMatchObject({ ok: true, mode: "ann" });
  });
});
