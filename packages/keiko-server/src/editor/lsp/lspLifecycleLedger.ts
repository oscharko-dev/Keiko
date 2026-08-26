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

import type { LspLifecycleEvent } from "@oscharko-dev/keiko-contracts";
import { deepRedactStrings, redact } from "@oscharko-dev/keiko-security";

// Bounded per-partition like the agent-audit ledger: a long-lived server must not grow this without
// limit. The historical cap (200) is preserved as a per-partition cap so a single busy workspace
// cannot displace an idle one's history.
const MAX_EVENTS_PER_PARTITION = 200;

const DEFAULT_PARTITION_KEY = "_default";

interface PartitionState {
  readonly events: LspLifecycleEvent[];
}

const partitions = new Map<string, PartitionState>();

function partitionState(key: string): PartitionState {
  const existing = partitions.get(key);
  if (existing !== undefined) return existing;
  const created: PartitionState = { events: [] };
  partitions.set(key, created);
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

/**
 * Union of every partition's events (newest last within each partition, but concatenated in the
 * insertion order of the partitions themselves). Used only by the diagnostic status route to project
 * a workspace-agnostic ledger view; every wire projection still relies on the content-free
 * managerId and status fields already in `LspLifecycleEvent`.
 */
export function listAllLspLifecycleEvents(): readonly LspLifecycleEvent[] {
  const merged: LspLifecycleEvent[] = [];
  for (const state of partitions.values()) merged.push(...state.events);
  return merged;
}

export function _resetLspLifecycleLedgerForTests(): void {
  partitions.clear();
}
