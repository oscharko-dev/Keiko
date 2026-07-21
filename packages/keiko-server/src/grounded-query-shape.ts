import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts";
import type { SearchAnchor } from "@oscharko-dev/keiko-workflows";

const DEFINITION_LOOKUP_RE =
  /\b(?:defined|definition|declared|declaration|implemented|implementation|definiert|deklariert|implementiert)\b/iu;
const RELATION_LOOKUP_RE =
  /(?:^|[^\p{L}\p{N}_])(?:callers?|calls?|history|historie|references?|referenziert|used|uses|usage|usages|verwendet|aufgerufen|aufrufe?|git|recent|recency|zuletzt|änderung|änderungen)(?=$|[^\p{L}\p{N}_])/iu;
const TEST_IDENTIFIER_RE = /(?:tests?|specs?)$/iu;

export function directDefinitionSymbol(
  query: RetrievalQuery,
  anchors: readonly SearchAnchor[],
): string | undefined {
  if (!DEFINITION_LOOKUP_RE.test(query.text) || RELATION_LOOKUP_RE.test(query.text)) {
    return undefined;
  }
  const identifiers = anchors.filter(
    (anchor) => anchor.kind === "identifier" && anchor.weight >= 0.85,
  );
  const symbol = identifiers.length === 1 ? identifiers[0]?.term : undefined;
  return symbol === undefined || TEST_IDENTIFIER_RE.test(symbol) ? undefined : symbol;
}
