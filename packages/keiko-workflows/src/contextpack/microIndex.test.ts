// Tests for the ephemeral micro-index (Issue #183). Covers round-trip, TTL expiry,
// LRU eviction at capacity, deterministic and order-independent key derivation, and
// negative-option validation.

import { describe, expect, it } from "vitest";

import type {
  ConnectedContextPack,
  ExplorationBudget,
  ExplorationUsage,
  RetrievalQuery,
  SelectedScope,
} from "@oscharko-dev/keiko-contracts/connected-context";

import {
  createMicroIndex,
  DEFAULT_MICRO_INDEX,
  makeIndexKey,
  type MicroIndexOptions,
} from "./microIndex.js";

function scope(scopeId: string): SelectedScope {
  return {
    schemaVersion: "1",
    scopeId,
    workspaceRoot: "/workspace",
    kind: "workspace-root",
    relativePaths: [],
    conversationId: undefined,
    connectedAtMs: 0,
  };
}

function query(): RetrievalQuery {
  return {
    kind: "natural-language",
    text: "where is auth wired",
    caseSensitive: false,
    maxResults: 10,
    emittedAtMs: 0,
  };
}

function emptyBudget(): ExplorationBudget {
  return {
    searchCallsMax: 16,
    filesReadMax: 32,
    excerptBytesMax: 1024,
    modelInputTokensMax: 0,
    modelOutputTokensMax: 0,
    elapsedMsMax: 1000,
    rerankCallsMax: 0,
  };
}

function zeroUsage(): ExplorationUsage {
  return {
    searchCalls: 0,
    filesRead: 0,
    excerptBytes: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    elapsedMs: 0,
    rerankCalls: 0,
  };
}

function pack(stableId: string, scopeId: string): ConnectedContextPack {
  return {
    schemaVersion: "1",
    stableId,
    scope: scope(scopeId),
    query: query(),
    budget: emptyBudget(),
    usage: zeroUsage(),
    files: [],
    omitted: [],
    uncertainty: [],
    emittedAtMs: 0,
    ledgerRef: undefined,
  };
}

function clock(initial: number): { now: () => number; advance: (ms: number) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

function options(now: () => number, overrides: Partial<MicroIndexOptions> = {}): MicroIndexOptions {
  return {
    ttlMs: overrides.ttlMs ?? DEFAULT_MICRO_INDEX.ttlMs,
    maxEntries: overrides.maxEntries ?? DEFAULT_MICRO_INDEX.maxEntries,
    nowMs: now,
  };
}

describe("createMicroIndex", () => {
  it("round-trips: set then get returns the same pack", () => {
    const c = clock(1_000);
    const idx = createMicroIndex(options(c.now));
    const p = pack("p-1", "s-1");
    idx.set("k1", p);
    expect(idx.get("k1")).toBe(p);
    expect(idx.size()).toBe(1);
  });

  it("returns undefined for a missing key", () => {
    const idx = createMicroIndex(options(() => 0));
    expect(idx.get("missing")).toBeUndefined();
  });

  it("expires entries past ttlMs and shrinks size", () => {
    const c = clock(1_000);
    const idx = createMicroIndex(options(c.now, { ttlMs: 1_000 }));
    idx.set("k1", pack("p-1", "s-1"));
    expect(idx.size()).toBe(1);
    c.advance(1_500);
    expect(idx.get("k1")).toBeUndefined();
    expect(idx.size()).toBe(0);
  });

  it("evicts the oldest entry when maxEntries would be exceeded", () => {
    const c = clock(1_000);
    const idx = createMicroIndex(options(c.now, { maxEntries: 2 }));
    idx.set("a", pack("p-a", "s-a"));
    c.advance(1);
    idx.set("b", pack("p-b", "s-b"));
    c.advance(1);
    idx.set("c", pack("p-c", "s-c"));
    expect(idx.size()).toBe(2);
    expect(idx.get("a")).toBeUndefined();
    expect(idx.get("b")).toBeDefined();
    expect(idx.get("c")).toBeDefined();
  });

  it("refreshes LRU order on get so recently-read entries survive eviction", () => {
    const c = clock(1_000);
    const idx = createMicroIndex(options(c.now, { maxEntries: 2 }));
    idx.set("a", pack("p-a", "s-a"));
    c.advance(1);
    idx.set("b", pack("p-b", "s-b"));
    c.advance(1);
    // Touch "a" so it is the most-recently used.
    expect(idx.get("a")).toBeDefined();
    c.advance(1);
    idx.set("c", pack("p-c", "s-c"));
    expect(idx.get("a")).toBeDefined();
    expect(idx.get("b")).toBeUndefined();
    expect(idx.get("c")).toBeDefined();
  });

  it("clear() empties the store", () => {
    const idx = createMicroIndex(options(() => 1_000));
    idx.set("k1", pack("p-1", "s-1"));
    idx.set("k2", pack("p-2", "s-2"));
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.get("k1")).toBeUndefined();
  });

  it("delete() removes a single entry", () => {
    const idx = createMicroIndex(options(() => 1_000));
    idx.set("k1", pack("p-1", "s-1"));
    idx.delete("k1");
    expect(idx.get("k1")).toBeUndefined();
    expect(idx.size()).toBe(0);
  });

  it("rejects non-positive ttlMs", () => {
    expect(() => createMicroIndex(options(() => 0, { ttlMs: 0 }))).toThrow(RangeError);
    expect(() => createMicroIndex(options(() => 0, { ttlMs: -1 }))).toThrow(RangeError);
  });

  it("rejects non-positive maxEntries", () => {
    expect(() => createMicroIndex(options(() => 0, { maxEntries: 0 }))).toThrow(RangeError);
  });

  it("rejects a non-function nowMs at construction time", () => {
    // Copilot review on PR #252: a missing nowMs would otherwise surface as a less
    // actionable "options.nowMs is not a function" the next time get/set is called.
    const bad = { ttlMs: 1000, maxEntries: 8, nowMs: null as unknown as () => number };
    expect(() => createMicroIndex(bad)).toThrow(TypeError);
  });
});

describe("makeIndexKey", () => {
  const base = {
    scopeId: "scope-1",
    queryKind: "natural-language",
    queryText: "where is auth",
    atomStableIds: ["a-1", "a-2", "a-3"] as readonly string[],
  };

  it("is deterministic: same input yields the same key", () => {
    expect(makeIndexKey(base)).toBe(makeIndexKey(base));
  });

  it("is order-independent on atomStableIds", () => {
    const forward = makeIndexKey(base);
    const reversed = makeIndexKey({ ...base, atomStableIds: ["a-3", "a-2", "a-1"] });
    expect(forward).toBe(reversed);
  });

  it("changes when scopeId changes", () => {
    expect(makeIndexKey({ ...base, scopeId: "scope-2" })).not.toBe(makeIndexKey(base));
  });

  it("changes when query text changes", () => {
    expect(makeIndexKey({ ...base, queryText: "different" })).not.toBe(makeIndexKey(base));
  });

  it("emits the `ix-` prefix and a 16-hex-char body", () => {
    const key = makeIndexKey(base);
    expect(key.startsWith("ix-")).toBe(true);
    expect(key.length).toBe(3 + 16);
    expect(/^ix-[0-9a-f]{16}$/.test(key)).toBe(true);
  });
});
