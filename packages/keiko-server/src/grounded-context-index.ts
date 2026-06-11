// Server-local lifecycle for Issue #183's ephemeral context-pack micro-index. The workflow
// package owns the cache implementation; this module scopes instances to a connected chat/session
// and provides deterministic cleanup hooks for chat/project lifecycle changes. Nothing persists.

import { createHash } from "node:crypto";

import type { SelectedScope } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  createMicroIndex,
  DEFAULT_MICRO_INDEX,
  type MicroIndex,
} from "@oscharko-dev/keiko-workflows";

export interface GroundedContextIndexRegistryOptions {
  readonly ttlMs?: number;
  readonly maxEntriesPerScope?: number;
  readonly maxScopes?: number;
  readonly sweepIntervalMs?: number;
  readonly autoSweep?: boolean;
}

export interface GroundedContextIndexRegistry {
  forScope(scope: SelectedScope, nowMs: () => number): MicroIndex;
  clearConversation(conversationId: string): void;
  clearWorkspace(workspaceRoot: string): void;
  clearAll(): void;
  sweep(nowMs: () => number): void;
  size(): number;
  dispose(): void;
}

interface MutableClock {
  nowMs: () => number;
}

interface RegistryEntry {
  readonly key: string;
  readonly index: MicroIndex;
  readonly clock: MutableClock;
  readonly conversationId: string | undefined;
  readonly workspaceRoot: string;
  expiresAtMs: number;
  touchedAtMs: number;
}

interface ResolvedOptions {
  readonly ttlMs: number;
  readonly maxEntriesPerScope: number;
  readonly maxScopes: number;
  readonly sweepIntervalMs: number;
  readonly autoSweep: boolean;
}

const DEFAULT_MAX_SCOPES = 32;
const DEFAULT_MAX_ENTRIES_PER_SCOPE = 8;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function optionOrDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}

function resolveOptions(options: GroundedContextIndexRegistryOptions | undefined): ResolvedOptions {
  const provided = options ?? {};
  const resolved = {
    ttlMs: optionOrDefault(provided.ttlMs, DEFAULT_MICRO_INDEX.ttlMs),
    maxEntriesPerScope: optionOrDefault(provided.maxEntriesPerScope, DEFAULT_MAX_ENTRIES_PER_SCOPE),
    maxScopes: optionOrDefault(provided.maxScopes, DEFAULT_MAX_SCOPES),
    sweepIntervalMs: optionOrDefault(provided.sweepIntervalMs, DEFAULT_SWEEP_INTERVAL_MS),
    autoSweep: optionOrDefault(provided.autoSweep, true),
  };
  assertPositiveInteger("ttlMs", resolved.ttlMs);
  assertPositiveInteger("maxEntriesPerScope", resolved.maxEntriesPerScope);
  assertPositiveInteger("maxScopes", resolved.maxScopes);
  assertPositiveInteger("sweepIntervalMs", resolved.sweepIntervalMs);
  return resolved;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeKey(scope: SelectedScope): string {
  const source = JSON.stringify({
    workspaceRoot: scope.workspaceRoot,
    scopeId: scope.scopeId,
    kind: scope.kind,
    relativePaths: [...scope.relativePaths].sort(),
    conversationId: scope.conversationId,
    connectedAtMs: scope.connectedAtMs,
  });
  return `gci-${sha256Hex(source).slice(0, 16)}`;
}

function evictExpired(entries: Map<string, RegistryEntry>, nowMs: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAtMs <= nowMs) {
      entry.index.clear();
      entries.delete(key);
    }
  }
}

function evictOldest(entries: Map<string, RegistryEntry>, maxScopes: number): void {
  while (entries.size >= maxScopes) {
    let oldest: RegistryEntry | undefined;
    for (const entry of entries.values()) {
      if (oldest === undefined || entry.touchedAtMs < oldest.touchedAtMs) {
        oldest = entry;
      }
    }
    if (oldest === undefined) {
      return;
    }
    oldest.index.clear();
    entries.delete(oldest.key);
  }
}

