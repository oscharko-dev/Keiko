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
import {
  RepositoryReferenceInline,
  type OpenRepositoryReference,
  type RepositoryReferenceRoot,
} from "./repositoryReferences";
import type {
  GroundedAnswer,
  GroundedAnswerContextPackSummary,
  GroundedAnswerRankingSummary,
  GroundedEvidenceCitation,
  GroundedRerankerDiagnostics,
  GroundedUncertainty,
  HybridGroundedAnswerContextSummary,
  LocalKnowledgeEvidenceCitation,
  LocalKnowledgeGroundedAnswerContextSummary,
} from "@/lib/types";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";

interface GroundedAnswerProps {
  readonly answer: GroundedAnswer | undefined;
  readonly busy: boolean;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
  readonly citationPreview?: CitationPreviewController | undefined;
}

type ConnectedGroundedAnswer = Extract<
  GroundedAnswer,
  { readonly groundingKind: "connected-context" }
>;
type HybridGroundedAnswer = Extract<GroundedAnswer, { readonly groundingKind: "hybrid" }>;
type KnowledgeGroundedAnswer = Extract<
  GroundedAnswer,
  { readonly groundingKind: "local-knowledge" }
>;

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
export function humanizeToken(value: string): string {
  return value.replaceAll("-", " ");
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return value === 1 ? singular : plural;
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

export function MetricRow({
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

// Path-free explainable-ranking panel (enterprise retrieval M2). Renders ONLY the bucket and
// ecosystem aggregate counts the BFF summary carries — no file paths, scores, or per-file signals
// (those live solely in the regulated audit evidence). Collapsed by default so it never disrupts
// the answer layout; absent entirely when the answer carries no ranking summary.
function RankingRationale({
  summary,
}: {
  readonly summary: GroundedAnswerRankingSummary;
}): ReactNode {
  const buckets = Object.entries(summary.bucketCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1));
  if (buckets.length === 0) {
    return null;
  }
  return (
    <details className="grounded-ranking-rationale">
      <summary aria-label="Why these files were selected">Why these files?</summary>
      <dl className="grounded-context-pack-dl">
        {buckets.map(([bucket, count]) => (
          <MetricRow
            key={`bucket-${bucket}`}
            label={humanizeToken(bucket)}
            value={formatCount(count)}
          />
        ))}
      </dl>
      {summary.ecosystems.length > 0 ? (
        <p className="grounded-ranking-ecosystems">
          {`Ecosystems: ${summary.ecosystems.map((eco) => `${eco.id} (${formatCount(eco.count)})`).join(", ")}`}
        </p>
      ) : null}
    </details>
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
      {contextPack.rankingSummary !== undefined ? (
        <RankingRationale summary={contextPack.rankingSummary} />
      ) : null}
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
  // Issue #1285 — a document citation references extracted document text, not source lines; make
  // that explicit so the line span is not read as an on-screen line number.
  const kind =
    citation.documentFormat === undefined
      ? "Evidence citation"
      : `${citation.documentFormat.toUpperCase()} document evidence (extracted text)`;
  if (citation.lineRange === undefined) {
    return `${kind} in ${citation.scopePath} — ${relevance}`;
  }
  const span =
    citation.documentFormat === undefined
      ? `at lines ${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`
      : `at extracted span ${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
  return `${kind} in ${citation.scopePath} ${span} — ${relevance}`;
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
  repositoryRoots,
  openRepositoryReference,
}: {
  readonly citation: GroundedEvidenceCitation;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
}): ReactNode {
  const documentFormat = citation.documentFormat?.toUpperCase();
  const canOpenRepositoryCitation =
    documentFormat === undefined &&
    openRepositoryReference !== undefined &&
    repositoryRoots.length > 0;
  return (
    <span className="grounded-citation" title={citationTitle(citation)}>
      {documentFormat === undefined ? null : (
        <>
          <span className="grounded-citation-doc-badge">{documentFormat}</span>
          <span className="sr-only"> document evidence extracted text </span>
        </>
      )}
      <span className="grounded-citation-range">
        {canOpenRepositoryCitation ? (
          <RepositoryReferenceInline
            reference={{
              label: formatRange(citation),
              path: citation.scopePath,
              ...(citation.lineRange === undefined
                ? {}
                : {
                    lineStart: citation.lineRange.startLine,
                    lineEnd: citation.lineRange.endLine,
                  }),
            }}
            roots={repositoryRoots}
            openReference={openRepositoryReference}
            className="repo-ref-link grounded-citation-open"
          />
        ) : (
          formatRange(citation)
        )}
      </span>
      <CitationScore score={citation.score} />
    </span>
  );
}

// uiux-fix F012 C091 — a live 80-candidate run rendered an 80-chip "evidence wall" for a
// one-sentence answer. Cap the default view at the top-scored chips and put the rest behind
// an explicit disclosure so the strongest cited evidence references stay findable.
const CITATION_DISPLAY_CAP = 8;

function uniqueByStableId<T extends { readonly stableId: string }>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    if (seen.has(item.stableId)) continue;
    seen.add(item.stableId);
    unique.push(item);
  }
  return unique;
}

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
      {expanded ? "Show fewer citations" : `Show all ${String(total)} citations`}
    </button>
  );
}

function CitationList({
  citations,
  repositoryRoots,
  openRepositoryReference,
}: {
  readonly citations: readonly GroundedEvidenceCitation[];
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) return null;
  // Defensive re-sort: the wire delivers folder citations score-sorted already, but the cap
  // must never hide a stronger citation behind a weaker one.
  const sorted = uniqueByStableId([...citations].sort((a, b) => b.score - a.score));
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
            <CitationReference
              citation={citation}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
            />
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

function uniqueCitationCount<T extends { readonly stableId: string }>(items: readonly T[]): number {
  return uniqueByStableId(items).length;
}

function connectedEvidenceSummary(answer: ConnectedGroundedAnswer): string {
  const citationCount = uniqueCitationCount(answer.citations);
  const filesRead = answer.contextPack.usage.filesRead;
  const filesMax = formatCap(answer.contextPack.budget.filesReadMax);
  const omittedCount = answer.contextPack.omittedCount;
  const citationLabel = pluralize(citationCount, "citation");
  const omitted = omittedCount > 0 ? ` · ${formatCount(omittedCount)} not used` : "";
  return `${formatCount(citationCount)} ${citationLabel} · ${formatCount(filesRead)} / ${filesMax} files read${omitted}`;
}

function knowledgeEvidenceSummary(answer: KnowledgeGroundedAnswer): string {
  const citationCount = uniqueCitationCount(answer.citations);
  const sourceLabel = pluralize(citationCount, "citation");
  return `${formatCount(citationCount)} ${sourceLabel} · ${formatCount(answer.contextPack.referencesUsed)} / ${formatCount(answer.contextPack.referenceBudget)} references`;
}

function hybridEvidenceSummary(answer: HybridGroundedAnswer): string {
  const fileCount = uniqueCitationCount(answer.citations);
  const knowledgeCount = uniqueCitationCount(answer.knowledgeCitations);
  return `${formatCount(fileCount)} file ${pluralize(fileCount, "citation")} · ${formatCount(knowledgeCount)} knowledge ${pluralize(knowledgeCount, "citation")}`;
}

function GroundedEvidenceDisclosure({
  title,
  summary,
  hasCoverageWarning = false,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly hasCoverageWarning?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details className="grounded-evidence-disclosure">
      <summary className="grounded-evidence-summary">
        <span className="grounded-evidence-summary-title">{title}</span>
        <span className="grounded-evidence-summary-meta">{summary}</span>
        {hasCoverageWarning ? (
          <span className="grounded-evidence-summary-badge">Partial coverage</span>
        ) : null}
      </summary>
      <div className="grounded-evidence-body">{children}</div>
    </details>
  );
}

function LocalKnowledgeCitationList({
  citations,
  citationPreview,
}: {
  readonly citations: readonly LocalKnowledgeEvidenceCitation[];
  readonly citationPreview: CitationPreviewController | undefined;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) return null;
  function labelForCitation(citation: LocalKnowledgeEvidenceCitation): string {
    return citation.source === undefined
      ? `${citation.marker} ${citation.label}`
      : `${citation.marker} ${citation.source} · ${citation.label}`;
  }
  // uiux-fix F012 C091 — same cap + disclosure as CitationList above.
  const sorted = uniqueByStableId([...citations].sort((a, b) => b.score - a.score));
  const visible = expanded ? sorted : sorted.slice(0, CITATION_DISPLAY_CAP);
  return (
    <div className="grounded-citations-wrap">
      <span className="grounded-citations-label">Knowledge citations</span>
      <ul className="grounded-citations" aria-label="Knowledge citations">
        {visible.map((citation) => (
          <li key={citation.stableId} className="grounded-citations-item">
            <KnowledgeCitationChip
              citation={citation}
              citationPreview={citationPreview}
              label={labelForCitation(citation)}
            />
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

function knowledgeCitationTitle(citation: LocalKnowledgeEvidenceCitation): string {
  return citation.source === undefined
    ? `${citation.label} — relevance ${citation.score.toFixed(2)}`
    : `${citation.source} · ${citation.label} — relevance ${citation.score.toFixed(2)}`;
}

function KnowledgeCitationChip({
  citation,
  citationPreview,
  label,
}: {
  readonly citation: LocalKnowledgeEvidenceCitation;
  readonly citationPreview: CitationPreviewController | undefined;
  readonly label: string;
}): ReactNode {
  const affordance = citationPreview?.forCitation(citation);
  if (affordance === undefined) {
    return (
      <span className="grounded-citation" title={knowledgeCitationTitle(citation)}>
        <span className="grounded-citation-range">{label}</span>
        <CitationScore score={citation.score} />
      </span>
    );
  }

  const blocked = affordance.state === "blocked";
  const opening = citationPreview?.isOpening(citation) ?? false;
  const actionLabel =
    affordance.state === "recoverable"
      ? "Recover PDF"
      : affordance.state === "blocked"
        ? "PDF unavailable"
        : "Open PDF";
  const actionTitle =
    affordance.state === "recoverable"
      ? "Open PDF recovery"
      : affordance.state === "blocked"
        ? "PDF preview unavailable"
        : "Open PDF preview";

  return (
    <button
      type="button"
      className={`grounded-citation grounded-citation-action grounded-citation-action--${affordance.state}`}
      aria-disabled={blocked || opening ? "true" : undefined}
      aria-label={`${label} · ${actionLabel}`}
      data-tip={actionTitle}
      title={`${knowledgeCitationTitle(citation)} · ${actionLabel}`}
      onClick={() => {
        if (blocked || opening || citationPreview === undefined) return;
        void citationPreview.openCitation(citation, "citation-chip");
      }}
    >
      <span className="grounded-citation-range">{label}</span>
      <span className="grounded-citation-action-label">{actionLabel}</span>
      <CitationScore score={citation.score} />
    </button>
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
  // Bounded small-document extraction diagnostics (Issue #1285).
  { reason: "unsupported-format", label: "an unsupported document format" },
  { reason: "no-text-layer", label: "a scanned document with no text layer" },
  { reason: "malformed-document", label: "a malformed document" },
  { reason: "encrypted-document", label: "a password-protected document" },
];
// Repository Search now extracts bounded text from small DOCX/XLSX/text-layer-PDF documents
// (Issue #1285); larger, scanned, encrypted, or other document formats stay on the Local Knowledge
// path. Shown whenever a connected document or binary file was skipped.
const REPOSITORY_DOCUMENT_NOTICE =
  "Repository Search reads text, code, and small DOCX, XLSX, and text-layer PDF documents. Larger, scanned, encrypted, or other document formats remain available through Local Knowledge.";

function CoverageNotice({
  omittedCounts,
}: {
  readonly omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"];
}): ReactNode {
  const gaps = COVERAGE_GAP_REASONS.map(({ reason, label }) => ({
    label,
    count: omittedCounts[reason] ?? 0,
  })).filter((gap) => gap.count > 0);
  const total = gaps.reduce((sum, gap) => sum + gap.count, 0);
  if (total <= 0) return null;
  const detail = gaps.map((gap) => `${String(gap.count)} ${gap.label}`).join(", ");
  const fileWord = total === 1 ? "file" : "files";
  const verb = total === 1 ? "was" : "were";
  const showDocumentNotice =
    (omittedCounts.binary ?? 0) > 0 ||
    (omittedCounts["unsupported-format"] ?? 0) > 0 ||
    (omittedCounts["no-text-layer"] ?? 0) > 0 ||
    (omittedCounts["malformed-document"] ?? 0) > 0 ||
    (omittedCounts["encrypted-document"] ?? 0) > 0;
  return (
    <div className="grounded-coverage-notice" role="note">
      <span className="grounded-coverage-notice-title">Partial coverage</span>
      <span>
        {`This answer reflects only the searchable files in the connected scope — ${String(total)} ${fileWord} ${verb} not searched (${detail}). It does not cover the entire folder.`}
      </span>
      {showDocumentNotice ? <span>{REPOSITORY_DOCUMENT_NOTICE}</span> : null}
    </div>
  );
}

function hasCoverageWarning(
  omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"],
): boolean {
  return COVERAGE_GAP_REASONS.some(({ reason }) => omittedCounts[reason] > 0);
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
        <MetricRow label="Knowledge Pods" value={String(contextPack.capsuleCount)} />
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

// Epic #189 Slice 3 M5 — hybrid context pack: folder + Knowledge Pod sources side-by-side.
function HybridContextPackSummary({
  contextPack,
}: {
  readonly contextPack: HybridGroundedAnswerContextSummary;
}): ReactNode {
  return (
    <section className="grounded-context-pack" aria-label="Hybrid source summary">
      <div className="grounded-context-pack-headline">
        {`Hybrid: ${String(contextPack.folderSourceCount)} folder source${contextPack.folderSourceCount === 1 ? "" : "s"} + ${String(contextPack.connectorSourceCount)} Knowledge Pod source${contextPack.connectorSourceCount === 1 ? "" : "s"}`}
      </div>
      <ContextPackSummary contextPack={contextPack.folder} />
      <LocalKnowledgeContextPackSummary contextPack={contextPack.knowledge} />
    </section>
  );
}

// GEN-AI-RETRIEVAL-001 (RB-4): the model reranker silently degraded to fallback (RRF/lexical) order.
const DEGRADED_RERANKER_STATUSES: ReadonlySet<string> = new Set([
  "unavailable",
  "invalid-response",
  "not-configured",
]);

function rerankerDegradationNote(
  reranker: GroundedRerankerDiagnostics | undefined,
): string | undefined {
  if (reranker === undefined || !DEGRADED_RERANKER_STATUSES.has(reranker.status)) {
    return undefined;
  }
  return "Ranking: reranker unavailable — showing fallback (lexical) order.";
}

// GEN-AI-GROUNDING-007 (RB-4): compute the SUMMARY-LEVEL warnings that must be visible without
// expanding the evidence disclosure — abstention, unsupported (fabricated) citations, a truncated
// answer, and silent reranker degradation. Returns [] when the answer is fully grounded.
function groundedSummaryWarnings(answer: GroundedAnswer): readonly string[] {
  const warnings: string[] = [];
  const markers = answer.uncertainty;
  const noEvidence =
    markers.some((m) => m.kind === "no-evidence") ||
    (answer.groundingKind === "local-knowledge" && answer.noEvidence);
  if (noEvidence) {
    warnings.push("No supporting evidence was found — this answer is not grounded.");
  }
  const unsupported = markers.filter((m) => m.kind === "unsupported-citation").length;
  if (unsupported > 0) {
    warnings.push(
      `${String(unsupported)} unsupported citation${unsupported === 1 ? "" : "s"} — the answer ` +
        `references sources that were not in the retrieved evidence.`,
    );
  }
  if (markers.some((m) => m.kind === "incomplete-answer")) {
    warnings.push("The answer was cut off before completion and may be partial.");
  }
  const reranker =
    answer.groundingKind === "local-knowledge" || answer.groundingKind === "hybrid"
      ? answer.contextPack.reranker
      : undefined;
  const rerankNote = rerankerDegradationNote(reranker);
  if (rerankNote !== undefined) {
    warnings.push(rerankNote);
  }
  return warnings;
}

// A visible, non-collapsed banner so uncertainty/degradation is never hidden behind the disclosure
// (GEN-AI-GROUNDING-007 / GEN-AI-RETRIEVAL-001). Reuses existing grounded CSS classes so it does not
// touch the SHA-pinned globals.css surface.
function GroundedAnswerWarnings({ answer }: { readonly answer: GroundedAnswer }): ReactNode {
  const warnings = groundedSummaryWarnings(answer);
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div className="grounded-uncertainty" role="alert">
      <div>
        <span className="grounded-evidence-summary-badge">Needs review</span>
      </div>
      <ul className="grounded-uncertainty-list">
        {warnings.map((warning, index) => (
          <li key={`grounded-warning-${String(index)}`}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

export function GroundedAnswer({
  answer,
  busy,
  repositoryRoots = [],
  openRepositoryReference,
  citationPreview,
}: GroundedAnswerProps): ReactNode {
  if (answer === undefined) {
    // uiux-fix F012 C163 — the panel also serves capsule/connector-only chats where no
    // repository is involved; keep the loading text source-neutral.
    return busy ? (
      <div className="grounded-meta" role="status" aria-live="polite" aria-busy="true">
        Searching connected sources and asking Keiko…
      </div>
    ) : null;
  }
  if (answer.groundingKind === "local-knowledge") {
    return (
      <div className="grounded-answer">
        <GroundedAnswerWarnings answer={answer} />
        <GroundedEvidenceDisclosure
          title="Knowledge evidence"
          summary={knowledgeEvidenceSummary(answer)}
        >
          <LocalKnowledgeCitationList
            citations={answer.citations}
            citationPreview={citationPreview}
          />
          <UncertaintyLine markers={answer.uncertainty} />
          <LocalKnowledgeContextPackSummary contextPack={answer.contextPack} />
        </GroundedEvidenceDisclosure>
      </div>
    );
  }
  // Epic #189 Slice 3 M5 — hybrid answer: merged content, folder citations, Knowledge Pod citations.
  if (answer.groundingKind === "hybrid") {
    return (
      <div className="grounded-answer">
        <GroundedAnswerWarnings answer={answer} />
        <GroundedEvidenceDisclosure
          title="Grounding evidence"
          summary={hybridEvidenceSummary(answer)}
          hasCoverageWarning={hasCoverageWarning(answer.contextPack.folder.omittedCounts)}
        >
          <CoverageNotice omittedCounts={answer.contextPack.folder.omittedCounts} />
          {/* Folder evidence (source-tagged) */}
          <CitationList
            citations={answer.citations}
            repositoryRoots={repositoryRoots}
            openRepositoryReference={openRepositoryReference}
          />
          {/* Knowledge Pod evidence (source-tagged) */}
          <LocalKnowledgeCitationList
            citations={answer.knowledgeCitations}
            citationPreview={citationPreview}
          />
          <UncertaintyLine markers={answer.uncertainty} />
          <OmittedLine
            omittedCount={answer.omittedCount}
            omittedCounts={answer.contextPack.folder.omittedCounts}
          />
          <AuditEvidenceLink runId={answer.evidenceRunId} runIds={answer.evidenceRunIds} />
          <HybridContextPackSummary contextPack={answer.contextPack} />
        </GroundedEvidenceDisclosure>
      </div>
    );
  }
  return (
    <div className="grounded-answer">
      <GroundedAnswerWarnings answer={answer} />
      <GroundedEvidenceDisclosure
        title="Evidence"
        summary={connectedEvidenceSummary(answer)}
        hasCoverageWarning={hasCoverageWarning(answer.contextPack.omittedCounts)}
      >
        <CoverageNotice omittedCounts={answer.contextPack.omittedCounts} />
        <CitationList
          citations={answer.citations}
          repositoryRoots={repositoryRoots}
          openRepositoryReference={openRepositoryReference}
        />
        <UncertaintyLine markers={answer.uncertainty} />
        <OmittedLine
          omittedCount={answer.contextPack.omittedCount}
          omittedCounts={answer.contextPack.omittedCounts}
        />
        <AuditEvidenceLink runId={answer.evidenceRunId} runIds={answer.evidenceRunIds} />
        <ContextPackSummary contextPack={answer.contextPack} />
      </GroundedEvidenceDisclosure>
    </div>
  );
}
