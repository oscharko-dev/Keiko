import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts";
import type { SearchAnchor } from "@oscharko-dev/keiko-workflows";

const DEFINITION_LOOKUP_RE =
  /\b(?:defined|definition|declared|declaration|implemented|implementation|definiert|deklariert|implementiert)\b/iu;
const RELATION_LOOKUP_TERMS = new Set([
  "aufruf",
  "aufrufe",
  "aufgerufen",
  "caller",
  "callers",
  "call",
  "calls",
  "git",
  "historie",
  "history",
  "recency",
  "recent",
  "reference",
  "references",
  "referenziert",
  "usage",
  "usages",
  "used",
  "uses",
  "verwendet",
  "zuletzt",
  "änderung",
  "änderungen",
]);
const TEST_IDENTIFIER_RE = /(?:tests?|specs?)$/iu;

function hasRelationLookupTerm(text: string): boolean {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]/u)
    .some((term) => RELATION_LOOKUP_TERMS.has(term));
}

export function directDefinitionSymbol(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
): string | undefined {
  if (!DEFINITION_LOOKUP_RE.test(query.text) || hasRelationLookupTerm(query.text)) {
    return undefined;
  }
  const identifiers = anchors.filter(
    (anchor) => anchor.kind === "identifier" && anchor.weight >= 0.85,
  );
  const symbol = identifiers.length === 1 ? identifiers[0]?.term : undefined;
  return symbol === undefined || TEST_IDENTIFIER_RE.test(symbol) ? undefined : symbol;
}
