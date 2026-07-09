"use client";

// Issue #198 — Capsule detail Client Component.
// Four sections: Overview, Sources, Health Diagnostics, Indexing Job History.
// Parser diagnostics NEVER render raw extracted text — only severity/code/message/page_number.
// State is split into capsule-detail-state.ts to keep each file under 400 LOC.

import { useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  CapsuleLargeDocumentHealth,
  CapsuleHealth,
  CoverageQuality,
  ExtractionPhase,
  KnowledgeCapsuleId,
  LargeDocumentJobProgress,
  ParserDiagnostic,
  IndexingJobRecord,
  ParserDiagnosticSeverity,
  IndexingJobStatus,
  CapsuleContextualRetrievalSettings,
} from "@oscharko-dev/keiko-contracts";
import { isTerminalExtractionPhase } from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleDetail as CapsuleDetailData,
  CapsuleActionResponse,
  SourceIndexStats,
} from "@/lib/local-knowledge-api";
import {
  resumeCapsuleLargeDocuments,
  updateCapsuleContextualRetrieval,
} from "@/lib/local-knowledge-api";
import { formatBytes, formatDurationCompact as formatDuration } from "@/lib/format";
import {
  useLocalKnowledgeTranslate as useTranslate,
  type I18nTranslate,
} from "../local-knowledge-i18n";
import Link from "next/link";
import { STATUS_LABELS } from "../connector-graph-types";
import { useCapsuleDetail } from "./capsule-detail-state";
import { CapsuleActions } from "./capsule-actions";
import { CapsuleRename } from "./capsule-rename";
import { SourceRebindControl } from "./source-rebind-control";
import detailStyles from "../capsule-detail.module.css";
import { Explainable } from "../detail-help";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTs(epochMs: number): string {
  // Explicit en-US: the surrounding UI copy is English; an OS-locale date
  // ("10. Juni 2026") next to "Last indexed" mixed languages per machine
  // (uiux-fix F033, C367).
  return new Date(epochMs).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100).toString()}%`;
}

function scopeLocation(scope: SourceIndexStats["scope"], t: I18nTranslate): string {
  if (scope.kind === "folder") return scope.rootPath;
  if (scope.kind === "repository") return scope.repositoryRoot;
  return t(
    scope.files.length === 1
      ? "localKnowledge.detail.sources.selectedFiles.one"
      : "localKnowledge.detail.sources.selectedFiles.many",
    { root: scope.rootPath, count: scope.files.length },
  );
}

function sourceTotal(src: SourceIndexStats): number {
  return src.indexedCount + src.failedCount + src.skippedCount;
}

function latestJob(data: CapsuleDetailData): IndexingJobRecord | undefined {
  return data.indexingJobs[0];
}

function completedDocuments(job: IndexingJobRecord | undefined): number {
  if (job === undefined) return 0;
  return job.processedDocuments + job.failedDocuments + job.skippedDocuments;
}

function indexedDocuments(data: CapsuleDetailData): number {
  return Math.max(
    0,
    data.health.documentCount - data.health.failedDocuments - data.health.skippedDocuments,
  );
}

function progressStyle(value: number): { readonly width: string } {
  return { width: formatPercent(value) };
}

type EmbeddingCompatibility = NonNullable<CapsuleHealth["embeddingCompatibility"]>;
type ContextualRetrievalHealth = NonNullable<CapsuleHealth["contextualRetrieval"]>;

function formatEmbeddingIdentity(identity: CapsuleHealth["embeddingIdentity"]): string {
  return `${identity.provider} / ${identity.modelId} (${identity.vectorDimensions.toString()}d, ${identity.vectorMetric})`;
}

function compatibilityStatus(data: CapsuleDetailData): EmbeddingCompatibility["status"] {
  return (
    data.health.embeddingCompatibility?.status ??
    (data.health.vectorCompatible ? "compatible" : "incompatible")
  );
}

function compatibilityTone(status: EmbeddingCompatibility["status"]): "ok" | "warn" | "danger" {
  if (status === "compatible") return "ok";
  if (status === "unknown") return "warn";
  return "danger";
}

function compatibilityLabel(status: EmbeddingCompatibility["status"], t: I18nTranslate): string {
  if (status === "compatible") return t("localKnowledge.detail.compatibility.compatible");
  if (status === "unknown") return t("localKnowledge.detail.compatibility.unknown");
  return t("localKnowledge.detail.compatibility.incompatible");
}

function contextualTone(
  status: ContextualRetrievalHealth["status"] | undefined,
): "neutral" | "ok" | "warn" | "danger" {
  if (status === "ready") return "ok";
  if (status === "unavailable") return "danger";
  if (status === "rebuild-required" || status === "degraded") return "warn";
  return "neutral";
}

function contextualStatusLabel(
  status: ContextualRetrievalHealth["status"] | undefined,
  t: I18nTranslate,
): string {
  if (status === "ready") return t("localKnowledge.detail.context.status.ready");
  if (status === "rebuild-required") return t("localKnowledge.detail.context.status.rebuild");
  if (status === "degraded") return t("localKnowledge.detail.context.status.degraded");
  if (status === "unavailable") return t("localKnowledge.detail.context.status.unavailable");
  return t("localKnowledge.detail.context.status.disabled");
}

// ---------------------------------------------------------------------------
// SectionHeading
// ---------------------------------------------------------------------------

function SectionHeading({ children, help }: { children: ReactNode; help?: string }): ReactNode {
  return (
    <h2 className="lk-section-head">
      {help === undefined ? children : <Explainable description={help}>{children}</Explainable>}
    </h2>
  );
}

const DEFAULT_VISIBLE_ROWS = 25;

function useVisibleRows(total: number): {
  readonly visibleCount: number;
  readonly showAll: boolean;
  readonly setShowAll: (value: boolean) => void;
} {
  const [showAll, setShowAll] = useState(false);
  return {
    visibleCount: showAll ? total : Math.min(DEFAULT_VISIBLE_ROWS, total),
    showAll,
    setShowAll,
  };
}

function MoreRowsButton({
  hiddenCount,
  showAll,
  onToggle,
  noun,
  t,
}: {
  hiddenCount: number;
  showAll: boolean;
  onToggle: () => void;
  noun: string;
  t: I18nTranslate;
}): ReactNode {
  if (!showAll && hiddenCount <= 0) return null;
  return (
    <button type="button" className="lk-btn lk-btn-ghost" onClick={onToggle}>
      {showAll
        ? t("localKnowledge.detail.rows.showFewer", { noun })
        : t("localKnowledge.detail.rows.showMore", { count: hiddenCount, noun })}
    </button>
  );
}

// ---------------------------------------------------------------------------
// IndexingStatusSection
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  meta,
  help,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  meta: ReactNode;
  help?: string;
  tone?: "neutral" | "ok" | "warn" | "danger";
}): ReactNode {
  const card = (
    <div className="lkd-metric-card" data-tone={tone}>
      <span className="lkd-metric-label">{label}</span>
      <strong className="lkd-metric-value">{value}</strong>
      <span className="lkd-metric-meta">{meta}</span>
    </div>
  );
  if (help === undefined) return card;
  return (
    <Explainable as="div" block={true} description={help}>
      {card}
    </Explainable>
  );
}

function ProgressBar({
  value,
  label,
  tone = "ok",
}: {
  value: number;
  label: string;
  tone?: "ok" | "warn" | "danger";
}): ReactNode {
  return (
    <div className="lkd-progress" role="img" aria-label={`${label}: ${formatPercent(value)}`}>
      <span className="lkd-progress-fill" data-tone={tone} style={progressStyle(value)} />
    </div>
  );
}

function ProgressRow({
  label,
  value,
  help,
  tone = "ok",
}: {
  label: string;
  value: number;
  help: string;
  tone?: "ok" | "warn" | "danger";
}): ReactNode {
  return (
    <Explainable as="div" block={true} description={help}>
      <div className="lkd-status-bar-row">
        <span>{label}</span>
        <ProgressBar value={value} label={label} tone={tone} />
        <span>{formatPercent(value)}</span>
      </div>
    </Explainable>
  );
}

function partialIndexMessage(
  data: CapsuleDetailData,
  job: IndexingJobRecord | undefined,
  t: I18nTranslate,
): string {
  const missingVectors = data.health.chunkCount - data.health.vectorCount;
  if (job?.lastError?.code === "EMBEDDING_ADAPTER_FAILED") {
    return t("localKnowledge.detail.index.embeddingStopped", {
      message: job.lastError.message,
      count: missingVectors,
    });
  }
  if (missingVectors > 0) {
    return t("localKnowledge.detail.index.missingVectors", { count: missingVectors });
  }
  if (data.health.unsupportedDocuments > 0) {
    return t("localKnowledge.detail.index.unsupportedDocuments", {
      count: data.health.unsupportedDocuments,
    });
  }
  return t("localKnowledge.detail.index.aligned");
}

function IndexingStatusSection({ data }: { data: CapsuleDetailData }): ReactNode {
  const t = useTranslate();
  const job = latestJob(data);
  const total = job?.totalDocuments ?? data.health.documentCount;
  const completed = completedDocuments(job);
  const indexedDocumentCount = indexedDocuments(data);
  const documentProgress = total > 0 ? completed / total : 0;
  const indexedProgress =
    data.health.chunkCount > 0 ? data.health.vectorCount / data.health.chunkCount : 0;
  const missingVectors = Math.max(0, data.health.chunkCount - data.health.vectorCount);
  const jobDuration =
    job !== undefined
      ? formatDuration((job.finishedAt ?? Date.now()) - job.startedAt)
      : t("localKnowledge.detail.index.noJobRecorded");
  const elapsedMs = job !== undefined ? Math.max(Date.now() - job.startedAt, 1) : 0;
  const docsPerMs = completed > 0 ? completed / elapsedMs : 0;
  const etaMs = docsPerMs > 0 ? Math.max(0, total - completed) / docsPerMs : 0;
  const remainingLabel =
    job?.status === "running" && total > 0 && completed > 0
      ? t("localKnowledge.detail.index.eta", { duration: formatDuration(etaMs) })
      : jobDuration;
  const issueTone =
    missingVectors > 0 || data.health.failedDocuments > 0
      ? job?.lastError !== undefined
        ? "danger"
        : "warn"
      : "ok";

  return (
    <section aria-labelledby="lkd-index-status-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading help={t("localKnowledge.detail.help.indexStatus")}>
          <span id="lkd-index-status-heading">{t("localKnowledge.detail.index.title")}</span>
        </SectionHeading>
        <span className="lkd-live-note" aria-live="polite">
          {job?.status === "running"
            ? t("localKnowledge.detail.index.updating")
            : t("localKnowledge.detail.index.latestRun")}
        </span>
      </div>
      <div className="lkd-metric-grid">
        <MetricCard
          label={t("localKnowledge.detail.index.indexedDocuments")}
          help={t("localKnowledge.detail.help.indexedDocuments")}
          value={`${indexedDocumentCount.toString()} / ${data.health.documentCount.toString()}`}
          meta={t("localKnowledge.detail.index.failedSkipped", {
            failed: data.health.failedDocuments,
            skipped: data.health.skippedDocuments,
          })}
          tone={
            data.health.failedDocuments > 0
              ? "danger"
              : data.health.skippedDocuments > 0
                ? "warn"
                : "ok"
          }
        />
        <MetricCard
          label={t("localKnowledge.detail.index.vectors")}
          help={t("localKnowledge.detail.help.vectors")}
          value={`${data.health.vectorCount.toString()} / ${data.health.chunkCount.toString()}`}
          meta={
            missingVectors > 0
              ? t("localKnowledge.detail.index.chunksMissingVectors", { count: missingVectors })
              : t("localKnowledge.detail.index.allChunksEmbedded")
          }
          tone={missingVectors > 0 ? "danger" : "ok"}
        />
        <MetricCard
          label={t("localKnowledge.detail.index.latestJob")}
          help={t("localKnowledge.detail.help.latestJob")}
          value={
            job !== undefined
              ? jobStatusLabel(job.status, t)
              : t("localKnowledge.detail.index.notIndexed")
          }
          meta={remainingLabel}
          tone={
            job?.status === "failed" ? "danger" : job?.status === "running" ? "warn" : "neutral"
          }
        />
      </div>
      <div className="lkd-status-bars">
        <ProgressRow
          label={t("localKnowledge.detail.index.discoveryProgress")}
          value={documentProgress}
          help={t("localKnowledge.detail.help.discoveryProgress")}
        />
        <ProgressRow
          label={t("localKnowledge.detail.index.retrievalCoverage")}
          value={indexedProgress}
          help={t("localKnowledge.detail.help.retrievalCoverage")}
          tone={missingVectors > 0 ? "danger" : "ok"}
        />
      </div>
      <Explainable as="div" block={true} description={t("localKnowledge.detail.help.indexMessage")}>
        <p className="lkd-status-callout" data-tone={issueTone}>
          {partialIndexMessage(data, job, t)}
        </p>
      </Explainable>
    </section>
  );
}

// ---------------------------------------------------------------------------
// EmbeddingCompatibilitySection
// ---------------------------------------------------------------------------

function EmbeddingCompatibilitySection({ data }: { data: CapsuleDetailData }): ReactNode {
  const t = useTranslate();
  const compatibility = data.health.embeddingCompatibility;
  const status = compatibilityStatus(data);
  const tone = compatibilityTone(status);
  const pinnedModel =
    compatibility === undefined
      ? formatEmbeddingIdentity(data.health.embeddingIdentity)
      : `${compatibility.pinnedModelId} (${compatibility.pinnedVectorDimensions.toString()}d, ${compatibility.pinnedVectorMetric})`;
  const pinnedProvider = compatibility?.pinnedProvider ?? data.health.embeddingIdentity.provider;
  const currentModel =
    compatibility?.currentModelId ?? t("localKnowledge.detail.compatibility.notConfigured");
  const currentProvider =
    compatibility?.currentProvider ?? t("localKnowledge.detail.compatibility.noProvider");
  const message =
    compatibility?.message ??
    (data.health.vectorCompatible
      ? t("localKnowledge.detail.compatibility.readyMessage")
      : t("localKnowledge.detail.compatibility.fixGatewayMessage"));

  return (
    <section aria-labelledby="lkd-embedding-compat-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading help={t("localKnowledge.detail.help.embeddingSection")}>
          <span id="lkd-embedding-compat-heading">
            {t("localKnowledge.detail.compatibility.title")}
          </span>
        </SectionHeading>
        <span className="lkd-live-note">{compatibilityLabel(status, t)}</span>
      </div>
      <div className="lkd-metric-grid">
        <MetricCard
          label={t("localKnowledge.detail.compatibility.pinnedModel")}
          help={t("localKnowledge.detail.help.pinnedModel")}
          value={pinnedModel}
          meta={pinnedProvider}
        />
        <MetricCard
          label={t("localKnowledge.detail.compatibility.currentModel")}
          help={t("localKnowledge.detail.help.currentModel")}
          value={currentModel}
          meta={currentProvider}
        />
        <MetricCard
          label={t("localKnowledge.detail.compatibility.metric")}
          help={t("localKnowledge.detail.help.compatibility")}
          value={compatibilityLabel(status, t)}
          meta={compatibility?.reason ?? t("localKnowledge.detail.compatibility.legacyHealth")}
          tone={tone}
        />
      </div>
      <Explainable
        as="div"
        block={true}
        description={t("localKnowledge.detail.help.embeddingMessage")}
      >
        <p className="lkd-status-callout" data-tone={tone}>
          {message}
        </p>
      </Explainable>
    </section>
  );
}

// ---------------------------------------------------------------------------
// OverviewSection
// ---------------------------------------------------------------------------

function OverviewRow({
  label,
  value,
  help,
}: {
  label: string;
  value: ReactNode;
  help?: string;
}): ReactNode {
  return (
    <div className="lkd-row">
      <dt className="lkd-label">
        {help === undefined ? label : <Explainable description={help}>{label}</Explainable>}
      </dt>
      <dd className="lkd-value">{value}</dd>
    </div>
  );
}

function OverviewSection({ data }: { data: CapsuleDetailData }): ReactNode {
  const t = useTranslate();
  const { capsule, health } = data;
  const embId = capsule.embeddingModelIdentity;
  const status = compatibilityStatus(data);

  return (
    <section aria-labelledby="lkd-overview-heading">
      <SectionHeading help={t("localKnowledge.detail.help.overview")}>
        <span id="lkd-overview-heading">{t("localKnowledge.detail.overview.title")}</span>
      </SectionHeading>
      <dl className="lkd-dl">
        <OverviewRow label={t("localKnowledge.detail.overview.name")} value={capsule.displayName} />
        {capsule.description !== undefined ? (
          <OverviewRow
            label={t("localKnowledge.detail.overview.description")}
            value={capsule.description}
          />
        ) : null}
        {capsule.tags.length > 0 ? (
          <OverviewRow
            label={t("localKnowledge.detail.overview.tags")}
            value={
              <ul className="lkd-tags" aria-label={t("localKnowledge.detail.overview.tags")}>
                {capsule.tags.map((tag) => (
                  <li key={tag} className="lkd-tag">
                    {tag}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
        <OverviewRow
          label={t("common.status")}
          help={t("localKnowledge.detail.help.overviewStatus")}
          value={
            <span
              className="lk-badge"
              data-state={capsule.lifecycleState}
              role="status"
              aria-label={t("localKnowledge.detail.overview.statusAria", {
                status: STATUS_LABELS[capsule.lifecycleState],
              })}
            >
              {STATUS_LABELS[capsule.lifecycleState]}
            </span>
          }
        />
        <OverviewRow
          label={t("localKnowledge.detail.overview.embeddingModel")}
          help={t("localKnowledge.detail.help.overviewEmbeddingModel")}
          value={formatEmbeddingIdentity(embId)}
        />
        <OverviewRow
          label={t("localKnowledge.detail.overview.storageSize")}
          help={t("localKnowledge.detail.help.overviewStorage")}
          value={formatBytes(health.storageSizeBytes)}
        />
        <OverviewRow
          label={t("localKnowledge.detail.overview.unsupportedDocuments")}
          help={t("localKnowledge.detail.help.overviewUnsupported")}
          value={health.unsupportedDocuments.toString()}
        />
        {health.lastIndexedAt !== undefined ? (
          <OverviewRow
            label={t("localKnowledge.detail.overview.lastIndexed")}
            help={t("localKnowledge.detail.help.overviewLastIndexed")}
            value={formatTs(health.lastIndexedAt)}
          />
        ) : null}
        <OverviewRow
          label={t("localKnowledge.detail.overview.vectorCompatible")}
          help={t("localKnowledge.detail.help.overviewVectorCompatible")}
          value={
            status === "compatible"
              ? t("localKnowledge.detail.compatibility.compatible")
              : status === "unknown"
                ? t("localKnowledge.detail.overview.vectorUnknown")
                : t("localKnowledge.detail.overview.vectorIncompatible")
          }
        />
        {health.staleReasons.length > 0 ? (
          <OverviewRow
            label={t("localKnowledge.detail.overview.staleReasons")}
            help={t("localKnowledge.detail.help.overviewStaleReasons")}
            value={
              <ul
                className="lkd-stale-reasons"
                aria-label={t("localKnowledge.detail.overview.staleReasons")}
              >
                {health.staleReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
        ) : null}
        {health.unsupportedGuidance.length > 0 ? (
          <OverviewRow
            label={t("localKnowledge.detail.overview.nextSteps")}
            help={t("localKnowledge.detail.help.overviewNextSteps")}
            value={
              <ul
                className="lkd-stale-reasons"
                aria-label={t("localKnowledge.detail.overview.unsupportedGuidance")}
              >
                {health.unsupportedGuidance.map((guidance) => (
                  <li key={guidance}>{guidance}</li>
                ))}
              </ul>
            }
          />
        ) : null}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ContextualRetrievalSection
// ---------------------------------------------------------------------------

interface ContextualRetrievalSectionProps {
  readonly data: CapsuleDetailData;
  readonly onSaved: (data: CapsuleDetailData) => void;
  readonly updateImpl?: typeof updateCapsuleContextualRetrieval;
}

function positiveIntOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function settingInputValue(value: number | undefined): string {
  return value === undefined ? "" : value.toString();
}

function ContextualRetrievalSection({
  data,
  onSaved,
  updateImpl = updateCapsuleContextualRetrieval,
}: ContextualRetrievalSectionProps): ReactNode {
  const t = useTranslate();
  const settings = data.capsule.contextualRetrieval;
  const health = data.health.contextualRetrieval;
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [modelId, setModelId] = useState(settings?.modelId ?? "");
  const [strict, setStrict] = useState(settings?.strict ?? false);
  const [maxContextChars, setMaxContextChars] = useState(
    settingInputValue(settings?.maxContextChars),
  );
  const [documentContextMaxChars, setDocumentContextMaxChars] = useState(
    settingInputValue(settings?.documentContextMaxChars),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(settings?.enabled ?? false);
    setModelId(settings?.modelId ?? "");
    setStrict(settings?.strict ?? false);
    setMaxContextChars(settingInputValue(settings?.maxContextChars));
    setDocumentContextMaxChars(settingInputValue(settings?.documentContextMaxChars));
  }, [settings]);

  async function handleSave(): Promise<void> {
    const parsedMaxContextChars = positiveIntOrUndefined(maxContextChars);
    const parsedDocumentContextMaxChars = positiveIntOrUndefined(documentContextMaxChars);
    const next: CapsuleContextualRetrievalSettings = {
      enabled,
      ...(modelId.trim().length > 0 ? { modelId: modelId.trim() } : {}),
      strict,
      ...(parsedMaxContextChars !== undefined ? { maxContextChars: parsedMaxContextChars } : {}),
      ...(parsedDocumentContextMaxChars !== undefined
        ? { documentContextMaxChars: parsedDocumentContextMaxChars }
        : {}),
    };
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const updated = await updateImpl(data.capsule.id, next);
      onSaved(updated);
      setMessage(t("localKnowledge.detail.context.saved"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("localKnowledge.detail.context.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lkd-contextual-retrieval-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading help={t("localKnowledge.detail.help.contextualRetrieval")}>
          <span id="lkd-contextual-retrieval-heading">
            {t("localKnowledge.detail.context.title")}
          </span>
        </SectionHeading>
        <span className="lkd-live-note">{contextualStatusLabel(health?.status, t)}</span>
      </div>
      <p className="lkd-status-callout" data-tone={contextualTone(health?.status)}>
        {t("localKnowledge.detail.context.description")}
      </p>
      {health !== undefined ? (
        <div className="lkd-metric-grid">
          <MetricCard
            label={t("localKnowledge.detail.context.retrievalContext")}
            help={t("localKnowledge.detail.help.contextStatus")}
            value={contextualStatusLabel(health.status, t)}
            meta={t("localKnowledge.detail.context.settingsSource", { source: health.source })}
            tone={contextualTone(health.status)}
          />
          <MetricCard
            label={t("localKnowledge.detail.context.model")}
            help={t("localKnowledge.detail.help.contextModel")}
            value={health.modelId ?? t("localKnowledge.detail.context.gatewayDefault")}
            meta={
              health.strict
                ? t("localKnowledge.detail.context.strict")
                : t("localKnowledge.detail.context.nonStrict")
            }
          />
          <MetricCard
            label={t("localKnowledge.detail.context.staleChunks")}
            help={t("localKnowledge.detail.help.contextStale")}
            value={health.staleChunkCount.toString()}
            meta={t("localKnowledge.detail.context.degradedChunks", {
              count: health.degradedChunkCount,
            })}
            tone={health.rebuildRequired ? "warn" : health.degradedChunkCount > 0 ? "warn" : "ok"}
          />
        </div>
      ) : null}
      {health?.message !== undefined ? (
        <p
          className="lkd-status-callout"
          data-tone={contextualTone(health.status)}
          role={health.rebuildRequired ? "status" : undefined}
        >
          {health.message}
        </p>
      ) : null}
      <div className="lkd-connect-row">
        <label
          className="dlg-label"
          htmlFor="lkd-context-enabled"
          title={t("localKnowledge.detail.help.contextEnable")}
        >
          <input
            id="lkd-context-enabled"
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setEnabled(event.target.checked)}
          />{" "}
          {t("localKnowledge.detail.context.generateAtIndex")}
        </label>
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-context-model" className="dlg-label">
          <Explainable description={t("localKnowledge.detail.help.contextModelInput")}>
            {t("localKnowledge.detail.context.modelId")}
          </Explainable>
        </label>
        <input
          id="lkd-context-model"
          type="text"
          className="dlg-input lkd-connect-input"
          value={modelId}
          disabled={busy || !enabled}
          placeholder={t("localKnowledge.detail.context.defaultModelPlaceholder")}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setModelId(event.target.value)}
        />
      </div>
      <div className="lkd-connect-row">
        <label
          className="dlg-label"
          htmlFor="lkd-context-strict"
          title={t("localKnowledge.detail.help.contextStrict")}
        >
          <input
            id="lkd-context-strict"
            type="checkbox"
            checked={strict}
            disabled={busy || !enabled}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setStrict(event.target.checked)}
          />{" "}
          {t("localKnowledge.detail.context.failOnError")}
        </label>
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-context-max" className="dlg-label">
          <Explainable description={t("localKnowledge.detail.help.contextGeneratedLimit")}>
            {t("localKnowledge.detail.context.generatedLimit")}
          </Explainable>
        </label>
        <input
          id="lkd-context-max"
          type="number"
          min={1}
          className="dlg-input lkd-connect-input"
          value={maxContextChars}
          disabled={busy || !enabled}
          placeholder="480"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setMaxContextChars(event.target.value)
          }
        />
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-document-context-max" className="dlg-label">
          <Explainable description={t("localKnowledge.detail.help.contextDocumentLimit")}>
            {t("localKnowledge.detail.context.documentLimit")}
          </Explainable>
        </label>
        <input
          id="lkd-document-context-max"
          type="number"
          min={1}
          className="dlg-input lkd-connect-input"
          value={documentContextMaxChars}
          disabled={busy || !enabled}
          placeholder="12000"
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            setDocumentContextMaxChars(event.target.value)
          }
        />
      </div>
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        disabled={busy}
        aria-busy={busy}
        title={t("localKnowledge.detail.help.contextSave")}
        onClick={() => void handleSave()}
      >
        {busy ? t("common.saving") : t("localKnowledge.detail.context.save")}
      </button>
      {message !== null ? (
        <p className="lkd-status-callout" data-tone="warn" role="status">
          {message}
        </p>
      ) : null}
      {error !== null ? (
        <div role="alert" aria-live="assertive" className="lk-alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SourcesSection
// ---------------------------------------------------------------------------

function SourcesSection({
  capsuleId,
  sources,
  onActionComplete,
}: {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly sources: readonly SourceIndexStats[];
  readonly onActionComplete: () => void;
}): ReactNode {
  const t = useTranslate();
  if (sources.length === 0) {
    return (
      <section aria-labelledby="lkd-sources-heading">
        <SectionHeading help={t("localKnowledge.detail.help.sources")}>
          <span id="lkd-sources-heading">{t("localKnowledge.detail.sources.title")}</span>
        </SectionHeading>
        <p className="lkd-empty-note">{t("localKnowledge.detail.sources.empty")}</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="lkd-sources-heading">
      <SectionHeading help={t("localKnowledge.detail.help.sources")}>
        <span id="lkd-sources-heading">{t("localKnowledge.detail.sources.title")}</span>
      </SectionHeading>
      <ul className="lkd-list lkd-source-list" aria-label={t("localKnowledge.detail.sources.list")}>
        {sources.map((src) => {
          const total = sourceTotal(src);
          const location = scopeLocation(src.scope, t);
          return (
            <li
              key={src.sourceId}
              className="lkd-source-card"
              title={t("localKnowledge.detail.help.sourceCard")}
            >
              <div className="lkd-source-card-head">
                <div>
                  <div className="lkd-source-name" title={src.displayName}>
                    {src.displayName}
                  </div>
                  <div className="lkd-source-path" title={location}>
                    {location}
                  </div>
                </div>
                <div className="lkd-source-card-actions">
                  <span className="lkd-source-scope">{src.scope.kind}</span>
                  <SourceRebindControl
                    capsuleId={capsuleId}
                    source={src}
                    onRebound={onActionComplete}
                  />
                </div>
              </div>
              <div
                className="lkd-source-coverage"
                role="img"
                title={t("localKnowledge.detail.help.sourceCoverage")}
                aria-label={t("localKnowledge.detail.sources.coverage", {
                  indexed: src.indexedCount,
                  failed: src.failedCount,
                  skipped: src.skippedCount,
                })}
              >
                <span
                  className="lkd-source-segment lkd-source-segment-ok"
                  style={progressStyle(total > 0 ? src.indexedCount / total : 0)}
                />
                <span
                  className="lkd-source-segment lkd-source-segment-fail"
                  style={progressStyle(total > 0 ? src.failedCount / total : 0)}
                />
                <span
                  className="lkd-source-segment lkd-source-segment-skip"
                  style={progressStyle(total > 0 ? src.skippedCount / total : 0)}
                />
              </div>
              <div
                className="lkd-source-counts"
                aria-label={t("localKnowledge.detail.documentCounts")}
              >
                <span className="lkd-count lkd-count-ok">
                  {t("localKnowledge.detail.counts.indexed", { count: src.indexedCount })}
                </span>
                <span className="lkd-count lkd-count-fail">
                  {t("localKnowledge.detail.counts.failed", { count: src.failedCount })}
                </span>
                <span className="lkd-count lkd-count-skip">
                  {t("localKnowledge.detail.counts.skipped", { count: src.skippedCount })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PrivacySection(): ReactNode {
  const t = useTranslate();
  return (
    <section aria-labelledby="lkd-privacy-heading">
      <SectionHeading help={t("localKnowledge.detail.help.privacy")}>
        <span id="lkd-privacy-heading">{t("localKnowledge.detail.privacy.title")}</span>
      </SectionHeading>
      <ul className="lkd-list" aria-label={t("localKnowledge.detail.privacy.details")}>
        <li className="lkd-source-row">{t("localKnowledge.detail.privacy.localState")}</li>
        <li className="lkd-source-row">{t("localKnowledge.detail.privacy.modelGateway")}</li>
        <li className="lkd-source-row">{t("localKnowledge.detail.privacy.deletion")}</li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// HealthDiagnosticsSection
// Renders ONLY severity, code, message, and page_number.
// Raw extracted text is intentionally absent (browser-safety rule from contracts).
// ---------------------------------------------------------------------------

function diagnosticSeverityLabel(severity: ParserDiagnosticSeverity, t: I18nTranslate): string {
  if (severity === "info") return t("localKnowledge.detail.diagnostics.severity.info");
  if (severity === "warning") return t("localKnowledge.detail.diagnostics.severity.warning");
  return t("localKnowledge.detail.diagnostics.severity.error");
}

const MAX_DIAGNOSTIC_GROUPS = 8;

interface DiagnosticGroup {
  readonly key: string;
  readonly severity: ParserDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly count: number;
}

function diagnosticGroups(diagnostics: readonly ParserDiagnostic[]): readonly DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticGroup>();
  for (const diag of diagnostics) {
    const key = `${diag.severity}\u0000${diag.code}\u0000${diag.message}`;
    const existing = groups.get(key);
    groups.set(key, {
      key,
      severity: diag.severity,
      code: diag.code,
      message: diag.message,
      count: (existing?.count ?? 0) + 1,
    });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function DiagnosticGroupRow({ group, t }: { group: DiagnosticGroup; t: I18nTranslate }): ReactNode {
  const severityLabel = diagnosticSeverityLabel(group.severity, t);
  return (
    <li
      className="lkd-diag-group"
      data-severity={group.severity}
      title={t("localKnowledge.detail.help.diagnosticRow")}
      aria-label={t("localKnowledge.detail.diagnostics.groupAria", {
        severity: severityLabel,
        code: group.code,
        count: group.count,
      })}
    >
      <span className="lkd-diag-severity" aria-hidden="true">
        {severityLabel}
      </span>
      <span className="lkd-diag-group-count">{group.count.toString()}x</span>
      <span className="lkd-diag-code">{group.code}</span>
      <span className="lkd-diag-message">{group.message}</span>
    </li>
  );
}

function DiagnosticRow({ diag, t }: { diag: ParserDiagnostic; t: I18nTranslate }): ReactNode {
  const severityLabel = diagnosticSeverityLabel(diag.severity, t);
  return (
    <li
      className="lkd-diag-row"
      data-severity={diag.severity}
      title={t("localKnowledge.detail.help.diagnosticRow")}
      aria-label={t("localKnowledge.detail.diagnostics.rowAria", {
        severity: severityLabel,
        code: diag.code,
      })}
    >
      <span className="lkd-diag-severity" aria-hidden="true">
        {severityLabel}
      </span>
      <span className="lkd-diag-code">{diag.code}</span>
      <span className="lkd-diag-message">{diag.message}</span>
      {diag.pageNumber !== undefined ? (
        <span className="lkd-diag-page">p.{diag.pageNumber.toString()}</span>
      ) : null}
    </li>
  );
}

function HealthDiagnosticsSection({
  diagnostics,
}: {
  diagnostics: readonly ParserDiagnostic[];
}): ReactNode {
  const t = useTranslate();
  const { visibleCount, showAll, setShowAll } = useVisibleRows(diagnostics.length);
  const visible = diagnostics.slice(0, visibleCount);
  const hiddenCount = diagnostics.length - visible.length;
  const groups = diagnosticGroups(diagnostics).slice(0, MAX_DIAGNOSTIC_GROUPS);

  return (
    <section aria-labelledby="lkd-diag-heading">
      <SectionHeading help={t("localKnowledge.detail.help.diagnostics")}>
        <span id="lkd-diag-heading">{t("localKnowledge.detail.diagnostics.title")}</span>
      </SectionHeading>
      {diagnostics.length === 0 ? (
        <p className="lkd-empty-note" data-testid="diag-empty">
          {t("localKnowledge.detail.diagnostics.empty")}
        </p>
      ) : (
        <>
          <ul
            className="lkd-list lkd-diag-group-list"
            aria-label={t("localKnowledge.detail.diagnostics.groupedList")}
          >
            {groups.map((group) => (
              <DiagnosticGroupRow key={group.key} group={group} t={t} />
            ))}
          </ul>
          <ul
            className="lkd-list lkd-diag-list"
            aria-label={t("localKnowledge.detail.diagnostics.list")}
          >
            {visible.map((diag, i) => (
              <DiagnosticRow key={`${diag.code}-${i.toString()}`} diag={diag} t={t} />
            ))}
          </ul>
          <MoreRowsButton
            hiddenCount={hiddenCount}
            noun={t("localKnowledge.detail.rows.diagnostics")}
            showAll={showAll}
            onToggle={() => setShowAll(!showAll)}
            t={t}
          />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// IndexingJobsSection
// ---------------------------------------------------------------------------

function jobStatusLabel(status: IndexingJobStatus, t: I18nTranslate): string {
  if (status === "queued") return t("localKnowledge.detail.jobs.status.queued");
  if (status === "running") return t("localKnowledge.detail.jobs.status.running");
  if (status === "succeeded") return t("localKnowledge.detail.jobs.status.succeeded");
  if (status === "failed") return t("localKnowledge.detail.jobs.status.failed");
  return t("localKnowledge.detail.jobs.status.cancelled");
}

function JobRow({ job, t }: { job: IndexingJobRecord; t: I18nTranslate }): ReactNode {
  const duration =
    job.finishedAt !== undefined
      ? formatDuration(job.finishedAt - job.startedAt)
      : t("localKnowledge.detail.jobs.inProgress");
  return (
    <li
      className="lkd-job-row"
      title={t("localKnowledge.detail.help.jobRow")}
      aria-label={t("localKnowledge.detail.jobs.rowAria", {
        id: job.id,
        status: jobStatusLabel(job.status, t),
      })}
    >
      <span className="lkd-job-status" data-status={job.status}>
        {jobStatusLabel(job.status, t)}
      </span>
      <span className="lkd-job-dates">
        <time dateTime={new Date(job.startedAt).toISOString()}>{formatTs(job.startedAt)}</time>
        {job.finishedAt !== undefined ? (
          <>
            {" — "}
            <time dateTime={new Date(job.finishedAt).toISOString()}>
              {formatTs(job.finishedAt)}
            </time>
          </>
        ) : null}
      </span>
      <span className="lkd-job-duration">{duration}</span>
      <div className="lkd-source-counts" aria-label={t("localKnowledge.detail.documentCounts")}>
        <span className="lkd-count lkd-count-ok">
          {t("localKnowledge.detail.counts.processed", { count: job.processedDocuments })}
        </span>
        <span className="lkd-count lkd-count-fail">
          {t("localKnowledge.detail.counts.failed", { count: job.failedDocuments })}
        </span>
        <span className="lkd-count lkd-count-skip">
          {t("localKnowledge.detail.counts.skipped", { count: job.skippedDocuments })}
        </span>
      </div>
      {job.lastError !== undefined ? (
        <div className="lkd-job-error">
          <span>{job.lastError.code}</span>
          <span>{job.lastError.message}</span>
        </div>
      ) : null}
    </li>
  );
}

function IndexingJobsSection({ jobs }: { jobs: readonly IndexingJobRecord[] }): ReactNode {
  const t = useTranslate();
  const { visibleCount, showAll, setShowAll } = useVisibleRows(jobs.length);
  const visible = jobs.slice(0, visibleCount);
  const hiddenCount = jobs.length - visible.length;

  return (
    <section aria-labelledby="lkd-jobs-heading">
      <SectionHeading help={t("localKnowledge.detail.help.jobs")}>
        <span id="lkd-jobs-heading">{t("localKnowledge.detail.jobs.title")}</span>
      </SectionHeading>
      {jobs.length === 0 ? (
        <p className="lkd-empty-note">{t("localKnowledge.detail.jobs.empty")}</p>
      ) : (
        <>
          <ul className="lkd-list" aria-label={t("localKnowledge.detail.jobs.list")}>
            {visible.map((job) => (
              <JobRow key={job.id} job={job} t={t} />
            ))}
          </ul>
          <MoreRowsButton
            hiddenCount={hiddenCount}
            noun={t("localKnowledge.detail.rows.jobs")}
            showAll={showAll}
            onToggle={() => setShowAll(!showAll)}
            t={t}
          />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CapsuleDetail — root export
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LargeDocumentSection (Epic #1160, Issue #1286)
// Granular per-document progress, partial-coverage badge, retrieval-quality
// warnings, and a Resume control for interrupted large-document jobs.
// ---------------------------------------------------------------------------

function phaseLabel(phase: ExtractionPhase, t: I18nTranslate): string {
  if (phase === "preflight") return t("localKnowledge.detail.large.phase.preflight");
  if (phase === "extracting") return t("localKnowledge.detail.large.phase.extracting");
  if (phase === "extracted") return t("localKnowledge.detail.large.phase.extracted");
  if (phase === "chunking") return t("localKnowledge.detail.large.phase.chunking");
  if (phase === "chunked") return t("localKnowledge.detail.large.phase.chunked");
  if (phase === "embedding") return t("localKnowledge.detail.large.phase.embedding");
  if (phase === "embedded") return t("localKnowledge.detail.large.phase.embedded");
  if (phase === "complete") return t("localKnowledge.detail.large.phase.complete");
  if (phase === "cancelled") return t("localKnowledge.detail.large.phase.cancelled");
  return t("localKnowledge.detail.large.phase.failed");
}

function coverageTone(coverage: CoverageQuality): "ok" | "warn" | "danger" {
  if (coverage === "complete") return "ok";
  if (coverage === "none") return "danger";
  return "warn";
}

function LargeDocumentRow({
  progress,
  t,
}: {
  progress: LargeDocumentJobProgress;
  t: I18nTranslate;
}): ReactNode {
  return (
    <li className="lkd-source-card" title={t("localKnowledge.detail.help.largeDocumentRow")}>
      <div className="lkd-source-card-head">
        <div className="lkd-source-name" title={progress.safeDisplayName}>
          {progress.safeDisplayName}
        </div>
        <span className="lkd-source-scope">{phaseLabel(progress.phase, t)}</span>
      </div>
      <div className="lkd-metric-meta">
        <span data-tone={coverageTone(progress.coverage)}>
          {t("localKnowledge.detail.large.coverage", { coverage: progress.coverage })}
        </span>
        {" · "}
        {t("localKnowledge.detail.large.pages", { count: progress.processedPages })}
        {" · "}
        {t("localKnowledge.detail.large.chunksEmbedded", {
          embedded: progress.embeddedChunkCount,
          chunks: progress.chunkCount,
        })}
        {progress.resumable ? ` · ${t("localKnowledge.detail.large.resumable")}` : ""}
      </div>
    </li>
  );
}

interface LargeDocumentSectionProps {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly health: CapsuleLargeDocumentHealth;
  readonly onActionComplete: () => void;
  readonly jobActive: boolean;
  readonly resumeImpl?: typeof resumeCapsuleLargeDocuments;
}

function LargeDocumentSection({
  capsuleId,
  health,
  onActionComplete,
  jobActive,
  resumeImpl,
}: LargeDocumentSectionProps): ReactNode {
  const t = useTranslate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (health.progress.length === 0) return null;

  const activePhases = health.progress
    .filter((p) => !isTerminalExtractionPhase(p.phase))
    .map((p) => phaseLabel(p.phase, t));

  async function handleResume(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await (resumeImpl ?? resumeCapsuleLargeDocuments)(capsuleId);
      onActionComplete();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("localKnowledge.detail.large.resumeFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lkd-large-doc-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading help={t("localKnowledge.detail.help.largeDocuments")}>
          <span id="lkd-large-doc-heading">{t("localKnowledge.detail.large.title")}</span>
        </SectionHeading>
        <span className="lkd-live-note" role="status" aria-live="polite">
          {activePhases.length > 0
            ? t("localKnowledge.detail.large.inProgress", { phases: activePhases.join(", ") })
            : t("localKnowledge.detail.large.idle")}
        </span>
      </div>
      {health.partialCoverageDocuments > 0 ? (
        <p className="lkd-status-callout" data-tone="warn">
          {t(
            health.partialCoverageDocuments === 1
              ? "localKnowledge.detail.large.partialCoverage.one"
              : "localKnowledge.detail.large.partialCoverage.many",
            { count: health.partialCoverageDocuments },
          )}
        </p>
      ) : null}
      <ul className="lkd-list lkd-source-list" aria-label={t("localKnowledge.detail.large.list")}>
        {health.progress.map((progress) => (
          <LargeDocumentRow key={progress.documentId} progress={progress} t={t} />
        ))}
      </ul>
      {health.qualityWarnings.length > 0 ? (
        <ul
          className="lkd-stale-reasons"
          aria-label={t("localKnowledge.detail.large.qualityWarnings")}
        >
          {health.qualityWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {health.resumableDocuments.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            void handleResume();
          }}
          disabled={busy || jobActive}
          aria-label={t("localKnowledge.detail.large.resumeAria")}
          title={t("localKnowledge.detail.help.largeResume")}
          className="lk-action-button"
        >
          {busy
            ? t("localKnowledge.detail.large.resuming")
            : t(
                health.resumableDocuments.length === 1
                  ? "localKnowledge.detail.large.resume.one"
                  : "localKnowledge.detail.large.resume.many",
                { count: health.resumableDocuments.length },
              )}
        </button>
      ) : null}
      {error !== null ? (
        <div role="alert" aria-live="assertive" className="lk-alert">
          {error}
        </div>
      ) : null}
    </section>
  );
}

export interface CapsuleDetailProps {
  readonly capsuleId?: KnowledgeCapsuleId;
  readonly onDeleted?: (response: CapsuleActionResponse) => void;
  // Injectable fetch seam — defaults to the real BFF helper. Tests pass a mock
  // so they never hit the network, following the ConnectorGraph seam pattern.
  readonly fetchDetailImpl?: typeof import("@/lib/local-knowledge-api").fetchCapsuleDetail;
  // Injectable resume seam for the large-document Resume control (tests pass a mock).
  readonly resumeImpl?: typeof resumeCapsuleLargeDocuments;
  readonly updateContextualRetrievalImpl?: typeof updateCapsuleContextualRetrieval;
}

export function CapsuleDetail({
  capsuleId: providedCapsuleId,
  onDeleted,
  fetchDetailImpl,
  resumeImpl,
  updateContextualRetrievalImpl,
}: CapsuleDetailProps = {}): ReactNode {
  const t = useTranslate();
  const searchParams = useSearchParams();
  const router = useRouter();
  const capsuleId =
    providedCapsuleId ?? ((searchParams.get("capsuleId") ?? "") as KnowledgeCapsuleId);

  const { data, loadStatus, loadError, reload, replaceData } = useCapsuleDetail(
    capsuleId,
    fetchDetailImpl,
  );

  function handleDeleted(response: CapsuleActionResponse): void {
    if (onDeleted !== undefined) {
      onDeleted(response);
      return;
    }
    router.push("/local-knowledge");
  }

  if (loadStatus === "loading") {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        {t("localKnowledge.detail.loading")}
      </p>
    );
  }

  if (loadStatus === "error" || data === null) {
    // Missing capsuleId is not a transient failure — retrying with the same
    // empty id can never succeed. Offer the way back to the overview instead
    // (uiux-fix F033, C229).
    if (capsuleId === "") {
      return (
        <div role="alert" aria-live="assertive" className="lk-alert">
          {t("localKnowledge.detail.noSelection")}
          <Link href="/local-knowledge" className="lk-alert-retry">
            {t("localKnowledge.detail.backToLocalKnowledge")}
          </Link>
        </div>
      );
    }
    const isMissingCapsule =
      loadError?.includes("NOT_FOUND") === true ||
      loadError?.toLowerCase().includes("not found") === true;
    if (isMissingCapsule) {
      return (
        <div role="alert" aria-live="assertive" className="lk-alert">
          {t("localKnowledge.detail.notFound")}
          <Link href="/local-knowledge" className="lk-alert-retry">
            {t("localKnowledge.overview.backToPods")}
          </Link>
        </div>
      );
    }
    return (
      <div role="alert" aria-live="assertive" className="lk-alert">
        {loadError ?? t("localKnowledge.detail.loadFailed")}
        <button
          type="button"
          onClick={reload}
          aria-label={t("localKnowledge.detail.retryLoad")}
          className="lk-alert-retry"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className={`lkd-content ${detailStyles.detailContent}`}>
      <header className={`lk-header ${detailStyles.podHeader}`}>
        <h1 className={`lk-title ${detailStyles.podTitle}`}>{data.capsule.displayName}</h1>
        <CapsuleRename
          capsuleId={capsuleId}
          displayName={data.capsule.displayName}
          {...(data.capsule.description !== undefined
            ? { description: data.capsule.description }
            : {})}
          onRenamed={reload}
        />
      </header>

      {/* Own block below the header: the multi-line connect form, Index-now row
          and action buttons no longer compete with the H1 inside the
          .lk-header flex row (uiux-fix F033, C104). */}
      <CapsuleActions
        capsuleId={capsuleId}
        capsuleDisplayName={data.capsule.displayName}
        sourceCount={data.sources.length}
        lifecycleState={data.capsule.lifecycleState}
        vectorCompatible={data.health.vectorCompatible}
        contextualRebuildRequired={data.health.contextualRetrieval?.rebuildRequired ?? false}
        onActionComplete={reload}
        onDeleted={handleDeleted}
      />

      <IndexingStatusSection data={data} />
      <details className={detailStyles.advancedDisclosure}>
        <summary className={detailStyles.disclosureSummary}>
          <span>
            <Explainable description={t("localKnowledge.detail.help.advanced")}>
              {t("localKnowledge.detail.advanced.summary")}
            </Explainable>
          </span>
          <span>{t("localKnowledge.detail.advanced.hint")}</span>
          <span className={detailStyles.disclosureIcon} aria-hidden="true" />
        </summary>
        <div className={detailStyles.advancedStack}>
          <EmbeddingCompatibilitySection data={data} />
          <ContextualRetrievalSection
            data={data}
            onSaved={replaceData}
            {...(updateContextualRetrievalImpl !== undefined
              ? { updateImpl: updateContextualRetrievalImpl }
              : {})}
          />
          {data.largeDocumentHealth !== undefined ? (
            <LargeDocumentSection
              capsuleId={capsuleId}
              health={data.largeDocumentHealth}
              onActionComplete={reload}
              jobActive={
                data.capsule.lifecycleState === "indexing" ||
                latestJob(data)?.status === "running" ||
                latestJob(data)?.status === "queued"
              }
              {...(resumeImpl !== undefined ? { resumeImpl } : {})}
            />
          ) : null}
          <SourcesSection capsuleId={capsuleId} sources={data.sources} onActionComplete={reload} />
          <OverviewSection data={data} />
          <PrivacySection />
          <HealthDiagnosticsSection diagnostics={data.parserDiagnostics} />
          <IndexingJobsSection jobs={data.indexingJobs} />
        </div>
      </details>
    </div>
  );
}
