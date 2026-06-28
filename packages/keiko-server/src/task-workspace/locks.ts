// Consolidated advisory-lock model for managed task workspaces (Issue #449, Epic #443, ADR-0093 D2).
//
// Before #449 the lock-liveness predicate, the default TTL, and the lock builder were copied verbatim
// into provisioning.ts, lifecycle.ts, reconciliation.ts, cleanup.ts, and repair.ts — five places a TTL
// or expiry-parsing fix could silently diverge. This module is the single home: the behaviour is
// byte-for-byte the previous copies (an explicit `expiresAt` wins; otherwise the TTL since
// `acquiredAt`; a non-finite timestamp fails closed → treated as not live), now defined once.
//
// The advisory `WorkspaceLock` is the ACROSS-RESTART / ACROSS-ACTOR coordination record persisted on the
// instance row; it is checked optimistically and is NOT an intra-process serializer (that is the
// in-process `WorkspaceMutexRegistry`, ADR-0093 D1). On a process crash a held advisory lock TTL-expires
// here and #447 reconciliation/repair clears it.

import type { WorkspaceLock, WorkspaceLockReason } from "@oscharko-dev/keiko-contracts";

// The default span a provisioning/activation/mutation/repair/cleanup lock stays valid before it is
// treated as stale. Mirrors the value the five services each previously declared.
export const DEFAULT_LOCK_TTL_MS = 5 * 60_000;

// Whether an advisory lock is still live at `nowMs`. An explicit expiry wins; otherwise the TTL since
// acquisition; a non-finite timestamp fails closed (treated as not live). `null` is never live.
export function lockIsLive(lock: WorkspaceLock | null, nowMs: number, ttlMs: number): boolean {
  if (lock === null) return false;
  if (lock.expiresAt !== undefined) {
    const expiry = Date.parse(lock.expiresAt);
    return Number.isFinite(expiry) ? nowMs < expiry : false;
  }
  const acquired = Date.parse(lock.acquiredAt);
  return Number.isFinite(acquired) ? nowMs - acquired < ttlMs : false;
}

export interface MakeWorkspaceLockArgs {
  readonly newId: () => string;
  readonly owner: string;
  readonly reason: WorkspaceLockReason;
  readonly nowMs: number;
  readonly ttlMs: number;
}

// Builds an advisory lock with a content-free id, the requesting actor as owner, the reason, and an
// explicit expiry `ttlMs` after acquisition. Generalizes the previous per-service `makeLock` /
// `makeRepairLock` / `cleanupLock` builders over the lock reason.
export function makeWorkspaceLock(args: MakeWorkspaceLockArgs): WorkspaceLock {
  return {
    lockId: args.newId(),
    owner: args.owner,
    reason: args.reason,
    acquiredAt: new Date(args.nowMs).toISOString(),
    expiresAt: new Date(args.nowMs + args.ttlMs).toISOString(),
  };
}

// Applies the single default-TTL fallback the five services each inlined as `deps.lockTtlMs ??
// DEFAULT_LOCK_TTL_MS`, so the default lives in exactly one place.
export function resolveLockTtl(lockTtlMs?: number): number {
  return lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
}
