"use client";

// Renders a grounded repository-aware assistant answer (Issue #185). Mostly presentation:
// content + a citation row + uncertainty markers + omitted count, plus a local disclosure
// state for long citation lists (uiux-fix F012 C091). The component is wire-shape
// agnostic — it consumes `GroundedAnswer` from @oscharko-dev/keiko-contracts/bff-wire via the
// UI's lib/types re-export. Citations are static evidence references until a future change wires
// them to the Files-window preview at the cited line range.

import { useState } from "react";
import type { ReactNode } from "react";
import {
  citationFindingTotal,
  citationMarkerIndices,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { isCanonicalConnectedSearchAbstention } from "@oscharko-dev/keiko-contracts/runtime/no-evidence-answer";
import { formatBytes, formatMs } from "@/lib/format";
import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";
import type { OptionalWidgetMessageKey as MessageKey } from "@/lib/i18n-messages.optional.en";
import {
  RepositoryReferenceInline,
  repositoryReferencePathLabels,
  type OpenRepositoryReference,
  type RepositoryReferenceRoot,
  type RepositoryReference,
} from "./repositoryReferences";
import type {
  GroundedAnswer,
  GroundedAnswerContextPackSummary,
  GroundedAnswerRankingSummary,
  GroundedEvidenceCitation,
  GroundedRerankerDiagnostics,
  GroundedUncertainty,
  HtmlManualCitationOpenUnavailableReason,
  HybridGroundedAnswerContextSummary,
  HtmlManualCitationMetadata,
  KnowledgePodRetrievalActivity,
  KnowledgePodRetrievalActivityReasonCode,
  KnowledgePodRetrievalActivityState,
  LocalKnowledgeEvidenceCitation,
  LocalKnowledgeGroundedAnswerContextSummary,
} from "@/lib/types";
import type { CitationPreviewController } from "./hooks/usePdfCitationPreview";
import activityBadgeStyles from "./GroundedAnswer.module.css";

// Opens the citation's target in the existing governed documentation browser widget (ADR-0113) so
// that widget's own navigateDocumentation call renders the authoritative reason/severity outcome —
// the chip never re-implements that classification. Returns whether a window was actually opened.
type OpenDocumentationTarget = (target: string) => boolean;

interface GroundedAnswerProps {
  readonly answer: GroundedAnswer | undefined;
  readonly busy: boolean;
  readonly repositoryRoots?: readonly RepositoryReferenceRoot[] | undefined;
  readonly openRepositoryReference?: OpenRepositoryReference | undefined;
  readonly citationPreview?: CitationPreviewController | undefined;
  readonly openDocumentationTarget?: OpenDocumentationTarget | undefined;
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
function formatCapWith(value: number | null, format: (n: number) => string): string {
  if (value === null) return "∞";
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

function localKnowledgeScopeKindLabel(
  scopeKind: LocalKnowledgeGroundedAnswerContextSummary["scopeKind"],
): string {
  return scopeKind === "capsule-set" ? "Knowledge Pod Set" : "Knowledge Pod";
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return value === 1 ? singular : plural;
}

function formatEcosystemEntry(eco: { readonly id: string; readonly count: number }): string {
  return `${eco.id} (${formatCount(eco.count)})`;
}

function formatScopeLabel(summary: GroundedAnswerContextPackSummary, t: I18nTranslate): string {
  if (summary.scopeKind === "workspace-root") {
    return t("grounded.inspection.scopeFolder");
  }
  // The opaque scopeId is BFF-internal (a sha256 prefix). Truncating to 8 hex chars keeps
  // it short enough to read but still distinguishable across binding sessions. The label
  // never carries the file count (Copilot PR #264 finding: "files (3 files)" double-prints
  // when the headline also prepends the count); the headline owns the count display.
  const idTail = summary.scopeId.slice(-8);
  const kind = t(
    summary.scopeKind === "directory"
      ? "grounded.inspection.scopeDirectory"
      : "grounded.inspection.scopeFileList",
  );
  return `${kind} (${idTail})`;
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

// Descending by count; ties break ascending alphabetically by bucket name.
function compareBucketEntries(a: readonly [string, number], b: readonly [string, number]): number {
  if (b[1] !== a[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : 1;
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
  const t = useTranslate();
  const buckets = Object.entries(summary.bucketCounts)
    .filter(([, count]) => count > 0)
    .sort(compareBucketEntries);
  if (buckets.length === 0) {
    return null;
  }
  return (
    <details className="grounded-ranking-rationale">
      <summary aria-label={t("grounded.inspection.rankingAria")}>
        {t("grounded.inspection.rankingTitle")}
      </summary>
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
          {t("grounded.inspection.ecosystems", {
            entries: summary.ecosystems.map(formatEcosystemEntry).join(", "),
          })}
        </p>
      ) : null}
    </details>
  );
}

// workspace-root and directory scopes do not have an atomic file count: workspace-root is
// unbounded (fileCount sentinel -1), directory scopes contain whatever files the planner
// selected at search time, not a fixed count of "what was bound". Only the "files" scope
// kind has a meaningful count to display (Copilot PR #264 — "1 file in directory" reads
// as "this directory contains exactly one file" which it doesn't).
const QUERY_KIND_LABELS: Readonly<
  Record<GroundedAnswerContextPackSummary["queryKind"], MessageKey>
> = {
  "natural-language": "grounded.inspection.queryNatural",
  "exact-symbol": "grounded.inspection.querySymbol",
  "file-pattern": "grounded.inspection.queryFiles",
  regex: "grounded.inspection.queryRegex",
};

function contextPackHeadline(
  contextPack: GroundedAnswerContextPackSummary,
  t: I18nTranslate,
): string {
  const scope = formatScopeLabel(contextPack, t);
  return t(
    contextPack.scopeKind === "files"
      ? contextPack.fileCount === 1
        ? "grounded.inspection.scopeFile"
        : "grounded.inspection.scopeFiles"
      : "grounded.inspection.scope",
    {
      scope,
      count: contextPack.fileCount,
    },
  );
}

type InspectionMetric = readonly [string, string];
type SearchCoverage = GroundedAnswerContextPackSummary["coverage"];

function hasOnlyOmittedMatches(coverage: NonNullable<SearchCoverage>): boolean {
  return (
    coverage.reasons.length === 1 &&
    coverage.reasons[0] === "match-cap" &&
    coverage.filesScanned === coverage.filesAfterPolicy &&
    coverage.filesSkipped === 0 &&
    coverage.depthPrunedByDiscovery === 0 &&
    coverage.maxFilesPrunedByDiscovery === 0
  );
}

function selectedReadCount(pack: GroundedAnswerContextPackSummary, t: I18nTranslate): string {
  return pack.budget.filesReadMax === null
    ? t("grounded.inspection.fileCountUncapped", { used: formatCount(pack.usage.filesRead) })
    : inspectionCount(
        t,
        "grounded.inspection.fileCount",
        pack.usage.filesRead,
        pack.budget.filesReadMax,
      );
}

function inspectionCount(t: I18nTranslate, key: MessageKey, used: number, max: number): string {
  return t(key, { used: formatCount(used), max: formatCapWith(max, formatCount) });
}

function inspectionCoverageMetrics(
  pack: GroundedAnswerContextPackSummary,
  t: I18nTranslate,
): readonly InspectionMetric[] {
  const coverage = pack.coverage;
  if (coverage === undefined) return [];
  return [
    [
      t("grounded.inspection.recursive"),
      inspectionCount(
        t,
        "grounded.inspection.scopeFileCount",
        coverage.filesScanned,
        coverage.filesDiscovered,
      ),
    ],
    [
      t("grounded.inspection.coverage"),
      t(
        hasOnlyOmittedMatches(coverage)
          ? "grounded.inspection.resultsLimited"
          : coverage.incomplete
            ? "grounded.inspection.incomplete"
            : "grounded.inspection.complete",
      ),
    ],
  ];
}

function inspectionReadMetrics(
  pack: GroundedAnswerContextPackSummary,
  t: I18nTranslate,
): readonly InspectionMetric[] {
  const { usage, budget } = pack;
  return [
    [
      t("grounded.inspection.searches"),
      inspectionCount(
        t,
        "grounded.inspection.searchCount",
        usage.searchCalls,
        budget.searchCallsMax,
      ),
    ],
    [t("grounded.inspection.selectedReads"), selectedReadCount(pack, t)],
    [
      t("grounded.inspection.excerptBytes"),
      `${formatBytes(usage.excerptBytes)} / ${formatCapWith(budget.excerptBytesMax, formatBytes)}`,
    ],
    [
      t("grounded.inspection.rerank"),
      inspectionCount(t, "grounded.inspection.callCount", usage.rerankCalls, budget.rerankCallsMax),
    ],
  ];
}

function inspectionModelMetrics(
  { usage, budget }: GroundedAnswerContextPackSummary,
  t: I18nTranslate,
): readonly InspectionMetric[] {
  return [
    [
      t("grounded.inspection.input"),
      inspectionCount(
        t,
        "grounded.inspection.tokenCount",
        usage.modelInputTokens,
        budget.modelInputTokensMax,
      ),
    ],
    [
      t("grounded.inspection.output"),
      inspectionCount(
        t,
        "grounded.inspection.tokenCount",
        usage.modelOutputTokens,
        budget.modelOutputTokensMax,
      ),
    ],
  ];
}

function inspectionTimeMetrics(
  pack: GroundedAnswerContextPackSummary,
  t: I18nTranslate,
): readonly InspectionMetric[] {
  return [
    [t("grounded.inspection.duration"), formatMs(pack.elapsedMs)],
    [
      t("grounded.inspection.timeLimit"),
      pack.budget.elapsedMsMax === null
        ? t("grounded.inspection.noTimeLimit")
        : formatCapWith(pack.budget.elapsedMsMax, formatMs),
    ],
    [t("grounded.inspection.query"), t(QUERY_KIND_LABELS[pack.queryKind])],
  ];
}

function inspectionMetrics(
  pack: GroundedAnswerContextPackSummary,
  t: I18nTranslate,
): readonly InspectionMetric[] {
  return [
    ...inspectionCoverageMetrics(pack, t),
    ...inspectionReadMetrics(pack, t),
    ...inspectionModelMetrics(pack, t),
    ...inspectionTimeMetrics(pack, t),
  ];
}

function SearchCoverageDetail({ coverage }: { readonly coverage: SearchCoverage }): ReactNode {
  const t = useTranslate();
  const detail = searchCoverageDetail(coverage, t);
  return detail === undefined ? null : <p className="grounded-meta">{detail}</p>;
}

function ContextPackSummary({
  contextPack,
}: {
  readonly contextPack: GroundedAnswerContextPackSummary;
}): ReactNode {
  const t = useTranslate();
  return (
    <section className="grounded-context-pack" aria-label={t("grounded.inspection.aria")}>
      <div className="grounded-context-pack-headline">{contextPackHeadline(contextPack, t)}</div>
      <dl className="grounded-context-pack-dl">
        {inspectionMetrics(contextPack, t).map(([label, value]) => (
          <MetricRow key={label} label={label} value={value} />
        ))}
      </dl>
      {contextPack.coverage === undefined ? null : (
        <p className="grounded-meta">{t("grounded.inspection.scopeCountHint")}</p>
      )}
      <SearchCoverageDetail coverage={contextPack.coverage} />
      <p className="grounded-meta">
        {contextPack.budget.filesReadMax === null
          ? t("grounded.inspection.readHintUncapped")
          : t("grounded.inspection.readHint", { max: formatCap(contextPack.budget.filesReadMax) })}
      </p>
      <p className="grounded-meta">{t("grounded.inspection.timeHint")}</p>
      <p className="grounded-meta">{t("grounded.inspection.modelBudgetHint")}</p>
      {contextPack.rankingSummary === undefined ? null : (
        <RankingRationale summary={contextPack.rankingSummary} />
      )}
    </section>
  );
}

function formatRange(citation: GroundedEvidenceCitation): string {
  if (citation.lineRange === undefined) {
    return citation.scopePath;
  }
  return `${citation.scopePath}:${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function citationTitle(citation: GroundedEvidenceCitation, t: I18nTranslate): string {
  const kind =
    citation.documentFormat === undefined
      ? t("grounded.citation.evidence")
      : t("grounded.citation.documentEvidence", { format: citation.documentFormat.toUpperCase() });
  const span =
    citation.lineRange === undefined
      ? ""
      : t(
          citation.documentFormat === undefined
            ? "grounded.citation.lines"
            : "grounded.citation.extractedSpan",
          {
            start: citation.lineRange.startLine,
            end: citation.lineRange.endLine,
          },
        );
  return t("grounded.citation.title", {
    kind,
    path: citation.scopePath,
    span,
  });
}

function citationRepositoryReference(citation: GroundedEvidenceCitation): RepositoryReference {
  return {
    label: formatRange(citation),
    path: citation.scopePath,
    ...(citation.lineRange === undefined
      ? {}
      : {
          lineStart: citation.lineRange.startLine,
          lineEnd: citation.lineRange.endLine,
        }),
  };
}

function attributedCitationLabel(label: string, sourceLabel: string | undefined): string {
  return sourceLabel === undefined ? label : `${sourceLabel} · ${label}`;
}

function CitationReference({
  citation,
  repositoryRoots,
  openRepositoryReference,
  displayPath,
  sourceLabel,
}: {
  readonly citation: GroundedEvidenceCitation;
  readonly repositoryRoots: readonly RepositoryReferenceRoot[];
  readonly openRepositoryReference: OpenRepositoryReference | undefined;
  readonly displayPath: string;
  readonly sourceLabel: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const documentFormat = citation.documentFormat?.toUpperCase();
  const canOpenRepositoryCitation =
    documentFormat === undefined &&
    openRepositoryReference !== undefined &&
    repositoryRoots.length > 0;
  return (
    <span className="grounded-citation" title={citationTitle(citation, t)}>
      {documentFormat === undefined ? null : (
        <>
          <span className="grounded-citation-doc-badge">{documentFormat}</span>
          <span className="sr-only"> document evidence extracted text </span>
        </>
      )}
      <span className="grounded-citation-range">
        {canOpenRepositoryCitation ? (
          <RepositoryReferenceInline
            reference={citationRepositoryReference(citation)}
            roots={repositoryRoots}
            openReference={openRepositoryReference}
            className="repo-ref-link grounded-citation-open"
            displayPath={attributedCitationLabel(displayPath, sourceLabel)}
          />
        ) : (
          attributedCitationLabel(formatRange(citation), sourceLabel)
        )}
      </span>
    </span>
  );
}

// uiux-fix F012 C091 — a live 80-candidate run rendered an 80-chip "evidence wall" for a
// one-sentence answer. Cap the default view at the top-scored chips and put the rest behind
// an explicit disclosure so the strongest cited evidence references stay findable.
const CITATION_DISPLAY_CAP = 8;
const ACTIVITY_POD_DISPLAY_CAP = 8;

interface CitationIdentityInput {
  readonly stableId: string;
  readonly lineRange?: { readonly startLine: number; readonly endLine: number } | undefined;
}

function citationIdentity(citation: CitationIdentityInput): string {
  return JSON.stringify([
    citation.stableId,
    citation.lineRange?.startLine ?? null,
    citation.lineRange?.endLine ?? null,
  ]);
}

function uniqueByCitationIdentity<T extends CitationIdentityInput>(
  items: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const identity = citationIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
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
  const t = useTranslate();
  if (total <= CITATION_DISPLAY_CAP) return null;
  return (
    <button
      type="button"
      className="grounded-citations-more"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? t("grounded.citations.showFewer")
        : t("grounded.citations.showAll", { count: total })}
    </button>
  );
}

function ActivityDisclosureButton({
  total,
  expanded,
  onToggle,
}: {
  readonly total: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  if (total <= ACTIVITY_POD_DISPLAY_CAP) return null;
  return (
    <button
      type="button"
      className="grounded-citations-more"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? "Show fewer Knowledge Pods" : `Show all ${String(total)} Knowledge Pods`}
    </button>
  );
}

function attributedCitationCollisions(
  citations: readonly GroundedEvidenceCitation[],
): ReadonlySet<string> {
  const sources = new Map<string, Set<string | undefined>>();
  for (const citation of citations) {
    const group = sources.get(citation.scopePath) ?? new Set<string | undefined>();
    group.add(citation.source);
    sources.set(citation.scopePath, group);
  }
  return new Set([...sources].filter(([, group]) => group.size > 1).map(([path]) => path));
}

function citationSourceLabel(
  citation: GroundedEvidenceCitation,
  collisions: ReadonlySet<string>,
): string | undefined {
  return collisions.has(citation.scopePath) && citation.source !== undefined
    ? stripUnsafeFormatChars(citation.source)
    : undefined;
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
  const t = useTranslate();
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) return null;
  // Defensive re-sort: the wire delivers folder citations score-sorted already, but the cap
  // must never hide a stronger citation behind a weaker one.
  const sorted = uniqueByCitationIdentity([...citations].sort((a, b) => b.score - a.score));
  const labels = repositoryReferencePathLabels(sorted.map((citation) => citation.scopePath));
  const collisions = attributedCitationCollisions(sorted);
  const visible = expanded ? sorted : sorted.slice(0, CITATION_DISPLAY_CAP);
  // Copilot PR #258 finding: the prior "Evidence" label was a direct child of role="list"
  // which is invalid (only listitem children allowed). Lift the label OUT of the list and
  // use real <ul>/<li> elements.
  return (
    <div className="grounded-citations-wrap">
      <span className="grounded-citations-label">{t("grounded.title.evidence")}</span>
      <ul className="grounded-citations" aria-label={t("grounded.citations.evidenceAria")}>
        {visible.map((citation) => (
          <li key={citationIdentity(citation)} className="grounded-citations-item">
            <CitationReference
              citation={citation}
              repositoryRoots={repositoryRoots}
              openRepositoryReference={openRepositoryReference}
              displayPath={labels.get(citation.scopePath) ?? citation.scopePath}
              sourceLabel={citationSourceLabel(citation, collisions)}
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

function uniqueCitationCount<T extends CitationIdentityInput>(items: readonly T[]): number {
  return uniqueByCitationIdentity(items).length;
}

function citationCountLabel(
  t: I18nTranslate,
  count: number,
  keys: { readonly one: MessageKey; readonly other: MessageKey },
  values: Readonly<Record<string, string | number>> = {},
): string {
  return t(count === 1 ? keys.one : keys.other, { ...values, count: formatCount(count) });
}

function connectedEvidenceSummary(answer: ConnectedGroundedAnswer, t: I18nTranslate): string {
  const citationCount = uniqueCitationCount(answer.citations);
  const omittedCount = answer.contextPack.omittedCount;
  return citationCountLabel(
    t,
    citationCount,
    answer.contextPack.budget.filesReadMax === null
      ? {
          one: "grounded.summary.connected.uncapped.one",
          other: "grounded.summary.connected.uncapped.other",
        }
      : { one: "grounded.summary.connected.one", other: "grounded.summary.connected.other" },
    {
      read: formatCount(answer.contextPack.usage.filesRead),
      max:
        answer.contextPack.budget.filesReadMax === null
          ? ""
          : formatCap(answer.contextPack.budget.filesReadMax),
      omitted:
        omittedCount > 0 ? t("grounded.summary.notUsed", { count: formatCount(omittedCount) }) : "",
    },
  );
}

function knowledgeEvidenceSummary(answer: KnowledgeGroundedAnswer, t: I18nTranslate): string {
  return citationCountLabel(
    t,
    uniqueCitationCount(answer.citations),
    { one: "grounded.summary.knowledge.one", other: "grounded.summary.knowledge.other" },
    {
      used: formatCount(answer.contextPack.referencesUsed),
      budget: formatCount(answer.contextPack.referenceBudget),
    },
  );
}

function hybridEvidenceSummary(answer: HybridGroundedAnswer, t: I18nTranslate): string {
  const files = citationCountLabel(t, uniqueCitationCount(answer.citations), {
    one: "grounded.summary.hybrid.file.one",
    other: "grounded.summary.hybrid.file.other",
  });
  const knowledge = citationCountLabel(t, uniqueCitationCount(answer.knowledgeCitations), {
    one: "grounded.summary.hybrid.knowledge.one",
    other: "grounded.summary.hybrid.knowledge.other",
  });
  return `${files} · ${knowledge}`;
}

const ACTIVITY_STATE_LABELS: Record<KnowledgePodRetrievalActivityState, string> = {
  searched: "Searched",
  skipped: "Skipped",
  degraded: "Degraded",
  denied: "Denied",
  unavailable: "Unavailable",
  "not-selected": "Not selected",
};

const ACTIVITY_REASON_LABELS: Record<KnowledgePodRetrievalActivityReasonCode, string> = {
  "selected-for-search": "selected for search",
  searched: "searched",
  "not-selected": "not selected",
  "source-skipped": "source skipped",
  "scope-not-ready": "scope not ready",
  "indexing-in-progress": "indexing in progress",
  "stale-capsule": "stale pod",
  "retrieval-failure": "retrieval failure",
  "no-scope": "no scope",
  "no-vectors": "no vectors",
  "incompatible-embedding-identity": "embedding model mismatch",
  "dense-scan-too-large": "vector scan too large",
  "below-min-score": "below minimum score",
  "answer-grounding-rejected": "grounding rejected",
  "no-evidence-stated": "no evidence stated",
  "no-evidence": "no evidence",
  "empty-query": "empty query",
  "empty-answer": "empty answer",
  "embedding-failed": "embedding failed",
  "embedding-unavailable": "embedding unavailable",
  "reranker-unavailable": "reranker unavailable",
  "reranker-invalid-response": "reranker invalid response",
  "policy-denied": "policy denied",
  "capability-missing": "capability missing",
  "remote-unavailable": "remote unavailable",
  "pack-validation-failed": "pack validation failed",
  "max-sources-exceeded": "source limit exceeded",
};

type RetrievalActivityPod = KnowledgePodRetrievalActivity["pods"][number];

function activityPodLine(pod: RetrievalActivityPod): string {
  const referenceLabel = pluralize(pod.counts.referenceCount, "reference");
  const citationLabel = pluralize(pod.counts.citationCount, "citation");
  return `${pod.displayName} · ${formatCount(pod.counts.referenceCount)} ${referenceLabel} · ${formatCount(pod.counts.citationCount)} ${citationLabel}`;
}

function activityReasons(pod: RetrievalActivityPod): string {
  return pod.reasonCodes.map((reason) => ACTIVITY_REASON_LABELS[reason]).join(", ");
}

function activityModes(pod: RetrievalActivityPod): string {
  return pod.modes.map(humanizeToken).join(", ");
}

function KnowledgePodRetrievalActivityPanel({
  activity,
}: {
  readonly activity: KnowledgePodRetrievalActivity | undefined;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (activity === undefined || activity.pods.length === 0) return null;
  const { summary } = activity;
  const visiblePods = expanded ? activity.pods : activity.pods.slice(0, ACTIVITY_POD_DISPLAY_CAP);
  return (
    <section
      className={`grounded-context-pack ${activityBadgeStyles.scope}`}
      aria-label="Knowledge Pod retrieval activity"
    >
      <div className="grounded-context-pack-headline">Knowledge Pod activity</div>
      <dl className="grounded-context-pack-dl">
        <MetricRow label="Searched" value={formatCount(summary.searchedCount)} />
        <MetricRow label="Skipped" value={formatCount(summary.skippedCount)} />
        <MetricRow label="Degraded" value={formatCount(summary.degradedCount)} />
        <MetricRow label="Denied" value={formatCount(summary.deniedCount)} />
        <MetricRow label="Unavailable" value={formatCount(summary.unavailableCount)} />
        <MetricRow label="Not selected" value={formatCount(summary.notSelectedCount)} />
        <MetricRow
          label="Candidates"
          value={`${formatCount(summary.denseCandidateCount)} vector · ${formatCount(summary.lexicalCandidateCount)} lexical · ${formatCount(summary.fusedCandidateCount)} fused`}
        />
        <MetricRow
          label="Evidence"
          value={`${formatCount(summary.referenceCount)} ${pluralize(summary.referenceCount, "reference")} · ${formatCount(summary.citationCount)} ${pluralize(summary.citationCount, "citation")}`}
        />
      </dl>
      <ul
        className={`grounded-uncertainty-list ${activityBadgeStyles.activityList}`}
        aria-label="Knowledge Pod activity details"
      >
        {visiblePods.map((pod) => (
          <li key={`${pod.podKind}-${pod.podId}`} className={activityBadgeStyles.activityListItem}>
            <span className="grounded-evidence-summary-badge" data-activity-state={pod.state}>
              {ACTIVITY_STATE_LABELS[pod.state]}
            </span>{" "}
            {activityPodLine(pod)}
            {" · "}
            <span className={`grounded-meta ${activityBadgeStyles.activityMeta}`}>
              {`Modes: ${activityModes(pod)} · Reasons: ${activityReasons(pod)}`}
            </span>
          </li>
        ))}
      </ul>
      <ActivityDisclosureButton
        total={activity.pods.length}
        expanded={expanded}
        onToggle={() => {
          setExpanded((value) => !value);
        }}
      />
    </section>
  );
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
  const t = useTranslate();
  return (
    <details className="grounded-evidence-disclosure">
      <summary className="grounded-evidence-summary">
        <span className="grounded-evidence-summary-title">{title}</span>
        <span className="grounded-evidence-summary-meta">{summary}</span>
        {hasCoverageWarning ? (
          <span className="grounded-evidence-summary-badge">{t("grounded.partialCoverage")}</span>
        ) : null}
      </summary>
      <div className="grounded-evidence-body">{children}</div>
    </details>
  );
}

// PR #3678 review: a citation whose claim shares little wording with its excerpt stays linked, but
// while no entailment judge verified the answer (its `entailment-unavailable` caveat) the chip says
// the support is unverified, so the reader knows WHICH source the caveat is about.
function supportUnverified(markers: readonly GroundedUncertainty[]): boolean {
  return markers.some((marker) => marker.kind === "entailment-unavailable");
}

// A chip whose aria-label replaces its content names the unverified support in that label too, so a
// screen reader hears it on the HTML-manual and PDF-preview chips as well (PR #3678 review).
function useSupportAwareLabel(label: string, unverified: boolean): string {
  const t = useTranslate();
  return unverified ? `${label} · ${t("grounded.citation.unverified")}` : label;
}

function UnverifiedSupportBadge(): ReactNode {
  const t = useTranslate();
  return (
    <span className={activityBadgeStyles.cmpCitationUnverified}>
      {t("grounded.citation.unverified")}
    </span>
  );
}

function knowledgeCitationLabel(citation: LocalKnowledgeEvidenceCitation): string {
  if (citation.htmlManual !== undefined) {
    return manualCitationLabel(citation);
  }
  return citation.source === undefined
    ? `${citation.marker} ${citation.label}`
    : `${citation.marker} ${citation.source} · ${citation.label}`;
}

function LocalKnowledgeCitationList({
  citations,
  citationPreview,
  openDocumentationTarget,
  unverifiedSupport = false,
}: {
  readonly citations: readonly LocalKnowledgeEvidenceCitation[];
  readonly citationPreview: CitationPreviewController | undefined;
  readonly openDocumentationTarget: OpenDocumentationTarget | undefined;
  readonly unverifiedSupport?: boolean;
}): ReactNode {
  const t = useTranslate();
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) return null;
  // uiux-fix F012 C091 — same cap + disclosure as CitationList above.
  const sorted = uniqueByCitationIdentity([...citations].sort((a, b) => b.score - a.score));
  const visible = expanded ? sorted : sorted.slice(0, CITATION_DISPLAY_CAP);
  return (
    <div className="grounded-citations-wrap">
      <span className="grounded-citations-label">{t("grounded.citations.knowledge")}</span>
      <ul className="grounded-citations" aria-label={t("grounded.citations.knowledge")}>
        {visible.map((citation) => (
          <li
            key={citationIdentity(citation)}
            className={`grounded-citations-item ${activityBadgeStyles.citationListItem}`}
          >
            <KnowledgeCitationChip
              citation={citation}
              citationPreview={citationPreview}
              label={knowledgeCitationLabel(citation)}
              openDocumentationTarget={openDocumentationTarget}
              unverified={unverifiedSupport && citation.lexicalSupport === "weak"}
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
  if (citation.htmlManual !== undefined) {
    const section = citation.htmlManual.sectionPath?.join(" · ");
    const suffix = section === undefined ? "" : ` · ${section}`;
    return `${citation.htmlManual.pageTitle}${suffix} — HTML manual evidence`;
  }
  return citation.source === undefined ? citation.label : `${citation.source} · ${citation.label}`;
}

function manualCitationLabel(citation: LocalKnowledgeEvidenceCitation): string {
  const manual = citation.htmlManual;
  if (manual === undefined) return `${citation.marker} ${citation.label}`;
  const source = citation.source === undefined ? "HTML manual" : `${citation.source} · HTML manual`;
  const section = manual.sectionPath?.join(" · ");
  const sectionSuffix = section === undefined || section.length === 0 ? "" : ` · ${section}`;
  return `${citation.marker} ${source} · ${manual.pageTitle}${sectionSuffix}`;
}

// Curated, short copy for every governed reason a manual citation cannot be reopened — mirrors the
// tone of DocumentationBrowserWidget's REASON_COPY without exposing the raw wire enum token.
const MANUAL_UNAVAILABLE_REASON_COPY: Readonly<
  Record<HtmlManualCitationOpenUnavailableReason, string>
> = {
  "source-metadata-unavailable": "Source unavailable",
  "citation-lineage-mismatch": "Citation mismatch",
  "target-outside-approved-scope": "Outside approved scope",
  "target-unsupported": "Unsupported target",
  "target-credentialed": "Requires sign-in",
  "target-unavailable": "Target unavailable",
};

function manualCitationActionLabel(manual: HtmlManualCitationMetadata): string {
  if (manual.open.state === "available") return "Open manual";
  if (manual.open.state === "page-level-only") return "Open page";
  return MANUAL_UNAVAILABLE_REASON_COPY[manual.open.reason];
}

function manualCitationChipActionLabel(
  state: "idle" | "opened" | "failed",
  manual: HtmlManualCitationMetadata,
): string {
  let label: string;
  if (state === "opened") {
    label = "Opened";
  } else if (state === "failed") {
    label = "Open failed";
  } else {
    label = manualCitationActionLabel(manual);
  }
  return label;
}

function ManualCitationChip({
  citation,
  label,
  openDocumentationTarget,
  unverified = false,
}: {
  readonly citation: LocalKnowledgeEvidenceCitation;
  readonly label: string;
  readonly openDocumentationTarget: OpenDocumentationTarget | undefined;
  readonly unverified?: boolean;
}): ReactNode {
  const manual = citation.htmlManual;
  const [state, setState] = useState<"idle" | "opened" | "failed">("idle");
  const accessibleLabel = useSupportAwareLabel(label, unverified);
  if (manual === undefined) return null;
  const unavailable = manual.open.state === "unavailable";
  const actionLabel = manualCitationChipActionLabel(state, manual);
  const target = manual.open.state === "unavailable" ? undefined : manual.open.target;
  const modifier = unavailable || state === "failed" ? " grounded-citation-action--blocked" : "";
  return (
    <button
      type="button"
      className={`grounded-citation grounded-citation-action ${activityBadgeStyles.manualCitationAction}${modifier}`}
      aria-disabled={unavailable ? "true" : undefined}
      aria-label={`${accessibleLabel} · ${actionLabel}`}
      title={`${knowledgeCitationTitle(citation)} · ${actionLabel}`}
      onClick={() => {
        if (target === undefined || unavailable || openDocumentationTarget === undefined) return;
        // Opens the existing governed documentation browser widget (ADR-0113) with this target; the
        // widget itself calls navigateDocumentation and renders the authoritative reason/severity —
        // this chip never re-implements or discards that classification.
        setState(openDocumentationTarget(target) ? "opened" : "failed");
      }}
    >
      <span className={`grounded-citation-range ${activityBadgeStyles.manualCitationRange}`}>
        {label}
      </span>
      {unverified ? <UnverifiedSupportBadge /> : null}
      <span className="grounded-citation-action-label" aria-live="polite">
        {actionLabel}
      </span>
    </button>
  );
}

function pdfPreviewActionText(state: string): {
  readonly actionLabel: string;
  readonly actionTitle: string;
} {
  if (state === "recoverable")
    return { actionLabel: "Recover PDF", actionTitle: "Open PDF recovery" };
  if (state === "blocked") {
    return { actionLabel: "PDF unavailable", actionTitle: "PDF preview unavailable" };
  }
  return { actionLabel: "Open PDF", actionTitle: "Open PDF preview" };
}

function KnowledgeCitationChip({
  citation,
  citationPreview,
  label,
  openDocumentationTarget,
  unverified,
}: {
  readonly citation: LocalKnowledgeEvidenceCitation;
  readonly citationPreview: CitationPreviewController | undefined;
  readonly label: string;
  readonly openDocumentationTarget: OpenDocumentationTarget | undefined;
  readonly unverified: boolean;
}): ReactNode {
  const accessibleLabel = useSupportAwareLabel(label, unverified);
  if (citation.htmlManual !== undefined) {
    return (
      <ManualCitationChip
        citation={citation}
        label={label}
        openDocumentationTarget={openDocumentationTarget}
        unverified={unverified}
      />
    );
  }
  const affordance = citationPreview?.forCitation(citation);
  if (affordance === undefined) {
    return (
      <span className="grounded-citation" title={knowledgeCitationTitle(citation)}>
        <span className="grounded-citation-range">{label}</span>
        {unverified ? <UnverifiedSupportBadge /> : null}
      </span>
    );
  }

  const blocked = affordance.state === "blocked";
  const opening = citationPreview?.isOpening(citation) ?? false;
  const { actionLabel, actionTitle } = pdfPreviewActionText(affordance.state);

  return (
    <button
      type="button"
      className={`grounded-citation grounded-citation-action grounded-citation-action--${affordance.state}`}
      aria-disabled={blocked || opening ? "true" : undefined}
      aria-label={`${accessibleLabel} · ${actionLabel}`}
      data-tip={actionTitle}
      title={`${knowledgeCitationTitle(citation)} · ${actionLabel}`}
      onClick={() => {
        if (blocked || opening || citationPreview === undefined) return;
        void citationPreview.openCitation(citation, "citation-chip");
      }}
    >
      <span className="grounded-citation-range">{label}</span>
      {unverified ? <UnverifiedSupportBadge /> : null}
      <span className="grounded-citation-action-label">{actionLabel}</span>
    </button>
  );
}

const UNCERTAINTY_KIND_LABEL_KEYS: ReadonlyMap<string, MessageKey> = new Map([
  ["no-evidence", "grounded.uncertainty.kind.noEvidence"],
  ["stale-evidence", "grounded.uncertainty.kind.staleEvidence"],
  ["scope-incomplete", "grounded.uncertainty.kind.scopeIncomplete"],
  ["budget-clipped", "grounded.uncertainty.kind.budgetClipped"],
  ["tool-unavailable", "grounded.uncertainty.kind.toolUnavailable"],
  ["low-confidence", "grounded.uncertainty.kind.lowConfidence"],
  ["unsupported-citation", "grounded.uncertainty.kind.unsupportedCitation"],
  ["uncited-answer", "grounded.uncertainty.kind.uncitedAnswer"],
  ["incomplete-answer", "grounded.uncertainty.kind.incompleteAnswer"],
  ["unsupported-claim", "grounded.uncertainty.kind.unsupportedClaim"],
  ["entailment-unavailable", "grounded.uncertainty.kind.entailmentUnavailable"],
]);

const RETRIEVAL_UNCERTAINTY_DETAIL_KEYS: ReadonlyMap<string, MessageKey> = new Map([
  ["no-evidence", "grounded.detail.noEvidence"],
  ["stale-evidence", "grounded.detail.staleEvidence"],
  ["scope-incomplete", "grounded.detail.scopeIncomplete"],
  ["budget-clipped", "grounded.detail.budgetClipped"],
  ["tool-unavailable", "grounded.detail.toolUnavailable"],
  ["low-confidence", "grounded.detail.lowConfidence"],
]);

// The kinds whose meaning is fixed by the kind alone: their line is the localised description, not
// the server's English claim text. Retrieval originals remain available in a separate disclosure.
const UNCERTAINTY_KIND_DETAIL_KEYS: ReadonlyMap<string, MessageKey> = new Map([
  ...RETRIEVAL_UNCERTAINTY_DETAIL_KEYS,
  ["unsupported-citation", "grounded.detail.unsupportedCitation"],
  ["uncited-answer", "grounded.detail.uncitedAnswer"],
  ["incomplete-answer", "grounded.detail.incomplete"],
  ["unsupported-claim", "grounded.detail.unsupportedClaim"],
  ["entailment-unavailable", "grounded.detail.entailmentUnavailable"],
]);

// uiux-fix F012 C160 — marker kinds are internal enums ("no-evidence"); show the localised label,
// and humanize an unknown kind like the omission reasons below.
function uncertaintyKindLabel(kind: string, t: I18nTranslate): string {
  const key = UNCERTAINTY_KIND_LABEL_KEYS.get(kind);
  return key === undefined ? humanizeToken(kind) : t(key);
}

function searchCoverageDetail(coverage: SearchCoverage, t: I18nTranslate): string | undefined {
  if (coverage?.reasons.includes("io-error") === true) return t("grounded.detail.scopeReadError");
  if (coverage !== undefined && hasOnlyOmittedMatches(coverage)) {
    return t("grounded.detail.scopeMatchesOmitted");
  }
  return undefined;
}

function uncertaintyLineText(marker: GroundedUncertainty, t: I18nTranslate): string {
  const detailKey = UNCERTAINTY_KIND_DETAIL_KEYS.get(marker.kind);
  if (detailKey === undefined) return marker.claim;
  const detail = t(detailKey);
  if (marker.kind !== "unsupported-citation") return detail;
  // Keep WHICH markers dangle: the indices are already visible in the answer text, so naming them
  // discloses nothing new and lets the reader find them.
  const named = citationMarkerIndices(marker.claim).map((index) => `[${String(index)}]`);
  // A marker that lists only part of its dangling indices says so instead of implying it is all.
  const unlisted = (citationFindingTotal(marker.claim) ?? named.length) > named.length;
  if (named.length === 0) return detail;
  return `${detail} ${named.join(", ")}${unlisted ? ", …" : ""}`;
}

function OriginalUncertaintyDetails({
  markers,
  t,
}: {
  readonly markers: readonly GroundedUncertainty[];
  readonly t: I18nTranslate;
}): ReactNode {
  const first = markers[0];
  if (first === undefined || !RETRIEVAL_UNCERTAINTY_DETAIL_KEYS.has(first.kind)) return null;
  return (
    <details>
      <summary>{t("grounded.uncertainty.original")}</summary>
      {markers.map((marker, index) => (
        <p key={index} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {marker.claim}
        </p>
      ))}
    </details>
  );
}

function uncertaintyDisplayGroups(
  markers: readonly GroundedUncertainty[],
): readonly (readonly GroundedUncertainty[])[] {
  const groups: GroundedUncertainty[][] = [];
  const retrievalGroups = new Map<string, GroundedUncertainty[]>();
  for (const marker of markers) {
    const existing = retrievalGroups.get(marker.kind);
    if (existing !== undefined) {
      existing.push(marker);
      continue;
    }
    const group = [marker];
    groups.push(group);
    if (RETRIEVAL_UNCERTAINTY_DETAIL_KEYS.has(marker.kind)) {
      retrievalGroups.set(marker.kind, group);
    }
  }
  return groups;
}

function UncertaintyItem({
  markers,
  t,
}: {
  readonly markers: readonly GroundedUncertainty[];
  readonly t: I18nTranslate;
}): ReactNode {
  const first = markers[0];
  if (first === undefined) return null;
  return (
    <li>
      <span>{`${uncertaintyKindLabel(first.kind, t)}: ${uncertaintyLineText(first, t)}`}</span>
      <OriginalUncertaintyDetails markers={markers} t={t} />
    </li>
  );
}

function UncertaintyLine({
  markers,
}: {
  readonly markers: readonly GroundedUncertainty[];
}): ReactNode {
  const t = useTranslate();
  if (markers.length === 0) return null;
  const kinds = Array.from(new Set(markers.map((m) => uncertaintyKindLabel(m.kind, t)))).join(", ");
  return (
    <div className="grounded-uncertainty" role="note">
      <div>{t("grounded.uncertainty.summary", { count: markers.length, kinds })}</div>
      <ul className="grounded-uncertainty-list">
        {uncertaintyDisplayGroups(markers).map((group, index) => (
          <UncertaintyItem key={index} markers={group} t={t} />
        ))}
      </ul>
    </div>
  );
}

function compareOmittedReasonEntries(
  a: readonly [string, number],
  b: readonly [string, number],
): number {
  const [reasonA] = a;
  const [reasonB] = b;
  return compareStrings(reasonA, reasonB);
}

const OMISSION_LABEL_KEYS: ReadonlyMap<string, MessageKey> = new Map([
  ["outside-scope", "grounded.omission.outside-scope"],
  ["binary", "grounded.omission.binary"],
  ["generated", "grounded.omission.generated"],
  ["ignored", "grounded.omission.ignored"],
  ["size-exceeded", "grounded.omission.size-exceeded"],
  ["near-duplicate", "grounded.omission.near-duplicate"],
  ["low-relevance", "grounded.omission.low-relevance"],
  ["redacted-only", "grounded.omission.redacted-only"],
  ["budget-exhausted", "grounded.omission.budget-exhausted"],
  ["tool-unavailable", "grounded.omission.tool-unavailable"],
  ["unsupported-format", "grounded.omission.unsupported-format"],
  ["no-text-layer", "grounded.omission.no-text-layer"],
  ["malformed-document", "grounded.omission.malformed-document"],
  ["encrypted-document", "grounded.omission.encrypted-document"],
]);

function omissionLabel(reason: string, t: I18nTranslate): string {
  const key = OMISSION_LABEL_KEYS.get(reason);
  return key === undefined ? humanizeToken(reason) : t(key);
}

function OmittedLine({
  omittedCount,
  omittedCounts,
}: {
  readonly omittedCount: number;
  readonly omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"];
}): ReactNode {
  const t = useTranslate();
  if (omittedCount <= 0) return null;
  const reasonSummary = Object.entries(omittedCounts)
    .filter(([, count]) => count > 0)
    .sort(compareOmittedReasonEntries)
    .map(([reason, count]) => `${omissionLabel(reason, t)}: ${String(count)}`)
    .join(", ");
  const suffix = reasonSummary.length > 0 ? ` (${reasonSummary})` : "";
  // Omission entries are unique file paths, not excerpt atoms. Keep the same unit as the wire.
  return (
    <div className="grounded-meta">
      {t("grounded.inspection.notUsed", { count: omittedCount, reasons: suffix })}
    </div>
  );
}

// Recorded omission paths are bounded evidence, not an exhaustive corpus exclusion census.
// Keep their reasons visible without inferring totals from discovery or scan counters.
const COVERAGE_GAP_REASONS: readonly (keyof GroundedAnswerContextPackSummary["omittedCounts"])[] = [
  "size-exceeded",
  "binary",
  "tool-unavailable",
  "unsupported-format",
  "no-text-layer",
  "malformed-document",
  "encrypted-document",
];

function CoverageNotice({
  omittedCounts,
}: {
  readonly omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"];
}): ReactNode {
  const t = useTranslate();
  const gaps = COVERAGE_GAP_REASONS.map((reason) => ({
    label: omissionLabel(reason, t),
    count: omittedCounts[reason] ?? 0,
  })).filter((gap) => gap.count > 0);
  const recordedCount = gaps.reduce((sum, gap) => sum + gap.count, 0);
  if (recordedCount <= 0) return null;
  const detail = gaps.map((gap) => `${formatCount(gap.count)} ${gap.label}`).join(", ");
  const showDocumentNotice = COVERAGE_GAP_REASONS.some(
    (reason) =>
      reason !== "size-exceeded" && reason !== "tool-unavailable" && omittedCounts[reason] > 0,
  );
  return (
    <div className="grounded-coverage-notice" role="note">
      <span className="grounded-coverage-notice-title">{t("grounded.partialCoverage")}</span>
      <span>
        {t(
          recordedCount === 1
            ? "grounded.inspection.coverageGap.one"
            : "grounded.inspection.coverageGap.other",
          { count: formatCount(recordedCount), detail },
        )}
      </span>
      {showDocumentNotice ? <span>{t("grounded.inspection.documentHint")}</span> : null}
    </div>
  );
}

function hasCoverageWarning(
  omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"],
): boolean {
  return COVERAGE_GAP_REASONS.some((reason) => omittedCounts[reason] > 0);
}

function AuditEvidenceLink({
  runId,
  runIds,
}: {
  readonly runId: string | undefined;
  readonly runIds?: readonly string[] | undefined;
}): ReactNode {
  const t = useTranslate();
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
            ? t("grounded.inspection.audit")
            : t("grounded.inspection.auditNumbered", { number: index + 1 })}{" "}
          {/* WCAG 3.2.2 — notify screen-reader users that this link opens in a new tab */}
          <span className="sr-only">{t("grounded.inspection.newTab")}</span>
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
        <MetricRow label="Mode" value={localKnowledgeScopeKindLabel(contextPack.scopeKind)} />
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

// GEN-AI-RETRIEVAL-001 (RB-4): the model reranker genuinely failed and silently degraded to the
// fallback retrieval order. A not-configured reranker is the default, fully-supported install
// state — not a failure — and must never raise this banner; it mirrors the backend's
// rerankerForRetrievalActivity suppressor in local-knowledge-grounded-qa.ts (Epic #1820 / #1922).
const DEGRADED_RERANKER_STATUSES: ReadonlySet<string> = new Set([
  "unavailable",
  "invalid-response",
]);

function rerankerDegradationNote(
  reranker: GroundedRerankerDiagnostics | undefined,
  t: I18nTranslate,
): string | undefined {
  if (reranker === undefined || reranker.failureKind === "not-configured") {
    return undefined;
  }
  if (!DEGRADED_RERANKER_STATUSES.has(reranker.status)) {
    return undefined;
  }
  return t("grounded.warning.rerankerUnavailable");
}

// The out-of-evidence citations the answer used. One server marker stands for EVERY dangling
// citation of the answer ("...evidence markers not present in the retrieved evidence: [7], [9]"),
// so counting marker objects reported "1 unsupported citation" for an answer with five bad markers.
// A marker that lists only part of its findings states their total (`citationFindingTotal`, PR
// #3678 review); otherwise its distinct named indices count, and a marker naming no numeric index
// (a `[path:line]` reference) counts as one.
function unsupportedCitationCount(markers: readonly GroundedUncertainty[]): number {
  const indices = new Set<number>();
  let counted = 0;
  for (const marker of markers) {
    if (marker.kind !== "unsupported-citation") continue;
    const total = citationFindingTotal(marker.claim);
    const named = citationMarkerIndices(marker.claim);
    if (total !== undefined) counted += total;
    else if (named.length === 0) counted += 1;
    else for (const index of named) indices.add(index);
  }
  return indices.size + counted;
}

// One `unsupported-claim` marker stands for every unentailed claim of the answer and states their
// total when there is more than one.
function unsupportedClaimCount(markers: readonly GroundedUncertainty[]): number {
  return markers
    .filter((marker) => marker.kind === "unsupported-claim")
    .reduce((sum, marker) => sum + (citationFindingTotal(marker.claim) ?? 1), 0);
}

function countedWarning(
  t: I18nTranslate,
  count: number,
  keys: { readonly one: MessageKey; readonly other: MessageKey },
  detail: MessageKey,
): string {
  return `${t(count === 1 ? keys.one : keys.other, { count: formatCount(count) })} — ${t(detail)}`;
}

// Citation-related summary warnings, each in its own kind: a fabricated citation
// (`unsupported-citation`), a claim its cited source does not support (`unsupported-claim`) and an
// answer that carries no citation at all (`uncited-answer`) are three different problems.
function citationWarnings(markers: readonly GroundedUncertainty[], t: I18nTranslate): string[] {
  const warnings: string[] = [];
  const unsupported = unsupportedCitationCount(markers);
  if (unsupported > 0) {
    warnings.push(
      countedWarning(
        t,
        unsupported,
        {
          one: "grounded.count.unsupportedCitation.one",
          other: "grounded.count.unsupportedCitation.other",
        },
        "grounded.detail.unsupportedCitation",
      ),
    );
  }
  if (markers.some((m) => m.kind === "uncited-answer")) {
    warnings.push(t("grounded.detail.uncitedAnswer"));
  }
  // Knowledge M1.2 (#2563): a citation that was in the pack but does not SUPPORT its claim.
  const unsupportedClaims = unsupportedClaimCount(markers);
  if (unsupportedClaims > 0) {
    warnings.push(
      countedWarning(
        t,
        unsupportedClaims,
        {
          one: "grounded.count.unsupportedClaim.one",
          other: "grounded.count.unsupportedClaim.other",
        },
        "grounded.detail.unsupportedClaim",
      ),
    );
  }
  return warnings;
}

// GEN-AI-GROUNDING-007 (RB-4): compute the SUMMARY-LEVEL warnings that must be visible without
// expanding the evidence disclosure — abstention, unsupported (fabricated) citations, uncited
// answers, a truncated answer, and silent reranker degradation. Returns [] when the answer is
// fully grounded. Every line is localised by marker KIND, never taken from the server's English
// claim text.
function groundedSummaryWarnings(answer: GroundedAnswer, t: I18nTranslate): readonly string[] {
  const warnings: string[] = [];
  const markers = answer.uncertainty;
  const noEvidence =
    markers.some((m) => m.kind === "no-evidence") ||
    (answer.groundingKind === "local-knowledge" && answer.noEvidence);
  if (noEvidence) {
    warnings.push(t("grounded.warning.noEvidence"));
  }
  warnings.push(...citationWarnings(markers, t));
  // Knowledge M1.2 (#2563): the entailment verification step could not run (fail-closed caveat).
  if (markers.some((m) => m.kind === "entailment-unavailable")) {
    warnings.push(t("grounded.detail.entailmentUnavailable"));
  }
  if (markers.some((m) => m.kind === "incomplete-answer")) {
    warnings.push(t("grounded.detail.incomplete"));
  }
  const reranker =
    answer.groundingKind === "local-knowledge" || answer.groundingKind === "hybrid"
      ? answer.contextPack.reranker
      : undefined;
  const rerankNote = rerankerDegradationNote(reranker, t);
  if (rerankNote !== undefined) {
    warnings.push(rerankNote);
  }
  return warnings;
}

// A visible, non-collapsed banner so uncertainty/degradation is never hidden behind the disclosure
// (GEN-AI-GROUNDING-007 / GEN-AI-RETRIEVAL-001). Reuses existing grounded CSS classes so it does not
// touch the SHA-pinned globals.css surface.
function isCanonicalEmptySearch(answer: ConnectedGroundedAnswer): boolean {
  return (
    isCanonicalConnectedSearchAbstention(answer.content) &&
    answer.citations.length === 0 &&
    answer.omittedCount === 0 &&
    answer.uncertainty.length > 0 &&
    answer.uncertainty.every((marker) => marker.kind === "no-evidence")
  );
}

function hasEmptyUninvokedSearchSummary(pack: GroundedAnswerContextPackSummary): boolean {
  return (
    pack.usage.filesRead === 0 &&
    pack.citationCount === 0 &&
    pack.omittedCount === 0 &&
    Object.values(pack.omittedCounts).every((count) => count === 0) &&
    pack.usage.modelInputTokens === 0 &&
    pack.usage.modelOutputTokens === 0
  );
}

function hasCompleteEligibleCoverage(
  coverage: NonNullable<GroundedAnswerContextPackSummary["coverage"]>,
): boolean {
  return (
    !coverage.incomplete &&
    !coverage.truncated &&
    coverage.reasons.length === 0 &&
    coverage.filesScanned === coverage.filesAfterPolicy &&
    coverage.filesSkipped === 0 &&
    coverage.depthPrunedByDiscovery === 0 &&
    coverage.maxFilesPrunedByDiscovery === 0
  );
}

function certifiedEmptySearchCoverage(
  answer: GroundedAnswer,
): GroundedAnswerContextPackSummary["coverage"] {
  if (answer.groundingKind !== "connected-context" || !isCanonicalEmptySearch(answer)) {
    return undefined;
  }
  const coverage = answer.contextPack.coverage;
  if (
    coverage === undefined ||
    coverage.matchesReturned !== 0 ||
    !hasEmptyUninvokedSearchSummary(answer.contextPack) ||
    !hasCompleteEligibleCoverage(coverage)
  ) {
    return undefined;
  }
  return coverage;
}

function GroundedAnswerWarnings({ answer }: { readonly answer: GroundedAnswer }): ReactNode {
  const t = useTranslate();
  const emptyCoverage = certifiedEmptySearchCoverage(answer);
  if (emptyCoverage !== undefined) {
    return (
      <div className="grounded-meta" role="status" aria-live="polite">
        <p>{t("grounded.search.empty")}</p>
        <p>
          {t("grounded.search.emptyCoverage", {
            scanned: formatCount(emptyCoverage.filesScanned),
            eligible: formatCount(emptyCoverage.filesAfterPolicy),
          })}
        </p>
      </div>
    );
  }
  const warnings = groundedSummaryWarnings(answer, t);
  if (warnings.length === 0) {
    return null;
  }
  return (
    <div className="grounded-uncertainty" role="alert">
      <div>
        <span className="grounded-evidence-summary-badge">{t("grounded.reviewBadge")}</span>
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
  openDocumentationTarget,
}: GroundedAnswerProps): ReactNode {
  const t = useTranslate();
  if (answer === undefined) {
    // uiux-fix F012 C163 — the panel also serves capsule/connector-only chats where no
    // repository is involved; keep the loading text source-neutral.
    return busy ? (
      <div className="grounded-meta" role="status" aria-live="polite" aria-busy="true">
        {t("grounded.loading")}
      </div>
    ) : null;
  }
  if (answer.groundingKind === "local-knowledge") {
    return (
      <div className="grounded-answer">
        <GroundedAnswerWarnings answer={answer} />
        <GroundedEvidenceDisclosure
          title={t("grounded.title.knowledge")}
          summary={knowledgeEvidenceSummary(answer, t)}
        >
          <LocalKnowledgeCitationList
            citations={answer.citations}
            citationPreview={citationPreview}
            openDocumentationTarget={openDocumentationTarget}
            unverifiedSupport={supportUnverified(answer.uncertainty)}
          />
          <KnowledgePodRetrievalActivityPanel activity={answer.retrievalActivity} />
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
          title={t("grounded.title.grounding")}
          summary={hybridEvidenceSummary(answer, t)}
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
            openDocumentationTarget={openDocumentationTarget}
            unverifiedSupport={supportUnverified(answer.uncertainty)}
          />
          <KnowledgePodRetrievalActivityPanel activity={answer.retrievalActivity} />
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
        title={t("grounded.title.evidence")}
        summary={connectedEvidenceSummary(answer, t)}
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
