// Unit tests for the loopback mock server (Issue #2634). The end-to-end suite in
// `knowledge-m2-clean-checkout-demo.test.mjs` drives the mock through
// `runCleanCheckoutDemo`, but the mock's individual responder functions and its socket bind /
// close lifecycle are exercised here directly. Two reasons:
//
//   1. The lifecycle assertions (idempotent close, ephemeral port, `/healthz` shape) are
//      independent of the demo journey and belong on their own tests.
//   2. Sonar's new-code coverage floor is per-line, and this file gives the responder helpers
//      direct in-process exercise so lcov shows them covered.

import { afterEach, describe, expect, it } from "vitest";

import {
  deterministicEmbedding,
  reverseRerankResults,
  startCleanCheckoutMockServer,
} from "../lib/clean-checkout-demo-mock-server.mjs";

const OPEN_MOCKS = [];

async function boot(options) {
  const mock = await startCleanCheckoutMockServer(options);
  OPEN_MOCKS.push(mock);
  return mock;
}

afterEach(async () => {
  while (OPEN_MOCKS.length > 0) {
    await OPEN_MOCKS.pop().close();
  }
});

describe("deterministicEmbedding", () => {
  it("returns a vector of the requested dimensions", () => {
    const vector = deterministicEmbedding("hello", 32);
    expect(vector).toHaveLength(32);
  });

  it("is a pure function — same input yields identical output", () => {
    const first = deterministicEmbedding("Keiko clean-checkout demo", 48);
    const second = deterministicEmbedding("Keiko clean-checkout demo", 48);
    expect(first).toEqual(second);
  });

  it("produces an L2-normalised vector (approximately)", () => {
    const vector = deterministicEmbedding("normalisation probe", 64);
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it("falls back to a uniform L2 vector on empty input rather than dividing by zero", () => {
    const vector = deterministicEmbedding("", 16);
    const expectedValue = 1 / Math.sqrt(16);
    for (const value of vector) {
      expect(value).toBeCloseTo(expectedValue, 6);
    }
  });
});

describe("reverseRerankResults", () => {
  it("returns the reversed document order, capped by topN", () => {
    const docs = ["a", "b", "c", "d", "e"];
    const results = reverseRerankResults(docs, 3);
    expect(results.map((entry) => entry.index)).toEqual([4, 3, 2]);
  });

  it("clamps a topN larger than the document count to the document count", () => {
    const docs = ["a", "b"];
    const results = reverseRerankResults(docs, 100);
    expect(results.map((entry) => entry.index)).toEqual([1, 0]);
  });

  it("emits monotonically-decreasing relevance scores so the caller can trust the order", () => {
    const docs = ["a", "b", "c", "d"];
    const scores = reverseRerankResults(docs, 4).map((entry) => entry.relevance_score);
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]).toBeLessThan(scores[index - 1]);
    }
  });

  it("returns an empty result set when topN is zero or coerces to zero", () => {
    expect(reverseRerankResults(["a", "b"], 0)).toEqual([]);
    expect(reverseRerankResults(["a", "b"], "not-a-number")).toEqual([]);
  });
});

describe("startCleanCheckoutMockServer", () => {
  it("binds to an ephemeral loopback port and serves a healthz response", async () => {
    const mock = await boot({ embeddingDimensions: 32 });
    expect(mock.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(mock.embeddingDimensions).toBe(32);
    const response = await globalThis.fetch(`${mock.origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves OpenAI-compatible embeddings whose vectors match deterministicEmbedding", async () => {
    const mock = await boot({ embeddingDimensions: 16 });
    const response = await globalThis.fetch(`${mock.origin}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: ["alpha", "beta"], model: "keiko-mock" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].embedding).toEqual(deterministicEmbedding("alpha", 16));
    expect(body.data[1].embedding).toEqual(deterministicEmbedding("beta", 16));
    expect(body.usage.prompt_tokens).toBe(2);
  });

  it("serves a LiteLLM-compatible rerank whose ordering matches reverseRerankResults", async () => {
    const mock = await boot({ embeddingDimensions: 16 });
    const response = await globalThis.fetch(`${mock.origin}/v1/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "keiko-mock-rerank",
        query: "test",
        documents: ["a", "b", "c", "d"],
        top_n: 3,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.map((entry) => entry.index)).toEqual([3, 2, 1]);
  });

  it("returns 404 for unrecognised paths", async () => {
    const mock = await boot({});
    const response = await globalThis.fetch(`${mock.origin}/v1/anything-else`);
    expect(response.status).toBe(404);
  });

  it("rejects malformed embedding bodies without throwing and still returns a valid shape", async () => {
    const mock = await boot({ embeddingDimensions: 16 });
    const response = await globalThis.fetch(`${mock.origin}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json-at-all{",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Malformed body falls through to a single empty input, so the response has one entry.
    expect(body.data).toHaveLength(1);
    expect(body.data[0].embedding).toHaveLength(16);
  });

  it("close() is idempotent — a second close does not throw and resolves quickly", async () => {
    const mock = await startCleanCheckoutMockServer({ embeddingDimensions: 16 });
    await mock.close();
    await expect(mock.close()).resolves.toBeUndefined();
  });
});
