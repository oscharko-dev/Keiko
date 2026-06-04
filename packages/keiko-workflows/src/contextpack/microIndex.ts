// Ephemeral, session-scoped micro-index for assembled ConnectedContextPacks (Epic #177,
// Issue #183). Pure in-memory cache backed by a Map; entries are TTL-bounded and capped
// by maxEntries (insertion order = LRU). NEVER written to disk — the audit ledger (#187)
// owns persistence. makeIndexKey uses SHA-256 with a fixed prefix so identical inputs
// reuse the same cached pack regardless of caller order on atomStableIds.

import { createHash } from "node:crypto";

import type { ConnectedContextPack } from "@oscharko-dev/keiko-contracts/connected-context";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface IndexEntry {
  readonly key: string;
  readonly pack: ConnectedContextPack;
  readonly insertedAtMs: number;
  readonly expiresAtMs: number;
}

export interface MicroIndexOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly nowMs: () => number;
}

export const DEFAULT_MICRO_INDEX: Omit<MicroIndexOptions, "nowMs"> = {
  ttlMs: 5 * 60 * 1000,
  maxEntries: 32,
} as const;

export interface MicroIndex {
  get(key: string): ConnectedContextPack | undefined;
  set(key: string, pack: ConnectedContextPack): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
}

export interface IndexKeyInput {
  readonly scopeId: string;
  readonly queryKind: string;
  readonly queryText: string;
  readonly atomStableIds: readonly string[];
}

// ─── Key derivation ───────────────────────────────────────────────────────────

function canonicalKeyInput(input: IndexKeyInput): string {
  const sorted = [...input.atomStableIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([input.scopeId, input.queryKind, input.queryText, sorted]);
}

export function makeIndexKey(input: IndexKeyInput): string {
  const hash = createHash("sha256").update(canonicalKeyInput(input)).digest("hex");
  return `ix-${hash.slice(0, 16)}`;
}

// ─── Micro-index factory ──────────────────────────────────────────────────────

function validateOptions(options: MicroIndexOptions): void {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new RangeError("createMicroIndex: ttlMs must be a positive finite number");
  }
  if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
    throw new RangeError("createMicroIndex: maxEntries must be a positive integer");
  }
  // Validate eagerly so the failure mode is a TypeError at construction rather than a
  // less actionable "options.nowMs is not a function" the next time get/set is called.
  if (typeof options.nowMs !== "function") {
    throw new TypeError("createMicroIndex: nowMs must be a function");
  }
}

function evictExpired(store: Map<string, IndexEntry>, nowMs: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAtMs <= nowMs) {
      store.delete(key);
    }
  }
}

function evictOldest(store: Map<string, IndexEntry>, capacity: number): void {
  while (store.size >= capacity) {
    const iterator = store.keys();
    const next = iterator.next();
    if (next.done === true) {
      return;
    }
    store.delete(next.value);
  }
}

export function createMicroIndex(options: MicroIndexOptions): MicroIndex {
  validateOptions(options);
  // Insertion order on a Map gives natural LRU semantics: `set` re-inserts at the tail,
  // and `evictOldest` removes from the head.
  const store = new Map<string, IndexEntry>();

  function get(key: string): ConnectedContextPack | undefined {
    const entry = store.get(key);
    if (entry === undefined) {
      return undefined;
    }
    const now = options.nowMs();
    if (entry.expiresAtMs <= now) {
      store.delete(key);
      return undefined;
    }
    // Refresh insertion order without changing expiry — recent reads stay warm.
    store.delete(key);
    store.set(key, entry);
    return entry.pack;
  }

  function set(key: string, pack: ConnectedContextPack): void {
    const now = options.nowMs();
    evictExpired(store, now);
    if (store.has(key)) {
      store.delete(key);
    } else {
      evictOldest(store, options.maxEntries);
    }
    const entry: IndexEntry = {
      key,
      pack,
      insertedAtMs: now,
      expiresAtMs: now + options.ttlMs,
    };
    store.set(key, entry);
  }

  function deleteKey(key: string): void {
    store.delete(key);
  }

  function clear(): void {
    store.clear();
  }

  function size(): number {
    return store.size;
  }

  return { get, set, delete: deleteKey, clear, size };
}
