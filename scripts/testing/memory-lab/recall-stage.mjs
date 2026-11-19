// The stage at which a memory an answer needs was lost (#4205): one pure derivation over what the
// product's retrieval route reported, shared by the recall trace and the failure classes. Closed
// values only.

/** The closed stages of one needed fact, in the order the derivation tests them. */
export const RECALL_STAGES = Object.freeze([
  "supplied",
  "not-stored",
  "trace-unavailable",
  "not-a-candidate",
  "not-admitted",
  "ranked-out",
  "cut-by-budget",
  "moved-down",
  "ranked-low",
]);

// The stage of an omitted memory: the two cuts the route names, or "not admitted" for any other reason.
function omittedStage(reason) {
  if (reason === "max-included-exceeded") return "ranked-out";
  if (reason === "budget-exceeded") return "cut-by-budget";
  return "not-admitted";
}

/**
 * The one derivation of a needed fact's stage. `traceAvailable` is false when the route call failed;
 * `storeKnown` is false when the store could not be read (then no id can be named);
 * `id` is null when no stored memory carries the fact; `position` and `scoreRank` are the 1-based
 * places in the route's final order and in the same entries sorted by score (null when not included);
 * `omittedReason` is the route's reason (null when not omitted).
 */
export function neededStage({
  storeKnown = true,
  traceAvailable,
  suppliedByChat,
  id,
  position,
  scoreRank,
  omittedReason,
}) {
  if (suppliedByChat) return "supplied";
  if (!storeKnown) return "trace-unavailable";
  if (id === null) return "not-stored";
  if (!traceAvailable) return "trace-unavailable";
  if (position !== null) return position > scoreRank ? "moved-down" : "ranked-low";
  if (omittedReason !== null) return omittedStage(omittedReason);
  return "not-a-candidate";
}
