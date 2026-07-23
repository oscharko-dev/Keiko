import type { ConnectedContextPack, EvidenceAtom, LineRange } from "@oscharko-dev/keiko-contracts";
import type {
  GroundedCitationDocumentFormat,
  GroundedEvidenceCitation,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import {
  buildPackCitationIndex,
  citationSourceIdForIndex,
  parseInlineCitations,
  resolveSupportedCitationSourceId,
  type ParsedInlineCitation,
} from "./grounded-faithfulness.js";

type CitationRedactor = (value: string) => string;

export function documentFormatForAtom(
  atom: EvidenceAtom,
): GroundedCitationDocumentFormat | undefined {
  if (atom.provenance.kind !== "document-extract") return undefined;
  const path = atom.scopePath.toLowerCase();
  if (path.endsWith(".docx")) return "docx";
  if (path.endsWith(".xlsx")) return "xlsx";
  return path.endsWith(".pdf") ? "pdf" : undefined;
}

function citationForAtom(atom: EvidenceAtom, redact: CitationRedactor): GroundedEvidenceCitation {
  const documentFormat = documentFormatForAtom(atom);
  return {
    scopePath: redact(atom.scopePath),
    lineRange: atom.lineRange,
    score: atom.score,
    stableId: redact(atom.stableId),
    ...(documentFormat === undefined ? {} : { documentFormat }),
  };
}

export function buildPackCitations(
  pack: ConnectedContextPack,
  redact: CitationRedactor,
): readonly GroundedEvidenceCitation[] {
  const citations = pack.files.flatMap((file) =>
    file.excerpts.map((excerpt) => citationForAtom(excerpt.atom, redact)),
  );
  return citations.sort((a, b) => b.score - a.score || a.stableId.localeCompare(b.stableId));
}

function rangeSpan(range: LineRange | undefined): number {
  return range === undefined ? 0 : range.endLine - range.startLine + 1;
}

function compareBareCitations(a: GroundedEvidenceCitation, b: GroundedEvidenceCitation): number {
  return (
    rangeSpan(a.lineRange) - rangeSpan(b.lineRange) ||
    b.score - a.score ||
    a.stableId.localeCompare(b.stableId)
  );
}

function rangeContains(container: LineRange, requested: LineRange): boolean {
  return container.startLine <= requested.startLine && container.endLine >= requested.endLine;
}

function rangeIntersection(left: LineRange, right: LineRange): LineRange | undefined {
  const startLine = Math.max(left.startLine, right.startLine);
  const endLine = Math.min(left.endLine, right.endLine);
  return startLine <= endLine ? { startLine, endLine } : undefined;
}

function projectSupportedMarker(
  marker: ParsedInlineCitation,
  citations: readonly GroundedEvidenceCitation[],
): readonly GroundedEvidenceCitation[] {
  const requested = marker.lineRange;
  if (requested === undefined) {
    const best = [...citations].sort(compareBareCitations)[0];
    return best === undefined ? [] : [best];
  }
  const containing = citations
    .filter((citation) =>
      citation.lineRange === undefined ? false : rangeContains(citation.lineRange, requested),
    )
    .sort(compareBareCitations)[0];
  if (containing !== undefined) return [{ ...containing, lineRange: requested }];
  return citations.flatMap((citation) => {
    if (citation.lineRange === undefined) return [];
    const intersection = rangeIntersection(citation.lineRange, requested);
    return intersection === undefined ? [] : [{ ...citation, lineRange: intersection }];
  });
}

function projectedCitationKey(sourceId: string, citation: GroundedEvidenceCitation): string {
  const range = citation.lineRange;
  return range === undefined
    ? `${sourceId}:${citation.stableId}:*`
    : `${sourceId}:${citation.stableId}:${String(range.startLine)}-${String(range.endLine)}`;
}

function redactCitation(
  citation: GroundedEvidenceCitation,
  redact: CitationRedactor,
): GroundedEvidenceCitation {
  return {
    ...citation,
    scopePath: redact(citation.scopePath),
    stableId: redact(citation.stableId),
  };
}

export interface SourcedGroundedEvidenceCitation {
  readonly sourceId: string;
  readonly citation: GroundedEvidenceCitation;
}

function buildAvailableSourcedCitations(
  packs: readonly ConnectedContextPack[],
): readonly SourcedGroundedEvidenceCitation[] {
  return packs.flatMap((pack, index) => {
    const sourceId = citationSourceIdForIndex(index);
    return buildPackCitations(pack, (value) => value).map((citation) => ({ sourceId, citation }));
  });
}

/** Project only answer markers supported by one unambiguous source and contained evidence range. */
export function buildSourcedAnswerCitations(
  packs: readonly ConnectedContextPack[],
  answerContent: string,
  redact: CitationRedactor,
): readonly SourcedGroundedEvidenceCitation[] {
  const index = buildPackCitationIndex(packs);
  const available = buildAvailableSourcedCitations(packs);
  const selected: SourcedGroundedEvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const marker of parseInlineCitations(answerContent)) {
    const sourceId = resolveSupportedCitationSourceId(marker, index);
    if (sourceId === undefined) continue;
    const candidates = available
      .filter((entry) => entry.sourceId === sourceId)
      .map((entry) => entry.citation)
      .filter((citation) => citation.scopePath === marker.scopePath);
    for (const citation of projectSupportedMarker(marker, candidates)) {
      const redacted = redactCitation(citation, redact);
      const key = projectedCitationKey(sourceId, redacted);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push({ sourceId, citation: redacted });
    }
  }
  return selected;
}

export function buildAnswerCitations(
  pack: ConnectedContextPack,
  answerContent: string,
  redact: CitationRedactor,
): readonly GroundedEvidenceCitation[] {
  return buildSourcedAnswerCitations([pack], answerContent, redact).map(
    (selected) => selected.citation,
  );
}
