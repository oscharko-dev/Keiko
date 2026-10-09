"use client";

// Renders a grounded repository-aware assistant answer (Issue #185). Mostly presentation:
// content + a citation row + uncertainty markers + omitted count, plus a local disclosure
// state for long citation lists (uiux-fix F012 C091). The component is wire-shape
// agnostic — it consumes `GroundedAnswer` from @oscharko-dev/keiko-contracts/bff-wire via the
// UI's lib/types re-export. Citations are static evidence references until a future change wires
// them to the Files-window preview at the cited line range.

import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  citationFindingTotal,
  citationMarkerIndices,
} from "@oscharko-dev/keiko-contracts/runtime/citation-markers";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import { stripUnsafeFormatChars } from "@oscharko-dev/keiko-contracts/text-safety";
import { isCanonicalConnectedSearchAbstention } from "@oscharko-dev/keiko-contracts/runtime/connected-search-abstention";
import { formatBytes, formatMs } from "@/lib/format";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
  type WidgetMessageKey as MessageKey,
} from "@/lib/optional-widget-i18n";
import { useLocale, type Locale, type MessageValues } from "@/lib/i18n";
import {
  RepositoryReferenceInline,
  citationRootOptions,
  repositoryReferencePathLabels,
  repositoryReferenceDisplayPath,
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
import {
  ConnectedEvidenceInspection,
  ConnectedRetrievalNotice,
  reportEvidenceInspection,
} from "./ConnectedEvidenceInspection";
import {
  connectedPromptEvidenceSummary,
  connectedOmissionTooltip,
  connectedOmissionLabel as omissionLabel,
} from "./connectedEvidencePresentation";

type I18nTranslate = OptionalWidgetTranslate & { readonly locale: Locale };

// Keep the selected locale alongside this component's private presentation translator.
function useTranslate(): I18nTranslate {
  const translate = useOptionalWidgetTranslate();
  const locale = useLocale();
  return useMemo(
    () =>
      Object.assign((key: MessageKey, values?: MessageValues): string => translate(key, values), {
        locale,
      }),
    [locale, translate],
  );
}

// Opens the citation's target in the existing governed documentation browser widget (ADR-0113) so
// that widget's own navigateDocumentation call renders the authoritative reason/severity outcome —
// the chip never re-implements that classification. Returns whether a window was actually opened.
type OpenDocumentationTarget = (target: string) => boolean;

interface GroundedAnswerProps {
  readonly answer: GroundedAnswer | undefined;
  readonly busy: boolean;
  readonly onReadPaths?:
    | ((runId: string, paths: readonly string[], sourceScopeFingerprint?: string) => void)
    | undefined;
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
function formatCap(value: number, locale: Locale): string {
  return Number.isFinite(value) ? formatCount(value, locale) : "—";
}

// Same "—" sentinel, but with a human-readable presenter (formatBytes/formatMs) for finite
// caps — the metric rows must not show raw byte/millisecond values (uiux-fix F012 C162;
// the CoverageNotice next to them already speaks in "2 MB").
function formatCapWith(value: number, format: (n: number) => string): string {
  return Number.isFinite(value) ? format(value) : "—";
}

// Thousands-separated counts for the token rows — five-/six-digit raw values like
// "32000" are hard to parse in the 11px mono column (uiux-fix F051 C318). The
// selected-locale grouping keeps the display consistent with the surrounding interface.
function formatCount(value: number, locale: Locale): string {
  return value.toLocaleString(locale);
}

// Internal enum tokens (e.g. "no-evidence", "natural-language", "capsule-set") are
// hyphen-joined pipeline vocabulary; render them as plain words for knowledge workers
// (uiux-fix F012 C160 — same humanizer the omission reasons already used).
export function humanizeToken(value: string): string {
  return value.replaceAll("-", " ");
}

function formatEcosystemEntry(
  eco: { readonly id: string; readonly count: number },
  t: I18nTranslate,
): string {
  return `${eco.id} (${formatCount(eco.count, t.locale)})`;
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
            value={formatCount(count, t.locale)}
          />
        ))}
      </dl>
      {summary.ecosystems.length > 0 ? (
        <p className="grounded-ranking-ecosystems">
          {t("grounded.inspection.ecosystems", {
            entries: summary.ecosystems.map((eco) => formatEcosystemEntry(eco, t)).join(", "),
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
  scopeLabel?: string,
): string {
  const scope = scopeLabel ?? formatScopeLabel(contextPack, t);
  let key: MessageKey = "grounded.inspection.scope";
  if (contextPack.scopeKind === "files") {
    key =
      contextPack.fileCount === 1
        ? "grounded.inspection.scopeFile"
        : "grounded.inspection.scopeFiles";
  }
  return t(key, { scope, count: formatCount(contextPack.fileCount, t.locale) });
}

type InspectionMetric = readonly [string, string];
type SearchCoverage = GroundedAnswerContextPackSummary["coverage"];

function hasInspectedEligibleFiles(coverage: NonNullable<SearchCoverage>): boolean {
  return (
    coverage.filesScanned === coverage.filesAfterPolicy &&
    coverage.filesSkipped === 0 &&
    coverage.depthPrunedByDiscovery === 0 &&
    coverage.maxFilesPrunedByDiscovery === 0
  );
}

function hasOnlyOmittedMatches(coverage: NonNullable<SearchCoverage>): boolean {
  return (
    coverage.reasons.length === 1 &&
    coverage.reasons[0] === "match-cap" &&
    hasInspectedEligibleFiles(coverage)
  );
}

function selectedReadCount(pack: GroundedAnswerContextPackSummary, t: I18nTranslate): string {
  if (pack.budget.filesReadMax !== null) {
    return inspectionCount(
      t,
      "grounded.inspection.fileCount",
      pack.usage.filesRead,
      pack.budget.filesReadMax,
    );
  }
  const key =
    pack.usage.filesRead === 1
      ? "grounded.inspection.fileCountUncapped.one"
      : "grounded.inspection.fileCountUncapped.other";
  return t(key, { used: formatCount(pack.usage.filesRead, t.locale) });
}

function inspectionCount(t: I18nTranslate, key: MessageKey, used: number, max: number): string {
  return t(key, {
    used: formatCount(used, t.locale),
    max: formatCapWith(max, (value) => formatCount(value, t.locale)),
  });
}

function coverageMessageKey(coverage: NonNullable<SearchCoverage>): MessageKey {
  if (hasOnlyOmittedMatches(coverage)) return "grounded.inspection.resultsLimited";
  return coverage.incomplete ? "grounded.inspection.incomplete" : "grounded.inspection.complete";
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
    [t("grounded.inspection.coverage"), t(coverageMessageKey(coverage))],
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
      `${formatBytes(usage.excerptBytes, t.locale)} / ${formatCapWith(budget.excerptBytesMax, (value) => formatBytes(value, t.locale))}`,
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
    [t("grounded.inspection.duration"), formatMs(pack.elapsedMs, t.locale)],
    [
      t("grounded.inspection.timeLimit"),
      pack.budget.elapsedMsMax === null
        ? t("grounded.inspection.noTimeLimit")
        : formatCapWith(pack.budget.elapsedMsMax, (value) => formatMs(value, t.locale)),
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
  scopeLabel,
}: {
  readonly scopeLabel?: string | undefined;
  readonly contextPack: GroundedAnswerContextPackSummary;
}): ReactNode {
  const t = useTranslate();
  return (
    <section className="grounded-context-pack" aria-label={t("grounded.inspection.aria")}>
      <div className="grounded-context-pack-headline">
        {contextPackHeadline(contextPack, t, scopeLabel)}
      </div>
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
          : t("grounded.inspection.readHint", {
              max: formatCap(contextPack.budget.filesReadMax, t.locale),
            })}
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
    return repositoryReferenceDisplayPath(citation.scopePath);
  }
  return `${repositoryReferenceDisplayPath(citation.scopePath)}:${String(citation.lineRange.startLine)}-${String(citation.lineRange.endLine)}`;
}

function citationSpan(citation: GroundedEvidenceCitation, t: I18nTranslate): string {
  if (citation.lineRange === undefined) return "";
  const key =
    citation.documentFormat === undefined
      ? "grounded.citation.lines"
      : "grounded.citation.extractedSpan";
  return t(key, {
    start: citation.lineRange.startLine,
    end: citation.lineRange.endLine,
  });
}

function citationTitle(citation: GroundedEvidenceCitation, t: I18nTranslate): string {
  const kind =
    citation.documentFormat === undefined
      ? t("grounded.citation.evidence")
      : t("grounded.citation.documentEvidence", { format: citation.documentFormat.toUpperCase() });
  return t("grounded.citation.title", {
    kind,
    path: repositoryReferenceDisplayPath(citation.scopePath),
    span: citationSpan(citation, t),
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

function useCitationReference(
  citation: GroundedEvidenceCitation,
  roots: readonly RepositoryReferenceRoot[],
): {
  readonly options: ReturnType<typeof citationRootOptions>;
  readonly reference: RepositoryReference;
} {
  return useMemo(
    () => ({
      options: citationRootOptions(citation, roots),
      reference: citationRepositoryReference(citation),
    }),
    [citation, roots],
  );
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
  const { options, reference } = useCitationReference(citation, repositoryRoots);
  const canOpenRepositoryCitation =
    documentFormat === undefined &&
    openRepositoryReference !== undefined &&
    repositoryRoots.length > 0;
  return (
    <span className="grounded-citation" title={citationTitle(citation, t)}>
      {documentFormat === undefined ? null : (
        <>
          <span className="grounded-citation-doc-badge">{documentFormat}</span>
          <span className="sr-only">{t("grounded.citation.extractedText")}</span>
        </>
      )}
      <span className="grounded-citation-range">
        {canOpenRepositoryCitation ? (
          <RepositoryReferenceInline
            reference={reference}
            {...options}
            rootRelative
            sourceLabel={sourceLabel}
            openReference={openRepositoryReference}
            className="repo-ref-link grounded-citation-open"
            displayPath={attributedCitationLabel(
              repositoryReferenceDisplayPath(displayPath),
              sourceLabel,
            )}
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
        : t("grounded.citations.showAll", { count: formatCount(total, t.locale) })}
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
  const t = useTranslate();
  if (total <= ACTIVITY_POD_DISPLAY_CAP) return null;
  return (
    <button
      type="button"
      className="grounded-citations-more"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? t("grounded.activity.showFewer")
        : t("grounded.activity.showAll", { count: formatCount(total, t.locale) })}
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
  const sorted = useMemo(
    () => uniqueByCitationIdentity([...citations].sort((a, b) => b.score - a.score)),
    [citations],
  );
  const labels = useMemo(
    () => repositoryReferencePathLabels(sorted.map((citation) => citation.scopePath)),
    [sorted],
  );
  const collisions = useMemo(() => attributedCitationCollisions(sorted), [sorted]);
  if (citations.length === 0) return null;
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
  return t(count === 1 ? keys.one : keys.other, { ...values, count: formatCount(count, t.locale) });
}

function connectedEvidenceSummary(answer: ConnectedGroundedAnswer, t: I18nTranslate): string {
  const citationCount = uniqueCitationCount(answer.citations);
  return connectedPromptEvidenceSummary(answer.contextPack, citationCount, t);
}

function knowledgeEvidenceSummary(answer: KnowledgeGroundedAnswer, t: I18nTranslate): string {
  return citationCountLabel(
    t,
    uniqueCitationCount(answer.citations),
    { one: "grounded.summary.knowledge.one", other: "grounded.summary.knowledge.other" },
    {
      used: formatCount(answer.contextPack.referencesUsed, t.locale),
      budget: formatCount(answer.contextPack.referenceBudget, t.locale),
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

const ACTIVITY_STATE_LABELS: Record<KnowledgePodRetrievalActivityState, MessageKey> = {
  searched: "grounded.activity.state.searched",
  skipped: "grounded.activity.state.skipped",
  degraded: "grounded.activity.state.degraded",
  denied: "grounded.activity.state.denied",
  unavailable: "grounded.activity.state.unavailable",
  "not-selected": "grounded.activity.state.not-selected",
};

const ACTIVITY_REASON_LABELS: Record<KnowledgePodRetrievalActivityReasonCode, MessageKey> = {
  "selected-for-search": "grounded.activity.reason.selected-for-search",
  searched: "grounded.activity.reason.searched",
  "not-selected": "grounded.activity.reason.not-selected",
  "source-skipped": "grounded.activity.reason.source-skipped",
  "scope-not-ready": "grounded.activity.reason.scope-not-ready",
  "indexing-in-progress": "grounded.activity.reason.indexing-in-progress",
  "stale-capsule": "grounded.activity.reason.stale-capsule",
  "retrieval-failure": "grounded.activity.reason.retrieval-failure",
  "no-scope": "grounded.activity.reason.no-scope",
  "no-vectors": "grounded.activity.reason.no-vectors",
  "incompatible-embedding-identity": "grounded.activity.reason.incompatible-embedding-identity",
  "dense-scan-too-large": "grounded.activity.reason.dense-scan-too-large",
  "below-min-score": "grounded.activity.reason.below-min-score",
  "answer-grounding-rejected": "grounded.activity.reason.answer-grounding-rejected",
  "no-evidence-stated": "grounded.activity.reason.no-evidence-stated",
  "no-evidence": "grounded.activity.reason.no-evidence",
  "empty-query": "grounded.activity.reason.empty-query",
  "empty-answer": "grounded.activity.reason.empty-answer",
  "embedding-failed": "grounded.activity.reason.embedding-failed",
  "embedding-unavailable": "grounded.activity.reason.embedding-unavailable",
  "reranker-unavailable": "grounded.activity.reason.reranker-unavailable",
  "reranker-invalid-response": "grounded.activity.reason.reranker-invalid-response",
  "policy-denied": "grounded.activity.reason.policy-denied",
  "capability-missing": "grounded.activity.reason.capability-missing",
  "remote-unavailable": "grounded.activity.reason.remote-unavailable",
  "pack-validation-failed": "grounded.activity.reason.pack-validation-failed",
  "max-sources-exceeded": "grounded.activity.reason.max-sources-exceeded",
};

type RetrievalActivityPod = KnowledgePodRetrievalActivity["pods"][number];

function activityEvidenceCounts(
  referenceCount: number,
  citationCount: number,
  t: I18nTranslate,
): string {
  const references = citationCountLabel(t, referenceCount, {
    one: "grounded.count.references.one",
    other: "grounded.count.references.other",
  });
  const citations = citationCountLabel(t, citationCount, {
    one: "grounded.count.citations.one",
    other: "grounded.count.citations.other",
  });
  return `${references} · ${citations}`;
}

function activityPodLine(pod: RetrievalActivityPod, t: I18nTranslate): string {
  return `${pod.displayName} · ${activityEvidenceCounts(pod.counts.referenceCount, pod.counts.citationCount, t)}`;
}

function activityReasons(pod: RetrievalActivityPod, t: I18nTranslate): string {
  return pod.reasonCodes.map((reason) => t(ACTIVITY_REASON_LABELS[reason])).join(", ");
}

const ACTIVITY_MODE_LABELS: Record<RetrievalActivityPod["modes"][number], MessageKey> = {
  "local-only": "grounded.activity.mode.local-only",
  hybrid: "grounded.activity.mode.hybrid",
  lexical: "grounded.activity.mode.lexical",
  vector: "grounded.activity.mode.vector",
  reranked: "grounded.activity.mode.reranked",
  sealed: "grounded.activity.mode.sealed",
  remote: "grounded.activity.mode.remote",
  federated: "grounded.activity.mode.federated",
  exact: "grounded.activity.mode.exact",
  broad: "grounded.activity.mode.broad",
};

function activityModes(pod: RetrievalActivityPod, t: I18nTranslate): string {
  return pod.modes.map((mode) => t(ACTIVITY_MODE_LABELS[mode])).join(", ");
}

function KnowledgePodRetrievalActivityPanel({
  activity,
}: {
  readonly activity: KnowledgePodRetrievalActivity | undefined;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const t = useTranslate();
  if (activity === undefined || activity.pods.length === 0) return null;
  const { summary } = activity;
  const visiblePods = expanded ? activity.pods : activity.pods.slice(0, ACTIVITY_POD_DISPLAY_CAP);
  return (
    <section
      className={`grounded-context-pack ${activityBadgeStyles.scope}`}
      aria-label={t("grounded.activity.aria")}
    >
      <div className="grounded-context-pack-headline">{t("grounded.activity.title")}</div>
      <dl className="grounded-context-pack-dl">
        <MetricRow
          label={t(ACTIVITY_STATE_LABELS["searched"])}
          value={formatCount(summary.searchedCount, t.locale)}
        />
        <MetricRow
          label={t(ACTIVITY_STATE_LABELS["skipped"])}
          value={formatCount(summary.skippedCount, t.locale)}
        />
        <MetricRow
          label={t(ACTIVITY_STATE_LABELS["degraded"])}
          value={formatCount(summary.degradedCount, t.locale)}
        />
        <MetricRow
          label={t(ACTIVITY_STATE_LABELS["denied"])}
          value={formatCount(summary.deniedCount, t.locale)}
        />
        <MetricRow
          label={t(ACTIVITY_STATE_LABELS["unavailable"])}
          value={formatCount(summary.unavailableCount, t.locale)}
        />
        <MetricRow
          label={t(ACTIVITY_STATE_LABELS["not-selected"])}
          value={formatCount(summary.notSelectedCount, t.locale)}
        />
        <MetricRow
          label={t("grounded.activity.candidates")}
          value={t("grounded.activity.candidateCounts", {
            dense: formatCount(summary.denseCandidateCount, t.locale),
            lexical: formatCount(summary.lexicalCandidateCount, t.locale),
            fused: formatCount(summary.fusedCandidateCount, t.locale),
          })}
        />
        <MetricRow
          label={t("grounded.title.evidence")}
          value={activityEvidenceCounts(summary.referenceCount, summary.citationCount, t)}
        />
      </dl>
      <ul
        className={`grounded-uncertainty-list ${activityBadgeStyles.activityList}`}
        aria-label={t("grounded.activity.details")}
      >
        {visiblePods.map((pod) => (
          <li key={`${pod.podKind}-${pod.podId}`} className={activityBadgeStyles.activityListItem}>
            <span className="grounded-evidence-summary-badge" data-activity-state={pod.state}>
              {t(ACTIVITY_STATE_LABELS[pod.state])}
            </span>{" "}
            {activityPodLine(pod, t)}
            {" · "}
            <span className={`grounded-meta ${activityBadgeStyles.activityMeta}`}>
              {t("grounded.activity.modesReasons", {
                modes: activityModes(pod, t),
                reasons: activityReasons(pod, t),
              })}
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
  summaryTitle,
  reportInspection = false,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly summaryTitle?: string | undefined;
  readonly reportInspection?: boolean;
  readonly hasCoverageWarning?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const t = useTranslate();
  return (
    <details
      className="grounded-evidence-disclosure"
      onToggle={(event) => {
        if (reportInspection && event.target === event.currentTarget && event.currentTarget.open)
          reportEvidenceInspection({ reason: "summary-expanded" });
      }}
    >
      <summary className="grounded-evidence-summary">
        <span className="grounded-evidence-summary-title">{title}</span>
        <span className="grounded-evidence-summary-meta" title={summaryTitle}>
          {summary}
        </span>
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

function knowledgeCitationLabel(
  citation: LocalKnowledgeEvidenceCitation,
  t: I18nTranslate,
): string {
  if (citation.htmlManual !== undefined) {
    return manualCitationLabel(citation, t);
  }
  const label =
    citation.source === undefined
      ? `${citation.marker} ${citation.label}`
      : `${citation.marker} ${citation.source} · ${citation.label}`;
  return stripUnsafeFormatChars(label);
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
  const sorted = useMemo(
    () => uniqueByCitationIdentity([...citations].sort((a, b) => b.score - a.score)),
    [citations],
  );
  if (citations.length === 0) return null;
  // uiux-fix F012 C091 — same cap + disclosure as CitationList above.
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
              label={knowledgeCitationLabel(citation, t)}
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

function knowledgeCitationTitle(
  citation: LocalKnowledgeEvidenceCitation,
  t: I18nTranslate,
): string {
  if (citation.htmlManual !== undefined) {
    const section = citation.htmlManual.sectionPath?.join(" · ");
    const suffix = section === undefined ? "" : ` · ${section}`;
    return stripUnsafeFormatChars(
      `${citation.htmlManual.pageTitle}${suffix} — ${t("grounded.manual.evidence")}`,
    );
  }
  const title =
    citation.source === undefined ? citation.label : `${citation.source} · ${citation.label}`;
  return stripUnsafeFormatChars(title);
}

function manualCitationLabel(citation: LocalKnowledgeEvidenceCitation, t: I18nTranslate): string {
  const manual = citation.htmlManual;
  if (manual === undefined) return stripUnsafeFormatChars(`${citation.marker} ${citation.label}`);
  const source =
    citation.source === undefined
      ? t("grounded.manual.name")
      : `${citation.source} · ${t("grounded.manual.name")}`;
  const section = manual.sectionPath?.join(" · ");
  const sectionSuffix = section === undefined || section.length === 0 ? "" : ` · ${section}`;
  return stripUnsafeFormatChars(
    `${citation.marker} ${source} · ${manual.pageTitle}${sectionSuffix}`,
  );
}

// Curated, short copy for every governed reason a manual citation cannot be reopened — mirrors the
// tone of DocumentationBrowserWidget's REASON_COPY without exposing the raw wire enum token.
const MANUAL_UNAVAILABLE_REASON_COPY: Readonly<
  Record<HtmlManualCitationOpenUnavailableReason, MessageKey>
> = {
  "source-metadata-unavailable": "grounded.manual.reason.source-metadata-unavailable",
  "citation-lineage-mismatch": "grounded.manual.reason.citation-lineage-mismatch",
  "target-outside-approved-scope": "grounded.manual.reason.target-outside-approved-scope",
  "target-unsupported": "grounded.manual.reason.target-unsupported",
  "target-credentialed": "grounded.manual.reason.target-credentialed",
  "target-unavailable": "grounded.manual.reason.target-unavailable",
};

function manualCitationActionLabel(manual: HtmlManualCitationMetadata, t: I18nTranslate): string {
  if (manual.open.state === "available") return t("grounded.manual.openManual");
  if (manual.open.state === "page-level-only") return t("grounded.manual.openPage");
  return t(MANUAL_UNAVAILABLE_REASON_COPY[manual.open.reason]);
}

function manualCitationChipActionLabel(
  state: "idle" | "opened" | "failed",
  manual: HtmlManualCitationMetadata,
  t: I18nTranslate,
): string {
  let label: string;
  if (state === "opened") {
    label = t("grounded.manual.opened");
  } else if (state === "failed") {
    label = t("grounded.manual.failed");
  } else {
    label = manualCitationActionLabel(manual, t);
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
  const t = useTranslate();
  const manual = citation.htmlManual;
  const [state, setState] = useState<"idle" | "opened" | "failed">("idle");
  const accessibleLabel = useSupportAwareLabel(label, unverified);
  if (manual === undefined) return null;
  const unavailable = manual.open.state === "unavailable";
  const actionLabel = manualCitationChipActionLabel(state, manual, t);
  const target = manual.open.state === "unavailable" ? undefined : manual.open.target;
  const modifier = unavailable || state === "failed" ? " grounded-citation-action--blocked" : "";
  return (
    <button
      type="button"
      className={`grounded-citation grounded-citation-action ${activityBadgeStyles.manualCitationAction}${modifier}`}
      aria-disabled={unavailable ? "true" : undefined}
      aria-label={`${accessibleLabel} · ${actionLabel}`}
      title={`${knowledgeCitationTitle(citation, t)} · ${actionLabel}`}
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

function pdfPreviewActionText(
  state: string,
  t: I18nTranslate,
): {
  readonly actionLabel: string;
  readonly actionTitle: string;
} {
  if (state === "recoverable")
    return { actionLabel: t("grounded.pdf.recover"), actionTitle: t("grounded.pdf.recoveryTitle") };
  if (state === "blocked") {
    return {
      actionLabel: t("grounded.pdf.unavailable"),
      actionTitle: t("grounded.pdf.unavailableTitle"),
    };
  }
  return { actionLabel: t("grounded.pdf.open"), actionTitle: t("grounded.pdf.openTitle") };
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
  const t = useTranslate();
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
      <span className="grounded-citation" title={knowledgeCitationTitle(citation, t)}>
        <span className="grounded-citation-range">{label}</span>
        {unverified ? <UnverifiedSupportBadge /> : null}
      </span>
    );
  }

  const blocked = affordance.state === "blocked";
  const opening = citationPreview?.isOpening(citation) ?? false;
  const { actionLabel, actionTitle } = pdfPreviewActionText(affordance.state, t);

  return (
    <button
      type="button"
      className={`grounded-citation grounded-citation-action grounded-citation-action--${affordance.state}`}
      aria-disabled={blocked || opening ? "true" : undefined}
      aria-label={`${accessibleLabel} · ${actionLabel}`}
      data-tip={actionTitle}
      title={`${knowledgeCitationTitle(citation, t)} · ${actionLabel}`}
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
  ["uncited-memory-context", "grounded.uncertainty.memoryKind"],
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
  ["uncited-answer", "grounded.uncertainty.warningReference"],
  ["uncited-memory-context", "grounded.uncertainty.memoryContext"],
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

function nextUncertaintyKey(
  marker: GroundedUncertainty | undefined,
  occurrences: Map<string, number>,
): string {
  const identity = JSON.stringify(marker ?? null);
  const occurrence = (occurrences.get(identity) ?? 0) + 1;
  occurrences.set(identity, occurrence);
  return `${identity}:${String(occurrence)}`;
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
  const originals = [...new Set(markers.map((marker) => marker.claim))];
  return (
    <details className={activityBadgeStyles.cmpOriginalDetails}>
      <summary>{t("grounded.uncertainty.original")}</summary>
      {originals.map((claim) => (
        <p key={claim}>{claim}</p>
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
      {markers.length > 1 ? (
        <span>
          {" "}
          · {t("grounded.uncertainty.groupCount", { count: formatCount(markers.length, t.locale) })}
        </span>
      ) : null}
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
  const occurrences = new Map<string, number>();
  const kinds = Array.from(new Set(markers.map((m) => uncertaintyKindLabel(m.kind, t)))).join(", ");
  return (
    <div className="grounded-uncertainty" role="note">
      <div>
        {t("grounded.uncertainty.summary", { count: formatCount(markers.length, t.locale), kinds })}
      </div>
      <ul className="grounded-uncertainty-list">
        {uncertaintyDisplayGroups(markers).map((group) => (
          <UncertaintyItem key={nextUncertaintyKey(group[0], occurrences)} markers={group} t={t} />
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
    .map(([reason, count]) => `${omissionLabel(reason, t)}: ${formatCount(count, t.locale)}`)
    .join(", ");
  const suffix = reasonSummary.length > 0 ? ` (${reasonSummary})` : "";
  // Omission entries are unique file paths, not excerpt atoms. Keep the same unit as the wire.
  return (
    <div className="grounded-meta">
      {t(
        omittedCount === 1
          ? "grounded.inspection.notUsed.one"
          : "grounded.inspection.notUsed.other",
        { count: formatCount(omittedCount, t.locale), reasons: suffix },
      )}
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
  singleFile = false,
}: {
  readonly singleFile?: boolean;
  readonly omittedCounts: GroundedAnswerContextPackSummary["omittedCounts"];
}): ReactNode {
  const t = useTranslate();
  const gaps = COVERAGE_GAP_REASONS.map((reason) => ({
    label: omissionLabel(reason, t),
    count: omittedCounts[reason] ?? 0,
  })).filter((gap) => gap.count > 0);
  const recordedCount = gaps.reduce((sum, gap) => sum + gap.count, 0);
  if (recordedCount <= 0) return null;
  const detail = gaps.map((gap) => `${formatCount(gap.count, t.locale)} ${gap.label}`).join(", ");
  const showDocumentNotice = COVERAGE_GAP_REASONS.some(
    (reason) =>
      reason !== "size-exceeded" && reason !== "tool-unavailable" && omittedCounts[reason] > 0,
  );
  return (
    <div className="grounded-coverage-notice" role="note">
      <span className="grounded-coverage-notice-title">{t("grounded.partialCoverage")}</span>
      <span>
        {t(
          singleFile
            ? "grounded.coverage.file"
            : recordedCount === 1
              ? "grounded.inspection.coverageGap.one"
              : "grounded.inspection.coverageGap.other",
          { count: formatCount(recordedCount, t.locale), detail },
        )}
      </span>
      {showDocumentNotice ? <span>{t("grounded.inspection.documentHint")}</span> : null}
    </div>
  );
}

function incompleteSearchCoverage(coverage: SearchCoverage): boolean {
  return coverage?.incomplete === true && !hasOnlyOmittedMatches(coverage);
}

function hasCoverageWarning(pack: GroundedAnswerContextPackSummary): boolean {
  return (
    incompleteSearchCoverage(pack.coverage) ||
    COVERAGE_GAP_REASONS.some((reason) => pack.omittedCounts[reason] > 0)
  );
}

function searchCoverageSummaryWarning(
  answer: GroundedAnswer,
  t: I18nTranslate,
): string | undefined {
  if (answer.groundingKind === "local-knowledge") return undefined;
  const pack = answer.groundingKind === "hybrid" ? answer.contextPack.folder : answer.contextPack;
  if (!incompleteSearchCoverage(pack.coverage)) return undefined;
  return searchCoverageDetail(pack.coverage, t) ?? t("grounded.detail.scopeIncomplete");
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
  const t = useTranslate();
  return (
    <section className="grounded-context-pack" aria-label={t("grounded.knowledge.scopeAria")}>
      <div className="grounded-context-pack-headline">
        {t("grounded.knowledge.scopeTitle", { scope: contextPack.scopeLabel })}
      </div>
      <dl className="grounded-context-pack-dl">
        <MetricRow
          label={t("grounded.knowledge.mode")}
          value={t(
            contextPack.scopeKind === "capsule-set"
              ? "grounded.knowledge.podSet"
              : "grounded.knowledge.pod",
          )}
        />
        <MetricRow
          label={t("grounded.knowledge.pods")}
          value={formatCount(contextPack.capsuleCount, t.locale)}
        />
        <MetricRow
          label={t("grounded.knowledge.sources")}
          value={formatCount(contextPack.sourceCount, t.locale)}
        />
        <MetricRow
          label={t("grounded.knowledge.citations")}
          value={formatCount(contextPack.citationCount, t.locale)}
        />
        <MetricRow
          label={t("grounded.knowledge.budget")}
          value={t("grounded.knowledge.references", {
            used: formatCount(contextPack.referencesUsed, t.locale),
            budget: formatCount(contextPack.referenceBudget, t.locale),
          })}
        />
      </dl>
    </section>
  );
}

// Epic #189 Slice 3 M5 — hybrid context pack: folder + Knowledge Pod sources side-by-side.
function HybridContextPackSummary({
  contextPack,
  scopeLabel,
}: {
  readonly scopeLabel?: string | undefined;
  readonly contextPack: HybridGroundedAnswerContextSummary;
}): ReactNode {
  const t = useTranslate();
  return (
    <section className="grounded-context-pack" aria-label={t("grounded.knowledge.hybridAria")}>
      <div className="grounded-context-pack-headline">
        {t("grounded.knowledge.hybridTitle", {
          folders: citationCountLabel(t, contextPack.folderSourceCount, {
            one: "grounded.count.folders.one",
            other: "grounded.count.folders.other",
          }),
          pods: citationCountLabel(t, contextPack.connectorSourceCount, {
            one: "grounded.count.pods.one",
            other: "grounded.count.pods.other",
          }),
        })}
      </div>
      <ContextPackSummary contextPack={contextPack.folder} scopeLabel={scopeLabel} />
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
  return `${t(count === 1 ? keys.one : keys.other, { count: formatCount(count, t.locale) })} — ${t(detail)}`;
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
  const coverageWarning = searchCoverageSummaryWarning(answer, t);
  if (coverageWarning !== undefined) warnings.push(coverageWarning);
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
    hasInspectedEligibleFiles(coverage)
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
    coverage?.matchesReturned !== 0 ||
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
            scanned: formatCount(emptyCoverage.filesScanned, t.locale),
            eligible: formatCount(emptyCoverage.filesAfterPolicy, t.locale),
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

type FolderAuditDetailsProps = Omit<GroundedAnswerProps, "answer" | "busy"> & {
  readonly answer: ConnectedGroundedAnswer | HybridGroundedAnswer;
};

function useInspectedFolderScope({ answer, onReadPaths }: FolderAuditDetailsProps): {
  readonly scopeLabel: string | undefined;
  readonly onRead: (
    runId: string,
    paths: readonly string[],
    selectedPaths: readonly string[],
    sourceScopeFingerprint?: string,
  ) => void;
} {
  const pack = answer.groundingKind === "hybrid" ? answer.contextPack.folder : answer.contextPack;
  const primaryId = answer.evidenceRunId ?? answer.evidenceRunIds?.[0];
  const key = JSON.stringify([answer.assistantMessageId, pack.scopeId, primaryId]);
  const [selection, setSelection] = useState<{
    readonly key: string;
    readonly paths: readonly string[];
  }>({ key: "", paths: [] });
  const onRead = useCallback(
    (
      runId: string,
      paths: readonly string[],
      selectedPaths: readonly string[],
      sourceScopeFingerprint?: string,
    ): void => {
      if (runId === primaryId) setSelection({ key, paths: selectedPaths });
      onReadPaths?.(runId, paths, sourceScopeFingerprint);
    },
    [key, primaryId, onReadPaths],
  );
  return {
    scopeLabel:
      selection.key === key && selection.paths.length > 0 ? selection.paths.join(", ") : undefined,
    onRead,
  };
}

function FolderAuditDetails(props: FolderAuditDetailsProps): ReactNode {
  const { answer } = props;
  const pack = answer.groundingKind === "hybrid" ? answer.contextPack.folder : answer.contextPack;
  const inspection = useInspectedFolderScope(props);
  return (
    <>
      <ConnectedEvidenceInspection
        key={answer.assistantMessageId}
        contextPack={pack}
        runIds={[
          ...(answer.evidenceRunId === undefined ? [] : [answer.evidenceRunId]),
          ...(answer.evidenceRunIds ?? []),
        ]}
        citationBehaviour={answer.citationBehaviour}
        attachedCitationCount={answer.citations.length}
        onReadPaths={inspection.onRead}
      />
      <AuditEvidenceLink runId={answer.evidenceRunId} runIds={answer.evidenceRunIds} />
      {answer.groundingKind === "hybrid" ? (
        <HybridContextPackSummary
          contextPack={answer.contextPack}
          scopeLabel={inspection.scopeLabel}
        />
      ) : (
        <ContextPackSummary contextPack={pack} scopeLabel={inspection.scopeLabel} />
      )}
    </>
  );
}

export function GroundedAnswer({
  answer,
  busy,
  repositoryRoots = [],
  openRepositoryReference,
  citationPreview,
  openDocumentationTarget,
  onReadPaths,
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
        <ConnectedRetrievalNotice contextPack={answer.contextPack.folder} />
        <GroundedEvidenceDisclosure
          reportInspection
          summaryTitle={connectedOmissionTooltip(answer.contextPack.folder, t)}
          title={t("grounded.title.grounding")}
          summary={`${connectedPromptEvidenceSummary(answer.contextPack.folder, uniqueCitationCount(answer.citations), t)} · ${hybridEvidenceSummary(answer, t)}`}
          hasCoverageWarning={hasCoverageWarning(answer.contextPack.folder)}
        >
          <CoverageNotice
            omittedCounts={answer.contextPack.folder.omittedCounts}
            singleFile={
              answer.contextPack.folder.scopeKind === "files" &&
              answer.contextPack.folder.fileCount === 1
            }
          />
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
          <FolderAuditDetails
            answer={answer}
            repositoryRoots={repositoryRoots}
            onReadPaths={onReadPaths}
          />
        </GroundedEvidenceDisclosure>
      </div>
    );
  }
  return (
    <div className="grounded-answer">
      <GroundedAnswerWarnings answer={answer} />
      <ConnectedRetrievalNotice contextPack={answer.contextPack} />
      <GroundedEvidenceDisclosure
        reportInspection
        summaryTitle={connectedOmissionTooltip(answer.contextPack, t)}
        title={t("grounded.title.evidence")}
        summary={connectedEvidenceSummary(answer, t)}
        hasCoverageWarning={hasCoverageWarning(answer.contextPack)}
      >
        <CoverageNotice
          omittedCounts={answer.contextPack.omittedCounts}
          singleFile={
            answer.contextPack.scopeKind === "files" && answer.contextPack.fileCount === 1
          }
        />
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
        <FolderAuditDetails
          answer={answer}
          repositoryRoots={repositoryRoots}
          onReadPaths={onReadPaths}
        />
      </GroundedEvidenceDisclosure>
    </div>
  );
}
