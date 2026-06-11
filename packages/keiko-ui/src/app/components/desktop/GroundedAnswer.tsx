"use client";

// Renders a grounded repository-aware assistant answer (Issue #185). Mostly presentation:
// content + a citation row + uncertainty markers + omitted count, plus a local disclosure
// state for long citation lists (uiux-fix F012 C091). The component is wire-shape
// agnostic — it consumes `GroundedAnswer` from @oscharko-dev/keiko-contracts/bff-wire via the
// UI's lib/types re-export. Citations are static evidence references until a future change wires
// them to the Files-window preview at the cited line range.

import { useState } from "react";
import type { ReactNode } from "react";
import { formatBytes, formatMs } from "@/lib/format";
import type {
  GroundedAnswer,
  GroundedAnswerContextPackSummary,
  GroundedEvidenceCitation,
  GroundedUncertainty,
  HybridGroundedAnswerContextSummary,
  LocalKnowledgeEvidenceCitation,
  LocalKnowledgeGroundedAnswerContextSummary,
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

// Same "—" sentinel, but with a human-readable presenter (formatBytes/formatMs) for finite
// caps — the metric rows must not show raw byte/millisecond values (uiux-fix F012 C162;
// the CoverageNotice next to them already speaks in "2 MB").
function formatCapWith(value: number, format: (n: number) => string): string {
  return Number.isFinite(value) ? format(value) : "—";
}

// Thousands-separated counts for the token rows — five-/six-digit raw values like
// "32000" are hard to parse in the 11px mono column (uiux-fix F051 C318). Fixed
// en-US grouping keeps the output deterministic across runtimes.
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

// Internal enum tokens (e.g. "no-evidence", "natural-language", "capsule-set") are
// hyphen-joined pipeline vocabulary; render them as plain words for knowledge workers
// (uiux-fix F012 C160 — same humanizer the omission reasons already used).
function humanizeToken(value: string): string {
  return value.replaceAll("-", " ");
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
  return `${humanizeToken(summary.scopeKind)} (${idTail})`;
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
          value={`${String(usage.searchCalls)} / ${formatCap(budget.searchCallsMax)} searches`}
        />
        <MetricRow
          label="Read"
          value={`${String(usage.filesRead)} / ${formatCap(budget.filesReadMax)} files`}
        />
        <MetricRow
          label="Bytes"
          value={`${formatBytes(usage.excerptBytes)} / ${formatCapWith(budget.excerptBytesMax, formatBytes)}`}
        />
        <MetricRow
          label="Input"
          value={`${formatCount(usage.modelInputTokens)} / ${formatCapWith(budget.modelInputTokensMax, formatCount)} tokens`}
        />
        <MetricRow
          label="Output"
          value={`${formatCount(usage.modelOutputTokens)} / ${formatCapWith(budget.modelOutputTokensMax, formatCount)} tokens`}
        />
        <MetricRow
          label="Rerank"
          value={`${String(usage.rerankCalls)} / ${formatCap(budget.rerankCallsMax)} calls`}
        />
        <MetricRow
          label="Time"
          value={`${formatMs(contextPack.elapsedMs)} / ${formatCapWith(budget.elapsedMsMax, formatMs)}`}
        />
        <MetricRow label="Query" value={humanizeToken(contextPack.queryKind)} />
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
  // uiux-fix F051 C306 — the tooltip must explain the trailing decimal on the chip
  // (a retrieval relevance score), not just the source location.
  const relevance = `relevance ${citation.score.toFixed(2)}`;
  if (citation.lineRange === undefined) {
    return `Evidence citation in ${citation.scopePath} — ${relevance}`;
  }
  return `Evidence citation in ${citation.scopePath} at lines ${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)} — ${relevance}`;
}

// uiux-fix F051 C306 — the score was a naked decimal ("0.87") with no visual or accessible
// label. The sr-only prefix gives screen readers "relevance 0.87" instead of a bare number;
// sighted users get the explanation via the chip tooltip (citationTitle above / the LK title).
function CitationScore({ score }: { readonly score: number }): ReactNode {
  return (
    <span className="grounded-citation-score">
      <span className="sr-only">relevance </span>
      {score.toFixed(2)}
    </span>
  );
}

function CitationReference({
  citation,
}: {
  readonly citation: GroundedEvidenceCitation;
}): ReactNode {
  return (
    <span className="grounded-citation" title={citationTitle(citation)}>
      <span>{formatRange(citation)}</span>
      <CitationScore score={citation.score} />
    </span>
  );
}

// uiux-fix F012 C091 — a live 80-candidate run rendered an 80-chip "evidence wall" for a
// one-sentence answer. Cap the default view at the top-scored chips and put the rest behind
// an explicit disclosure so the actually-cited sources stay findable.
const CITATION_DISPLAY_CAP = 8;

function CitationDisclosureButton({
  total,
  expanded,
  onToggle,
}: {
  readonly total: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  if (total <= CITATION_DISPLAY_CAP) return null;
  return (
    <button
      type="button"
      className="grounded-citations-more"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? "Show fewer sources" : `Show all ${String(total)} sources`}
    </button>
  );
}

function CitationList({
  citations,
}: {
  readonly citations: readonly GroundedEvidenceCitation[];
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) return null;
  // Defensive re-sort: the wire delivers folder citations score-sorted already, but the cap
  // must never hide a stronger source behind a weaker one.
  const sorted = [...citations].sort((a, b) => b.score - a.score);
  const visible = expanded ? sorted : sorted.slice(0, CITATION_DISPLAY_CAP);
  // Copilot PR #258 finding: the prior "Evidence" label was a direct child of role="list"
  // which is invalid (only listitem children allowed). Lift the label OUT of the list and
  // use real <ul>/<li> elements.
  return (
    <div className="grounded-citations-wrap">
      <span className="grounded-citations-label">Evidence</span>
      <ul className="grounded-citations" aria-label="Evidence citations">
        {visible.map((citation) => (
          <li key={citation.stableId} className="grounded-citations-item">
            <CitationReference citation={citation} />
          </li>
        ))}
      </ul>
      <CitationDisclosureButton
        total={sorted.length}
        expanded={expanded}
        onToggle={() => {
          setExpanded((value) => !value);
        }}
      />
    </div>
  );
}

function LocalKnowledgeCitationList({
  citations,
}: {
  readonly citations: readonly LocalKnowledgeEvidenceCitation[];
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) return null;
  function labelForCitation(citation: LocalKnowledgeEvidenceCitation): string {
    return citation.source === undefined
      ? `${citation.marker} ${citation.label}`
      : `${citation.marker} ${citation.source} · ${citation.label}`;
  }
  // uiux-fix F012 C091 — same cap + disclosure as CitationList above.
  const sorted = [...citations].sort((a, b) => b.score - a.score);
  const visible = expanded ? sorted : sorted.slice(0, CITATION_DISPLAY_CAP);
  return (
    <div className="grounded-citations-wrap">
      <span className="grounded-citations-label">Knowledge citations</span>
      <ul className="grounded-citations" aria-label="Knowledge citations">
        {visible.map((citation) => (
          <li key={citation.stableId} className="grounded-citations-item">
            <span
              className="grounded-citation"
              title={
                // uiux-fix F051 C306 — explain the trailing decimal (relevance score)
                // in the tooltip, mirroring citationTitle above.
                citation.source === undefined
                  ? `${citation.label} — relevance ${citation.score.toFixed(2)}`
                  : `${citation.source} · ${citation.label} — relevance ${citation.score.toFixed(2)}`
              }
            >
              <span>{labelForCitation(citation)}</span>
              <CitationScore score={citation.score} />
            </span>
          </li>
        ))}
      </ul>
      <CitationDisclosureButton
        total={sorted.length}
        expanded={expanded}
        onToggle={() => {
          setExpanded((value) => !value);
        }}
      />
    </div>
  );
}

function UncertaintyLine({
  markers,
}: {
  readonly markers: readonly GroundedUncertainty[];
}): ReactNode {
  if (markers.length === 0) return null;
  // uiux-fix F012 C160 — marker kinds are internal enums ("no-evidence"); humanize them
  // like the omission reasons below.
  const kinds = Array.from(new Set(markers.map((m) => humanizeToken(m.kind)))).join(", ");
  return (
    <div className="grounded-uncertainty" role="note">
      <div>{`Uncertainty (${String(markers.length)} markers — ${kinds})`}</div>
      <ul className="grounded-uncertainty-list">
        {markers.map((marker, index) => (
          <li
            key={`${marker.kind}-${String(index)}`}
          >{`${humanizeToken(marker.kind)}: ${marker.claim}`}</li>
        ))}
      </ul>
    </div>
  );
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
    .map(([reason, count]) => `${humanizeToken(reason)}: ${String(count)}`)
    .join(", ");
  const suffix = reasonSummary.length > 0 ? ` (${reasonSummary})` : "";
  // uiux-fix F012 C161 — "evidence atoms" is pipeline vocabulary; knowledge workers read
  // "excerpts". The CoverageNotice above speaks about whole files; this line is the
  // excerpt-level account (it additionally counts relevance filtering).
  return (
    <div className="grounded-meta">
      {`Not used: ${String(omittedCount)} excerpt${omittedCount === 1 ? "" : "s"}${suffix}`}
    </div>
  );
}

// Reasons a file in the connected scope could not be searched AT ALL — distinct from relevance
// filtering (low-relevance / near-duplicate, where the file was read) and from by-design noise
// exclusions (ignored deps/secrets). Surfacing these makes clear the answer does not cover the
// whole folder: a file over the 2 MiB cap or a binary/unsupported format is otherwise invisible.
const COVERAGE_GAP_REASONS: ReadonlyArray<{
  readonly reason: keyof GroundedAnswerContextPackSummary["omittedCounts"];
  readonly label: string;
}> = [
  { reason: "size-exceeded", label: "larger than 2 MB" },
  { reason: "binary", label: "binary or an unsupported format" },
  { reason: "tool-unavailable", label: "unreadable" },
];

function CoverageNotice({
  omittedCounts,
}: {
  readonly omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"];
}): ReactNode {
  const gaps = COVERAGE_GAP_REASONS.map(({ reason, label }) => ({
    label,
    count: omittedCounts[reason],
  })).filter((gap) => gap.count > 0);
  const total = gaps.reduce((sum, gap) => sum + gap.count, 0);
  if (total <= 0) return null;
  const detail = gaps.map((gap) => `${String(gap.count)} ${gap.label}`).join(", ");
  const fileWord = total === 1 ? "file" : "files";
  const verb = total === 1 ? "was" : "were";
  return (
    <div className="grounded-coverage-notice" role="note">
      <span className="grounded-coverage-notice-title">Partial coverage</span>
      <span>
        {`This answer reflects only the searchable files in the connected scope — ${String(total)} ${fileWord} ${verb} not searched (${detail}). It does not cover the entire folder.`}
      </span>
    </div>
  );
}

function AuditEvidenceLink({
  runId,
  runIds,
}: {
  readonly runId: string | undefined;
  readonly runIds?: readonly string[] | undefined;
}): ReactNode {
  const ids = Array.from(new Set([...(runId === undefined ? [] : [runId]), ...(runIds ?? [])]));
  if (ids.length === 0) return null;
  // uiux-fix F012 C136/C164 — the endpoint returns a raw JSON manifest; same-tab navigation
  // replaced the whole workspace (windows, scroll position, live streams) with a JSON dump.
  // Open in a new tab and style with the app link pattern instead of UA defaults.
  return (
    <div className="grounded-meta">
      {ids.map((id, index) => (
        <a
          key={id}
          className="sm-link"
          href={`/api/evidence/${encodeURIComponent(id)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {ids.length === 1
            ? "View connected-context audit evidence"
            : `View connected-context audit evidence ${String(index + 1)}`}{" "}
          {/* WCAG 3.2.2 — notify screen-reader users that this link opens in a new tab */}
          <span className="sr-only">(opens in new tab)</span>
        </a>
      ))}
    </div>
  );
}

function LocalKnowledgeContextPackSummary({
  contextPack,
}: {
  readonly contextPack: LocalKnowledgeGroundedAnswerContextSummary;
}): ReactNode {
  return (
    <section className="grounded-context-pack" aria-label="Knowledge scope summary">
      <div className="grounded-context-pack-headline">{`Knowledge scope: ${contextPack.scopeLabel}`}</div>
      <dl className="grounded-context-pack-dl">
        <MetricRow label="Mode" value={humanizeToken(contextPack.scopeKind)} />
        <MetricRow label="Capsules" value={String(contextPack.capsuleCount)} />
        <MetricRow label="Sources" value={String(contextPack.sourceCount)} />
        <MetricRow label="Citations" value={String(contextPack.citationCount)} />
        <MetricRow
          label="Context budget"
          value={`${String(contextPack.referencesUsed)} / ${String(contextPack.referenceBudget)} references`}
        />
      </dl>
    </section>
  );
}

// Epic #189 Slice 3 M5 — hybrid context pack: folder + connector source summaries side-by-side.
function HybridContextPackSummary({
  contextPack,
}: {
  readonly contextPack: HybridGroundedAnswerContextSummary;
}): ReactNode {
  return (
    <section className="grounded-context-pack" aria-label="Hybrid source summary">
      <div className="grounded-context-pack-headline">
        {`Hybrid: ${String(contextPack.folderSourceCount)} folder source${contextPack.folderSourceCount === 1 ? "" : "s"} + ${String(contextPack.connectorSourceCount)} connector source${contextPack.connectorSourceCount === 1 ? "" : "s"}`}
      </div>
      <ContextPackSummary contextPack={contextPack.folder} />
      <LocalKnowledgeContextPackSummary contextPack={contextPack.knowledge} />
    </section>
  );
}

export function GroundedAnswer({ answer, busy }: GroundedAnswerProps): ReactNode {
  if (answer === undefined) {
    // uiux-fix F012 C163 — the panel also serves capsule/connector-only chats where no
    // repository is involved; keep the loading text source-neutral.
    return busy ? (
      <div className="grounded-meta">Searching connected sources and asking Keiko…</div>
    ) : null;
  }
  if (answer.groundingKind === "local-knowledge") {
    return (
      <div className="grounded-answer">
        <LocalKnowledgeCitationList citations={answer.citations} />
        <UncertaintyLine markers={answer.uncertainty} />
        <LocalKnowledgeContextPackSummary contextPack={answer.contextPack} />
      </div>
    );
  }
  // Epic #189 Slice 3 M5 — hybrid answer: merged content, folder citations, connector citations.
  if (answer.groundingKind === "hybrid") {
    return (
      <div className="grounded-answer">
        <CoverageNotice omittedCounts={answer.contextPack.folder.omittedCounts} />
        {/* Folder evidence (source-tagged) */}
        <CitationList citations={answer.citations} />
        {/* Connector evidence (source-tagged) */}
        <LocalKnowledgeCitationList citations={answer.knowledgeCitations} />
        <UncertaintyLine markers={answer.uncertainty} />
        <OmittedLine
          omittedCount={answer.omittedCount}
          omittedCounts={answer.contextPack.folder.omittedCounts}
        />
        <AuditEvidenceLink runId={answer.evidenceRunId} runIds={answer.evidenceRunIds} />
        <HybridContextPackSummary contextPack={answer.contextPack} />
      </div>
    );
  }
  return (
    <div className="grounded-answer">
      <CoverageNotice omittedCounts={answer.contextPack.omittedCounts} />
      <CitationList citations={answer.citations} />
      <UncertaintyLine markers={answer.uncertainty} />
      <OmittedLine
        omittedCount={answer.omittedCount}
        omittedCounts={answer.contextPack.omittedCounts}
      />
      <AuditEvidenceLink runId={answer.evidenceRunId} runIds={answer.evidenceRunIds} />
      <ContextPackSummary contextPack={answer.contextPack} />
    </div>
  );
}
