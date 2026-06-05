import { describe, expect, it } from "vitest";
import { buildPromptSegments } from "../promptSegmentation.js";
import { createInMemoryReplayCache, deriveReplayCacheKey, isCacheable } from "../replayCache.js";
import { getQualityIntelligenceTaskProfile } from "../taskProfiles.js";

const PROFILE = getQualityIntelligenceTaskProfile("qi:judge-logic");
const NONCACHEABLE = getQualityIntelligenceTaskProfile("qi:self-check");

describe("Quality Intelligence replay cache", () => {
  it("derives the same key for the same (profile, prompt, model)", async () => {
    const segmentsA = buildPromptSegments(PROFILE, "judge this", [
      { kind: "atom-ref", value: "x" },
    ]);
    const segmentsB = buildPromptSegments(PROFILE, "judge this", [
      { kind: "atom-ref", value: "x" },
    ]);
    const keyA = await deriveReplayCacheKey(PROFILE, segmentsA, "model-1");
    const keyB = await deriveReplayCacheKey(PROFILE, segmentsB, "model-1");
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives different keys when the model id changes", async () => {
    const segments = buildPromptSegments(PROFILE, "judge this", []);
    const k1 = await deriveReplayCacheKey(PROFILE, segments, "model-1");
    const k2 = await deriveReplayCacheKey(PROFILE, segments, "model-2");
    expect(k1).not.toBe(k2);
  });

  it("derives different keys when the instruction changes", async () => {
    const a = buildPromptSegments(PROFILE, "do X", []);
    const b = buildPromptSegments(PROFILE, "do Y", []);
    const k1 = await deriveReplayCacheKey(PROFILE, a, "m");
    const k2 = await deriveReplayCacheKey(PROFILE, b, "m");
    expect(k1).not.toBe(k2);
  });

  it("isCacheable reflects profile.cacheable", () => {
    expect(isCacheable(PROFILE)).toBe(true);
    expect(isCacheable(NONCACHEABLE)).toBe(false);
  });

  it("in-memory cache stores, retrieves, evicts LRU-style, and deletes", () => {
    const cache = createInMemoryReplayCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    // "b" should be evicted (was least-recently used after touching "a").
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  it("capacity 0 makes set a no-op", () => {
    const cache = createInMemoryReplayCache<number>(0);
    cache.set("a", 1);
    expect(cache.get("a")).toBeUndefined();
  });
});