function createEntry(
  key: string,
  scope: SelectedScope,
  nowMs: () => number,
  options: ResolvedOptions,
): RegistryEntry {
  const clock: MutableClock = { nowMs };
  const now = nowMs();
  return {
    key,
    index: createMicroIndex({
      ttlMs: options.ttlMs,
      maxEntries: options.maxEntriesPerScope,
      nowMs: () => clock.nowMs(),
    }),
    clock,
    conversationId: scope.conversationId,
    workspaceRoot: scope.workspaceRoot,
    touchedAtMs: now,
    expiresAtMs: now + options.ttlMs,
  };
}

function touchEntry(entry: RegistryEntry, nowMs: () => number, ttlMs: number): void {
  const now = nowMs();
  entry.clock.nowMs = nowMs;
  entry.touchedAtMs = now;
  entry.expiresAtMs = now + ttlMs;
}

function getOrCreateScopeIndex(
  entries: Map<string, RegistryEntry>,
  options: ResolvedOptions,
  scope: SelectedScope,
  nowMs: () => number,
): MicroIndex {
  evictExpired(entries, nowMs());
  const key = scopeKey(scope);
  const existing = entries.get(key);
  if (existing !== undefined) {
    touchEntry(existing, nowMs, options.ttlMs);
    return existing.index;
  }
  evictOldest(entries, options.maxScopes);
  const created = createEntry(key, scope, nowMs, options);
  entries.set(key, created);
  return created.index;
}

function clearMatching(
  entries: Map<string, RegistryEntry>,
  predicate: (entry: RegistryEntry) => boolean,
): void {
  for (const [key, entry] of entries) {
    if (predicate(entry)) {
      entry.index.clear();
      entries.delete(key);
    }
  }
}

function clearEntries(entries: Map<string, RegistryEntry>): void {
  for (const entry of entries.values()) {
    entry.index.clear();
  }
  entries.clear();
}

export function createGroundedContextIndexRegistry(
  options?: GroundedContextIndexRegistryOptions,
): GroundedContextIndexRegistry {
  const resolved = resolveOptions(options);
  const entries = new Map<string, RegistryEntry>();
  const sweepTimer = resolved.autoSweep
    ? setInterval(() => {
        evictExpired(entries, Date.now());
      }, resolved.sweepIntervalMs)
    : undefined;
  if (sweepTimer !== undefined) {
    sweepTimer.unref();
  }

  return {
    forScope(scope, nowMs): MicroIndex {
      return getOrCreateScopeIndex(entries, resolved, scope, nowMs);
    },
    clearConversation(conversationId): void {
      clearMatching(entries, (entry) => entry.conversationId === conversationId);
    },
    clearWorkspace(workspaceRoot): void {
      clearMatching(entries, (entry) => entry.workspaceRoot === workspaceRoot);
    },
    clearAll(): void {
      clearEntries(entries);
    },
    sweep(nowMs): void {
      evictExpired(entries, nowMs());
    },
    size(): number {
      return entries.size;
    },
    dispose(): void {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
      }
      clearEntries(entries);
    },
  };
}

export const groundedContextIndexRegistry = createGroundedContextIndexRegistry();

export function microIndexForGroundedScope(scope: SelectedScope, nowMs: () => number): MicroIndex {
  return groundedContextIndexRegistry.forScope(scope, nowMs);
}

export function clearGroundedContextIndexesForConversation(conversationId: string): void {
  groundedContextIndexRegistry.clearConversation(conversationId);
}

export function clearGroundedContextIndexesForWorkspace(workspaceRoot: string): void {
  groundedContextIndexRegistry.clearWorkspace(workspaceRoot);
}

export function clearAllGroundedContextIndexes(): void {
  groundedContextIndexRegistry.clearAll();
}
