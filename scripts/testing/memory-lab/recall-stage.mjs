// The stage at which a memory an answer needs was lost (#4205): one pure derivation over what the
// product's retrieval route reported and what the chat actually supplied. Shared by the recall trace and
// the failure classes. Closed values only.
//
// The route's position of a memory says nothing certain about the chat's. Under the strict floor that
// Chat recall uses, the admitted memories are ranked among themselves; the route uses the lenient floor
// and ranks over one window. A fused rank is relative to its set, so when the two paths admit different
// sets their orders can differ, with or without an embedder. The stages that read a chat cut out of the
// route's order (`refused-by-chat`, `beyond-limit`, `moved-down`) were valid only while the chat ranked
// over the window like the route; they are gone, and a memory the route admitted and the chat did not
// supply is `admitted-not-supplied`, always. The route's position and score rank stay recorded as facts.

/** The closed stages of one needed fact. */
export const RECALL_STAGES = Object.freeze([
  "supplied",
  "not-stored",
  "not-a-candidate",
  "not-admitted",
  "admitted-not-supplied",
  "trace-unavailable",
]);

/**
 * The stages that older runs recorded (a chat cut read out of the route's order). They are never
 * derived any more; a reader of an old run still renders and counts them.
 */
export const LEGACY_RECALL_STAGES = Object.freeze([
  "refused-by-chat",
  "beyond-limit",
  "moved-down",
]);

/** The closed reasons a stage is `trace-unavailable`. */
export const UNAVAILABLE_REASONS = Object.freeze(["store-unreadable", "route-failed"]);

/** The one omission reason that is a limit, not a verdict on the memory. */
const LIMIT_REASON = "max-included-exceeded";

const verdict = (stage, reason) => (reason === undefined ? { stage } : { stage, reason });

// The route admitted the memory when it listed it, or omitted it only by its own limit.
const routeAdmitted = ({ position, omittedReason }) =>
  position !== null || omittedReason === LIMIT_REASON;

/**
 * The one derivation of a needed fact's stage, with the closed reason when it is `trace-unavailable`.
 * `storeKnown` is false when the store could not be read; `traceAvailable` is false when the route call
 * failed; `id` is null when no stored body matches the fact; `position` is the 1-based place in the
 * route's final order (null when not listed) and `omittedReason` the route's reason (null when not
 * omitted); `suppliedByChat` says the chat supplied it.
 */
export function neededVerdict({
  storeKnown = true,
  traceAvailable,
  suppliedByChat,
  id,
  position,
  omittedReason,
}) {
  if (suppliedByChat) return verdict("supplied");
  if (!storeKnown) return verdict("trace-unavailable", "store-unreadable");
  if (id === null) return verdict("not-stored");
  if (!traceAvailable) return verdict("trace-unavailable", "route-failed");
  if (routeAdmitted({ position, omittedReason })) return verdict("admitted-not-supplied");
  return verdict(omittedReason === null ? "not-a-candidate" : "not-admitted");
}

/** The stage of a needed fact (inputs as `neededVerdict`). */
export function neededStage(input) {
  return neededVerdict(input).stage;
}
