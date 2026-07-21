import type { ConnectedContextPack, EvidenceAtom, LineRange } from "@oscharko-dev/keiko-contracts";
import type {
  GroundedCitationDocumentFormat,
  GroundedEvidenceCitation,
} from "@oscharko-dev/keiko-contracts/bff-wire";

import { parseInlineCitations, type ParsedInlineCitation } from "./grounded-faithfulness.js";

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

function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && a.endLine >= b.startLine;
}

function rangeFit(citation: LineRange | undefined, requested: LineRange | undefined): number {
  if (requested === undefined) return 1;
  if (citation === undefined) return 1;
  if (!rangesOverlap(citation, requested)) return -1;
  if (citation.startLine === requested.startLine && citation.endLine === requested.endLine)
    return 5;
  if (citation.startLine <= requested.startLine && citation.endLine >= requested.endLine) return 4;
  if (requested.startLine <= citation.startLine && requested.endLine >= citation.endLine) return 3;
  return 2;
}

function rangeSpan(range: LineRange | undefined): number {
  return range === undefined ? 0 : range.endLine - range.startLine + 1;
}

function bestCitationFor(
  marker: ParsedInlineCitation,
  citations: readonly GroundedEvidenceCitation[],
): GroundedEvidenceCitation | undefined {
  return citations
    .filter(
      (citation) =>
        citation.scopePath === marker.scopePath &&
        rangeFit(citation.lineRange, marker.lineRange) >= 0,
    )
    .sort((a, b) => {
      const fit = rangeFit(b.lineRange, marker.lineRange) - rangeFit(a.lineRange, marker.lineRange);
      return (
        fit ||
        Math.abs(rangeSpan(a.lineRange) - rangeSpan(marker.lineRange)) -
          Math.abs(rangeSpan(b.lineRange) - rangeSpan(marker.lineRange)) ||
        b.score - a.score ||
        a.stableId.localeCompare(b.stableId)
      );
    })[0];
}

function citationAtAnswerRange(
  citation: GroundedEvidenceCitation,
  marker: ParsedInlineCitation,
): GroundedEvidenceCitation {
  const requested = marker.lineRange;
  const available = citation.lineRange;
  if (
    requested === undefined ||
    (available !== undefined &&
      (available.startLine > requested.startLine || available.endLine < requested.endLine))
  ) {
    return citation;
  }
  return { ...citation, lineRange: requested };
}

function projectedCitationKey(citation: GroundedEvidenceCitation): string {
  const range = citation.lineRange;
  return range === undefined
    ? `${citation.stableId}:*`
    : `${citation.stableId}:${String(range.startLine)}-${String(range.endLine)}`;
}

export function buildAnswerCitations(
  pack: ConnectedContextPack,
  answerContent: string,
  redact: CitationRedactor,
): readonly GroundedEvidenceCitation[] {
  const available = buildPackCitations(pack, redact);
  const selected: GroundedEvidenceCitation[] = [];
  const seen = new Set<string>();
  for (const marker of parseInlineCitations(answerContent)) {
    const citation = bestCitationFor(marker, available);
    if (citation === undefined) continue;
    const projected = citationAtAnswerRange(citation, marker);
    const key = projectedCitationKey(projected);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(projected);
  }
  return selected;
}
