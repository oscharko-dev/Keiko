// Reinforcement-strength primitive (#204 plasticity). Turns a memory's access history — how OFTEN
// and how RECENTLY it has been recalled — into a [0,1] re-ranking signal so a frequently-reused
// memory is surfaced ahead of a never-touched one. This realises the core plasticity promise ("a
// memory gets stronger when reused") at retrieval time; the maintenance pass already strengthens on
// a slower cadence, but ranking is where reuse must change what the user actually sees.
//
// Cognitive basis (ACT-R base-level activation, simplified): activation rises with practice
// frequency and decays with disuse. Two bounded, deterministic factors, multiplied:
//   accessRecency = exp(-ln2 * (now - lastAccessedAt) / HALF_LIFE)   disuse decay, 45-day half-life
//   frequency     = 1 - exp(-accessCount / SATURATION)              saturating practice gain
// A NEVER-accessed memory scores 0 (no reinforcement yet) so this subscore only ever ADDS signal for
// genuine reuse and never perturbs a fresh memory's existing relevance/recency/confidence ranking.
//
// Pure: no clock (now is passed in), no IO, no randomness. Same inputs => same output, so the
// retrieval layer stays replay-stable and the deterministic eval can pin it.

const MS_PER_DAY = 86_400_000;

// Disuse half-life. Matches the maintenance strength curve (keiko-memory-governance maintenance.ts)
// so "recency of use" decays at one consistent rate across ranking and the decay/forget cycle.
export const STRENGTH_HALF_LIFE_MS = 45 * MS_PER_DAY;

// Access count at which the frequency factor reaches ~0.63 of its ceiling. Logarithmic-feeling
// saturation: 1 recall ≈ 0.12, 8 ≈ 0.63, 24 ≈ 0.95 — heavy reuse keeps mattering with diminishing
// returns, matching the practice-curve intuition without an unbounded count term.
export const STRENGTH_FREQUENCY_SATURATION = 8;

// Structural subset of the vault's access row. The retrieval layer never imports the vault; the
// caller passes these counters in, keeping this package IO-free (ADR-0019 leaf rule).
export interface MemoryAccessStat {
  readonly accessCount: number;
  readonly lastAccessedAt: number;
}

// Reinforcement strength in [0,1]. `undefined` stat (memory never accessed) => 0.
export function reinforcementStrength(stat: MemoryAccessStat | undefined, nowMs: number): number {
  if (stat === undefined) return 0;
  const ageMs = nowMs - stat.lastAccessedAt;
  // Future-dated last-access (clock skew / source ahead of orchestrator) clamps to full recency
  // rather than producing a >1 factor that would poison the weighted sum.
  const accessRecency = ageMs <= 0 ? 1 : Math.exp(-(Math.LN2 * ageMs) / STRENGTH_HALF_LIFE_MS);
  const count = stat.accessCount > 0 ? stat.accessCount : 0;
  const frequency = 1 - Math.exp(-count / STRENGTH_FREQUENCY_SATURATION);
  const strength = frequency * accessRecency;
  if (strength < 0) return 0;
  if (strength > 1) return 1;
  return strength;
}

// Convenience: build the per-memory strength map the ranker consumes from a map of access stats.
// Lives here (next to the formula) so callers cannot drift from the canonical computation.
export function buildStrengthById<K>(
  statsById: ReadonlyMap<K, MemoryAccessStat>,
  nowMs: number,
): ReadonlyMap<K, number> {
  const out = new Map<K, number>();
  for (const [id, stat] of statsById) {
    const strength = reinforcementStrength(stat, nowMs);
    if (strength > 0) out.set(id, strength);
  }
  return out;
}
