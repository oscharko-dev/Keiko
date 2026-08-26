// Issue #1381, ADR-0069 D6/I4 — bounded, content-free in-memory ledger of LSP process lifecycle
// events. Mirrors agentActionAudit.ts: an append-only FIFO surfaces "recent LSP process
// activity" to the read-only status route. The record is content-free by construction (the contract
// `LspLifecycleEvent` carries only an opaque managerId, an enum status/error code, counts, and a
// timestamp — no source text, paths, method names, or raw stderr) and is run through the
// keiko-security redactor as defense in depth before it is stored or served, so a secret-shaped
// substring that ever slipped into an id cannot reach the ledger.
//
// KEIKO-0556: partitioned by an opaque workspacePartitionKey (mirroring dapLifecycleLedger.ts) so
// two workspace roots concurrently running the same language provider can no longer interleave
// their spawn/crash/restart events under an identical managerId — the caller (lspProcessManager
// via hostLanguageOperation) supplies the key derived from the workspace root's digest, never the
// raw path. Callers that pass no key land in a shared DEFAULT partition, preserving compat with
// any test seam that did not thread workspace context through.
//
// KEIKO-0556-r3: partitioning traded one unbounded FIFO for an unbounded MAP of bounded FIFOs --
// long-running-server root churn (workspaces opened and closed over days/weeks) would otherwise
// grow `partitions` forever. Bounded to MAX_PARTITIONS with deterministic least-recently-recorded
// eviction: `partitionState` moves a touched key to the end of the Map's iteration order (Maps
// preserve insertion order, and re-inserting a key after deleting it moves it), so the entry at
// the front is always the one least recently written to. Read paths never touch recency, so
// polling a workspace's ledger cannot itself keep it alive with no active language provider.

import type { LspLifecycleEvent } from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings, redact } from "@oscharko-dev/keiko-security";

// Bounded per-partition like the agent-audit ledger: a long-lived server must not grow this without
// limit. The historical cap (200) is preserved as a per-partition cap so a single busy workspace
// cannot displace an idle one's history.
const MAX_EVENTS_PER_PARTITION = 200;

// KEIKO-0556-r3: bounds the number of DISTINCT workspace partitions retained at once, independent
// of the per-partition event cap above. 64 comfortably covers every workspace a developer could
// plausibly have open/recently-active at once (mirrors MAX_RETAINED_JOBS's sizing rationale for
// the manual-pod job registry) while keeping the union route's response proportional to real
// concurrent activity rather than to a server process's cumulative lifetime root count.
const MAX_PARTITIONS = 64;

const DEFAULT_PARTITION_KEY = "_default";

interface PartitionState {
  readonly events: LspLifecycleEvent[];
}

const partitions = new Map<string, PartitionState>();

// Evicts the least-recently-touched partition(s) until the map is back at the cap. Called only
// after admitting a genuinely NEW partition, so an existing partition being re-touched never
// triggers its own eviction.
function evictLeastRecentlyTouchedPartitions(): void {
  while (partitions.size > MAX_PARTITIONS) {
    const oldestKey = partitions.keys().next().value;
    if (oldestKey === undefined) return;
    partitions.delete(oldestKey);
  }
}

function partitionState(key: string): PartitionState {
  const existing = partitions.get(key);
  if (existing !== undefined) {
    // Touch: delete + re-set moves this key to the end of Map iteration order (most-recently
    // touched), without allocating a new PartitionState or losing its events.
    partitions.delete(key);
    partitions.set(key, existing);
    return existing;
  }
  const created: PartitionState = { events: [] };
  partitions.set(key, created);
  evictLeastRecentlyTouchedPartitions();
  return created;
}

function redactEvent(event: LspLifecycleEvent): LspLifecycleEvent {
  return deepRedactStrings(event, redact) as LspLifecycleEvent;
}

/**
 * Record one content-free lifecycle event on the caller's partition. Best-effort and throw-free:
 * a ledger failure must never break the manager's lifecycle path. Returns the stored (redacted)
 * event, or null when recording failed. `partitionKey` should be a workspace-scoped opaque digest;
 * callers that omit it land in the shared default partition.
 */
export function recordLspLifecycleEvent(
  event: LspLifecycleEvent,
  partitionKey: string = DEFAULT_PARTITION_KEY,
): LspLifecycleEvent | null {
  try {
    const redacted = redactEvent(event);
    const state = partitionState(partitionKey);
    state.events.push(redacted);
    if (state.events.length > MAX_EVENTS_PER_PARTITION) {
      state.events.splice(0, state.events.length - MAX_EVENTS_PER_PARTITION);
    }
    return redacted;
  } catch {
    return null;
  }
}

/**
 * Recent lifecycle events on one partition, newest last, bounded to the FIFO cap. Already redacted
 * at record time. `partitionKey` omitted returns the shared default-partition view.
 */
export function listLspLifecycleEvents(
  partitionKey: string = DEFAULT_PARTITION_KEY,
): readonly LspLifecycleEvent[] {
  return partitions.get(partitionKey)?.events ?? [];
}

// A ledger event annotated with the (opaque, digest-derived — never a raw path) partition it was
// recorded on. Local to keiko-server, not a `@oscharko-dev/keiko-contracts` wire type: the status
// route decides whether/how to surface it, and adding a field here is a purely additive wire
// change for any existing consumer.
export interface PartitionedLspLifecycleEvent extends LspLifecycleEvent {
  readonly workspacePartitionKey: string;
}

/**
 * Union of every partition's events, newest last within each partition, globally re-ordered by
 * `timestampMs` so the merged timeline reflects real chronology instead of Map insertion order
 * (KEIKO-0556-r3). Each event carries its `workspacePartitionKey` so equal `managerId` values from
 * different workspace roots stay distinguishable. Ties (equal `timestampMs`, possible across
 * partitions, e.g. under a coarse clock) break deterministically: partitions are concatenated in
 * lexicographic key order before the stable sort, so a tie always resolves the same way for the
 * same underlying data — partition key first, then within-partition FIFO order.
 *
 * Used only by the diagnostic status route to project a workspace-agnostic ledger view; every wire
 * projection still relies on the content-free managerId, status, and now workspacePartitionKey
 * fields already validated as opaque/digest-derived at record time.
 */
export function listAllLspLifecycleEvents(): readonly PartitionedLspLifecycleEvent[] {
  const merged: PartitionedLspLifecycleEvent[] = [];
  for (const key of [...partitions.keys()].sort()) {
    const state = partitions.get(key);
    if (state === undefined) continue;
    for (const event of state.events) merged.push({ ...event, workspacePartitionKey: key });
  }
  merged.sort((a, b) => a.timestampMs - b.timestampMs);
  return merged;
}

export function _resetLspLifecycleLedgerForTests(): void {
  partitions.clear();
}
