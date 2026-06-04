// Package-private defaults for ConsolidationOptions. Centralised so a future tuning round can
// adjust the numeric thresholds in one place without combing through orchestrator branches.

// Jaccard similarity over body bigrams. 0.85 is conservative — empirically near-duplicate
// paraphrases (e.g. "user prefers tabs" vs "the user prefers tabs over spaces") score 0.55–0.75,
// so 0.85 is a high-precision / low-recall floor. Operators tune via ConsolidationOptions.
export const JACCARD_DEFAULT = 0.85;

// Confidence at or below this threshold flags a memory as low-confidence stale. Provenance
// confidence is calibrated [0, 1] (validator-enforced in keiko-contracts). 0.3 mirrors the
// "below one in three" intuition.
export const STALE_CONFIDENCE_DEFAULT = 0.3;

// ~90 days in milliseconds. Memories older than this without a refresh (updatedAt) are flagged
// "aged-out" UNLESS pinned. Pinned memories are exempt by AC.
export const MAX_AGE_MS_DEFAULT = 90 * 24 * 60 * 60 * 1000;

// Hard bound on clusters inspected per run. Dedup is O(n^2) bigram-jaccard per scope partition;
// 100 keeps a single run well under a second even on slow CI. Set to 0 to short-circuit to
// state:"skipped" (used by tests; in production a 0 run is a configuration smell).
export const MAX_CLUSTERS_PER_RUN_DEFAULT = 100;
