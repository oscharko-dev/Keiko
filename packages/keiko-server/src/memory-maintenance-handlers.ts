// Memory maintenance orchestrator (Epic #204) — the impure caller that drives the pure
// consolidation engine (#208) + maintenance planner (governance #209) against the vault (#206).
//
// POST /api/memory/maintenance runs a bounded, synchronous pass:
//   1. Load every memory (all scopes) + the access stats.
//   2. Run consolidation on reviewable live records; persist auto-applicable relationship edges and
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
  type MemoryMaintenancePolicy,
} from "@oscharko-dev/keiko-memory-governance";
import { MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS } from "@oscharko-dev/keiko-contracts";
import type {
  CodingWorkbenchMode,
  MemoryAuditEvent,
  MemoryAuditInitiatorSurface,
  MemoryEdge,
  MemoryEdgeId,
  MemoryId,
  MemoryRecord,
  MemoryScope,
  MemoryType,
} from "@oscharko-dev/keiko-contracts";
import { MemoryStorageError, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { currentAuditRedactString, type UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { errorBody } from "./routes.js";
import { recordMemoryAudit, type MemoryAuditSink } from "./memory-audit-handler.js";
import { emitServerDiagnostic, serverDiagnosticFromError } from "./diagnostics-log.js";
import {
  DEFAULT_MEMORY_AUTONOMY_MODE,
  memoryUnattendedAcceptanceAllowed,
  resolveMemoryMaintenanceAutonomyMode,
} from "./memory-capture-policy.js";
import {
  applyMemoryRetention,
  type MemoryRetentionDecision,
  type MemoryRetentionPolicy,
} from "./memory-retention.js";

export interface MaintenanceCounts {
  promoted: number;
  archived: number;
  expired: number;
  forgotten: number;
  superseded: number;
  edgesCreated: number;
  clustersInspected: number;
  reviewItemsCreated: number;
  retentionForgotten: number;
  tombstonesPurged: number;
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
    expired: 0,
    forgotten: 0,
    superseded: 0,
    edgesCreated: 0,
    clustersInspected: 0,
    reviewItemsCreated: 0,
    retentionForgotten: 0,
    tombstonesPurged: 0,
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

// The pass threads a store-plus-redactor sink rather than a bare EvidenceStore: this call used to
// be `recordMemoryAudit({ evidenceStore }, event)`, which silently took the identity redactor and
// wrote unredacted summaries and scope coordinates into the audit ledger. There is now no signature
// on the way down here that can carry a store without its redactor.
function emitAudit(
  auditSink: MemoryAuditSink | undefined,
  nowMs: number,
  kind: MemoryAuditEvent["kind"],
  surface: MemoryAuditInitiatorSurface,
  summary: string,
  extra: Record<string, unknown>,
): void {
  if (auditSink === undefined) return;
  const event = {
    schemaVersion: "1",
    kind,
    eventId: randomUUID(),
    occurredAt: nowMs,
    initiatorSurface: surface,
    summary,
    ...extra,
  } as MemoryAuditEvent;
  recordMemoryAudit(auditSink, event);
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

function isConsolidationEdge(edge: MemoryEdge): boolean {
  return edge.provenanceSummary?.startsWith("consolidation:") === true;
}

function alreadyAppliedConsolidationEdge(vault: MemoryVaultStore, edge: MemoryEdge): boolean {
  if (!isConsolidationEdge(edge)) return false;
  return vault
    .listOutgoingEdges(edge.fromMemoryId)
    .some(
      (existing) =>
        existing.toMemoryId === edge.toMemoryId &&
        existing.kind === edge.kind &&
        isConsolidationEdge(existing),
    );
}

function applyEdges(
  vault: MemoryVaultStore,
  edges: ReturnType<typeof runConsolidation>["edgesProposed"],
): number {
  let created = 0;
  for (const edge of edges) {
    if (!isAutoApplicableConsolidationEdge(edge)) continue;
    if (alreadyAppliedConsolidationEdge(vault, edge)) continue;
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
  auditSink: MemoryAuditSink | undefined,
  nowMs: number,
  plan: MemoryMaintenancePlan,
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceAccumulator,
): void {
  applyArchives(vault, auditSink, nowMs, plan.archive, byId, counts);
  applyExpirations(vault, auditSink, nowMs, plan.expire, byId, counts);
  applyForgets(vault, auditSink, nowMs, plan.forget, byId, counts);
}

function applyPromotions(
  vault: MemoryVaultStore,
  auditSink: MemoryAuditSink | undefined,
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
    // `retention`, not `memory-center`: this promotion is the unattended maintenance sweep, not an
    // operator acting in the Memory Center. The audit envelope must not attribute an autonomous
    // acceptance to a human surface — it is the only record of WHO accepted the memory.
    emitAudit(
      auditSink,
      nowMs,
      "memory:accepted",
      "retention",
      "Promoted a strong proposed memory.",
      { memoryId: id, scope: record.scope },
    );
  }
}

function applyArchives(
  vault: MemoryVaultStore,
  auditSink: MemoryAuditSink | undefined,
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
    emitAudit(auditSink, nowMs, "memory:archived", "retention", "Archived a faded memory.", {
      memoryId: id,
      scope: record.scope,
    });
  }
}

// Non-destructive fade-out of an un-reviewed proposal (governance `shouldExpire`). The row, its
// body, and its review-queue membership survive; only the status changes to `expired`, which
// retrieval suppresses and which the operator can still accept, archive, or forget. The audit event
// is body-free: id, scope, and the retention reason only.
function applyExpirations(
  vault: MemoryVaultStore,
  auditSink: MemoryAuditSink | undefined,
  nowMs: number,
  expirations: readonly { id: MemoryId; reason: string }[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceAccumulator,
): void {
  for (const expiry of expirations) {
    const record = byId.get(expiry.id);
    if (record?.status !== "proposed") continue;
    vault.updateMemory(expiry.id, { status: "expired", staleReason: expiry.reason }, nowMs);
    counts.expired += 1;
    emitAudit(
      auditSink,
      nowMs,
      "memory:updated",
      "retention",
      `Expired an un-reviewed memory proposal (${expiry.reason}).`,
      { memoryId: expiry.id, scope: record.scope },
    );
  }
}

function applyForgets(
  vault: MemoryVaultStore,
  auditSink: MemoryAuditSink | undefined,
  nowMs: number,
  forgets: readonly { id: MemoryId; reason: string }[],
  byId: Map<MemoryId, MemoryRecord>,
  counts: MaintenanceCounts,
): void {
  for (const forget of forgets) {
    const record = byId.get(forget.id);
    if (record === undefined) continue;
    if (record.status === "accepted" || record.status === "archived") continue;
    try {
      vault.deleteMemory(forget.id, {
        tombstone: true,
        forgetterSurface: "memory-maintenance",
        reason: forget.reason,
        nowMs,
      });
    } catch (err) {
      if (err instanceof MemoryStorageError && err.code === "not-found") continue;
      throw err;
    }
    counts.forgotten += 1;
    emitAudit(
      auditSink,
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

function auditRetentionForgets(
  auditSink: MemoryAuditSink | undefined,
  nowMs: number,
  decisions: readonly MemoryRetentionDecision[],
): void {
  for (const decision of decisions) {
    emitAudit(
      auditSink,
      nowMs,
      "memory:forgotten",
      "retention",
      `Forgot a memory (${decision.reason}).`,
      {
        memoryId: decision.memoryId,
        scope: decision.scope,
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
  // The effective product-wide autonomy posture this pass runs under (ADR-0129 D1, ADR-0146 D2).
  // Promotion (`proposed` -> `accepted`) is unattended acceptance of a memory the local human has
  // not reviewed, so it runs ONLY when `memoryUnattendedAcceptanceAllowed` admits the mode. An
  // ABSENT or unrecognised value fails closed to `governed-assist` (ADR-0124 D2 / ADR-0138 D2):
  // no promotion. Every other effect (consolidate, archive, expire, forget) is mode-independent.
  // Resolve it from server deps with `resolveMaintenanceAutonomyMode`.
  readonly autonomyMode?: CodingWorkbenchMode;
  // Type-aware decay multipliers (semanticization). When supplied, episodic memories fade — and so
  // archive/forget — faster than semantic facts / skills / preferences. When ABSENT the pass uses a
  // single flat half-life for every type (byte-identical to the pre-semanticization behaviour), so
  // the effect is strictly opt-in. Resolve it from the environment via `memorySemanticizationMultipliers`.
  readonly decayHalfLifeMultiplierByType?: Partial<Record<MemoryType, number>>;
  // Explicit operator policy. Absent means no absolute-age/count retention phase; the existing
  // strength-based maintenance remains unchanged. Server callers resolve this from env.
  readonly retentionPolicy?: MemoryRetentionPolicy;
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const RETENTION_ENV_FIELDS = {
  maxAgeMs: ["KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS", MILLIS_PER_DAY],
  maxRecordsPerScope: ["KEIKO_MEMORY_RETENTION_MAX_RECORDS_PER_SCOPE", 1],
  expireProposalsAfterMs: ["KEIKO_MEMORY_RETENTION_EXPIRE_PROPOSALS_AFTER_DAYS", MILLIS_PER_DAY],
  purgeForgottenAfterMs: ["KEIKO_MEMORY_RETENTION_PURGE_FORGOTTEN_AFTER_DAYS", MILLIS_PER_DAY],
} as const satisfies Readonly<
  Record<keyof MemoryRetentionPolicy, readonly [envName: string, multiplier: number]>
>;

function positiveIntegerEnv(env: EnvSource, name: string, multiplier: number): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value * multiplier)) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value * multiplier;
}

/** Resolves the operator-owned retention policy; no arbitrary deletion defaults are invented. */
export function memoryRetentionPolicy(env: EnvSource): MemoryRetentionPolicy | undefined {
  const entries = Object.entries(RETENTION_ENV_FIELDS).flatMap(([field, [name, multiplier]]) => {
    const value = positiveIntegerEnv(env, name, multiplier);
    return value === undefined ? [] : [[field, value] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

// Env-gated rollout of type-aware decay (semanticization), mirroring the KEIKO_MEMORY_FUSION
// convention: the capability ships wired and tested but OFF by default, so existing forgetting
// behaviour and its evaluation evidence are unchanged until an operator opts in with
// KEIKO_MEMORY_SEMANTICIZATION=1. Returns the recommended preset when enabled, otherwise undefined
// (flat single half-life). Flipping the default to on is a follow-up gated on retrieval/forgetting
// eval evidence, not a silent behaviour change here.
export function memorySemanticizationMultipliers(
  env: EnvSource,
): Partial<Record<MemoryType, number>> | undefined {
  return env.KEIKO_MEMORY_SEMANTICIZATION === "1"
    ? MEMORY_TYPE_DECAY_HALF_LIFE_MULTIPLIERS
    : undefined;
}

// Phase 1 — promote strong `proposed` memories FIRST. This keeps high-confidence captures visible
// to consolidation in the same maintenance pass instead of waiting for a second run.
//
// GOVERNED: promotion is unattended acceptance, so the caller's autonomy posture decides whether it
// runs at all (ADR-0146 D2). In `governed-assist` — and whenever the mode is absent or unresolvable
// — this phase is skipped entirely and every proposal stays in the review queue for the human.
function runPromotionPhase(
  vault: MemoryVaultStore,
  auditSink: MemoryAuditSink | undefined,
  nowMs: number,
  planPolicy: Partial<MemoryMaintenancePolicy>,
  counts: MaintenanceAccumulator,
  scopes: readonly MemoryScope[],
): void {
  const beforePromote = vault.listMemoriesAcrossScopes(scopes, { includeExpired: true });
  const promoteStats: ReadonlyMap<MemoryId, MemoryAccessStatLike> = vault.getAccessStats();
  const promotePlan = planMemoryMaintenance(beforePromote, promoteStats, {
    nowMs,
    policy: planPolicy,
  });
  applyPromotions(vault, auditSink, nowMs, promotePlan.promote, recordsById(beforePromote), counts);
}

export function runMemoryMaintenance(
  vault: MemoryVaultStore,
  auditSink?: MemoryAuditSink,
  options?: RunMaintenanceOptions,
): MaintenanceResult {
  // ONE clock for the whole pass: both plan phases and every vault write / audit timestamp use the
  // same nowMs, so selection is consistent within a run and fully replay-stable when nowMs is
  // injected (the deterministic-verification invariant the rest of the stack honours).
  const nowMs = options?.nowMs ?? Date.now();
  const planPolicy =
    options?.decayHalfLifeMultiplierByType !== undefined
      ? { decayHalfLifeMultiplierByType: options.decayHalfLifeMultiplierByType }
      : {};
  const counts = emptyCounts();
  const scopes = vault.listMemoryScopes();
  // Phase 1 — promote strong `proposed` memories FIRST, so high-confidence captures are visible to
  // consolidation in the same pass instead of waiting for a second run. ADR-0146 D2 / ADR-0124 D2:
  // promotion is unattended ACCEPTANCE, so it runs only where the resolved autonomy mode admits it.
  // In "Ask for approval" the pass still archives, expires and forgets — none of those accept
  // anything on the human's behalf — but nothing is promoted (0.3.0 audit P0, #2802).
  if (memoryUnattendedAcceptanceAllowed(options?.autonomyMode)) {
    runPromotionPhase(vault, auditSink, nowMs, planPolicy, counts, scopes);
  }
  // Phase 2 — consolidate live reviewable records: link safe near-duplicate metadata and surface
  // proposed/conflicted conflicts or merges as explicit review items. Status mutations require a
  // later governed review.
  const reviewable = vault
    .listMemoriesAcrossScopes(scopes, { includeExpired: true })
    .filter(
      (record) =>
        record.status === "accepted" ||
        record.status === "proposed" ||
        record.status === "conflicted",
    );
  runConsolidationPass(vault, nowMs, reviewable, counts);
  // Phase 3 — archive / forget on the post-consolidation snapshot. The access stats feed the
  // strength model; confidence itself is never mutated (O-V2).
  const all = vault.listMemoriesAcrossScopes(scopes, { includeExpired: true });
  const accessStats: ReadonlyMap<MemoryId, MemoryAccessStatLike> = vault.getAccessStats();
  const plan = planMemoryMaintenance(all, accessStats, { nowMs, policy: planPolicy });
  applyFadeEffects(vault, auditSink, nowMs, plan, recordsById(all), counts);
  // Phase 4 — explicit retention and tombstone purge. It shares this bounded pass, scope snapshot,
  // and deterministic clock; there is deliberately no timer or hidden background loop.
  if (options?.retentionPolicy !== undefined) {
    const retention = applyMemoryRetention({
      vault,
      scopes,
      policy: options.retentionPolicy,
      nowMs,
    });
    auditRetentionForgets(auditSink, nowMs, retention.forgotten);
    counts.retentionForgotten += retention.forgotten.length;
    counts.forgotten += retention.forgotten.length;
    counts.tombstonesPurged += retention.tombstonesPurged;
  }
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
  // Forwarded verbatim to the pass. Absent = no unattended acceptance (fail closed), so an
  // opportunistic sweep can never promote a proposal the caller did not authorise.
  readonly autonomyMode?: CodingWorkbenchMode;
  // Optional type-aware decay multipliers (semanticization). Forwarded verbatim to the pass; absent
  // keeps the flat single half-life. Resolve from the env via `memorySemanticizationMultipliers`.
  readonly decayHalfLifeMultiplierByType?: Partial<Record<MemoryType, number>>;
  readonly retentionPolicy?: MemoryRetentionPolicy;
  readonly onFailure?: ((error: unknown) => void) | undefined;
}

function notifyAutoMaintenanceFailure(
  onFailure: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    onFailure?.(error);
  } catch {
    return;
  }
}

// Runs ONE bounded maintenance pass iff enabled AND due, advancing the cursor BEFORE running so a
// re-entrant call within the same tick cannot double-fire. Returns the result, or null when skipped.
// Never throws: a maintenance fault must not break the caller (e.g. a chat turn); it is swallowed
// after advancing the cursor so a persistently-failing pass cannot hot-loop.
export function maybeRunAutoMaintenance(
  vault: MemoryVaultStore,
  auditSink: MemoryAuditSink | undefined,
  state: AutoMaintenanceState,
  options: MaybeRunAutoMaintenanceOptions,
): MaintenanceResult | null {
  if (!options.enabled) return null;
  if (!isMaintenanceDue(state.lastRunAtMs, options.nowMs, options.minIntervalMs)) return null;
  state.lastRunAtMs = options.nowMs;
  try {
    return runMemoryMaintenance(vault, auditSink, {
      nowMs: options.nowMs,
      ...(options.autonomyMode !== undefined ? { autonomyMode: options.autonomyMode } : {}),
      ...(options.decayHalfLifeMultiplierByType !== undefined
        ? { decayHalfLifeMultiplierByType: options.decayHalfLifeMultiplierByType }
        : {}),
      ...(options.retentionPolicy !== undefined
        ? { retentionPolicy: options.retentionPolicy }
        : {}),
    });
  } catch (error) {
    notifyAutoMaintenanceFailure(options.onFailure, error);
    return null;
  }
}

/**
 * Resolves the maintenance pass's audit sink from a request's deps — the store, the LIVE
 * gateway-aware string redactor, and the operator diagnostic sink for a failed evidence write.
 * Exported so the chat-path auto-run (`maybeRunAutoMaintenance`) and this route resolve it the same
 * way instead of each assembling a partial one.
 */
export function memoryMaintenanceAuditSink(deps: UiHandlerDeps): MemoryAuditSink {
  return {
    evidenceStore: deps.evidenceStore,
    redactString: currentAuditRedactString(deps),
    ...(deps.diagnostics === undefined ? {} : { diagnostics: deps.diagnostics }),
  };
}

// The maintenance pass's effective autonomy posture, resolved fail-closed. A UI-store fault must
// never widen authority and must never break the caller (the chat path runs this pass), so an
// unreadable policy row degrades to the most restrictive posture — no unattended acceptance — and
// is reported as a content-free operator diagnostic rather than swallowed.
export function resolveMaintenanceAutonomyMode(deps: UiHandlerDeps): CodingWorkbenchMode {
  try {
    return resolveMemoryMaintenanceAutonomyMode(deps);
  } catch (error) {
    emitServerDiagnostic(
      deps.diagnostics,
      serverDiagnosticFromError({
        correlationId: randomUUID(),
        operation: "memory.maintenance.autonomy-mode",
        source: "memory-maintenance-handlers.resolveMaintenanceAutonomyMode",
        error,
        redact: (summary): string => String(deps.redactor(summary)),
      }),
    );
    return DEFAULT_MEMORY_AUTONOMY_MODE;
  }
}

function reportRetentionPolicyFailure(deps: UiHandlerDeps, error: unknown): string {
  const correlationId = randomUUID();
  emitServerDiagnostic(
    deps.diagnostics,
    serverDiagnosticFromError({
      correlationId,
      operation: "memory.maintenance.retention-policy",
      source: "memory-maintenance-handlers.resolveMemoryRetentionPolicy",
      error,
      redact: (summary): string => String(deps.redactor(summary)),
    }),
  );
  return correlationId;
}

export type MemoryRetentionPolicyResolution =
  | { readonly ok: true; readonly policy: MemoryRetentionPolicy | undefined }
  | { readonly ok: false };

export function resolveMemoryRetentionPolicy(deps: UiHandlerDeps): MemoryRetentionPolicyResolution {
  try {
    return { ok: true, policy: memoryRetentionPolicy(deps.env) };
  } catch (error) {
    reportRetentionPolicyFailure(deps, error);
    return { ok: false };
  }
}

function manualRetentionPolicy(
  deps: UiHandlerDeps,
): MemoryRetentionPolicy | undefined | RouteResult {
  try {
    return memoryRetentionPolicy(deps.env);
  } catch (error) {
    const correlationId = reportRetentionPolicyFailure(deps, error);
    return {
      status: 500,
      body: errorBody(
        "MEMORY_RETENTION_CONFIG_INVALID",
        "Memory retention configuration is invalid.",
        correlationId,
      ),
    };
  }
}

export function handleRunMaintenance(_ctx: RouteContext, deps: UiHandlerDeps): RouteResult {
  const vault = resolveVault(deps);
  if (isRouteResult(vault)) return vault;
  try {
    const multipliers = memorySemanticizationMultipliers(deps.env);
    const retentionPolicy = manualRetentionPolicy(deps);
    if (isRouteResult(retentionPolicy)) return retentionPolicy;
    const counts = runMemoryMaintenance(vault, memoryMaintenanceAuditSink(deps), {
      autonomyMode: resolveMaintenanceAutonomyMode(deps),
      ...(multipliers !== undefined ? { decayHalfLifeMultiplierByType: multipliers } : {}),
      ...(retentionPolicy !== undefined ? { retentionPolicy } : {}),
    });
    return { status: 200, body: counts };
  } catch {
    // COUPLING-004: never forward the raw `error.message` into the response envelope — a vault
    // fault can embed a filesystem path or SQL fragment. Match memoryMutationErrorBody() /
    // governanceErrorBody(): a code-keyed, fixed string that carries no dynamic detail across the
    // trust boundary. The concrete cause is observable server-side via the thrown error, not here.
    return {
      status: 500,
      body: errorBody("MEMORY_MAINTENANCE_FAILED", "Memory maintenance failed."),
    };
  }
}
