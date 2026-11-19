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

/** The closed reasons a stage is `trace-unavailable`. */
export const UNAVAILABLE_REASONS = Object.freeze([
  "store-unreadable",
  "route-failed",
  "chat-limit-unreadable",
  "chat-block-unplaceable",
]);

// What the chat's block says about the needed memory (`needed` is its route position):
// - "refused": the chat kept a retrieved memory the route ranks behind it, or fewer than its limit;
// - "beyond": the chat's block is full and at least one of its memories is ranked against the needed
//   one (above it), so the needed memory ranked beyond the chat's limit;
// - "unplaceable": the block is full and none of its retrieved memories can be placed against the
//   needed one (the route did not rank them, or both were omitted by its limit), so the comparison has
//   no basis.
function chatBlock({ supplied, limit }, needed) {
  if (supplied.positions.some((position) => position !== null && position > needed))
    return "refused";
  if (supplied.count < limit) return "refused";
  const placed = supplied.positions.some(
    (position) => Number.isFinite(position) && position <= needed,
  );
  return placed ? "beyond" : "unplaceable";
}

// The needed memory ranked beyond the chat's limit; `moved-down` when its score rank was inside the
// limit but the reorder put it outside.
function beyondLimit({ position, scoreRank, limit }) {
  if (position !== null && position > limit && scoreRank !== null && scoreRank <= limit)
    return "moved-down";
  return "beyond-limit";
}

const verdict = (stage, reason) => (reason === undefined ? { stage } : { stage, reason });

/**
 * The one derivation of a needed fact's stage, with the closed reason when it is `trace-unavailable`.
 * Inputs as `neededStage`.
 */
export function neededVerdict({
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
  if (suppliedByChat) return verdict("supplied");
  if (!storeKnown) return verdict("trace-unavailable", "store-unreadable");
  if (id === null) return verdict("not-stored");
  if (!traceAvailable) return verdict("trace-unavailable", "route-failed");
  const ranked = routePosition({ position, omittedReason });
  if (ranked === null) return verdict(omittedReason === null ? "not-a-candidate" : "not-admitted");
  if (limit === null) return verdict("trace-unavailable", "chat-limit-unreadable");
  const block = chatBlock({ supplied, limit }, ranked);
  if (block === "refused") return verdict("refused-by-chat");
  if (block === "unplaceable") return verdict("trace-unavailable", "chat-block-unplaceable");
  return verdict(beyondLimit({ position, scoreRank, limit }));
}

/**
 * The stage of a needed fact. `storeKnown` is false when the store could not be read;
 * `traceAvailable` is false when the route call failed; `limit` is the chat's limit on retrieved
 * memories (null when it could not be read from the subject's build). `id` is null when no stored
 * body matches the fact. `position` and `scoreRank` are the 1-based places in the route's final order
 * and in the same entries sorted by score (null when not listed); `omittedReason` is the route's reason
 * (null when not omitted). `supplied` is what the chat supplied as retrieved memories (never the
 * standing profile): `count`, and `positions`, each one's route position (`Infinity` when the route
 * omitted it by its limit, null when the route did not rank it).
 */
export function neededStage(input) {
  return neededVerdict(input).stage;
}
