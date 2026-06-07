// Memory maintenance planner (#204) — the "consolidate + forget" decision engine.
//
// PURE: same input + same nowMs => byte-identical plan. No clock reads, no IO, no randomness. The
// caller (BFF maintenance orchestrator) pre-fetches the records and the access stats, calls this to
// compute a plan, and applies the plan back to the vault + audit ledger. The split mirrors the
// consolidation engine: planning is a pure function, application is the impure caller's job.
//
// Each record receives AT MOST ONE decision. Priority (highest first): forget > archive > promote
// > reinforce > decay. A pinned record is never decayed, archived, or forgotten (its strength is
// pinned to 1); it may still be promoted or reinforced since those only strengthen it.
//
// Strength model (human-memory analogue):
//   base         = provenance.confidence                       (calibrated [0,1])
//   freqBoost    = 1 + 0.15 * ln(1 + accessCount)              (recall strengthens)
//   recencyFactor= exp(-ln2 * (now - lastTouch) / HALF_LIFE)   (disuse decays; 45-day half-life)
//   strength     = pinned ? 1 : clamp(base * freqBoost * recencyFactor, 0, 1)
// lastTouch is the last access timestamp, falling back to createdAt when never accessed.

import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

// Structural subset of the vault's MemoryAccessStat so this leaf package does not depend on the
// vault package (ADR-0019 direction). The orchestrator passes the vault's map directly.
export interface MemoryAccessStatLike {
  readonly lastAccessedAt: number;
  readonly accessCount: number;
}

export interface MemoryMaintenancePolicy {
  readonly halfLifeMs: number;
  readonly promoteStrength: number;
  readonly reinforceMinAccessCount: number;
  readonly reinforceMinRecency: number;
  readonly reinforceStep: number;
  readonly reinforceCap: number;
  readonly decayMaxRecency: number;
  readonly decayMinAgeMs: number;
  readonly decayFactor: number;
  readonly decayFloor: number;
  readonly archiveMaxStrength: number;
  readonly archiveMinAgeMs: number;
  readonly forgetArchivedMinAgeMs: number;
  readonly forgetProposedMaxStrength: number;
  readonly forgetProposedMinAgeMs: number;
  readonly maxForgetPerRun: number;
}

const DAY_MS = 864e5;

export const MEMORY_MAINTENANCE_DEFAULTS: MemoryMaintenancePolicy = {
  halfLifeMs: 45 * DAY_MS,
  promoteStrength: 0.45,
  reinforceMinAccessCount: 2,
  reinforceMinRecency: 0.6,
  reinforceStep: 0.1,
  reinforceCap: 0.98,
  decayMaxRecency: 0.5,
  decayMinAgeMs: 3 * DAY_MS,
  decayFactor: 0.6,
  decayFloor: 0.05,
  archiveMaxStrength: 0.2,
  archiveMinAgeMs: 3 * DAY_MS,
  forgetArchivedMinAgeMs: 30 * DAY_MS,
  forgetProposedMaxStrength: 0.1,
  forgetProposedMinAgeMs: 14 * DAY_MS,
  maxForgetPerRun: 25,
};

export interface MemoryMaintenancePlan {
  readonly promote: MemoryId[];
  readonly reinforce: { id: MemoryId; confidence: number }[];
  readonly decay: { id: MemoryId; confidence: number }[];
  readonly archive: MemoryId[];
  readonly forget: { id: MemoryId; reason: string }[];
}

