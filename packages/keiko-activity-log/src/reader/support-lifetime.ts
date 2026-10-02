// A process lifetime's own start names its runtime (Node version, platform, architecture). Only
// `keiko ui` writes one; a one-shot command writes none (its fatal and exit lines come without one).
// The query states a start the log can no longer account for: a lifetime without one whose segments
// no longer run unbroken and intact from its first. A received report must show each lifetime's start
// or a line of its first segment, and one holding a heartbeat without the start lost that start,
// because the heartbeat begins only after it.
export const LIFETIME_ANCHOR_OP = "process.started";
export const LIFETIME_PROOF_OP = "process.heartbeat";
