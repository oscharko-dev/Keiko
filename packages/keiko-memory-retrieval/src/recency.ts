// Recency-decay primitive. Exponential half-life model: a memory is worth 1.0 at
// updatedAt = nowMs, 0.5 at one half-life of age, 0.25 at two half-lives, etc. Future-dated
// records are clamped to 1.0 so a clock-skew or capture-source-ahead-of-orchestrator does
// not produce a negative or super-unit score that would poison the weighted sum.
//
// Half-life is 7 days. This matches the conversational-memory expectation that "recent"
// runs the previous week; consolidation (#208) will collapse older records into semantic
// facts whose recency continues to refresh on every update. The constant is exported so
// callers (e.g. an audit dashboard) can reproduce the score deterministically.

const MS_PER_DAY = 86_400_000;
export const RECENCY_HALF_LIFE_MS = 7 * MS_PER_DAY;
const LN_2 = Math.LN2;

export function recencyScore(updatedAt: number, nowMs: number): number {
  const ageMs = nowMs - updatedAt;
  if (ageMs <= 0) return 1;
  const decay = Math.exp(-(LN_2 * ageMs) / RECENCY_HALF_LIFE_MS);
  if (decay < 0) return 0;
  if (decay > 1) return 1;
  return decay;
}
