// A process lifetime's own start names its runtime (Node version, platform, architecture). Only
// `keiko ui` writes one, and its heartbeat begins only after it: a lifetime whose heartbeat is held
// but whose start is not lost that start. A one-shot command writes neither (its fatal and exit lines
// come without a start), so it has no start to lose. The query selects by this rule and the report
// analyzer recomputes it from received evidence.
export const LIFETIME_ANCHOR_OP = "process.started";
export const LIFETIME_PROOF_OP = "process.heartbeat";
