// Renders a grounded repository-aware assistant answer (Issue #185). Pure presentation:
// content + a citation row + uncertainty markers + omitted count. The component is wire-shape
// agnostic — it consumes `GroundedAnswer` from @oscharko-dev/keiko-contracts/bff-wire via the
// UI's lib/types re-export. Click handlers on citation buttons are intentional no-ops in this
// PR; a future change wires them to the Files-window preview at the cited line range.

import type { ReactNode } from "react";
import type { GroundedAnswer, GroundedEvidenceCitation, GroundedUncertainty } from "@/lib/types";

interface GroundedAnswerProps {
  readonly answer: GroundedAnswer | undefined;
  readonly busy: boolean;
}

function formatRange(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) {
    return citation.scopePath;
  }
  return `${citation.scopePath}:${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function citationAriaLabel(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) {
    return `Open citation for ${citation.scopePath}`;
  }
  return `Open citation for ${citation.scopePath} at lines ${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function CitationButton({ citation }: { readonly citation: GroundedEvidenceCitation }): ReactNode {
  return (
    <button
      type="button"
      className="grounded-citation"
      aria-label={citationAriaLabel(citation)}
      onClick={() => {
        // Intentional no-op — future PR wires this to the Files window preview.
      }}
    >
      <span>{formatRange(citation)}</span>
      <span className="grounded-citation-score">{citation.score.toFixed(2)}</span>
    </button>
  );
}

function CitationList({
  citations,
}: {
  readonly citations: readonly GroundedEvidenceCitation[];
}): ReactNode {
  if (citations.length === 0) return null;
  return (
    <div className="grounded-citations" role="list" aria-label="Evidence citations">
      <span className="grounded-citations-label">Evidence</span>
      {citations.map((citation) => (
        <span key={citation.stableId} role="listitem">
          <CitationButton citation={citation} />
        </span>
      ))}
    </div>
  );
}

function UncertaintyLine({
  markers,
}: {
  readonly markers: readonly GroundedUncertainty[];
}): ReactNode {
  if (markers.length === 0) return null;
  const kinds = Array.from(new Set(markers.map((m) => m.kind))).join(", ");
  return (
    <div className="grounded-uncertainty" role="note">
      {`(${String(markers.length)} markers — ${kinds})`}
    </div>
  );
}

function OmittedLine({ omittedCount }: { readonly omittedCount: number }): ReactNode {
  if (omittedCount <= 0) return null;
  return <div className="grounded-meta">{`Omitted: ${String(omittedCount)} evidence atoms`}</div>;
}

export function GroundedAnswer({ answer, busy }: GroundedAnswerProps): ReactNode {
  if (answer === undefined) {
    return busy ? <div className="grounded-meta">Asking Keiko (grounded)…</div> : null;
  }
  return (
    <div className="grounded-answer">
      <div className="grounded-answer-body">{answer.content}</div>
      <CitationList citations={answer.citations} />
      <UncertaintyLine markers={answer.uncertainty} />
      <OmittedLine omittedCount={answer.omittedCount} />
    </div>
  );
}
