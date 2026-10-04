/** Stable search-outcome text shared by the server and its display-only UI recognizer. */
export const LEGACY_CONNECTED_SEARCH_ABSTENTION =
  "I could not find evidence in the connected scope to answer this question. " +
  "No answer is given because there is nothing to ground it in.";

export const CONNECTED_SEARCH_ABSTENTION_EN = "No matching evidence was found for this search.";
export const CONNECTED_SEARCH_ABSTENTION_DE = "Keine passenden Belege für diese Suche gefunden.";

const CANONICAL_CONNECTED_SEARCH_ABSTENTIONS: ReadonlySet<string> = new Set([
  LEGACY_CONNECTED_SEARCH_ABSTENTION,
  CONNECTED_SEARCH_ABSTENTION_EN,
  CONNECTED_SEARCH_ABSTENTION_DE,
]);

/** Strict canonical recognition; arbitrary model refusals and additional claims are excluded. */
export function isCanonicalConnectedSearchAbstention(text: string): boolean {
  return CANONICAL_CONNECTED_SEARCH_ABSTENTIONS.has(text);
}
