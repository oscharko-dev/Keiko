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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";
import type {
  OpenAIEmbeddingAdapter,
  OpenAIEmbeddingBatchOutcome,
} from "@oscharko-dev/keiko-model-gateway";

import { DEFAULT_EMBEDDING, freshStore } from "../_support.js";
import type { LocalKnowledgeTokenizer } from "../chunking/index.js";
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
import type { ChunkToEmbed, IndexingLogContext } from "./types.js";
import type { KnowledgeLogEvent, KnowledgeLogSink } from "../knowledge-log.js";
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

  it("deduplicates identical embedding payloads while preserving one vector per chunk", async () => {
    const repeated = buildFixture("alpha ".repeat(900));
    let calls = 0;
    const chunks = repeated.chunks.slice(0, 2).map((chunk) => ({
      ...chunk,
      text: "repeated boilerplate paragraph",
    }));
    const adapter = scriptedAdapter({
      responder: (req) => {
        calls += 1;
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    try {
      expect(chunks).toHaveLength(2);
      const result = await embedChunkBatch(chunks, {
        adapter,
        store: repeated.store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("storage"),
      });

      expect(calls).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.vectors.map((vector) => vector.chunkId)).toEqual(
        chunks.map((chunk) => chunk.id),
      );
      expect(
        countVectorsForDocument(
          repeated.store._internal.db,
          repeated.seeded.capsuleId,
          repeated.seeded.documentId,
        ),
      ).toBe(2);
    } finally {
      repeated.cleanup();
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

  it("sends raw document chunk text without a Qwen3 query instruction prefix", async () => {
    const qwenIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "Qwen3-Embedding-8B",
    };
    const inputs: string[] = [];
    const adapter = scriptedAdapter({
      responder: (req) => {
        inputs.push(req.input);
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, qwenIdentity.vectorDimensions),
            modelId: qwenIdentity.modelId,
          },
        };
      },
    });
    const first = fixture.chunks[0];
    if (first === undefined) throw new Error("fixture produced no chunks");
    const rawText = "Document chunk that must remain raw for indexing.";

    await embedChunkBatch([{ ...first, text: rawText }], {
      adapter,
      store: fixture.store,
      pinnedIdentity: qwenIdentity,
      concurrency: 1,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    expect(inputs).toEqual([rawText]);
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

  it("accepts a LiteLLM upstream response model only when it matches the pinned revision", async () => {
    const litellmPinned: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      modelId: "Qwen3-Embedding-8B",
      modelRevision: "RedHatAI/Qwen3-Embedding-8B",
    };
    const adapter = scriptedAdapter({
      responder: (req) => ({
        ok: true,
        value: {
          vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
          modelId: "RedHatAI/Qwen3-Embedding-8B",
        },
      }),
    });

    const result = await embedChunkBatch(fixture.chunks, {
      adapter,
      store: fixture.store,
      pinnedIdentity: litellmPinned,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("storage"),
    });

    expect(result.errors).toEqual([]);
    expect(result.vectors).toHaveLength(fixture.chunks.length);
    expect(result.vectors[0]?.embeddingIdentity).toMatchObject({
      modelId: "Qwen3-Embedding-8B",
      modelRevision: "RedHatAI/Qwen3-Embedding-8B",
    });
    expect(countVectorsForCapsule(fixture.store._internal.db, fixture.seeded.capsuleId)).toBe(
      fixture.chunks.length,
    );
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
      // Transport is transient → it would retry with real backoff; inject an instant
      // sleep so the perpetually-failing chunk exhausts its retries without waiting.
      retry: { maxRetries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() },
    });

    expect(result.errors.some((e) => e.code === "EMBEDDING_ADAPTER_FAILED")).toBe(true);
    expect(result.vectors).toHaveLength(Math.max(0, fixture.chunks.length - 1));
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
    let outerInFlight = 0;
    let outerPeak = 0;

    // Wrap only the outer adapter.request — this is what the batcher calls and whose
    // concurrency it controls. Track in-flight count across a microtask boundary so
    // concurrent awaits are visible.
    const base = scriptedAdapter({
      responder: (req) => ({
        ok: true as const,
        value: {
          vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
          modelId: DEFAULT_EMBEDDING.modelId,
        },
      }),
    });
    const trackingAdapter: typeof base = {
      ...base,
      request: async (
        req: Parameters<typeof base.request>[0],
      ): Promise<Awaited<ReturnType<typeof base.request>>> => {
        outerInFlight += 1;
        if (outerInFlight > outerPeak) outerPeak = outerInFlight;
        await new Promise((r) => setImmediate(r));
        const outcome = await base.request(req);
        outerInFlight -= 1;
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

    // outerPeak tracks only the batcher-controlled outer calls — must not exceed concurrency=2.
    expect(outerPeak).toBeLessThanOrEqual(2);
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

describe("embedChunkBatch — transient-failure retry", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // Instant, deterministic backoff so the retry loop never touches the wall clock.
  const instantRetry = { maxRetries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() } as const;

  function firstChunk(): ChunkToEmbed {
    const chunk = fixture.chunks[0];
    if (chunk === undefined) throw new Error("fixture produced no chunks");
    return chunk;
  }

  it("retries a transient failure and succeeds on the next attempt", async () => {
    const attempts = new Map<string, number>();
    const adapter = scriptedAdapter({
      responder: (req) => {
        const n = (attempts.get(req.input) ?? 0) + 1;
        attempts.set(req.input, n);
        if (n === 1) return { ok: false, kind: "timeout" };
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });

    const result = await embedChunkBatch(fixture.chunks, {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 2,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: instantRetry,
    });

    expect(result.errors).toEqual([]);
    expect(result.vectors).toHaveLength(fixture.chunks.length);
    for (const chunk of fixture.chunks) {
      expect(attempts.get(chunk.text)).toBe(2);
    }
  });

  it("does not retry a permanent failure", async () => {
    let calls = 0;
    const adapter = scriptedAdapter({
      responder: () => {
        calls += 1;
        return { ok: false, kind: "wrong-header" };
      },
    });

    const result = await embedChunkBatch(fixture.chunks, {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 2,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: { maxRetries: 3, baseDelayMs: 0, sleep: () => Promise.resolve() },
    });

    expect(result.vectors).toEqual([]);
    // One call per chunk — an auth failure must not burn the retry budget.
    expect(calls).toBe(fixture.chunks.length);
  });

  it("gives up after exactly maxRetries on a perpetual transient failure", async () => {
    let calls = 0;
    const adapter = scriptedAdapter({
      responder: () => {
        calls += 1;
        return { ok: false, kind: "rate-limited" };
      },
    });

    const result = await embedChunkBatch([firstChunk()], {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 1,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: instantRetry,
    });

    expect(result.errors.some((e) => e.code === "EMBEDDING_ADAPTER_FAILED")).toBe(true);
    // first attempt + 2 retries.
    expect(calls).toBe(3);
  });

  it("stops retrying once the signal aborts during backoff", async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapter = scriptedAdapter({
      responder: () => {
        calls += 1;
        return { ok: false, kind: "transport" };
      },
    });

    const result = await embedChunkBatch([firstChunk()], {
      adapter,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 1,
      signal: controller.signal,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: {
        maxRetries: 5,
        baseDelayMs: 0,
        sleep: () => {
          controller.abort();
          return Promise.reject(new DOMException("aborted", "AbortError"));
        },
      },
    });

    // First attempt fails transient → enters backoff → sleep aborts → loop bails.
    expect(calls).toBe(1);
    expect(result.vectors).toEqual([]);
  });

  it("retries an answered 5xx like a transient failure but never a 4xx", async () => {
    let serverErrorCalls = 0;
    const serverError = scriptedAdapter({
      responder: () => {
        serverErrorCalls += 1;
        return { ok: false, kind: "http-error", status: 503 };
      },
    });
    await embedChunkBatch([firstChunk()], {
      adapter: serverError,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 1,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: instantRetry,
    });
    // A 5xx answer stays retry-worthy exactly like the torn-connection "transport" kind.
    expect(serverErrorCalls).toBe(3);

    // 408 (answered request timeout) is equally transient — it was retried under the old
    // everything-is-transport classification and must stay retried.
    let requestTimeoutCalls = 0;
    const requestTimeout = scriptedAdapter({
      responder: () => {
        requestTimeoutCalls += 1;
        return { ok: false, kind: "http-error", status: 408 };
      },
    });
    await embedChunkBatch([firstChunk()], {
      adapter: requestTimeout,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 1,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: instantRetry,
    });
    expect(requestTimeoutCalls).toBe(3);

    // 425 (Too Early) is the second answered-timeout status the transient set names; without
    // its own pin, dropping the 425 condition would pass the suite.
    let tooEarlyCalls = 0;
    const tooEarly = scriptedAdapter({
      responder: () => {
        tooEarlyCalls += 1;
        return { ok: false, kind: "http-error", status: 425 };
      },
    });
    await embedChunkBatch([firstChunk()], {
      adapter: tooEarly,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 1,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: instantRetry,
    });
    expect(tooEarlyCalls).toBe(3);

    let badRequestCalls = 0;
    const badRequest = scriptedAdapter({
      responder: () => {
        badRequestCalls += 1;
        return { ok: false, kind: "http-error", status: 400 };
      },
    });
    const result = await embedChunkBatch([firstChunk()], {
      adapter: badRequest,
      store: fixture.store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 1,
      now: fixedClock(),
      idSource: fixedIds("storage"),
      retry: instantRetry,
    });
    // A 4xx answer is deterministic: exactly one attempt, no backoff burn (under the old
    // everything-is-transport classification this looped through the full retry schedule).
    expect(badRequestCalls).toBe(1);
    expect(result.errors.some((e) => e.code === "EMBEDDING_ADAPTER_FAILED")).toBe(true);
    // The persisted document error names the status — indexing-time failures carry the same
    // diagnostic precision as the preflight and readiness safe messages.
    expect(result.errors.some((e) => e.message.includes("http-error (HTTP 400)"))).toBe(true);
  });
});

// ─── #189 GRD-004: array-batch embedding port ────────────────────────────────
function batchAdapter(identity: EmbeddingModelIdentity = DEFAULT_EMBEDDING): {
  adapter: OpenAIEmbeddingAdapter;
  batchCallSizes: number[];
  scalarCalls: () => number;
} {
  const batchCallSizes: number[] = [];
  let scalarCalls = 0;
  const vec = (t: string): Float32Array => deterministicVector(t, identity.vectorDimensions);
  const adapter: OpenAIEmbeddingAdapter = {
    endpoint: "https://example.test/v1",
    apiKey: ["sk-", "test"].join(""),
    request: (req) => {
      scalarCalls += 1;
      return Promise.resolve({
        ok: true,
        value: { vector: vec(req.input), modelId: identity.modelId },
      });
    },
    requestBatch: (req) => {
      batchCallSizes.push(req.inputs.length);
      return Promise.resolve({
        ok: true,
        value: req.inputs.map((t) => ({ vector: vec(t), modelId: identity.modelId })),
      });
    },
  };
  return { adapter, batchCallSizes, scalarCalls: () => scalarCalls };
}

function buildArrayBatchFixture(): Fixture {
  return buildFixture("alpha beta gamma delta epsilon zeta eta theta ".repeat(80));
}

describe("embedChunkBatch — array-batch port (#189 GRD-004)", () => {
  it("uses requestBatch (never the scalar request) and persists one vector per chunk", async () => {
    const { store, cleanup, seeded, chunks } = buildArrayBatchFixture();
    const { adapter, batchCallSizes, scalarCalls } = batchAdapter();
    const result = await embedChunkBatch(chunks, {
      adapter,
      store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("vec"),
    });
    expect(scalarCalls()).toBe(0);
    expect(batchCallSizes).toHaveLength(1);
    expect(batchCallSizes[0]).toBe(chunks.length);
    expect(result.vectors).toHaveLength(chunks.length);
    expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
      chunks.length,
    );
    cleanup();
  });

  it("splits more chunks than the per-request item cap into ceil(N/cap) array calls", async () => {
    const { store, cleanup } = freshStore();
    const seeded = seedCapsuleSourceAndDocument(store);
    const longText = "alpha beta gamma delta epsilon zeta eta theta ".repeat(4000);
    const chunkIds = seedDocumentWithChunks(store, seeded, longText);
    expect(chunkIds.length).toBeGreaterThan(96);
    const chunks: ChunkToEmbed[] = chunkIds.map((id, i) => ({
      id,
      capsuleId: seeded.capsuleId,
      sourceId: seeded.sourceId,
      documentId: seeded.documentId,
      text: `chunk-${String(i)}-distinct-payload`,
    }));
    const { adapter, batchCallSizes, scalarCalls } = batchAdapter();
    const result = await embedChunkBatch(chunks, {
      adapter,
      store,
      pinnedIdentity: DEFAULT_EMBEDDING,
      concurrency: 4,
      now: fixedClock(),
      idSource: fixedIds("vec"),
    });
    expect(scalarCalls()).toBe(0);
    // Item cap is 96; N>96 must fan out into more than one call, never one-per-chunk.
    expect(batchCallSizes).toHaveLength(Math.ceil(chunks.length / 96));
    expect(batchCallSizes.length).toBeLessThan(chunks.length);
    expect(batchCallSizes.reduce((a, b) => a + b, 0)).toBe(chunks.length);
    expect(result.vectors).toHaveLength(chunks.length);
    cleanup();
  });

  it("splits token-dense batches before the Qwen3 32K-class token budget is exceeded", async () => {
    const { store, cleanup, seeded, chunks: seededChunks } = buildFixture("dense ".repeat(40_000));
    const chunks: ChunkToEmbed[] = seededChunks.slice(0, 40).map((chunk, i) => ({
      ...chunk,
      text: `dense-${String(i)}-${"漢".repeat(1_000)}`,
    }));
    const { adapter, batchCallSizes } = batchAdapter();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
      });

      expect(result.errors).toEqual([]);
      expect(result.vectors).toHaveLength(chunks.length);
      expect(batchCallSizes.length).toBeGreaterThan(1);
      expect(batchCallSizes.reduce((sum, n) => sum + n, 0)).toBe(chunks.length);
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        chunks.length,
      );
    } finally {
      cleanup();
    }
  });

  it("uses the injected tokenizer for array-batch token budgeting", async () => {
    const { store, cleanup, seeded, chunks: seededChunks } = buildFixture("alpha ".repeat(400));
    const chunks: ChunkToEmbed[] = seededChunks.slice(0, 3).map((chunk, i) => ({
      ...chunk,
      text: `short-${String(i)}`,
    }));
    const tokenizer: LocalKnowledgeTokenizer = {
      identity: "test-tokenizer-v1",
      kind: "tokenizer",
      countTokens: () => 16_000,
    };
    const { adapter, batchCallSizes } = batchAdapter();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        tokenizer,
      });

      expect(result.errors).toEqual([]);
      expect(result.vectors).toHaveLength(chunks.length);
      expect(batchCallSizes.length).toBeGreaterThan(1);
      expect(batchCallSizes.every((n) => n === 1)).toBe(true);
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        chunks.length,
      );
    } finally {
      cleanup();
    }
  });

  it("passes optional batch transport fields and supports non-l2 persisted vectors", async () => {
    const { store, cleanup, seeded, chunks } = buildFixture();
    const controller = new AbortController();
    const pinnedIdentity: EmbeddingModelIdentity = {
      ...DEFAULT_EMBEDDING,
      dimensionsParam: DEFAULT_EMBEDDING.vectorDimensions,
      normalization: "none",
    };
    const requests: Parameters<NonNullable<OpenAIEmbeddingAdapter["requestBatch"]>>[0][] = [];
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      apiKeyHeaderName: "X-Embedding-Key",
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request) => {
        requests.push(request);
        return Promise.resolve({
          ok: true as const,
          value: request.inputs.map((input) => ({
            vector: deterministicVector(input, pinnedIdentity.vectorDimensions),
            modelId: pinnedIdentity.modelId,
          })),
        });
      },
    };

    try {
      const selected = chunks.slice(0, 2);
      const result = await embedChunkBatch(selected, {
        adapter,
        store,
        pinnedIdentity,
        concurrency: 2,
        signal: controller.signal,
        now: fixedClock(),
        idSource: fixedIds("vec"),
      });

      expect(result.errors).toEqual([]);
      expect(result.vectors).toHaveLength(selected.length);
      expect(result.vectors[0]?.embeddingIdentity.normalization).toBe("none");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.apiKeyHeaderName).toBe("X-Embedding-Key");
      expect(requests[0]?.dimensions).toBe(DEFAULT_EMBEDDING.vectorDimensions);
      expect(requests[0]?.signal).toBe(controller.signal);
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        selected.length,
      );
    } finally {
      cleanup();
    }
  });

  it("retries a transient array-batch failure and succeeds on the next attempt", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    let calls = 0;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request): Promise<OpenAIEmbeddingBatchOutcome> => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ ok: false, kind: "timeout" });
        return Promise.resolve({
          ok: true,
          value: request.inputs.map((input) => ({
            vector: deterministicVector(input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          })),
        });
      },
    };

    try {
      const result = await embedChunkBatch(chunks.slice(0, 2), {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: { maxRetries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() },
      });

      expect(calls).toBe(2);
      expect(result.errors).toEqual([]);
      expect(result.vectors).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it("maps permanent array-batch failures to per-chunk adapter errors without persistence", async () => {
    const { store, cleanup, seeded, chunks } = buildArrayBatchFixture();
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: () => Promise.resolve({ ok: false, kind: "wrong-header" }),
    };

    try {
      const selected = chunks.slice(0, 3);
      const result = await embedChunkBatch(selected, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
      });

      expect(result.vectors).toEqual([]);
      expect(result.errors).toHaveLength(selected.length);
      expect(result.errors.every((error) => error.code === "EMBEDDING_ADAPTER_FAILED")).toBe(true);
      // A deterministic rejection is NOT gateway-outage evidence: no transient flag, so the
      // orchestrator's circuit breaker never counts it.
      expect(result.errors.every((error) => error.transient === undefined)).toBe(true);
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        0,
      );
    } finally {
      cleanup();
    }
  });

  it("surfaces invalid-response when an array-batch response omits one embedding", async () => {
    const { store, cleanup, seeded, chunks } = buildArrayBatchFixture();
    const selected = chunks.slice(0, 2);
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request) =>
        Promise.resolve({
          ok: true as const,
          value: request.inputs.slice(0, 1).map((input) => ({
            vector: deterministicVector(input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          })),
        }),
    };

    try {
      const result = await embedChunkBatch(selected, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
      });

      expect(result.vectors).toHaveLength(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain("invalid-response");
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        1,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses to persist any vector when an array-batch item drifts from the pinned identity", async () => {
    const { store, cleanup, seeded, chunks } = buildArrayBatchFixture();
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request) =>
        Promise.resolve({
          ok: true as const,
          value: request.inputs.map((input, index) => ({
            vector: deterministicVector(
              input,
              index === 0 ? 32 : DEFAULT_EMBEDDING.vectorDimensions,
            ),
            modelId: DEFAULT_EMBEDDING.modelId,
          })),
        }),
    };

    try {
      const result = await embedChunkBatch(chunks.slice(0, 3), {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
      });

      expect(result.vectors).toEqual([]);
      expect(result.errors.some((error) => error.code === "INCOMPATIBLE_EMBEDDING_IDENTITY")).toBe(
        true,
      );
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        0,
      );
    } finally {
      cleanup();
    }
  });

  it("stops retrying array batches when the signal aborts during backoff", async () => {
    const { store, cleanup, seeded, chunks } = buildArrayBatchFixture();
    const controller = new AbortController();
    let calls = 0;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: () => {
        calls += 1;
        return Promise.resolve({ ok: false as const, kind: "rate-limited" as const });
      },
    };

    try {
      const result = await embedChunkBatch(chunks.slice(0, 1), {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        signal: controller.signal,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: {
          maxRetries: 5,
          baseDelayMs: 0,
          sleep: () => {
            controller.abort();
            return Promise.reject(new DOMException("aborted", "AbortError"));
          },
        },
      });

      expect(calls).toBe(1);
      expect(result.vectors).toEqual([]);
      expect(result.errors.some((error) => error.code === "CANCELLED")).toBe(true);
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        0,
      );
    } finally {
      cleanup();
    }
  });

  // ─── Scalar-ladder partial progress (customer field incident, 0.3.12) ────────
  // A ladder-deadline expiry is transient, but re-sending the identical full input list discards
  // every finished embedding each round: non-convergent whenever inputCount x per-item latency
  // exceeds the ladder cap — the 0.3.11 endless-indexing shape, one cap higher. A transient
  // failure that carries the completed prefix must RESUME behind it, and progress must reset the
  // retry budget so only zero-progress attempts burn it.
  it("resumes an array batch behind the completed prefix instead of re-embedding from item zero", async () => {
    const { store, cleanup, seeded, chunks } = buildFixture(
      "alpha beta gamma delta epsilon zeta eta theta ".repeat(240),
    );
    const selected = chunks.slice(0, 3);
    // Fixture-shape precondition: the resume journey needs three real chunks.
    expect(selected).toHaveLength(3);
    const vec = (t: string): Float32Array =>
      deterministicVector(t, DEFAULT_EMBEDDING.vectorDimensions);
    const requests: (readonly string[])[] = [];
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request): Promise<OpenAIEmbeddingBatchOutcome> => {
        requests.push(request.inputs);
        if (requests.length === 1) {
          return Promise.resolve({
            ok: false,
            kind: "timeout",
            partial: request.inputs
              .slice(0, 2)
              .map((t) => ({ vector: vec(t), modelId: DEFAULT_EMBEDDING.modelId })),
          });
        }
        return Promise.resolve({
          ok: true,
          value: request.inputs.map((t) => ({
            vector: vec(t),
            modelId: DEFAULT_EMBEDDING.modelId,
          })),
        });
      },
    };

    try {
      const result = await embedChunkBatch(selected, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: { maxRetries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() },
      });

      // The retry must carry ONLY the remainder — re-sending the full list is the
      // non-convergent shape this pin exists to forbid.
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]?.slice(2));
      expect(result.errors).toEqual([]);
      expect(result.vectors).toHaveLength(3);
      expect(countVectorsForDocument(store._internal.db, seeded.capsuleId, seeded.documentId)).toBe(
        3,
      );
    } finally {
      cleanup();
    }
  });

  it("converges one item per deadline window because progress resets the retry budget", async () => {
    const { store, cleanup, chunks } = buildFixture(
      "alpha beta gamma delta epsilon zeta eta theta ".repeat(240),
    );
    const selected = chunks.slice(0, 3);
    expect(selected).toHaveLength(3);
    const vec = (t: string): Float32Array =>
      deterministicVector(t, DEFAULT_EMBEDDING.vectorDimensions);
    let calls = 0;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request): Promise<OpenAIEmbeddingBatchOutcome> => {
        calls += 1;
        if (request.inputs.length === 1) {
          return Promise.resolve({
            ok: true,
            value: request.inputs.map((t) => ({
              vector: vec(t),
              modelId: DEFAULT_EMBEDDING.modelId,
            })),
          });
        }
        // Every window finishes exactly one item before the deadline expires.
        return Promise.resolve({
          ok: false,
          kind: "timeout",
          partial: request.inputs
            .slice(0, 1)
            .map((t) => ({ vector: vec(t), modelId: DEFAULT_EMBEDDING.modelId })),
        });
      },
    };

    try {
      const result = await embedChunkBatch(selected, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        // With a STATIC budget of 1 this walk needs the progress reset to survive two
        // consecutive expiries; without it the second expiry would be terminal.
        retry: { maxRetries: 1, baseDelayMs: 0, sleep: () => Promise.resolve() },
      });

      expect(calls).toBe(3);
      expect(result.errors).toEqual([]);
      expect(result.vectors).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  it("still gives up after maxRetries zero-progress expiries", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    let calls = 0;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: () => {
        calls += 1;
        return Promise.resolve({ ok: false as const, kind: "timeout" as const });
      },
    };

    try {
      const result = await embedChunkBatch(chunks.slice(0, 2), {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: { maxRetries: 2, baseDelayMs: 0, sleep: () => Promise.resolve() },
      });

      expect(calls).toBe(3);
      expect(result.vectors).toEqual([]);
      expect(result.errors.every((error) => error.code === "EMBEDDING_ADAPTER_FAILED")).toBe(true);
      // Exhausted TRANSIENT retries carry the classification the orchestrator's gateway
      // circuit breaker counts (2026-08 field review).
      expect(result.errors.every((error) => error.transient === true)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ─── Activity log ────────────────────────────────────────────────────────────
// The orchestrator's IndexingEvent stream reports job and document STATE CHANGES. It cannot
// see which embedding transport was chosen, how many round-trips a batch actually cost, that a
// batch was retried four times, or that a partial prefix was absorbed instead of discarded —
// and those are exactly the facts an operator needs when a run is slow rather than broken.
// These tests pin that those decisions reach the sink, and that no chunk text goes with them.
describe("embedChunkBatch — activity log", () => {
  function recordingSink(): {
    sink: KnowledgeLogSink;
    events: KnowledgeLogEvent[];
    ops: () => readonly string[];
    find: (op: string) => KnowledgeLogEvent | undefined;
  } {
    const events: KnowledgeLogEvent[] = [];
    return {
      sink: {
        write: (event): void => {
          events.push(event);
        },
      },
      events,
      ops: (): readonly string[] => events.map((event) => event.op),
      find: (op): KnowledgeLogEvent | undefined => events.find((event) => event.op === op),
    };
  }

  const noBackoff = {
    maxRetries: 2,
    baseDelayMs: 0,
    sleep: (): Promise<void> => Promise.resolve(),
  };

  // Ten real chunk rows. The `vectors` table has a foreign key onto `chunks`, so a test that
  // needs several distinct chunks has to seed them through the real chunker rather than
  // fabricating ids.
  function buildTenChunkFixture(): Fixture {
    return buildFixture("alpha beta gamma delta epsilon zeta eta theta ".repeat(400));
  }

  const CONTEXT: IndexingLogContext = {
    jobId: "11111111-2222-3333-4444-555555555555",
    capsuleIdDigest: "0123456789abcdef",
    documentIdDigest: "fedcba9876543210",
  };

  it("records the array-batch transport choice, the grouping, and the completion", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter } = batchAdapter();
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
      });

      const selected = log.find("embedding.batch.transport-selected");
      // `info`, not `debug`: the transport and the request profile are the run's spine, and an
      // operator reading the file at the default level must see them.
      expect(selected?.level).toBe("info");
      expect(selected?.category).toBe("embedding");
      expect(selected?.extra).toEqual({
        transport: "array-batch",
        chunkCount: chunks.length,
        uniqueChunkCount: chunks.length,
        dedupedCount: 0,
        concurrency: 4,
        endpointHost: "https://example.test",
      });

      const grouped = log.find("embedding.batch.grouped");
      expect(grouped?.level).toBe("info");
      expect(grouped?.extra).toEqual({
        uniqueChunkCount: chunks.length,
        batchCount: 1,
        concurrency: 4,
        endpointHost: "https://example.test",
      });

      const completed = log.find("embedding.batch.completed");
      expect(completed?.level).toBe("info");
      expect(completed?.extra).toEqual({
        chunkCount: chunks.length,
        vectorCount: result.vectors.length,
        errorCount: 0,
      });
      expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  it("names the scalar transport and the dedupe ratio when the adapter has no requestBatch", async () => {
    const { store, cleanup, chunks } = buildTenChunkFixture();
    // Real seeded chunk rows (the vectors table has a foreign key onto them), all carrying the
    // SAME payload so the dedupe collapses three chunks into one request.
    const repeated: readonly ChunkToEmbed[] = chunks
      .slice(0, 3)
      .map((chunk) => ({ ...chunk, text: "identical payload for every chunk" }));
    expect(repeated).toHaveLength(3);
    const log = recordingSink();
    try {
      await embedChunkBatch(repeated, {
        adapter: happyAdapter(),
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 2,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
      });

      expect(log.find("embedding.batch.transport-selected")?.extra).toEqual({
        transport: "scalar",
        chunkCount: repeated.length,
        uniqueChunkCount: 1,
        dedupedCount: 2,
        concurrency: 2,
        endpointHost: "https://example.test",
      });
      expect(log.ops()).not.toContain("embedding.batch.grouped");
    } finally {
      cleanup();
    }
  });

  it("records a zero-progress retry with its attempt, backoff, and error kind", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const identity = DEFAULT_EMBEDDING;
    let calls = 0;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request): Promise<OpenAIEmbeddingBatchOutcome> => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ ok: false, kind: "timeout", status: 504 });
        }
        return Promise.resolve({
          ok: true,
          value: request.inputs.map((text) => ({
            vector: deterministicVector(text, identity.vectorDimensions),
            modelId: identity.modelId,
          })),
        });
      },
    };
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(chunks.slice(0, 2), {
        adapter,
        store,
        pinnedIdentity: identity,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: noBackoff,
        logSink: log.sink,
      });

      expect(result.errors).toEqual([]);
      const retry = log.find("embedding.batch.retry");
      expect(retry?.level).toBe("warn");
      expect(retry?.errorKind).toBe("timeout");
      expect(retry?.status).toBe(504);
      expect(retry?.extra).toEqual({
        attempt: 1,
        zeroProgressRetries: 1,
        maxRetries: 2,
        delayMs: 0,
        remainingCount: 2,
        completedCount: 0,
        transport: "array-batch",
        endpointHost: "https://example.test",
      });
      // "Refused instantly" and "burned the provider deadline" are the same error kind; only
      // the duration separates them, so the field has to be on the line.
      expect(retry?.durationMs).toBeGreaterThanOrEqual(0);
      expect(log.ops()).not.toContain("embedding.batch.partial-progress");
    } finally {
      cleanup();
    }
  });

  // Regression pin for the always-zero attempt number. A batch that inches forward one item per
  // round-trip is the exact shape of the field incident ("0 of 36 vectors" while the gateway is
  // technically answering), and reporting the RESET retry budget as `attempt` made every one of
  // those lines read `attempt: 0` — indistinguishable from a single first try. Two consecutive
  // partial rounds: the attempt number must climb 1 → 2 while the zero-progress budget, which is
  // reset by progress, stays at 0.
  it("counts real round-trips on a partial prefix instead of the reset retry budget", async () => {
    const { store, cleanup, chunks } = buildTenChunkFixture();
    const identity = DEFAULT_EMBEDDING;
    const selected = chunks.slice(0, 3);
    expect(selected).toHaveLength(3);
    const embed = (text: string): { vector: Float32Array; modelId: string } => ({
      vector: deterministicVector(text, identity.vectorDimensions),
      modelId: identity.modelId,
    });
    let calls = 0;
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: (request): Promise<OpenAIEmbeddingBatchOutcome> => {
        calls += 1;
        const head = request.inputs[0];
        if (calls <= 2 && head !== undefined) {
          return Promise.resolve({ ok: false, kind: "timeout", partial: [embed(head)] });
        }
        return Promise.resolve({ ok: true, value: request.inputs.map(embed) });
      },
    };
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(selected, {
        adapter,
        store,
        pinnedIdentity: identity,
        concurrency: 1,
        // Three inches forward need a budget that progress keeps resetting; two zero-progress
        // rounds still exhaust it, so the pin is about the counter and not about the budget.
        retry: { maxRetries: 2, baseDelayMs: 0, sleep: (): Promise<void> => Promise.resolve() },
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
      });

      expect(result.vectors).toHaveLength(3);
      const progress = log.events.filter(
        (event) => event.op === "embedding.batch.partial-progress",
      );
      expect(progress).toHaveLength(2);
      expect(progress.map((event) => event.extra?.attempt)).toEqual([1, 2]);
      expect(progress.map((event) => event.extra?.zeroProgressRetries)).toEqual([0, 0]);
      expect(progress.map((event) => event.extra?.completedCount)).toEqual([1, 2]);
      expect(progress.map((event) => event.extra?.remainingCount)).toEqual([2, 1]);
      expect(progress[0]?.level).toBe("warn");
      expect(progress[0]?.errorKind).toBe("timeout");
      expect(progress[0]?.extra?.endpointHost).toBe("https://example.test");
      expect(progress[0]?.durationMs).toBeGreaterThanOrEqual(0);
      expect(log.ops()).not.toContain("embedding.batch.retry");
    } finally {
      cleanup();
    }
  });

  it("records the exhausted batch with its transient classification and item count", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const adapter: OpenAIEmbeddingAdapter = {
      endpoint: "https://example.test/v1",
      apiKey: ["sk-", "test"].join(""),
      request: () => Promise.resolve({ ok: false, kind: "transport" }),
      requestBatch: () => Promise.resolve({ ok: false as const, kind: "timeout" as const }),
    };
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(chunks.slice(0, 2), {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: noBackoff,
        logSink: log.sink,
      });

      expect(result.vectors).toEqual([]);
      const failed = log.find("embedding.batch.failed");
      expect(failed?.level).toBe("warn");
      expect(failed?.errorKind).toBe("timeout");
      expect(failed?.extra).toEqual({
        itemCount: 2,
        transient: true,
        transport: "array-batch",
        endpointHost: "https://example.test",
      });
      expect(failed?.durationMs).toBeGreaterThanOrEqual(0);
      // The batch still "completed" — with zero vectors and two errors, at warn.
      const completed = log.find("embedding.batch.completed");
      expect(completed?.level).toBe("warn");
      expect(completed?.extra).toEqual({ chunkCount: 2, vectorCount: 0, errorCount: 2 });
    } finally {
      cleanup();
    }
  });

  it("records the fail-closed identity rejection with both dimensions and zero vectors", async () => {
    const { store, cleanup, chunks } = buildFixture();
    const adapter = scriptedAdapter({
      responder: (req) => ({
        ok: true,
        value: { vector: deterministicVector(req.input, 768), modelId: DEFAULT_EMBEDDING.modelId },
      }),
    });
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
      });

      expect(result.vectors).toEqual([]);
      const rejectedIdentity = log.find("embedding.identity.rejected");
      expect(rejectedIdentity?.level).toBe("error");
      expect(rejectedIdentity?.errorKind).toBe("INCOMPATIBLE_EMBEDDING_IDENTITY");
      expect(rejectedIdentity?.extra).toEqual({
        pinnedDimensions: DEFAULT_EMBEDDING.vectorDimensions,
        observedDimensions: 768,
        pinnedNormalization: "l2",
      });

      const rejectedBatch = log.find("embedding.batch.rejected");
      expect(rejectedBatch?.level).toBe("error");
      expect(rejectedBatch?.errorKind).toBe("INCOMPATIBLE_EMBEDDING_IDENTITY");
      expect(rejectedBatch?.extra).toMatchObject({ vectorCount: 0, chunkCount: chunks.length });
      expect(log.ops()).not.toContain("embedding.batch.completed");
    } finally {
      cleanup();
    }
  });

  it("records a tokenizer budgeting failure that degrades the whole set without a request", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter, batchCallSizes } = batchAdapter();
    const throwingTokenizer: LocalKnowledgeTokenizer = {
      identity: "throwing-test-tokenizer",
      kind: "estimator",
      countTokens: (): number => {
        throw new RangeError("tokenizer exploded");
      },
    };
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        tokenizer: throwingTokenizer,
        logSink: log.sink,
      });

      expect(batchCallSizes).toEqual([]);
      expect(result.vectors).toEqual([]);
      const budgeting = log.find("embedding.batch.budgeting-failed");
      expect(budgeting?.level).toBe("warn");
      expect(budgeting?.errorKind).toBe("RangeError");
      expect(budgeting?.extra).toEqual({ uniqueChunkCount: chunks.length });
    } finally {
      cleanup();
    }
  });

  it("records the cancellation exit instead of a completion", async () => {
    const { store, cleanup, chunks } = buildFixture();
    const controller = new AbortController();
    const adapter = scriptedAdapter({
      responder: (req) => {
        controller.abort();
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });
    const log = recordingSink();
    try {
      await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        signal: controller.signal,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
      });

      const cancelled = log.find("embedding.batch.cancelled");
      expect(cancelled?.level).toBe("warn");
      expect(cancelled?.errorKind).toBe("CANCELLED");
      expect(cancelled?.extra).toMatchObject({ vectorCount: 0 });
      expect(log.ops()).not.toContain("embedding.batch.completed");
    } finally {
      cleanup();
    }
  });

  // The leak proof. Every line above carries counts and kinds; none may carry the payload.
  it("never lets chunk text, the api key, or the endpoint reach a logged field", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter } = batchAdapter();
    const log = recordingSink();
    try {
      await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
      });

      expect(log.events.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(log.events);
      expect(serialized).not.toContain("alpha beta gamma");
      expect(serialized).not.toContain(adapter.apiKey);
      expect(serialized).not.toContain(adapter.endpoint);
      for (const chunk of chunks) {
        expect(serialized).not.toContain(chunk.text);
      }
    } finally {
      cleanup();
    }
  });

  // Defect: a throw out of `persistOutcomes` skipped every closing line, so the file ended on a
  // SUCCESSFUL gateway round-trip and an operator saw a batch that embedded fine and then simply
  // stopped. The write is the last step of a flush and the only one that throws.
  it("records the vector-persistence failure on the throwing path", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter } = batchAdapter();
    const log = recordingSink();
    const explodingIdSource = (): string => {
      throw new RangeError("storage reference source exploded");
    };
    try {
      await expect(
        embedChunkBatch(chunks, {
          adapter,
          store,
          pinnedIdentity: DEFAULT_EMBEDDING,
          concurrency: 1,
          now: fixedClock(),
          idSource: explodingIdSource,
          logSink: log.sink,
          logContext: CONTEXT,
        }),
      ).rejects.toThrow(/vector persistence failed/);

      const persistFailed = log.find("embedding.batch.persist-failed");
      expect(persistFailed?.level).toBe("error");
      expect(persistFailed?.category).toBe("embedding");
      // The batcher wraps the cause in an IndexingError, so the KIND an operator sees is the
      // persistence code — not the tokenizer/transport codes every other failure line carries.
      expect(persistFailed?.errorKind).toBe("PERSISTENCE_FAILED");
      expect(persistFailed?.durationMs).toBeGreaterThanOrEqual(0);
      expect(persistFailed?.extra).toMatchObject({
        chunkCount: chunks.length,
        vectorCount: 0,
        capsuleIdDigest: CONTEXT.capsuleIdDigest,
      });
      // The whole point: the run must NOT look like it completed.
      expect(log.ops()).not.toContain("embedding.batch.completed");
    } finally {
      cleanup();
    }
  });

  // Defect: with concurrency 4 several documents embed at once, so an uncorrelated line cannot be
  // attributed to the work that produced it.
  it("stamps the job id and both digests on every line it writes", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter } = batchAdapter();
    const log = recordingSink();
    try {
      await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: log.sink,
        logContext: CONTEXT,
      });

      expect(log.events.length).toBeGreaterThan(0);
      for (const event of log.events) {
        expect(event.correlationId).toBe(CONTEXT.jobId);
        expect(event.extra?.capsuleIdDigest).toBe(CONTEXT.capsuleIdDigest);
        expect(event.extra?.documentIdDigest).toBe(CONTEXT.documentIdDigest);
      }
    } finally {
      cleanup();
    }
  });

  it("times and locates every scalar retry so a refusal is distinguishable from a deadline", async () => {
    const { store, cleanup, chunks } = buildFixture();
    let calls = 0;
    const adapter = scriptedAdapter({
      endpoint: "https://gateway.test:8443/v1/embeddings?api-version=2024-02-01",
      responder: (req) => {
        calls += 1;
        if (calls === 1) return { ok: false, kind: "timeout", status: 504 };
        return {
          ok: true,
          value: {
            vector: deterministicVector(req.input, DEFAULT_EMBEDDING.vectorDimensions),
            modelId: DEFAULT_EMBEDDING.modelId,
          },
        };
      },
    });
    const log = recordingSink();
    try {
      await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: noBackoff,
        logSink: log.sink,
        logContext: CONTEXT,
      });

      const retry = log.find("embedding.chunk.retry");
      expect(retry?.level).toBe("warn");
      expect(retry?.errorKind).toBe("timeout");
      expect(retry?.status).toBe(504);
      expect(retry?.durationMs).toBeGreaterThanOrEqual(0);
      // Port kept (it is part of "which gateway"), api-version query and path dropped.
      expect(retry?.extra).toMatchObject({
        attempt: 1,
        maxRetries: 2,
        transport: "scalar",
        endpointHost: "https://gateway.test:8443",
      });
    } finally {
      cleanup();
    }
  });

  // `attempt` is ROUND-TRIPS ISSUED on both transports, never the retry budget — the budget is
  // `maxRetries` and is reported beside it. The expectation is derived from what the adapter
  // actually received rather than restated as a literal: every chunk here fails identically, so
  // the calls the adapter counted, divided by the chunks, IS the number of round-trips the
  // exhausted line must report. Pinning the budget instead read one low and made an exhausted
  // scalar chunk look like it had spent one fewer call than it had.
  it("exhausts the scalar ladder with the attempt count, the duration, and the host", async () => {
    const { store, cleanup, chunks } = buildFixture();
    let calls = 0;
    const adapter = scriptedAdapter({
      responder: () => {
        calls += 1;
        return { ok: false, kind: "transport" };
      },
    });
    const log = recordingSink();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: noBackoff,
        logSink: log.sink,
        logContext: CONTEXT,
      });

      expect(result.vectors).toEqual([]);
      const roundTripsPerChunk = calls / chunks.length;
      expect(roundTripsPerChunk).toBe(noBackoff.maxRetries + 1);
      const exhausted = log.find("embedding.chunk.retry-exhausted");
      expect(exhausted?.level).toBe("warn");
      expect(exhausted?.errorKind).toBe("transport");
      expect(exhausted?.durationMs).toBeGreaterThanOrEqual(0);
      expect(exhausted?.extra).toMatchObject({
        attempt: roundTripsPerChunk,
        maxRetries: noBackoff.maxRetries,
        transport: "scalar",
        endpointHost: "https://example.test",
      });
    } finally {
      cleanup();
    }
  });

  // The endpoint is diagnostic, its path and query are not: a provider URL has historically
  // carried a deployment id, an api-version and an outright credential in exactly those places.
  it("reduces the endpoint to scheme://host, never its userinfo, path, or query", async () => {
    const { store, cleanup, chunks } = buildFixture();
    const adapter = scriptedAdapter({
      endpoint: "https://svc:hunter2@gateway.test/v1/embeddings?api_key=leaked-value",
      responder: () => ({ ok: false, kind: "transport" }),
    });
    const log = recordingSink();
    try {
      await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 1,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        retry: noBackoff,
        logSink: log.sink,
        logContext: CONTEXT,
      });

      expect(log.find("embedding.chunk.retry-exhausted")?.extra?.endpointHost).toBe(
        "https://gateway.test",
      );
      const serialized = JSON.stringify(log.events);
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("leaked-value");
      expect(serialized).not.toContain("/v1/embeddings");
      expect(serialized).not.toContain("api_key");
    } finally {
      cleanup();
    }
  });

  // Two runs over the same failing path, differing only in the endpoint: an unparseable endpoint
  // must OMIT the field rather than write `undefined` ("the gateway has no host" is a different
  // diagnosis from "we could not read the configuration"), while a parseable one must carry it.
  // The parseable half is what keeps this from passing when the field is dropped everywhere.
  it("omits the endpoint field when the endpoint does not parse, and carries it when it does", async () => {
    const failEverything = (): { ok: false; kind: "transport" } => ({
      ok: false,
      kind: "transport",
    });
    const exhaustedExtraFor = async (endpoint: string): Promise<Record<string, unknown>> => {
      const { store, cleanup, chunks } = buildFixture();
      const log = recordingSink();
      try {
        await embedChunkBatch(chunks, {
          adapter: scriptedAdapter({ endpoint, responder: failEverything }),
          store,
          pinnedIdentity: DEFAULT_EMBEDDING,
          concurrency: 1,
          now: fixedClock(),
          idSource: fixedIds("vec"),
          retry: noBackoff,
          logSink: log.sink,
        });
        const exhausted = log.find("embedding.chunk.retry-exhausted");
        expect(exhausted).toBeDefined();
        return { ...exhausted?.extra };
      } finally {
        cleanup();
      }
    };

    expect(await exhaustedExtraFor("not-a-url")).not.toHaveProperty("endpointHost");
    expect(await exhaustedExtraFor("https://gateway.test/v1")).toHaveProperty(
      "endpointHost",
      "https://gateway.test",
    );
  });

  it("is inert when no sink is wired", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter } = batchAdapter();
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
      });
      expect(result.vectors).toHaveLength(chunks.length);
    } finally {
      cleanup();
    }
  });

  // The sink is caller-supplied code and every embedding decision is logged, so an unguarded
  // write would put a logging defect inside the transport choice, the retry ladder, the pinned-
  // identity gate and `persistAndReport` alike — a batch that embedded perfectly would be
  // reported as failed because writing the line about it threw.
  it("embeds the whole batch even when every write to the sink throws", async () => {
    const { store, cleanup, chunks } = buildArrayBatchFixture();
    const { adapter } = batchAdapter();
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const dead: KnowledgeLogSink = {
      write: (): never => {
        throw new Error("sink is down");
      },
    };
    try {
      const result = await embedChunkBatch(chunks, {
        adapter,
        store,
        pinnedIdentity: DEFAULT_EMBEDDING,
        concurrency: 4,
        now: fixedClock(),
        idSource: fixedIds("vec"),
        logSink: dead,
      });

      expect(result.vectors).toHaveLength(chunks.length);
      // Not silent, and not once per line either: one report for the dead sink.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });
});
