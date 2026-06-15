// Memory retention policy enforcer (Epic #204, Issue #214).
//
// Pure-ish function over the public MemoryVaultStore port. For each caller-supplied scope
// it lists every memory, classifies each as `keep` / `expire-age` / `expire-proposal` /
// `evict-overflow`, and issues `vault.deleteMemory(id, { tombstone: true, ... })` for
// every non-keep classification. The audit handler (#214 bridge) observes the resulting
// `memory:tombstoned` events and appends `memory:forgotten` records to the audit ledger
// — retention enforcement is therefore self-audited through the existing seam.
//
// Hard invariants:
//
//   - Pinned records are NEVER eligible for retention. The pin flag overrides every other
//     classification reason; tested explicitly.
//   - Retention iterates the scopes the caller passes. The public MemoryVaultStore has no
//     `listAllScopes()` capability, so a global enumeration would require an internal
//     port extension. Out of scope here.
//   - Forgotten-purge (purgeForgottenAfterMs) uses the public vault port to delete only
//     tombstones in the caller-supplied scopes whose forgottenAt is older than the
//     deterministic cutoff.
//
// Why the operations are issued in a sequence of one-by-one deletes: the vault's delete
// is already wrapped in a SQLite transaction (#206), and emitting a batch API here would
// hide the per-event audit signal that the handler depends on.

import type {
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import { memoryScopeKey } from "./memory-scope-sanitizer.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MemoryRetentionPolicy {
  // Records older than `nowMs - maxAgeMs` (by updatedAt) are eligible for retention.
  // Pinned records are always kept regardless.
  readonly maxAgeMs?: number;
  // When a scope holds more than `maxRecordsPerScope` non-pinned records, the OLDEST
  // (by updatedAt) are evicted until the cap is met. Pinned records do not count toward
  // the cap (and are never evicted by the cap).
  readonly maxRecordsPerScope?: number;
  // Proposed records older than `nowMs - expireProposalsAfterMs` are eligible. Targets
  // only records in status="proposed" so a stale review-queue entry does not block the
  // reviewer indefinitely.
  readonly expireProposalsAfterMs?: number;
  // Forgotten/tombstoned records older than this are purged from the tombstone ledger
  // through the public vault port.
  readonly purgeForgottenAfterMs?: number;
}

export type MemoryRetentionReason = "expire-age" | "expire-proposal" | "evict-overflow";

export interface MemoryRetentionDecision {
  readonly memoryId: MemoryId;
  readonly scope: MemoryScope;
  readonly reason: MemoryRetentionReason;
  readonly updatedAt: number;
  readonly status: MemoryStatus;
}

export interface MemoryRetentionResult {
  readonly evaluated: number;
  readonly forgotten: readonly MemoryRetentionDecision[];
  readonly kept: number;
  readonly byReason: Readonly<Record<MemoryRetentionReason, number>>;
  // Number of tombstones purged across the scanned scopes when purgeForgottenAfterMs is set.
  // Always 0 when purgeForgottenAfterMs is undefined.
  readonly forgottenPurgeBacklog: number;
}

// ─── Pure classification ──────────────────────────────────────────────────────

function isAgeExpired(record: MemoryRecord, nowMs: number, policy: MemoryRetentionPolicy): boolean {
  if (policy.maxAgeMs === undefined) {
    return false;
  }
  return nowMs - record.updatedAt > policy.maxAgeMs;
}

function isProposalExpired(
  record: MemoryRecord,
  nowMs: number,
  policy: MemoryRetentionPolicy,
): boolean {
  if (policy.expireProposalsAfterMs === undefined) {
    return false;
  }
  if (record.status !== "proposed") {
    return false;
  }
  return nowMs - record.updatedAt > policy.expireProposalsAfterMs;
}

// Returns the records that should be evicted by `maxRecordsPerScope`. Pinned records are
// excluded from the count entirely so the cap applies to the non-pinned working set.
function selectOverflowEvictions(
  records: readonly MemoryRecord[],
  policy: MemoryRetentionPolicy,
): readonly MemoryRecord[] {
  if (policy.maxRecordsPerScope === undefined) {
    return [];
  }
  const nonPinned = records.filter((r) => !r.pinned);
  if (nonPinned.length <= policy.maxRecordsPerScope) {
    return [];
  }
  // Oldest-first by updatedAt, then by id so same-timestamp retention is deterministic
  // across vault implementations and insertion orders.
  const sorted = [...nonPinned].sort(
    (a, b) => a.updatedAt - b.updatedAt || String(a.id).localeCompare(String(b.id)),
  );
  const overflowCount = nonPinned.length - policy.maxRecordsPerScope;
  return sorted.slice(0, overflowCount);
}

