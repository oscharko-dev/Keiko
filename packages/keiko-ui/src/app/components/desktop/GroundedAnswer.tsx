// Renders a grounded repository-aware assistant answer (Issue #185). Pure presentation:
// content + a citation row + uncertainty markers + omitted count. The component is wire-shape
// agnostic — it consumes `GroundedAnswer` from @oscharko-dev/keiko-contracts/bff-wire via the
// UI's lib/types re-export. Citations are static evidence references until a future change wires
// them to the Files-window preview at the cited line range.

import type { ReactNode } from "react";
import type {
  GroundedAnswer,
  GroundedAnswerContextPackSummary,
  GroundedEvidenceCitation,
  GroundedUncertainty,
} from "@/lib/types";

interface GroundedAnswerProps {
  readonly answer: GroundedAnswer | undefined;
  readonly busy: boolean;
}

// Display "—" for Infinity / non-finite caps (the default budget uses Number.POSITIVE_INFINITY
// for unbounded dimensions like rerankCallsMax when the orchestrator is disabled).
function formatCap(value: number): string {
  return Number.isFinite(value) ? String(value) : "—";
}

function formatScopeLabel(summary: GroundedAnswerContextPackSummary): string {
  if (summary.scopeKind === "workspace-root") {
    return "workspace root";
  }
  // The opaque scopeId is BFF-internal (a sha256 prefix). Truncating to 8 hex chars keeps
  // it short enough to read but still distinguishable across binding sessions. The label
  // never carries the file count (Copilot PR #264 finding: "files (3 files)" double-prints
  // when the headline also prepends the count); the headline owns the count display.
  const idTail = summary.scopeId.slice(-8);
  return `${summary.scopeKind} (${idTail})`;
}

function MetricRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <>
      <dt className="grounded-context-pack-dt">{label}</dt>
      <dd className="grounded-context-pack-dd">{value}</dd>
    </>
  );
}

function ContextPackSummary({
  contextPack,
}: {
  readonly contextPack: GroundedAnswerContextPackSummary;
}): ReactNode {
  const { usage, budget } = contextPack;
  const scope = formatScopeLabel(contextPack);
  // workspace-root and directory scopes do not have an atomic file count: workspace-root is
  // unbounded (fileCount sentinel -1), directory scopes contain whatever files the planner
  // selected at search time, not a fixed count of "what was bound". Only the "files" scope
  // kind has a meaningful count to display (Copilot PR #264 — "1 file in directory" reads
  // as "this directory contains exactly one file" which it doesn't).
  const headline =
    contextPack.scopeKind === "files"
      ? `Scope: ${String(contextPack.fileCount)} file${contextPack.fileCount === 1 ? "" : "s"} in ${scope}`
      : `Scope: ${scope}`;
  return (
    <section className="grounded-context-pack" aria-label="Context inspection summary">
      <div className="grounded-context-pack-headline">{headline}</div>
      <dl className="grounded-context-pack-dl">
        <MetricRow
          label="Searched"
          value={`${String(usage.searchCalls)}× / ${formatCap(budget.searchCallsMax)}`}
        />
        <MetricRow
          label="Read"
          value={`${String(usage.filesRead)} / ${formatCap(budget.filesReadMax)} files`}
        />
        <MetricRow
          label="Bytes"
          value={`${String(usage.excerptBytes)} / ${formatCap(budget.excerptBytesMax)} B`}
        />
        <MetricRow
          label="Input"
          value={`${String(usage.modelInputTokens)} / ${formatCap(budget.modelInputTokensMax)} tokens`}
        />
        <MetricRow
          label="Output"
          value={`${String(usage.modelOutputTokens)} / ${formatCap(budget.modelOutputTokensMax)} tokens`}
        />
        <MetricRow
          label="Rerank"
          value={`${String(usage.rerankCalls)} / ${formatCap(budget.rerankCallsMax)} calls`}
        />
        <MetricRow
          label="Time"
          value={`${String(contextPack.elapsedMs)} / ${formatCap(budget.elapsedMsMax)} ms`}
        />
        <MetricRow label="Query" value={contextPack.queryKind} />
      </dl>
    </section>
  );
}

function formatRange(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) {
    return citation.scopePath;
  }
  return `${citation.scopePath}:${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function citationTitle(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) {
    return `Evidence citation in ${citation.scopePath}`;
  }
  return `Evidence citation in ${citation.scopePath} at lines ${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function CitationReference({
  citation,
}: {
  readonly citation: GroundedEvidenceCitation;
}): ReactNode {
  return (
    <span className="grounded-citation" title={citationTitle(citation)}>
      <span>{formatRange(citation)}</span>
      <span className="grounded-citation-score">{citation.score.toFixed(2)}</span>
    </span>
  );
}

function CitationList({
  citations,
}: {
  readonly citations: readonly GroundedEvidenceCitation[];
}): ReactNode {
  if (citations.length === 0) return null;
  // Copilot PR #258 finding: the prior "Evidence" label was a direct child of role="list"
  // which is invalid (only listitem children allowed). Lift the label OUT of the list and
  // use real <ul>/<li> elements.
  return (
    <div className="grounded-citations-wrap">
      <span className="grounded-citations-label">Evidence</span>
      <ul className="grounded-citations" aria-label="Evidence citations">
        {citations.map((citation) => (
          <li key={citation.stableId} className="grounded-citations-item">
            <CitationReference citation={citation} />
          </li>
        ))}
      </ul>
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
      <div>{`Uncertainty (${String(markers.length)} markers — ${kinds})`}</div>
      <ul className="grounded-uncertainty-list">
        {markers.map((marker, index) => (
          <li key={`${marker.kind}-${String(index)}`}>{`${marker.kind}: ${marker.claim}`}</li>
        ))}
      </ul>
    </div>
  );
}

function formatOmissionReason(reason: string): string {
  return reason.replaceAll("-", " ");
}

function OmittedLine({
  omittedCount,
  omittedCounts,
}: {
  readonly omittedCount: number;
  readonly omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"];
}): ReactNode {
  if (omittedCount <= 0) return null;
  const reasonSummary = Object.entries(omittedCounts)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, count]) => `${formatOmissionReason(reason)}: ${String(count)}`)
    .join(", ");
  const suffix = reasonSummary.length > 0 ? ` (${reasonSummary})` : "";
  return (
    <div className="grounded-meta">{`Omitted: ${String(omittedCount)} evidence atoms${suffix}`}</div>
  );
}

export function GroundedAnswer({ answer, busy }: GroundedAnswerProps): ReactNode {
  if (answer === undefined) {
    return busy ? (
      <div className="grounded-meta">Exploring repository context and asking Keiko…</div>
    ) : null;
  }
  return (
    <div className="grounded-answer">
      <div className="grounded-answer-body">{answer.content}</div>
      <CitationList citations={answer.citations} />
      <UncertaintyLine markers={answer.uncertainty} />
      <OmittedLine
        omittedCount={answer.omittedCount}
        omittedCounts={answer.contextPack.omittedCounts}
      />
      <ContextPackSummary contextPack={answer.contextPack} />
    </div>
  );
}
