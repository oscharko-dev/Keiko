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
  "called",
  "calls",
  "git",
  "historie",
  "history",
  "recency",
  "recent",
  "reference",
  "referenced",
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
const IDENTIFIER_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*/gu;
const TEST_IDENTIFIER_SUFFIX_RE = /(?:Test|Tests|Spec|Specs)$/u;
const DELIMITED_TEST_IDENTIFIER_SUFFIX_RE = /(?:^|[_$])(?:tests?|specs?)$/u;

function hasRelationLookupTerm(text: string): boolean {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]/u)
    .some((term) => RELATION_LOOKUP_TERMS.has(term));
}

function isTestIdentifier(text: string, normalizedSymbol: string): boolean {
  const sourceToken = [...text.matchAll(IDENTIFIER_TOKEN_RE)]
    .map((match) => match[0])
    .find((token) => token.toLowerCase() === normalizedSymbol.toLowerCase());
  return (
    sourceToken !== undefined &&
    (TEST_IDENTIFIER_SUFFIX_RE.test(sourceToken) ||
      DELIMITED_TEST_IDENTIFIER_SUFFIX_RE.test(sourceToken))
  );
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
  return symbol === undefined || isTestIdentifier(query.text, symbol) ? undefined : symbol;
}
