// Deterministic decomposition of CHAINED questions into sub-queries (retrieval variants).
//
// A single embedding of "How do I configure the retry limit and what does error E410 mean?"
// lands between the two topics, and the AND-joined lexical query demands both topics in one
// chunk — so multi-part questions systematically under-retrieve. Splitting the parts and
// searching each as its own variant lets every leg of the chain recall its own evidence;
// reciprocal-rank fusion then merges the legs.
//
// This runs BEFORE (and independently of) the optional model-backed QueryTransformer: it is
// pure string analysis — no model call, no latency, no egress — so it applies to every
// strategy, not just "broad". The rules are deliberately conservative: a conjunction alone
// ("the difference between Maven and Gradle") is NEVER a split point; a split requires a
// question mark boundary, a semicolon, or a conjunction FOLLOWED BY an interrogative word.
// When in doubt this module returns [] and retrieval behaves exactly as before.

const MAX_CHAINED_PARTS = 3;
const MIN_PART_TOKENS = 3;

// Conjunction followed by an interrogative — the only conjunction form that safely marks a new
// question ("… und wie …", "… and what …"). Case-insensitive; the interrogative is kept with
// the second part via the capture group.
const CONJUNCTION_SPLIT_PATTERN =
  /\s+(?:und|sowie|and|plus)\s+(?=(?:wie|was|wo|wann|warum|wieso|weshalb|welche[rsnm]?|how|what|where|when|why|which|who|whom|whose)\b)/giu;

const QUESTION_MARK_SPLIT_PATTERN = /\?+/u;
const SEMICOLON_SPLIT_PATTERN = /;+/u;

function tokenCount(value: string): number {
  return value.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0).length;
}

function cleanedParts(rawParts: readonly string[]): readonly string[] {
  return rawParts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// All parts must independently look like queries; otherwise the decomposition is rejected as a
// whole. Splitting off a fragment like "and why" would produce a noise variant that pollutes
// fusion, so we prefer no decomposition over a partial one.
function acceptedParts(parts: readonly string[]): readonly string[] {
  if (parts.length < 2 || parts.length > MAX_CHAINED_PARTS) return [];
  if (parts.some((part) => tokenCount(part) < MIN_PART_TOKENS)) return [];
  return parts;
}

function splitBy(query: string, pattern: RegExp): readonly string[] {
  return acceptedParts(cleanedParts(query.split(pattern)));
}

// Returns the chained sub-queries of `query`, or [] when the query is not a recognizable
// chain. The original query is NOT included — callers decide how to combine.
export function decomposeChainedQuery(query: string): readonly string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const byQuestionMark = splitBy(trimmed, QUESTION_MARK_SPLIT_PATTERN);
  if (byQuestionMark.length > 0) return byQuestionMark;

  const bySemicolon = splitBy(trimmed, SEMICOLON_SPLIT_PATTERN);
  if (bySemicolon.length > 0) return bySemicolon;

  return splitBy(trimmed, CONJUNCTION_SPLIT_PATTERN);
}
