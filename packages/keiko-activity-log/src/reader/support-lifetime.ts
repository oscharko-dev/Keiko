import type {
  SupportLifetimeProvenance,
  SupportLifetimeStart,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import { compareText } from "./support-segment-manifest.js";

// A process lifetime's own start names its runtime (Node version, platform, architecture). Only
// `keiko ui` writes one; a one-shot command writes none (its fatal and exit lines come without one).
// The query accounts for every lifetime's start: `selected`, `absent` while its segments still run
// unbroken and intact from its first, else `lost`. A report carries that provenance, and a receiver
// checks it against the evidence: a selected start must be there, an absent one needs a line of the
// first segment and no heartbeat (which begins only after a start), and a lost one is insufficient.
export const LIFETIME_ANCHOR_OP = "process.started";
export const LIFETIME_PROOF_OP = "process.heartbeat";

export const SUPPORT_LIFETIME_STARTS: ReadonlySet<string> = new Set<SupportLifetimeStart>([
  "selected",
  "absent",
  "lost",
]);

// The lifetimes one report describes: the default closure bound, which also bounds its lifetimes.
export const MAX_SUPPORT_REPORT_LIFETIMES = 4096;

export function compareLifetimes(
  left: SupportLifetimeProvenance,
  right: SupportLifetimeProvenance,
): number {
  return left.pid - right.pid || compareText(left.instanceId, right.instanceId);
}
