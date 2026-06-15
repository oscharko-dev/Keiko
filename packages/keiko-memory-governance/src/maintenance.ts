// Memory maintenance planner (#204) — the "consolidate + forget" decision engine.
//
// PURE: same input + same nowMs => byte-identical plan. No clock reads, no IO, no randomness. The
// caller (BFF maintenance orchestrator) pre-fetches the records and the access stats, calls this to
// compute a plan, and applies the plan back to the vault + audit ledger. The split mirrors the
// consolidation engine: planning is a pure function, application is the impure caller's job.
//
// Each record receives AT MOST ONE decision. Priority (highest first): forget > archive > promote.
// A pinned record is never decayed, archived, or forgotten (its strength is pinned to 1); it may
// still be promoted since that only strengthens it.
//
// Strength model (human-memory analogue):
//   base         = provenance.confidence                       (calibrated [0,1])
//   freqBoost    = 1 + 0.15 * ln(1 + accessCount)              (recall strengthens)
//   recencyFactor= exp(-ln2 * (now - lastTouch) / HALF_LIFE)   (disuse decays; 45-day half-life)
//   utilityFactor= 0.5 + meanOutcomeUtility                    (outcome-gated; [0.5,1.5], default 1)
//   strength     = pinned ? 1 : clamp(base * freqBoost * recencyFactor * utilityFactor, 0, 1)
// lastTouch is the last access timestamp, falling back to createdAt when never accessed.
//
// OUTCOME-DRIVEN FORGETTING (#204, O-V1). Disuse is not the only reason to forget: a memory can be
// recent and frequently recalled yet keep leading to the WRONG answer. `utilityFactor` folds the
// mean of a memory's governed retention outcomes (proposal accepted/rejected, conflict won/lost,
// accepted correction superseding its origin) into the strength: all-bad outcomes (mean 0) halve it
// so the memory archives/forgets sooner; all-good (mean 1) raise it 1.5x so a proven-useful memory
// resists disuse decay. With NO outcomes the factor is exactly 1 and the model is byte-identical to
// the pre-O-V1 curve. The factor is bounded so outcomes shift, but never dominate, the prior signal.
//
// CONFIDENCE IS IMMUTABLE PROVENANCE (#204, O-V2). This pass NEVER overwrites provenance.confidence.
// Confidence is the calibrated veridicality of a memory at capture time and is changed only by an
// explicit, governed user correction/edit — never by a background job. "Reinforcement" and "decay"
// are not persisted nudges to confidence (that conflated veridicality with activation, lost the
// original value, and compounded non-idempotently as 0.6^n). Instead:
//   - reinforcement-on-reuse is realised LIVE at retrieval time via the access-derived strength
//     subscore (keiko-memory-retrieval strength.ts), and
//   - disuse-decay is computed ON THE FLY here through `recencyFactor` inside `effectiveStrength`,
//     which already gates archive/forget. So a faded memory still archives/forgets, but its
//     provenance stays intact and every run is idempotent.

import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

// Structural subset of the vault's MemoryAccessStat so this leaf package does not depend on the
// vault package (ADR-0019 direction). The orchestrator passes the vault's map directly.
export interface MemoryAccessStatLike {
  readonly lastAccessedAt: number;
  readonly accessCount: number;
  // Governed retention outcomes (#204, O-V1). Optional so a caller that does not track outcomes
  // (or a pre-O-V1 access row) yields a neutral utility factor of 1 — byte-identical to the
  // pre-outcome strength model.
  readonly outcomeCount?: number;
  readonly utilitySum?: number;
}

export interface MemoryMaintenancePolicy {
  readonly halfLifeMs: number;
  readonly promoteStrength: number;
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
  archiveMaxStrength: 0.2,
  archiveMinAgeMs: 3 * DAY_MS,
  forgetArchivedMinAgeMs: 30 * DAY_MS,
  forgetProposedMaxStrength: 0.1,
  forgetProposedMinAgeMs: 14 * DAY_MS,
  maxForgetPerRun: 25,
};

export interface MemoryMaintenancePlan {
  readonly promote: MemoryId[];
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
  // Only a genuine recall advances the recency anchor. An outcome-only row (accessCount 0, written
  // by recordOutcome before the memory was ever recalled) carries no "last use", so recency falls
  // back to createdAt — exactly as a never-tracked memory does. For every real access row
  // (accessCount >= 1) this is byte-identical to the prior `stat.lastAccessedAt ?? createdAt`.
  const lastTouch =
    stat !== undefined && stat.accessCount > 0 ? stat.lastAccessedAt : record.createdAt;
  return Math.exp((-Math.LN2 * (nowMs - lastTouch)) / halfLifeMs);
}

// Outcome-gated utility factor (#204, O-V1). Mean utility of the memory's recorded retention
// outcomes mapped linearly onto [0.5, 1.5]; no outcomes => exactly 1 (strength model unchanged).
function utilityFactor(stat: MemoryAccessStatLike | undefined): number {
  const count = stat?.outcomeCount ?? 0;
  if (count <= 0) return 1;
  const meanUtility = clamp01((stat?.utilitySum ?? 0) / count);
  return 0.5 + meanUtility;
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
  return clamp01(base * freqBoost * recencyFactor * utilityFactor(stat));
}

// ─── Per-record decision ───────────────────────────────────────────────────────
type DecisionKind = "forget" | "archive" | "promote" | "none";

interface RecordContext {
  readonly record: MemoryRecord;
  readonly stat: MemoryAccessStatLike | undefined;
  readonly strength: number;
  readonly ageMs: number;
  readonly accessCount: number;
}

interface Decision {
  readonly kind: DecisionKind;
  readonly reason?: string;
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

function decideForLive(c: RecordContext, p: MemoryMaintenancePolicy, nowMs: number): Decision {
  if (!c.record.pinned) {
    const forgetReason = shouldForget(c, p, nowMs);
    if (forgetReason !== null) return { kind: "forget", reason: forgetReason };
    if (shouldArchive(c, p)) return { kind: "archive" };
  }
  if (shouldPromote(c, p)) return { kind: "promote" };
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
    archive: acc.archive,
    forget: boundForget(acc.forgetCandidates, policy.maxForgetPerRun),
  };
}