export interface PlanMaintenanceOptions {
  readonly nowMs: number;
  readonly policy?: Partial<MemoryMaintenancePolicy>;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function recencyFactorOf(
  record: MemoryRecord,
  stat: MemoryAccessStatLike | undefined,
  nowMs: number,
  halfLifeMs: number,
): number {
  const lastTouch = stat?.lastAccessedAt ?? record.createdAt;
  return Math.exp((-Math.LN2 * (nowMs - lastTouch)) / halfLifeMs);
}

export function effectiveStrength(
  record: MemoryRecord,
  stat: MemoryAccessStatLike | undefined,
  nowMs: number,
  halfLifeMs: number = MEMORY_MAINTENANCE_DEFAULTS.halfLifeMs,
): number {
  if (record.pinned) return 1;
  const base = record.provenance.confidence;
  const freqBoost = 1 + 0.15 * Math.log1p(stat?.accessCount ?? 0);
  const recencyFactor = recencyFactorOf(record, stat, nowMs, halfLifeMs);
  return clamp01(base * freqBoost * recencyFactor);
}

// ─── Per-record decision ───────────────────────────────────────────────────────
type DecisionKind = "forget" | "archive" | "promote" | "reinforce" | "decay" | "none";

interface RecordContext {
  readonly record: MemoryRecord;
  readonly stat: MemoryAccessStatLike | undefined;
  readonly strength: number;
  readonly recencyFactor: number;
  readonly ageMs: number;
  readonly accessCount: number;
}

interface Decision {
  readonly kind: DecisionKind;
  readonly reason?: string;
  readonly confidence?: number;
}

function isValidityExpired(record: MemoryRecord, nowMs: number): boolean {
  const until = record.validity.validUntil;
  return until !== undefined && until <= nowMs;
}

function shouldForget(c: RecordContext, p: MemoryMaintenancePolicy, nowMs: number): string | null {
  if (isValidityExpired(c.record, nowMs)) return "validity-expired";
  if (c.record.status === "archived" && c.ageMs > p.forgetArchivedMinAgeMs) {
    return "archived-aged-out";
  }
  if (
    c.record.status === "proposed" &&
    c.strength < p.forgetProposedMaxStrength &&
    c.accessCount === 0 &&
    c.ageMs > p.forgetProposedMinAgeMs
  ) {
    return "proposed-faint-aged-out";
  }
  return null;
}

function shouldArchive(c: RecordContext, p: MemoryMaintenancePolicy): boolean {
  return (
    c.record.status === "accepted" &&
    c.strength < p.archiveMaxStrength &&
    c.ageMs > p.archiveMinAgeMs
  );
}

function shouldPromote(c: RecordContext, p: MemoryMaintenancePolicy): boolean {
  return (
    c.record.status === "proposed" &&
    c.record.provenance.sensitivity === "public" &&
    c.strength >= p.promoteStrength
  );
}

function reinforceConfidence(c: RecordContext, p: MemoryMaintenancePolicy): number | null {
  if (
    c.record.status === "accepted" &&
    c.accessCount >= p.reinforceMinAccessCount &&
    c.recencyFactor >= p.reinforceMinRecency
  ) {
    return Math.min(p.reinforceCap, c.record.provenance.confidence + p.reinforceStep);
  }
  return null;
}

function decayConfidence(c: RecordContext, p: MemoryMaintenancePolicy): number | null {
  if (c.accessCount === 0 && c.recencyFactor < p.decayMaxRecency && c.ageMs > p.decayMinAgeMs) {
    return Math.max(p.decayFloor, c.record.provenance.confidence * p.decayFactor);
  }
  return null;
}

function decideForLive(c: RecordContext, p: MemoryMaintenancePolicy, nowMs: number): Decision {
  if (!c.record.pinned) {
    const forgetReason = shouldForget(c, p, nowMs);
    if (forgetReason !== null) return { kind: "forget", reason: forgetReason };
    if (shouldArchive(c, p)) return { kind: "archive" };
  }
  if (shouldPromote(c, p)) return { kind: "promote" };
  const reinforce = reinforceConfidence(c, p);
  if (reinforce !== null) return { kind: "reinforce", confidence: reinforce };
  if (!c.record.pinned) {
    const decay = decayConfidence(c, p);
    if (decay !== null) return { kind: "decay", confidence: decay };
  }
  return { kind: "none" };
}

function buildContext(
  record: MemoryRecord,
  stat: MemoryAccessStatLike | undefined,
  nowMs: number,
  policy: MemoryMaintenancePolicy,
): RecordContext {
  return {
    record,
    stat,
    strength: effectiveStrength(record, stat, nowMs, policy.halfLifeMs),
    recencyFactor: recencyFactorOf(record, stat, nowMs, policy.halfLifeMs),
    ageMs: nowMs - record.createdAt,
    accessCount: stat?.accessCount ?? 0,
  };
}

interface ForgetCandidate {
  readonly id: MemoryId;
  readonly reason: string;
  readonly strength: number;
}

interface Accumulator {
  readonly promote: MemoryId[];
  readonly reinforce: { id: MemoryId; confidence: number }[];
  readonly decay: { id: MemoryId; confidence: number }[];
  readonly archive: MemoryId[];
  readonly forgetCandidates: ForgetCandidate[];
}

function applyDecision(acc: Accumulator, c: RecordContext, decision: Decision): void {
  const id = c.record.id;
  switch (decision.kind) {
    case "forget":
      acc.forgetCandidates.push({ id, reason: decision.reason ?? "forget", strength: c.strength });
      return;
    case "archive":
      acc.archive.push(id);
      return;
    case "promote":
      acc.promote.push(id);
      return;
    case "reinforce":
      acc.reinforce.push({ id, confidence: decision.confidence ?? c.record.provenance.confidence });
      return;
    case "decay":
      acc.decay.push({ id, confidence: decision.confidence ?? c.record.provenance.confidence });
      return;
    case "none":
      return;
  }
}

// Forget is bounded per run and ordered by ascending strength so the faintest memories go first.
// Ties break on id for determinism.
function boundForget(
  candidates: readonly ForgetCandidate[],
  maxForgetPerRun: number,
): { id: MemoryId; reason: string }[] {
  return [...candidates]
    .sort((a, b) =>
      a.strength !== b.strength ? a.strength - b.strength : a.id.localeCompare(b.id),
    )
    .slice(0, maxForgetPerRun)
    .map((c) => ({ id: c.id, reason: c.reason }));
}

export function planMemoryMaintenance(
  records: readonly MemoryRecord[],
  accessStats: ReadonlyMap<MemoryId, MemoryAccessStatLike>,
  options: PlanMaintenanceOptions,
): MemoryMaintenancePlan {
  const policy: MemoryMaintenancePolicy = { ...MEMORY_MAINTENANCE_DEFAULTS, ...options.policy };
  const acc: Accumulator = {
    promote: [],
    reinforce: [],
    decay: [],
    archive: [],
    forgetCandidates: [],
  };
  for (const record of records) {
    const stat = accessStats.get(record.id);
    const ctx = buildContext(record, stat, options.nowMs, policy);
    applyDecision(acc, ctx, decideForLive(ctx, policy, options.nowMs));
  }
  return {
    promote: acc.promote,
    reinforce: acc.reinforce,
    decay: acc.decay,
    archive: acc.archive,
    forget: boundForget(acc.forgetCandidates, policy.maxForgetPerRun),
  };
}
