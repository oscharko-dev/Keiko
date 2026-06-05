// Tests for the scripted offline embedding adapter (Epic #189, Issue #268). Pins:
//   1. Hash determinism — identical input ⇒ identical FNV value.
//   2. Vector determinism — identical input ⇒ byte-identical Float32Array bytes.
//   3. Distinct inputs ⇒ distinct vectors.
//   4. Topic salt routes the cosine — two inputs carrying the same topic marker are more
//      similar than two inputs with different topics.
//   5. Vector dimensions follow the configured identity.
//   6. No network IO — the module never references `fetch` at import time, and a request
//      resolves synchronously through `Promise.resolve` (we assert that by checking the
//      microtask queue is sufficient).
//   7. No time / random sources — verified textually by reading the module source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { EmbeddingModelIdentity } from "@oscharko-dev/keiko-contracts";

import {
  createScriptedEmbeddingAdapter,
  fnv1a32,
  withTopicMarker,
} from "./scripted-embedding-adapter.js";

const IDENTITY: EmbeddingModelIdentity = {
  provider: "openai",
  modelId: "text-embedding-eval",
  vectorDimensions: 32,
  vectorMetric: "cosine",
};

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bytesOf(vector: Float32Array): string {
  const view = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function embed(
  adapter: ReturnType<typeof createScriptedEmbeddingAdapter>,
  input: string,
): Promise<Float32Array> {
  const outcome = await adapter.request({
    endpoint: adapter.endpoint,
    apiKey: adapter.apiKey,
    modelId: IDENTITY.modelId,
    input,
  });
  if (!outcome.ok) throw new Error(`scripted adapter unexpectedly failed: ${outcome.kind}`);
  return outcome.value.vector;
}

describe("fnv1a32", () => {
  it("returns identical hashes for identical inputs", () => {
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
  });

  it("returns different hashes for different inputs", () => {
    expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
  });

  it("matches the documented FNV-1a 32-bit reference value for empty string", () => {
    // FNV-1a offset basis: 0x811c9dc5 = 2166136261. Empty input ⇒ basis unchanged.
    expect(fnv1a32("")).toBe(0x811c9dc5);
  });

  it("matches the documented FNV-1a 32-bit reference value for 'a'", () => {
    // hash('a') = (basis ^ 0x61) * PRIME mod 2^32 = 0xe40c292c.
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
});

describe("createScriptedEmbeddingAdapter — determinism", () => {
  it("returns byte-identical vectors for identical inputs across calls", async () => {
    const adapter = createScriptedEmbeddingAdapter({ identity: IDENTITY });
    const v1 = await embed(adapter, "the quick brown fox");
    const v2 = await embed(adapter, "the quick brown fox");
    expect(bytesOf(v1)).toBe(bytesOf(v2));
  });

  it("returns byte-identical vectors across distinct adapter instances", async () => {
    const a = createScriptedEmbeddingAdapter({ identity: IDENTITY });
    const b = createScriptedEmbeddingAdapter({ identity: IDENTITY });
    const va = await embed(a, "stable input");
    const vb = await embed(b, "stable input");
    expect(bytesOf(va)).toBe(bytesOf(vb));
  });

  it("returns vectors of the configured dimensionality", async () => {
    const adapter = createScriptedEmbeddingAdapter({
      identity: { ...IDENTITY, vectorDimensions: 8 },
    });
    const v = await embed(adapter, "hello");
    expect(v.length).toBe(8);
  });

  it("returns different vectors for different inputs", async () => {
    const adapter = createScriptedEmbeddingAdapter({ identity: IDENTITY });
    const v1 = await embed(adapter, "input one");
    const v2 = await embed(adapter, "input two");
    expect(bytesOf(v1)).not.toBe(bytesOf(v2));
  });
});

describe("createScriptedEmbeddingAdapter — topic salt", () => {
  it("makes two chunks with the same topic marker more similar than two with different topics", async () => {
    const adapter = createScriptedEmbeddingAdapter({
      identity: IDENTITY,
      topicBoosts: { alpha: 1.0, beta: 1.0 },
    });
    const a1 = await embed(adapter, withTopicMarker("text one", "alpha"));
    const a2 = await embed(adapter, withTopicMarker("text two", "alpha"));
    const b1 = await embed(adapter, withTopicMarker("text one", "beta"));
    const sameTopicCos = cosine(a1, a2);
    const crossTopicCos = cosine(a1, b1);
    expect(sameTopicCos).toBeGreaterThan(crossTopicCos);
  });

  it("strips the topic marker before hashing — body alone still influences the vector", async () => {
    const adapter = createScriptedEmbeddingAdapter({
      identity: IDENTITY,
      topicBoosts: { alpha: 0.5 },
    });
    const v1 = await embed(adapter, withTopicMarker("body A", "alpha"));
    const v2 = await embed(adapter, withTopicMarker("body B", "alpha"));
    // Body differs → lane-0 length signal and the FNV-blended lanes differ → vectors are
    // not byte-identical even though the topic is the same.
    expect(bytesOf(v1)).not.toBe(bytesOf(v2));
  });

  it("falls back to body-only hashing when no topic boost matches", async () => {
    const adapter = createScriptedEmbeddingAdapter({
      identity: IDENTITY,
      topicBoosts: { alpha: 1.0 },
    });
    // 'gamma' is not in the boosts table → adapter ignores it and emits the body-only
    // vector. We assert that the result equals what we get without any marker.
    const withUnknownTopic = await embed(adapter, withTopicMarker("body", "gamma"));
    const bare = await embed(adapter, "body");
    expect(bytesOf(withUnknownTopic)).toBe(bytesOf(bare));
  });

  it("clamps boosts outside [0, 1] without throwing", async () => {
    const adapter = createScriptedEmbeddingAdapter({
      identity: IDENTITY,
      // Negative and >1 values are clamped: -1 → 0 (no boost), 5 → 1 (full topic).
      topicBoosts: { neg: -1, hi: 5 },
    });
    const negResult = await embed(adapter, withTopicMarker("body", "neg"));
    const bareResult = await embed(adapter, "body");
    // Negative clamped to 0 → identical to bare.
    expect(bytesOf(negResult)).toBe(bytesOf(bareResult));
    // hi=5 clamped to 1 → identical to the same body with a `hi` boost of exactly 1.
    const hiResult = await embed(adapter, withTopicMarker("body", "hi"));
    const oneBoost = createScriptedEmbeddingAdapter({
      identity: IDENTITY,
      topicBoosts: { hi: 1 },
    });
    const hiOne = await embed(oneBoost, withTopicMarker("body", "hi"));
    expect(bytesOf(hiResult)).toBe(bytesOf(hiOne));
  });

  it("rejects topic markers that cannot be parsed by the adapter", () => {
    expect(() => withTopicMarker("body", "bad topic")).toThrow(/invalid eval topic marker/);
  });
});

describe("createScriptedEmbeddingAdapter — offline guarantees", () => {
  it("module source contains no Date.now / Math.random / performance / fetch references", () => {
    const path = fileURLToPath(new URL("./scripted-embedding-adapter.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    // Strip line comments + block comments so the doc-block prose explaining the rule
    // does not trigger the assertion (it explicitly names the forbidden symbols).
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/\bDate\.now\b/);
    expect(codeOnly).not.toMatch(/\bMath\.random\b/);
    expect(codeOnly).not.toMatch(/\bperformance\b/);
    expect(codeOnly).not.toMatch(/\bnew Date\b/);
    expect(codeOnly).not.toMatch(/\bfetch\s*\(/);
    expect(codeOnly).not.toMatch(/from\s+["']node:https?["']/);
  });

  it("request resolves without yielding to a macrotask (no IO)", async () => {
    const adapter = createScriptedEmbeddingAdapter({ identity: IDENTITY });
    let macrotaskFired = false;
    const macrotask = new Promise<void>((resolve) => {
      setImmediate(() => {
        macrotaskFired = true;
        resolve();
      });
    });
    // Run the request — if it touched the network or any timer, it would land after the
    // setImmediate macrotask.
    const outcome = await adapter.request({
      endpoint: adapter.endpoint,
      apiKey: adapter.apiKey,
      modelId: IDENTITY.modelId,
      input: "fast",
    });
    expect(outcome.ok).toBe(true);
    expect(macrotaskFired).toBe(false);
    await macrotask;
  });
});

describe("createScriptedEmbeddingAdapter — identity propagation", () => {
  it("returns modelId and modelRevision from the identity", async () => {
    const adapter = createScriptedEmbeddingAdapter({
      identity: { ...IDENTITY, modelRevision: "rev-1" },
    });
    const outcome = await adapter.request({
      endpoint: adapter.endpoint,
      apiKey: adapter.apiKey,
      modelId: IDENTITY.modelId,
      input: "x",
    });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.value.modelId).toBe(IDENTITY.modelId);
    expect(outcome.value.modelRevision).toBe("rev-1");
  });

  it("omits modelRevision when the identity has none", async () => {
    const adapter = createScriptedEmbeddingAdapter({ identity: IDENTITY });
    const outcome = await adapter.request({
      endpoint: adapter.endpoint,
      apiKey: adapter.apiKey,
      modelId: IDENTITY.modelId,
      input: "x",
    });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.value.modelRevision).toBeUndefined();
  });
});
