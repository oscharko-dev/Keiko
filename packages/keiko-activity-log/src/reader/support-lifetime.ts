// A process lifetime's own start names its runtime (Node version, platform, architecture). Only
// `keiko ui` writes one; a one-shot command writes none (its fatal and exit lines come without one).
// The query states a start the log can no longer account for: a lifetime without one whose segments
// no longer run unbroken from its first. A received report holding a lifetime's heartbeat without
// its start lost that start too, because the heartbeat begins only after it.
export const LIFETIME_ANCHOR_OP = "process.started";
export const LIFETIME_PROOF_OP = "process.heartbeat";
