// Pure shaper: SearchResult -> ShapedSearchObservation (ADR-0054, PR3-W3, D4). No IO, no clock, no
// randomness. Total — never throws on empty atoms. Preserves the top-scoring file ranges so the
// PR4 lane assembler can cite relevant matches without including any raw atom text. scopePath is
// allowed here: this is the internal tool-observations lane, not the path-free browser summary.
//
// SOURCE NOTE: SearchResult (keiko-workspace/repoSearch.ts) carries the atoms + truncation flag but
// NOT the original query string or the search kind (those are inputs to searchText/findFiles, not
// outputs). The caller supplies them via opts so the shaper stays a pure projection. The query is
// the untrusted input (user-typed or model-generated): it is redacted and byte-bounded, and the
// injection summary is computed over the redacted query, content-free.

import {
  MAX_OBSERVATION_QUERY_BYTES,
  MAX_TOP_RANGES,
  type ShapedSearchObservation,
  type ShapedSearchRange,
} from "@oscharko-dev/keiko-contracts";
import type { EvidenceAtom } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchResult } from "@oscharko-dev/keiko-workspace";

import { boundExcerpt, injectionSignalsFor, makeObservationId } from "./shared.js";

export interface ShapeSearchOptions {
  readonly observationId?: string | undefined;
  readonly query?: string | undefined;
  readonly searchKind?: string | undefined;
}

const DEFAULT_SEARCH_KIND = "text";

function toRange(atom: EvidenceAtom): ShapedSearchRange {
  const startLine = atom.lineRange?.startLine ?? 0;
  const endLine = atom.lineRange?.endLine ?? 0;
  return { scopePath: atom.scopePath, startLine, endLine, score: atom.score };
}

// Top MAX_TOP_RANGES atoms by descending score. Sorts a shallow copy (the source array is readonly
// and must not be mutated). Ties keep their relative input order via a stable comparator.
function topRanges(atoms: readonly EvidenceAtom[]): readonly ShapedSearchRange[] {
  const sorted = [...atoms].sort((a, b) => b.score - a.score);
  return sorted.slice(0, MAX_TOP_RANGES).map(toRange);
}

export function shapeSearchObservation(
  result: SearchResult,
  opts?: ShapeSearchOptions,
): ShapedSearchObservation {
  const observationId = opts?.observationId ?? makeObservationId("");
  const query = boundExcerpt(opts?.query ?? "", MAX_OBSERVATION_QUERY_BYTES);
  const ranges = topRanges(result.atoms);
  const candidateCount = result.atoms.length;
  const injection = injectionSignalsFor(query);
  return {
    kind: "search",
    observationId,
    query,
    searchKind: opts?.searchKind ?? DEFAULT_SEARCH_KIND,
    candidateCount,
    topRanges: ranges,
    omittedCount: candidateCount - ranges.length,
    truncated: result.truncated,
    injectionSignalCount: injection.count,
    hasCriticalInjectionSignal: injection.critical,
  };
}
