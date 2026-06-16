// Shared exponential half-life decay primitive (#204, O-P2).
//
// The retrieval layer modelled time-decay TWICE with the same kernel: edit-recency (recency.ts, on
// updatedAt) and use-recency inside reinforcement strength (strength.ts, on lastAccessedAt). They are
// DISTINCT signals with distinct half-lives — edit-freshness vs reuse-freshness — so they correctly
// coexist, but the kernel arithmetic should live in ONE place so the two cannot drift in how they
// clamp or compute. This is that single source of truth.
//
//   value = 1.0 at age 0, 0.5 at one half-life, 0.25 at two, … ; future-dated (age <= 0) clamps to
//   1.0 so clock skew never yields a negative or super-unit score that would poison the weighted sum.
//
// Pure: same (ageMs, halfLifeMs) => same value.
export function exponentialDecay(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  const decay = Math.exp(-(Math.LN2 * ageMs) / halfLifeMs);
  if (decay < 0) return 0;
  if (decay > 1) return 1;
  return decay;
}
