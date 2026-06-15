// Memory maintenance orchestrator (Epic #204) — the impure caller that drives the pure
// consolidation engine (#208) + maintenance planner (governance #209) against the vault (#206).
//
// POST /api/memory/maintenance runs a bounded, synchronous pass:
//   1. Load every memory (all scopes) + the access stats.
//   2. Run consolidation on the accepted subset; persist auto-applicable relationship edges and
//      return unresolved review items for MemoriaViva or CLI operators. Conflict and merge review
//      items are NEVER auto-applied here.
//   3. Compute the maintenance plan and apply it: promote (-> accepted), archive (-> archived),
//      forget (vault delete + tombstone + reason). Confidence is immutable provenance and is never
//      patched here (O-V2): reuse strengthens memories live in retrieval ranking, and disuse-decay
//      is computed on the fly via the strength curve that gates archive/forget.
//   4. Emit one audit event per applied effect and return the counts.
//
// CSRF: the server dispatch layer enforces x-keiko-csrf for POST, so this route is guarded without
// any per-handler check. External faults (a vault write that throws) are wrapped into a typed 500
// rather than crashing the loopback server.

import { randomUUID } from "node:crypto";
import { runConsolidation, type ReviewItem } from "@oscharko-dev/keiko-memory-consolidation";
import {
  planMemoryMaintenance,
  type MemoryAccessStatLike,
  type MemoryMaintenancePlan,
} from "@oscharko-dev/keiko-memory-governance";
import type {
  MemoryAuditEvent,
  MemoryAuditInitiatorSurface,
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts";
import type { MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { EvidenceStore } from "@oscharko-dev/keiko-evidence";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { recordMemoryAudit } from "./memory-audit-handler.js";

export interface MaintenanceCounts {
  promoted: number;
  archived: number;
  forgotten: number;
  superseded: number;
  edgesCreated: number;
  clustersInspected: number;
  reviewItemsCreated: number;
}

export interface MaintenanceResult extends MaintenanceCounts {
  readonly reviewItems: readonly ReviewItem[];
}

interface MaintenanceAccumulator extends MaintenanceCounts {
  readonly reviewItems: ReviewItem[];
}

function emptyCounts(): MaintenanceAccumulator {
  return {
    promoted: 0,
    archived: 0,
    forgotten: 0,
    superseded: 0,
    edgesCreated: 0,
    clustersInspected: 0,
    reviewItemsCreated: 0,
    reviewItems: [],
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
  nowMs: number,
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
    occurredAt: nowMs,
    initiatorSurface: surface,
    summary,
    ...extra,
  } as MemoryAuditEvent;
  recordMemoryAudit({ evidenceStore }, event);
}

function recordsById(records: readonly MemoryRecord[]): Map<MemoryId, MemoryRecord> {
  const map = new Map<MemoryId, MemoryRecord>();
  for (const record of records) map.set(record.id, record);
  return map;
}

// ─── Consolidation effects ───────────────────────────────────────────────────
function isAutoApplicableConsolidationEdge(edge: MemoryEdge): boolean {
  return (
    edge.kind === "derived-from" || edge.kind === "related" || edge.kind === "temporal-precedes"
  );
}

function applyEdges(
  vault: MemoryVaultStore,
  edges: ReturnType<typeof runConsolidation>["edgesProposed"],
): number {
  let created = 0;
  for (const edge of edges) {
    if (!isAutoApplicableConsolidationEdge(edge)) continue;
    vault.insertEdge(edge);
    created += 1;
  }
  return created;
}

function runConsolidationPass(
  vault: MemoryVaultStore,
  nowMs: number,
  records: readonly MemoryRecord[],
  counts: MaintenanceAccumulator,
): void {
  const result = runConsolidation(records, {
    nowMs,
    newEdgeId: (): MemoryEdgeId => randomUUID() as unknown as MemoryEdgeId,
    newReviewItemId: (): string => randomUUID(),
  });
  counts.edgesCreated += applyEdges(vault, result.edgesProposed);
  counts.clustersInspected += result.clustersInspected;
  counts.reviewItemsCreated += result.reviewItems.length;
  counts.reviewItems.push(...result.reviewItems);
}

// ─── Plan application ──────────────────────────────────────────────────────────
// Applies the archive / forget effects on the post-consolidation snapshot. Promotions are applied
// SEPARATELY and BEFORE consolidation (see runMemoryMaintenance) so that freshly-accepted memories
// are visible to conflict detection within the same maintenance pass.
//
// Confidence is NEVER mutated here (#204, O-V2): reinforcement-on-reuse is realised live in
// retrieval ranking, and disuse-decay is computed on the fly via the strength curve that already
// gates archive/forget — so provenance stays intact and every run is idempotent.
function applyFadeEffects(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  nowMs: number,
  plan: MemoryMaintenancePlan,
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceAccumulator,
): void {
  applyArchives(vault, evidenceStore, nowMs, plan.archive, byId, counts);
  applyForgets(vault, evidenceStore, nowMs, plan.forget, byId, counts);
}

function applyPromotions(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  nowMs: number,
  ids: readonly MemoryId[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceAccumulator,
): void {
  for (const id of ids) {
    const record = byId.get(id);
    if (record === undefined) continue;
    vault.updateMemory(id, { status: "accepted" }, nowMs);
    counts.promoted += 1;
    emitAudit(
      evidenceStore,
      nowMs,
      "memory:accepted",
      "memory-center",
      "Promoted a strong proposed memory.",
      { memoryId: id, scope: record.scope },
    );
  }
}

function applyArchives(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  nowMs: number,
  ids: readonly MemoryId[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceAccumulator,
): void {
  for (const id of ids) {
    const record = byId.get(id);
    if (record === undefined) continue;
    vault.updateMemory(id, { status: "archived" }, nowMs);
    counts.archived += 1;
    emitAudit(evidenceStore, nowMs, "memory:archived", "retention", "Archived a faded memory.", {
      memoryId: id,
      scope: record.scope,
    });
  }
}

function applyForgets(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  nowMs: number,
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
      nowMs,
    });
    counts.forgotten += 1;
    emitAudit(
      evidenceStore,
      nowMs,
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
export interface RunMaintenanceOptions {
  /** Injected clock. Defaults to Date.now(). Pass a fixed value to make the pass replay-stable. */
  readonly nowMs?: number;
}

export function runMemoryMaintenance(
  vault: MemoryVaultStore,
  evidenceStore?: EvidenceStore,
  options?: RunMaintenanceOptions,
): MaintenanceResult {
  // ONE clock for the whole pass: both plan phases and every vault write / audit timestamp use the
  // same nowMs, so selection is consistent within a run and fully replay-stable when nowMs is
  // injected (the deterministic-verification invariant the rest of the stack honours).
  const nowMs = options?.nowMs ?? Date.now();
  const counts = emptyCounts();
  // Phase 1 — promote strong `proposed` memories FIRST. Consolidation and conflict detection only
  // inspect `accepted` records, so without this a vault full of freshly-captured `proposed`
  // memories would need a SECOND maintenance run before any near-duplicate or polarity conflict is
  // resolved. Promoting up front makes a single "Run maintenance" fully effective.
  const beforePromote = vault.listMemories({ includeExpired: true });
  const promoteStats: ReadonlyMap<MemoryId, MemoryAccessStatLike> = vault.getAccessStats();
  const promotePlan = planMemoryMaintenance(beforePromote, promoteStats, { nowMs });
  applyPromotions(
    vault,
    evidenceStore,
    nowMs,
    promotePlan.promote,
    recordsById(beforePromote),
    counts,
  );
  // Phase 2 — consolidate the now-accepted set: link safe near-duplicate metadata and surface
  // conflicts / merges as explicit review items. Status mutations require a later governed review.
  const accepted = vault
    .listMemories({ includeExpired: true })
    .filter((record) => record.status === "accepted");
  runConsolidationPass(vault, nowMs, accepted, counts);
  // Phase 3 — archive / forget on the post-consolidation snapshot. The access stats feed the
  // strength model; confidence itself is never mutated (O-V2).
  const all = vault.listMemories({ includeExpired: true });
  const accessStats: ReadonlyMap<MemoryId, MemoryAccessStatLike> = vault.getAccessStats();
  const plan = planMemoryMaintenance(all, accessStats, { nowMs });
  applyFadeEffects(vault, evidenceStore, nowMs, plan, recordsById(all), counts);
  return counts;
}

// ─── Bounded autonomous maintenance (#204, O-V4) ───────────────────────────────
// The strength/decay/forget pass only "lives" if it actually runs. Rather than a free-running
// background loop (forbidden by the no-unbounded-hidden-activity invariant), maintenance is fired
// opportunistically — once memory is used — and rate-limited to at most once per interval. The pass
// itself is already bounded (maxForgetPerRun) and audited, so an autonomous fire is governed.

export const MEMORY_AUTO_MAINTENANCE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Pure: due iff never run, or the interval has elapsed. A non-finite/negative interval is treated as
// "never auto-run" so a misconfiguration can only DISABLE, never spin.
export function isMaintenanceDue(
  lastRunAtMs: number | undefined,
  nowMs: number,
  minIntervalMs: number = MEMORY_AUTO_MAINTENANCE_MIN_INTERVAL_MS,
): boolean {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return false;
  if (lastRunAtMs === undefined) return true;
  return nowMs - lastRunAtMs >= minIntervalMs;
}

// Caller-held cursor so the rate-limit state is explicit and testable (no module-global clock).
export interface AutoMaintenanceState {
  lastRunAtMs?: number;
}

export interface MaybeRunAutoMaintenanceOptions {
  readonly nowMs: number;
  readonly enabled: boolean;
  readonly minIntervalMs?: number;
}

// Runs ONE bounded maintenance pass iff enabled AND due, advancing the cursor BEFORE running so a
// re-entrant call within the same tick cannot double-fire. Returns the result, or null when skipped.
// Never throws: a maintenance fault must not break the caller (e.g. a chat turn); it is swallowed
// after advancing the cursor so a persistently-failing pass cannot hot-loop.
export function maybeRunAutoMaintenance(
  vault: MemoryVaultStore,
  evidenceStore: EvidenceStore | undefined,
  state: AutoMaintenanceState,
  options: MaybeRunAutoMaintenanceOptions,
): MaintenanceResult | null {
  if (!options.enabled) return null;
  if (!isMaintenanceDue(state.lastRunAtMs, options.nowMs, options.minIntervalMs)) return null;
  state.lastRunAtMs = options.nowMs;
  try {
    return runMemoryMaintenance(vault, evidenceStore, { nowMs: options.nowMs });
  } catch {
    return null;
  }
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
