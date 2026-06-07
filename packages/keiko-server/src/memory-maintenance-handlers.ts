// Memory maintenance orchestrator (Epic #204) — the impure caller that drives the pure
// consolidation engine (#208) + maintenance planner (governance #209) against the vault (#206).
//
// POST /api/memory/maintenance runs a bounded, synchronous pass:
//   1. Load every memory (all scopes) + the access stats.
//   2. Run consolidation on the accepted subset; persist proposed edges; AUTO-APPLY pairwise
//      supersede review items (a correction superseding one older conflicting memory) by demoting
//      the loser to `superseded`. Multi-way merges are NOT auto-resolved — they stay as review
//      items for the Memory Center.
//   3. Compute the maintenance plan and apply it: promote (-> accepted), reinforce / decay
//      (confidence patch), archive (-> archived), forget (vault delete + tombstone + reason).
//   4. Emit one audit event per applied effect and return the counts.
//
// CSRF: the server dispatch layer enforces x-keiko-csrf for POST, so this route is guarded without
// any per-handler check. External faults (a vault write that throws) are wrapped into a typed 500
// rather than crashing the loopback server.

import { randomUUID } from "node:crypto";
import {
  runConsolidation,
  type ProposedAction,
  type ReviewItem,
} from "@oscharko-dev/keiko-memory-consolidation";
import {
  planMemoryMaintenance,
  type MemoryAccessStatLike,
  type MemoryMaintenancePlan,
} from "@oscharko-dev/keiko-memory-governance";
import type {
  MemoryAuditEvent,
  MemoryAuditInitiatorSurface,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryScope,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";

export interface MaintenanceCounts {
  promoted: number;
  reinforced: number;
  decayed: number;
  archived: number;
  forgotten: number;
  superseded: number;
  edgesCreated: number;
  clustersInspected: number;
}

function emptyCounts(): MaintenanceCounts {
  return {
    promoted: 0,
    reinforced: 0,
    decayed: 0,
    archived: 0,
    forgotten: 0,
    superseded: 0,
    edgesCreated: 0,
    clustersInspected: 0,
  };
}

function isRouteResult(value: unknown): value is RouteResult {
  return (
    typeof value === "object" && value !== null && typeof (value as RouteResult).status === "number"
  );
}

function resolveVault(deps: UiHandlerDeps): MemoryVaultStore | RouteResult {
  if (deps.memoryVault === undefined) {
    return {
      status: 503,
      body: errorBody("MEMORY_UNAVAILABLE", "Memory vault is not configured."),
    };
  }
  return deps.memoryVault;
}

function emitAudit(
  evidenceStore: EvidenceStore | undefined,
  kind: MemoryAuditEvent["kind"],
  surface: MemoryAuditInitiatorSurface,
  summary: string,
  extra: Record<string, unknown>,
): void {
  if (evidenceStore === undefined) return;
  const event = {
    schemaVersion: "1",
    kind,
    eventId: randomUUID(),
    occurredAt: Date.now(),
    initiatorSurface: surface,
    summary,
    ...extra,
  } as MemoryAuditEvent;
  recordMemoryAudit({ evidenceStore }, event);
}

// Patch a record's confidence by rebuilding the provenance envelope (confidence lives there).
function patchConfidence(vault: MemoryVaultStore, record: MemoryRecord, confidence: number): void {
  vault.updateMemory(record.id, { provenance: { ...record.provenance, confidence } }, Date.now());
}

function recordsById(records: readonly MemoryRecord[]): Map<MemoryId, MemoryRecord> {
  const map = new Map<MemoryId, MemoryRecord>();
  for (const record of records) map.set(record.id, record);
  return map;
}

// ─── Consolidation effects ───────────────────────────────────────────────────
function applyEdges(
  vault: MemoryVaultStore,
  edges: ReturnType<typeof runConsolidation>["edgesProposed"],
): number {
  let created = 0;
  for (const edge of edges) {
    vault.insertEdge(edge);
    created += 1;
  }
  return created;
}

type SupersedeAction = Extract<ProposedAction, { kind: "supersede" }>;

// A pairwise supersede picks the OLDER memory as the loser: the newer correction wins, the older
// conflicting fact is demoted to `superseded` so retrieval suppresses it. Multi-way merges carry a
// `merge` action and are intentionally left untouched for human review.
function pairwiseSupersede(action: ProposedAction | undefined): SupersedeAction | null {
  return action?.kind === "supersede" ? action : null;
}

function applySupersessions(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  reviewItems: readonly ReviewItem[],
  byId: Map<MemoryId, MemoryRecord>,
): number {
  let superseded = 0;
  for (const item of reviewItems) {
    const action = pairwiseSupersede(item.proposedAction);
    if (action === null) continue;
    const loser = byId.get(action.older);
    if (loser?.status !== "accepted") continue;
    vault.updateMemory(action.older, { status: "superseded" }, Date.now());
    superseded += 1;
    emitSupersedeAudit(evidenceStore, action, loser.scope);
  }
  return superseded;
}

function emitSupersedeAudit(
  evidenceStore: EvidenceStore | undefined,
  action: SupersedeAction,
  scope: MemoryScope,
): void {
  emitAudit(
    evidenceStore,
    "memory:superseded",
    "consolidation",
    "Auto-superseded an older conflicting memory.",
    {
      oldMemoryId: action.older,
      newMemoryId: action.newer,
      scope,
    },
  );
}

function runConsolidationPass(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  records: readonly MemoryRecord[],
  counts: MaintenanceCounts,
): void {
  const result = runConsolidation(records, {
    nowMs: Date.now(),
    newEdgeId: (): MemoryEdgeId => randomUUID() as unknown as MemoryEdgeId,
    newReviewItemId: (): string => randomUUID(),
  });
  counts.edgesCreated += applyEdges(vault, result.edgesProposed);
  counts.clustersInspected += result.clustersInspected;
  counts.superseded += applySupersessions(
    vault,
    evidenceStore,
    result.reviewItems,
    recordsById(records),
  );
}

// ─── Plan application ──────────────────────────────────────────────────────────
// Applies the reinforce / decay / archive / forget effects on the post-consolidation snapshot.
// Promotions are applied SEPARATELY and BEFORE consolidation (see runMemoryMaintenance) so that
// freshly-accepted memories are visible to conflict detection within the same maintenance pass.
function applyDecayEffects(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  plan: MemoryMaintenancePlan,
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceCounts,
): void {
  applyConfidencePatches(vault, plan.reinforce, byId, (n) => (counts.reinforced += n));
  applyConfidencePatches(vault, plan.decay, byId, (n) => (counts.decayed += n));
  applyArchives(vault, evidenceStore, plan.archive, byId, counts);
  applyForgets(vault, evidenceStore, plan.forget, byId, counts);
}

function applyPromotions(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  ids: readonly MemoryId[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceCounts,
): void {
  for (const id of ids) {
    const record = byId.get(id);
    if (record === undefined) continue;
    vault.updateMemory(id, { status: "accepted" }, Date.now());
    counts.promoted += 1;
    emitAudit(
      evidenceStore,
      "memory:accepted",
      "memory-center",
      "Promoted a strong proposed memory.",
      { memoryId: id, scope: record.scope },
    );
  }
}

function applyConfidencePatches(
  vault: MemoryVaultStore,
  patches: readonly { id: MemoryId; confidence: number }[],
  byId: Map<MemoryId, MemoryRecord>,
  bump: (n: number) => void,
): void {
  for (const patch of patches) {
    const record = byId.get(patch.id);
    if (record === undefined) continue;
    patchConfidence(vault, record, patch.confidence);
    bump(1);
  }
}

function applyArchives(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  ids: readonly MemoryId[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceCounts,
): void {
  for (const id of ids) {
    const record = byId.get(id);
    if (record === undefined) continue;
    vault.updateMemory(id, { status: "archived" }, Date.now());
    counts.archived += 1;
    emitAudit(evidenceStore, "memory:archived", "retention", "Archived a faded memory.", {
      memoryId: id,
      scope: record.scope,
    });
  }
}

function applyForgets(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  forgets: readonly { id: MemoryId; reason: string }[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceCounts,
): void {
  for (const forget of forgets) {
    const record = byId.get(forget.id);
    if (record === undefined) continue;
    vault.deleteMemory(forget.id, {
      tombstone: true,
      forgetterSurface: "memory-maintenance",
      reason: forget.reason,
      nowMs: Date.now(),
    });
    counts.forgotten += 1;
    emitAudit(
      evidenceStore,
      "memory:forgotten",
      "retention",
      `Forgot a memory (${forget.reason}).`,
      {
        memoryId: forget.id,
        scope: record.scope,
        tombstoned: true,
      },
    );
  }
}

// Reusable maintenance core. Drives consolidation + the governance plan against a vault, emitting
// audit events when an evidence store is supplied. Exported so both the BFF route handler and the
// `keiko memory maintain` CLI run the SAME pass — no duplicated orchestration.
export function runMemoryMaintenance(
  vault: MemoryVaultStore,
  evidenceStore?: EvidenceStore,
): MaintenanceCounts {
  const counts = emptyCounts();
  // Phase 1 — promote strong `proposed` memories FIRST. Consolidation and conflict detection only
  // inspect `accepted` records, so without this a vault full of freshly-captured `proposed`
  // memories would need a SECOND maintenance run before any near-duplicate or polarity conflict is
  // resolved. Promoting up front makes a single "Run maintenance" fully effective.
  const beforePromote = vault.listMemories({ includeExpired: true });
  const promoteStats: ReadonlyMap<MemoryId, MemoryAccessStatLike> = vault.getAccessStats();
  const promotePlan = planMemoryMaintenance(beforePromote, promoteStats, { nowMs: Date.now() });
  applyPromotions(vault, evidenceStore, promotePlan.promote, recordsById(beforePromote), counts);
  // Phase 2 — consolidate the now-accepted set: link near-duplicates and auto-supersede pairwise
  // correction conflicts (the older conflicting fact -> `superseded`).
  const accepted = vault
    .listMemories({ includeExpired: true })
    .filter((record) => record.status === "accepted");
  runConsolidationPass(vault, evidenceStore, accepted, counts);
  // Phase 3 — reinforce / decay / archive / forget on the post-consolidation snapshot. The access
  // stats feed the strength model.
  const all = vault.listMemories({ includeExpired: true });
  const accessStats: ReadonlyMap<MemoryId, MemoryAccessStatLike> = vault.getAccessStats();
  const plan = planMemoryMaintenance(all, accessStats, { nowMs: Date.now() });
  applyDecayEffects(vault, evidenceStore, plan, recordsById(all), counts);
  return counts;
}

export function handleRunMaintenance(ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  void ctx;
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  try {
    const counts = runMemoryMaintenance(vault, deps.evidenceStore);
    return { status: 200, body: counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Memory maintenance failed.";
    return { status: 500, body: errorBody("MEMORY_MAINTENANCE_FAILED", message) };
  }
}
