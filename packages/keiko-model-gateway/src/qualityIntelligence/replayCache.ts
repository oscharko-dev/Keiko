// Quality Intelligence replay-cache primitives (Epic #270, Issue #279).
//
// Pure deterministic cache-key derivation + a port-pattern in-memory LRU. The cache is
// passed in by the caller; this module owns no IO. Keys are derived via SHA-256 over the
// canonical tuple (profile.id, normalisedPromptHash, modelId) so the same triple always
// yields the same key, irrespective of object identity. Cacheability is decided per
// profile via its `cacheable` flag — non-cacheable profiles are simply not stored.

import type { QualityIntelligencePromptSegments } from "./promptSegmentation.js";
import type { QualityIntelligenceTaskProfile } from "./taskProfiles.js";

export interface QualityIntelligenceReplayCachePort<TValue> {
  readonly get: (key: string) => TValue | undefined;
  readonly set: (key: string, value: TValue) => void;
  readonly delete: (key: string) => void;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function canonicalisePromptForHash(segments: QualityIntelligencePromptSegments): string {
  const evidence = segments.evidenceUntrusted.map((e) => `${e.kind}:${e.value}`).join("");
  return [segments.systemTrusted, segments.instructionTrusted, evidence].join("");
}

export async function deriveReplayCacheKey(
  profile: QualityIntelligenceTaskProfile,
  segments: QualityIntelligencePromptSegments,
  modelId: string,
): Promise<string> {
  const canonical = canonicalisePromptForHash(segments);
  const promptHash = await sha256Hex(canonical);
  const tuple = `${profile.id}${promptHash}${modelId}`;
  return await sha256Hex(tuple);
}

export function isCacheable(profile: QualityIntelligenceTaskProfile): boolean {
  return profile.cacheable;
}

// In-memory LRU implementation of the port. Capacity-bounded; oldest entries are evicted
// first. Provided for callers that want an in-process cache without writing one.
export function createInMemoryReplayCache<TValue>(
  capacity: number,
): QualityIntelligenceReplayCachePort<TValue> {
  const cap = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
  const map = new Map<string, TValue>();

  const evictIfNeeded = (): void => {
    while (map.size > cap) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      map.delete(oldestKey);
    }
  };

  return Object.freeze({
    get(key: string): TValue | undefined {
      if (!map.has(key)) {
        return undefined;
      }
      const value = map.get(key);
      // Touch for recency.
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: string, value: TValue): void {
      if (cap === 0) {
        return;
      }
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, value);
      evictIfNeeded();
    },
    delete(key: string): void {
      map.delete(key);
    },
  });
}
