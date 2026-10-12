import { isNumberedCompoundQueryTerm } from "@oscharko-dev/keiko-workspace";
import type { SearchAnchor } from "@oscharko-dev/keiko-workflows";
import type {
  CandidateFile,
  ConnectedContextPack,
  ContextSelectionDiagnostics,
  SelectedScope,
  UncertaintyMarker,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { RelativeFloorObservation } from "./grounded-evidence-selection.js";
import type { PreselectionRerankerResult } from "./grounded-preselection-reranker.js";

export interface SelectionQualityInput {
  readonly candidates: readonly CandidateFile[];
  readonly selected: readonly CandidateFile[];
  readonly absoluteFloor: number;
  readonly minScoreExemptPaths: ReadonlySet<string>;
  readonly scopeKind: SelectedScope["kind"];
  readonly relative: RelativeFloorObservation;
  readonly reranker: PreselectionRerankerResult;
}

export function selectionQuality(input: SelectionQualityInput): ContextSelectionDiagnostics {
  const fallback =
    input.scopeKind !== "files" &&
    input.selected.length > 0 &&
    !input.candidates.some(
      (candidate) =>
        candidate.score >= input.absoluteFloor ||
        input.minScoreExemptPaths.has(candidate.scopePath),
    );
  return {
    selectionConfidence: fallback ? "low" : "high",
    keepOneFallbackApplied: fallback,
    floorReferenceKind: input.relative.floorReferenceKind,
    relativeFloorPermille: input.relative.relativeFloorPermille,
    strongestOrdinaryScorePermille: Math.round(input.relative.strongestOrdinaryScore * 1000),
    absoluteFloorPermille: Math.round(input.absoluteFloor * 1000),
    rerankerDisposition: input.reranker.rerankerDisposition,
    reranked: input.reranker.reranked,
    rerankFailedCalls: input.reranker.rerankFailedCalls,
    ...(input.reranker.diagnostics === undefined ? {} : { reranker: input.reranker.diagnostics }),
  };
}

export function lowConfidenceSelectionMarker(nowMs: number): UncertaintyMarker {
  return {
    kind: "low-confidence-selection",
    claim: "The supplied evidence may be unrelated to the question.",
    impactedAtomIds: [],
    emittedAtMs: nowMs,
  };
}

/** Shape hints cannot confer subject confidence when their spelling is absent from admitted excerpts. */
export function withContextualHintConfidence(
  pack: ConnectedContextPack,
  anchors: readonly SearchAnchor[],
  nowMs: number,
): ConnectedContextPack {
  const selection = pack.diagnostics?.selection;
  if (pack.query.kind !== "natural-language" || selection?.selectionConfidence !== "high")
    return pack;
  const hints = anchors.filter(
    (anchor) => anchor.kind === "literal" && isNumberedCompoundQueryTerm(anchor.term),
  );
  if (hints.length === 0) return pack;
  const bodies = pack.files
    .flatMap((file) => file.excerpts)
    .map((excerpt) => (pack.query.caseSensitive ? excerpt.content : excerpt.content.toLowerCase()));
  if (hints.every((hint) => bodies.some((body) => body.includes(hint.term)))) return pack;
  return {
    ...pack,
    diagnostics: {
      rankedCandidates: [],
      ...pack.diagnostics,
      selection: { ...selection, selectionConfidence: "low" },
    },
    uncertainty: [...pack.uncertainty, lowConfidenceSelectionMarker(nowMs)],
  };
}