// Returns either the reason a single record should be forgotten, or undefined to keep it.
// Pinned records always return undefined. The age check takes precedence over the
// proposal-expiry check so the reported reason is the most descriptive applicable kind.
function classifyAgeOrProposal(
  record: MemoryRecord,
  nowMs: number,
  policy: MemoryRetentionPolicy,
): MemoryRetentionReason | undefined {
  if (record.pinned) {
    return undefined;
  }
  if (isAgeExpired(record, nowMs, policy)) {
    return "expire-age";
  }
  if (isProposalExpired(record, nowMs, policy)) {
    return "expire-proposal";
  }
  return undefined;
}

// Combines per-record age/proposal classification with the per-scope overflow eviction
// pass. Returns the deduplicated set of decisions; if a record qualifies under both an
// age rule and an overflow rule, the age rule wins (more descriptive).
function classifyScope(
  scope: MemoryScope,
  records: readonly MemoryRecord[],
  nowMs: number,
  policy: MemoryRetentionPolicy,
): readonly MemoryRetentionDecision[] {
  const decisions = new Map<MemoryId, MemoryRetentionDecision>();
  for (const record of records) {
    const reason = classifyAgeOrProposal(record, nowMs, policy);
    if (reason === undefined) {
      continue;
    }
    decisions.set(record.id, {
      memoryId: record.id,
      scope,
      reason,
      updatedAt: record.updatedAt,
      status: record.status,
    });
  }
  for (const record of selectOverflowEvictions(records, policy)) {
    if (decisions.has(record.id)) {
      continue;
    }
    decisions.set(record.id, {
      memoryId: record.id,
      scope,
      reason: "evict-overflow",
      updatedAt: record.updatedAt,
      status: record.status,
    });
  }
  return [...decisions.values()];
}

// ─── Public entry point ───────────────────────────────────────────────────────

export interface ApplyMemoryRetentionOptions {
  readonly vault: MemoryVaultStore;
  readonly scopes: readonly MemoryScope[];
  readonly policy: MemoryRetentionPolicy;
  readonly nowMs: number;
}

export function applyMemoryRetention(options: ApplyMemoryRetentionOptions): MemoryRetentionResult {
  const { vault, scopes, policy, nowMs } = options;
  const decisions = new Map<MemoryId, MemoryRetentionDecision>();
  let evaluated = 0;
  let forgottenPurgeBacklog = 0;
  const uniqueScopes = [...new Map(scopes.map((scope) => [memoryScopeKey(scope), scope])).values()];
  for (const scope of uniqueScopes) {
    const records = vault.listMemoriesByScope(scope, { includeExpired: true });
    evaluated += records.length;
    for (const decision of classifyScope(scope, records, nowMs, policy)) {
      decisions.set(decision.memoryId, decision);
    }
    forgottenPurgeBacklog += countPurgeBacklog(vault, scope, policy, nowMs);
  }
  const forgotten = [...decisions.values()];
  for (const decision of forgotten) {
    vault.deleteMemory(decision.memoryId, {
      tombstone: true,
      forgetterSurface: "retention",
      reason: decision.reason,
      nowMs,
    });
  }
  return {
    evaluated,
    forgotten,
    kept: evaluated - forgotten.length,
    byReason: countByReason(forgotten),
    forgottenPurgeBacklog,
  };
}

function countByReason(
  decisions: readonly MemoryRetentionDecision[],
): Readonly<Record<MemoryRetentionReason, number>> {
  const counts: Record<MemoryRetentionReason, number> = {
    "expire-age": 0,
    "expire-proposal": 0,
    "evict-overflow": 0,
  };
  for (const d of decisions) {
    counts[d.reason] += 1;
  }
  return counts;
}

function countPurgeBacklog(
  vault: MemoryVaultStore,
  scope: MemoryScope,
  policy: MemoryRetentionPolicy,
  nowMs: number,
): number {
  if (policy.purgeForgottenAfterMs === undefined) {
    return 0;
  }
  return vault.purgeTombstonesByScopeBefore(scope, nowMs - policy.purgeForgottenAfterMs);
}
