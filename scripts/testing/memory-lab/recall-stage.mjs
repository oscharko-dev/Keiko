// The stage at which a memory an answer needs was lost (#4205): one pure derivation over three facts,
// the route's order, what the chat actually supplied and the chat's own limit on retrieved memories.
// Shared by the recall trace and the failure classes. Closed values only.
//
// The chat path and the diagnostic route rank the same candidates before their floors, so among the
// memories both admit the order is the same. What differs is the cut: the chat keeps at most its
// limit of retrieved memories (`CHAT_MAX_RETRIEVED_MEMORIES`) behind a strict relevance floor and a
// token budget; the route keeps 12 behind a relaxed floor. The stage therefore names what is known
// and never a cause the route cannot know.

/** The closed stages of one needed fact. */
export const RECALL_STAGES = Object.freeze([
  "supplied",
  "not-stored",
  "not-a-candidate",
  "not-admitted",
  "refused-by-chat",
  "beyond-limit",
  "moved-down",
  "trace-unavailable",
]);

/** The one omission reason that is a limit, not a verdict on the memory. */
const LIMIT_REASON = "max-included-exceeded";

// A memory the route admitted but never listed (omitted by its limit) ranks behind every listed one.
// Two such memories have no known order between them.
const BEYOND_LISTED = Number.POSITIVE_INFINITY;

function routePosition({ position, omittedReason }) {
  if (position !== null) return position;
  return omittedReason === LIMIT_REASON ? BEYOND_LISTED : null;
}

// The chat kept fewer retrieved memories than its limit, or kept one the route ranks behind the
// needed memory: it refused the needed memory although it ranked high enough (strict floor or
// token budget, which this trace cannot tell apart).
function chatRefused({ supplied, limit }, needed) {
  const below = supplied.positions.some((position) => position !== null && position > needed);
  return below || supplied.count < limit;
}

// The needed memory ranked beyond the chat's limit; `moved-down` when its score rank was inside the
// limit but the reorder put it outside.
function beyondLimit({ position, scoreRank, limit }) {
  if (position !== null && position > limit && scoreRank !== null && scoreRank <= limit)
    return "moved-down";
  return "beyond-limit";
}

/**
 * The one derivation of a needed fact's stage. `storeKnown` is false when the store could not be read;
 * `traceAvailable` is false when the route call failed; `limit` is the chat's limit on retrieved
 * memories (null when it could not be read from the subject's build). `id` is null when no stored
 * body matches the fact. `position` and `scoreRank` are the 1-based places in the route's final order
 * and in the same entries sorted by score (null when not listed); `omittedReason` is the route's reason
 * (null when not omitted). `supplied` is what the chat supplied as retrieved memories (never the
 * standing profile): `count`, and `positions`, each one's route position (`Infinity` when the route
 * omitted it by its limit, null when the route did not rank it).
 */
export function neededStage({
  storeKnown = true,
  traceAvailable,
  limit,
  suppliedByChat,
  id,
  position,
  scoreRank,
  omittedReason,
  supplied,
}) {
  if (suppliedByChat) return "supplied";
  if (!storeKnown) return "trace-unavailable";
  if (id === null) return "not-stored";
  if (!traceAvailable) return "trace-unavailable";
  const ranked = routePosition({ position, omittedReason });
  if (ranked === null) return omittedReason === null ? "not-a-candidate" : "not-admitted";
  if (limit === null) return "trace-unavailable";
  if (chatRefused({ supplied, limit }, ranked)) return "refused-by-chat";
  return beyondLimit({ position, scoreRank, limit });
}
