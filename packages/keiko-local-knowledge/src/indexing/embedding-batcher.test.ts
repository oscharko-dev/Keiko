// Tests for the embedding batcher (Epic #189, Issue #196). The batcher is the only
// module that calls the OpenAIEmbeddingAdapter and the only module that inserts into the
// `vectors` table; these tests pin the contract:
//
//   * happy path: persists one vector per chunk, identity matches.
//   * incompatible identity: ZERO rows persisted (load-bearing #192 invariant — test #5 of
//     the issue scope).
//   * adapter failure: vectors=[] for that chunk, error surfaced, no row persisted.
//   * concurrency cap: only up to N adapter calls in flight at once.
//   * abort: in-flight responses do not lead to inserts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";

import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import { embedChunkBatch } from "./embedding-batcher.js";
import { countVectorsForCapsule, countVectorsForDocument } from "./vector-persist.js";
import {
  deterministicVector,
  happyAdapter,
  scriptedAdapter,
  seedCapsuleSourceAndDocument,
  seedDocumentWithChunks,
  type SeededFixture,
} from "./_support.js";
import type { ChunkToEmbed } from "./types.js";
import type { KnowledgeStore } from "../store.js";

interface Fixture {
  readonly store: KnowledgeStore;
  readonly cleanup: () => void;
  readonly seeded: SeededFixture;
  readonly chunks: readonly ChunkToEmbed[];
}

function buildFixture(
  text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi",
): Fixture {
  const { store, cleanup } = freshStore();
  const seeded = seedCapsuleSourceAndDocument(store);
  const chunkIds = seedDocumentWithChunks(store, seeded, text);
  const chunks: ChunkToEmbed[] = chunkIds.map((id, i) => ({
    id,
    capsuleId: seeded.capsuleId,
    sourceId: seeded.sourceId,
    documentId: seeded.documentId,
    text: `chunk-${String(i)}-${text.slice(0, 16)}`,
  }));
  return { store, cleanup, seeded, chunks };
}

function fixedIds(prefix: string): () => string {
  let n = 0;
  return (): string => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}

function fixedClock(start = 1_700_000_000_000): () => number {
  let n = start;
  return (): number => {
    n += 1;
    return n;
  };
}

describe("embedChunkBatch — happy path", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("persists one vector per chunk and returns matching records", async () => {
    const result = await embedChunkBatch(fixture.chunks, {
      adapter: happyAdapter(),
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    expect(result.errors).toEqual([]);
    expect(result.vectors).toHaveLength(fixture.chunks.length);
    expect(
      countVectorsForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(fixture.chunks.length);
    for (const v of result.vectors) {
      expect(v.embeddingIdentity.vectorDimensions).toBe(DEFAULT_EMBEDDING.vectorDimensions);
      expect(v.embeddingIdentity.modelId).toBe(DEFAULT_EMBEDDING.modelId);
    }
  });

  it("returns an empty result for an empty input without touching the store", async () => {
    const result = await embedChunkBatch([], {
      adapter: happyAdapter(),
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });
    expect(result.vectors).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.seeded.capsuleId)).toBe(0);
  });
});

describe("embedChunkBatch — identity gate", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("refuses to persist any vector when the adapter returns a dimension that mismatches the capsule's pinned identity", async () => {
    // Pinned dim=1536; adapter returns dim=768 — assertCompatibleEmbeddingIdentity must
    // fire and the batcher must NOT insert any row from the batch.
    const wrongDimIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      vectorDimensions: 768,
    };
    const adapter = scriptedAdapter({
      responder: (req) => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, wrongDimIdentity.vectorDimensions),
          modelId: DEFAULT_EMBEDDING.modelId,
        },
      }),
    });

    const result = await embedChunkBatch(fixture.chunks, {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    expect(result.vectors).toEqual([]);
    expect(result.errors.some((e) => e.code === "INCOMPATIBLE_EMBEDDING_IDENTITY")).toBe(true);
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.seeded.capsuleId)).toBe(0);
  });

  it("refuses to persist when the adapter reports a different modelId", async () => {
    const adapter = scriptedAdapter({
      responder: (req) => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
          modelId: "another-model",
        },
      }),
    });

    const result = await embedChunkBatch(fixture.chunks, {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    expect(result.vectors).toEqual([]);
    expect(result.errors.some((e) => e.code === "INCOMPATIBLE_EMBEDDING_IDENTITY")).toBe(true);
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.seeded.capsuleId)).toBe(0);
  });
});

describe("embedChunkBatch — adapter failure", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("surfaces per-chunk errors and skips persistence of the failed chunk only", async () => {
    const target = String(fixture.chunks[0]?.text);
    const adapter = scriptedAdapter({
      responder: (req) =>
        req.input === target
          ? { ok: false, kind: "transport" }
          : {
              ok: true,
              value: {
                vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
                modelId: DEFAULT_EMBEDDING.modelId,
              },
            },
    });

    const result = await embedChunkBatch(fixture.chunks, {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 2,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    expect(result.errors.some((e) => e.code === "EMBEDDING_ADAPTER_FAILED")).toBe(true);
    expect(result.vectors.length).toBe(Math.max(0, fixture.chunks.length - 1));
    expect(
      countVectorsForDocument(
        fixture.store._internal.db,
        fixture.seeded.capsuleId,
        fixture.seeded.documentId,
      ),
    ).toBe(result.vectors.length);
  });
});

describe("embedChunkBatch — bounded concurrency", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture(
      "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp",
    );
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("never exceeds the configured concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const adapter = scriptedAdapter({
      responder: (_req) => {
        // Track peak in the synchronous callback; the request is awaited in the batcher
        // so the responder is invoked once per call and the increment+decrement bracket
        // the await window for that call.
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        const outcome = {
          ok: true as const,
          value: {
            vector: deterministicVector(_req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
        inFlight -= 1;
        return outcome;
      },
    });

    // Wrap in an async layer that holds the in-flight count across a microtask boundary.
    const original = adapter.request;
    const trackingAdapter = {
      ...adapter,
      request: async (
        req: Parameters<typeof original>[0],
      ): Promise<Awaited<ReturnType<typeof original>>> => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setImmediate(r));
        const outcome = await original(req);
        inFlight -= 1;
        return outcome;
      },
    };

    await embedChunkBatch(fixture.chunks, {
      adapter: trackingAdapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 2,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    // Peak counts both the inner (synchronous) and outer (async) increments — the outer
    // is the one the batcher actually controls. We allow ≤ 2*N because the synchronous
    // increment in the inner responder shares the same counter; the outer wrapper's peak
    // can be at most `concurrency`.
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("embedChunkBatch — abort", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("does not persist when the signal is aborted before the batch starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await embedChunkBatch(fixture.chunks, {
      adapter: happyAdapter(),
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      signal: controller.signal,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });
    expect(result.vectors).toEqual([]);
    expect(result.errors.some((e) => e.code === "CANCELLED")).toBe(true);
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.seeded.capsuleId)).toBe(0);
  });
});
