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
import Link from "next/link";
import { STATUS_LABELS } from "../connector-graph-types";
import { useCapsuleDetail } from "./capsule-detail-state";
import { CapsuleActions } from "./capsule-actions";
import { CapsuleRename } from "./capsule-rename";
import { SourceRebindControl } from "./source-rebind-control";

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

function scopeLocation(scope: SourceIndexStats["scope"]): string {
  if (scope.kind === "folder") return scope.rootPath;
  if (scope.kind === "repository") return scope.repositoryRoot;
  return `${scope.rootPath} (${scope.files.length.toString()} selected files)`;
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

function compatibilityLabel(status: EmbeddingCompatibility["status"]): string {
  if (status === "compatible") return "Compatible";
  if (status === "unknown") return "Unknown";
  return "Incompatible";
}

function contextualTone(
  status: ContextualRetrievalHealth["status"] | undefined,
): "neutral" | "ok" | "warn" | "danger" {
  if (status === "ready") return "ok";
  if (status === "unavailable") return "danger";
  if (status === "rebuild-required" || status === "degraded") return "warn";
  return "neutral";
}

function contextualStatusLabel(status: ContextualRetrievalHealth["status"] | undefined): string {
  if (status === "ready") return "Ready";
  if (status === "rebuild-required") return "Rebuild required";
  if (status === "degraded") return "Degraded";
  if (status === "unavailable") return "Unavailable";
  return "Disabled";
}

// ---------------------------------------------------------------------------
// SectionHeading
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: ReactNode }): ReactNode {
  return <h2 className="lk-section-head">{children}</h2>;
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
}: {
  hiddenCount: number;
  showAll: boolean;
  onToggle: () => void;
  noun: string;
}): ReactNode {
  if (!showAll && hiddenCount <= 0) return null;
  return (
    <button type="button" className="lk-btn lk-btn-ghost" onClick={onToggle}>
      {showAll ? `Show fewer ${noun}` : `Show ${hiddenCount.toString()} more ${noun}`}
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
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  meta: ReactNode;
  tone?: "neutral" | "ok" | "warn" | "danger";
}): ReactNode {
  return (
    <div className="lkd-metric-card" data-tone={tone}>
      <span className="lkd-metric-label">{label}</span>
      <strong className="lkd-metric-value">{value}</strong>
      <span className="lkd-metric-meta">{meta}</span>
    </div>
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

function partialIndexMessage(data: CapsuleDetailData, job: IndexingJobRecord | undefined): string {
  const missingVectors = data.health.chunkCount - data.health.vectorCount;
  if (job?.lastError?.code === "EMBEDDING_ADAPTER_FAILED") {
    return `Embedding stopped early: ${job.lastError.message}. ${missingVectors.toString()} chunks still need vectors.`;
  }
  if (missingVectors > 0) {
    return `${missingVectors.toString()} chunks still need vectors before retrieval can cover the full source.`;
  }
  if (data.health.unsupportedDocuments > 0) {
    return `${data.health.unsupportedDocuments.toString()} documents need a different extraction path before they can be indexed.`;
  }
  return "Index and vectors are aligned for the current source set.";
}

function IndexingStatusSection({ data }: { data: CapsuleDetailData }): ReactNode {
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
      : "No job recorded";
  const elapsedMs = job !== undefined ? Math.max(Date.now() - job.startedAt, 1) : 0;
  const docsPerMs = completed > 0 ? completed / elapsedMs : 0;
  const etaMs = docsPerMs > 0 ? Math.max(0, total - completed) / docsPerMs : 0;
  const remainingLabel =
    job?.status === "running" && total > 0 && completed > 0
      ? `ETA ${formatDuration(etaMs)}`
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
        <SectionHeading>
          <span id="lkd-index-status-heading">Index status</span>
        </SectionHeading>
        <span className="lkd-live-note" aria-live="polite">
          {job?.status === "running" ? "Updating every 2s" : "Latest run"}
        </span>
      </div>
      <div className="lkd-metric-grid">
        <MetricCard
          label="Indexed documents"
          value={`${indexedDocumentCount.toString()} / ${data.health.documentCount.toString()}`}
          meta={`${data.health.failedDocuments.toString()} failed, ${data.health.skippedDocuments.toString()} skipped`}
          tone={
            data.health.failedDocuments > 0
              ? "danger"
              : data.health.skippedDocuments > 0
                ? "warn"
                : "ok"
          }
        />
        <MetricCard
          label="Vectors"
          value={`${data.health.vectorCount.toString()} / ${data.health.chunkCount.toString()}`}
          meta={
            missingVectors > 0
              ? `${missingVectors.toString()} chunks missing vectors`
              : "All chunks embedded"
          }
          tone={missingVectors > 0 ? "danger" : "ok"}
        />
        <MetricCard
          label="Latest job"
          value={job !== undefined ? JOB_STATUS_LABEL[job.status] : "Not indexed"}
          meta={remainingLabel}
          tone={
            job?.status === "failed" ? "danger" : job?.status === "running" ? "warn" : "neutral"
          }
        />
      </div>
      <div className="lkd-status-bars">
        <div className="lkd-status-bar-row">
          <span>Discovery progress</span>
          <ProgressBar value={documentProgress} label="Document discovery progress" />
          <span>{formatPercent(documentProgress)}</span>
        </div>
        <div className="lkd-status-bar-row">
          <span>Retrieval coverage</span>
          <ProgressBar
            value={indexedProgress}
            label="Vector retrieval coverage"
            tone={missingVectors > 0 ? "danger" : "ok"}
          />
          <span>{formatPercent(indexedProgress)}</span>
        </div>
      </div>
      <p className="lkd-status-callout" data-tone={issueTone}>
        {partialIndexMessage(data, job)}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// EmbeddingCompatibilitySection
// ---------------------------------------------------------------------------

function EmbeddingCompatibilitySection({ data }: { data: CapsuleDetailData }): ReactNode {
  const compatibility = data.health.embeddingCompatibility;
  const status = compatibilityStatus(data);
  const tone = compatibilityTone(status);
  const pinnedModel =
    compatibility === undefined
      ? formatEmbeddingIdentity(data.health.embeddingIdentity)
      : `${compatibility.pinnedModelId} (${compatibility.pinnedVectorDimensions.toString()}d, ${compatibility.pinnedVectorMetric})`;
  const pinnedProvider = compatibility?.pinnedProvider ?? data.health.embeddingIdentity.provider;
  const currentModel = compatibility?.currentModelId ?? "Not configured";
  const currentProvider = compatibility?.currentProvider ?? "No embedding provider";
  const message =
    compatibility?.message ??
    (data.health.vectorCompatible
      ? "The pinned embedding model is configured for embeddings."
      : "Embedding compatibility could not be confirmed. Run full re-embed after fixing the Gateway configuration.");

  return (
    <section aria-labelledby="lkd-embedding-compat-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading>
          <span id="lkd-embedding-compat-heading">Embedding compatibility</span>
        </SectionHeading>
        <span className="lkd-live-note">{compatibilityLabel(status)}</span>
      </div>
      <div className="lkd-metric-grid">
        <MetricCard label="Pinned model" value={pinnedModel} meta={pinnedProvider} />
        <MetricCard label="Current embedding model" value={currentModel} meta={currentProvider} />
        <MetricCard
          label="Compatibility"
          value={compatibilityLabel(status)}
          meta={compatibility?.reason ?? "legacy-health"}
          tone={tone}
        />
      </div>
      <p className="lkd-status-callout" data-tone={tone}>
        {message}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// OverviewSection
// ---------------------------------------------------------------------------

function OverviewRow({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className="lkd-row">
      <dt className="lkd-label">{label}</dt>
      <dd className="lkd-value">{value}</dd>
    </div>
  );
}

function OverviewSection({ data }: { data: CapsuleDetailData }): ReactNode {
  const { capsule, health } = data;
  const embId = capsule.embeddingModelIdentity;
  const status = compatibilityStatus(data);

  return (
    <section aria-labelledby="lkd-overview-heading">
      <SectionHeading>
        <span id="lkd-overview-heading">Overview</span>
      </SectionHeading>
      <dl className="lkd-dl">
        <OverviewRow label="Name" value={capsule.displayName} />
        {capsule.description !== undefined ? (
          <OverviewRow label="Description" value={capsule.description} />
        ) : null}
        {capsule.tags.length > 0 ? (
          <OverviewRow
            label="Tags"
            value={
              <ul className="lkd-tags" aria-label="Knowledge Pod tags">
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
          label="Status"
          value={
            <span
              className="lk-badge"
              data-state={capsule.lifecycleState}
              role="status"
              aria-label={`Status: ${STATUS_LABELS[capsule.lifecycleState]}`}
            >
              {STATUS_LABELS[capsule.lifecycleState]}
            </span>
          }
        />
        <OverviewRow label="Embedding model" value={formatEmbeddingIdentity(embId)} />
        <OverviewRow label="Storage size" value={formatBytes(health.storageSizeBytes)} />
        <OverviewRow label="Unsupported documents" value={health.unsupportedDocuments.toString()} />
        {health.lastIndexedAt !== undefined ? (
          <OverviewRow label="Last indexed" value={formatTs(health.lastIndexedAt)} />
        ) : null}
        <OverviewRow
          label="Vector compatible"
          value={
            status === "compatible"
              ? "Compatible"
              : status === "unknown"
                ? "Unknown — check Gateway configuration"
                : "Incompatible — full re-embed required"
          }
        />
        {health.staleReasons.length > 0 ? (
          <OverviewRow
            label="Stale reasons"
            value={
              <ul className="lkd-stale-reasons" aria-label="Stale reasons">
                {health.staleReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
        ) : null}
        {health.unsupportedGuidance.length > 0 ? (
          <OverviewRow
            label="Next steps"
            value={
              <ul className="lkd-stale-reasons" aria-label="Unsupported document guidance">
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
      setMessage("Saved. Full rebuild / rechunk this pod to apply retrieval text changes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save contextual retrieval.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lkd-contextual-retrieval-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading>
          <span id="lkd-contextual-retrieval-heading">Contextual retrieval</span>
        </SectionHeading>
        <span className="lkd-live-note">{contextualStatusLabel(health?.status)}</span>
      </div>
      <p className="lkd-status-callout" data-tone={contextualTone(health?.status)}>
        Adds a context-generation chat call per chunk during indexing. Run Full rebuild / rechunk
        after saving.
      </p>
      {health !== undefined ? (
        <div className="lkd-metric-grid">
          <MetricCard
            label="Retrieval context"
            value={contextualStatusLabel(health.status)}
            meta={`settings: ${health.source}`}
            tone={contextualTone(health.status)}
          />
          <MetricCard
            label="Context model"
            value={health.modelId ?? "Gateway default"}
            meta={health.strict ? "strict" : "non-strict fallback"}
          />
          <MetricCard
            label="Stale context chunks"
            value={health.staleChunkCount.toString()}
            meta={`${health.degradedChunkCount.toString()} degraded`}
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
        <label className="dlg-label" htmlFor="lkd-context-enabled">
          <input
            id="lkd-context-enabled"
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setEnabled(event.target.checked)}
          />{" "}
          Generate retrieval context at index time
        </label>
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-context-model" className="dlg-label">
          Context model ID
        </label>
        <input
          id="lkd-context-model"
          type="text"
          className="dlg-input lkd-connect-input"
          value={modelId}
          disabled={busy || !enabled}
          placeholder="Use gateway default chat model"
          onChange={(event: ChangeEvent<HTMLInputElement>) => setModelId(event.target.value)}
        />
      </div>
      <div className="lkd-connect-row">
        <label className="dlg-label" htmlFor="lkd-context-strict">
          <input
            id="lkd-context-strict"
            type="checkbox"
            checked={strict}
            disabled={busy || !enabled}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setStrict(event.target.checked)}
          />{" "}
          Fail indexing if context generation fails
        </label>
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-context-max" className="dlg-label">
          Generated context character limit
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
          Document context character limit
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
        onClick={() => void handleSave()}
      >
        {busy ? "Saving…" : "Save retrieval settings"}
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
  if (sources.length === 0) {
    return (
      <section aria-labelledby="lkd-sources-heading">
        <SectionHeading>
          <span id="lkd-sources-heading">Sources</span>
        </SectionHeading>
        <p className="lkd-empty-note">No sources attached to this pod.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="lkd-sources-heading">
      <SectionHeading>
        <span id="lkd-sources-heading">Sources</span>
      </SectionHeading>
      <ul className="lkd-list lkd-source-list" aria-label="Knowledge Pod sources">
        {sources.map((src) => {
          const total = sourceTotal(src);
          const location = scopeLocation(src.scope);
          return (
            <li key={src.sourceId} className="lkd-source-card">
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
                aria-label={`Source document coverage: ${src.indexedCount.toString()} indexed, ${src.failedCount.toString()} failed, ${src.skippedCount.toString()} skipped`}
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
              <div className="lkd-source-counts" aria-label="Document counts">
                <span className="lkd-count lkd-count-ok">
                  {src.indexedCount.toString()} indexed
                </span>
                <span className="lkd-count lkd-count-fail">
                  {src.failedCount.toString()} failed
                </span>
                <span className="lkd-count lkd-count-skip">
                  {src.skippedCount.toString()} skipped
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
  return (
    <section aria-labelledby="lkd-privacy-heading">
      <SectionHeading>
        <span id="lkd-privacy-heading">Privacy and deletion</span>
      </SectionHeading>
      <ul className="lkd-list" aria-label="Privacy and deletion details">
        <li className="lkd-source-row">
          Indexed text, vectors, diagnostics, and job history stay in Keiko&apos;s local runtime
          state on this machine.
        </li>
        <li className="lkd-source-row">
          Selected chunks may be sent through the configured Model Gateway for embeddings during
          indexing and for grounded answers when you ask questions against this Knowledge Pod.
        </li>
        <li className="lkd-source-row">
          Deleting a Knowledge Pod removes its local index data and Knowledge Pod Set memberships.
          Source files on disk are not deleted.
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// HealthDiagnosticsSection
// Renders ONLY severity, code, message, and page_number.
// Raw extracted text is intentionally absent (browser-safety rule from contracts).
// ---------------------------------------------------------------------------

const DIAG_SEVERITY_LABEL: Record<ParserDiagnosticSeverity, string> = {
  info: "Info",
  warning: "Warning",
  error: "Error",
};

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

function DiagnosticGroupRow({ group }: { group: DiagnosticGroup }): ReactNode {
  return (
    <li
      className="lkd-diag-group"
      data-severity={group.severity}
      aria-label={`${DIAG_SEVERITY_LABEL[group.severity]}: ${group.code} (${group.count.toString()}x)`}
    >
      <span className="lkd-diag-severity" aria-hidden="true">
        {DIAG_SEVERITY_LABEL[group.severity]}
      </span>
      <span className="lkd-diag-group-count">{group.count.toString()}x</span>
      <span className="lkd-diag-code">{group.code}</span>
      <span className="lkd-diag-message">{group.message}</span>
    </li>
  );
}

function DiagnosticRow({ diag }: { diag: ParserDiagnostic }): ReactNode {
  return (
    <li
      className="lkd-diag-row"
      data-severity={diag.severity}
      aria-label={`${DIAG_SEVERITY_LABEL[diag.severity]}: ${diag.code}`}
    >
      <span className="lkd-diag-severity" aria-hidden="true">
        {DIAG_SEVERITY_LABEL[diag.severity]}
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
  const { visibleCount, showAll, setShowAll } = useVisibleRows(diagnostics.length);
  const visible = diagnostics.slice(0, visibleCount);
  const hiddenCount = diagnostics.length - visible.length;
  const groups = diagnosticGroups(diagnostics).slice(0, MAX_DIAGNOSTIC_GROUPS);

  return (
    <section aria-labelledby="lkd-diag-heading">
      <SectionHeading>
        <span id="lkd-diag-heading">Health Diagnostics</span>
      </SectionHeading>
      {diagnostics.length === 0 ? (
        <p className="lkd-empty-note" data-testid="diag-empty">
          No parser diagnostics — all documents processed cleanly.
        </p>
      ) : (
        <>
          <ul className="lkd-list lkd-diag-group-list" aria-label="Grouped parser diagnostics">
            {groups.map((group) => (
              <DiagnosticGroupRow key={group.key} group={group} />
            ))}
          </ul>
          <ul className="lkd-list lkd-diag-list" aria-label="Parser diagnostics">
            {visible.map((diag, i) => (
              <DiagnosticRow key={`${diag.code}-${i.toString()}`} diag={diag} />
            ))}
          </ul>
          <MoreRowsButton
            hiddenCount={hiddenCount}
            noun="diagnostics"
            showAll={showAll}
            onToggle={() => setShowAll(!showAll)}
          />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// IndexingJobsSection
// ---------------------------------------------------------------------------

const JOB_STATUS_LABEL: Record<IndexingJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

function JobRow({ job }: { job: IndexingJobRecord }): ReactNode {
  const duration =
    job.finishedAt !== undefined ? formatDuration(job.finishedAt - job.startedAt) : "In progress";
  return (
    <li className="lkd-job-row" aria-label={`Job ${job.id}: ${JOB_STATUS_LABEL[job.status]}`}>
      <span className="lkd-job-status" data-status={job.status}>
        {JOB_STATUS_LABEL[job.status]}
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
      <div className="lkd-source-counts" aria-label="Document counts">
        <span className="lkd-count lkd-count-ok">
          {job.processedDocuments.toString()} processed
        </span>
        <span className="lkd-count lkd-count-fail">{job.failedDocuments.toString()} failed</span>
        <span className="lkd-count lkd-count-skip">{job.skippedDocuments.toString()} skipped</span>
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
  const { visibleCount, showAll, setShowAll } = useVisibleRows(jobs.length);
  const visible = jobs.slice(0, visibleCount);
  const hiddenCount = jobs.length - visible.length;

  return (
    <section aria-labelledby="lkd-jobs-heading">
      <SectionHeading>
        <span id="lkd-jobs-heading">Indexing Job History</span>
      </SectionHeading>
      {jobs.length === 0 ? (
        <p className="lkd-empty-note">No indexing jobs recorded yet.</p>
      ) : (
        <>
          <ul className="lkd-list" aria-label="Indexing job history">
            {visible.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
          <MoreRowsButton
            hiddenCount={hiddenCount}
            noun="jobs"
            showAll={showAll}
            onToggle={() => setShowAll(!showAll)}
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

const PHASE_LABELS: Readonly<Record<ExtractionPhase, string>> = {
  preflight: "Preflight",
  extracting: "Extracting",
  extracted: "Extracted",
  chunking: "Chunking",
  chunked: "Chunked",
  embedding: "Embedding",
  embedded: "Embedded",
  complete: "Complete",
  cancelled: "Cancelled",
  failed: "Failed",
};

function coverageTone(coverage: CoverageQuality): "ok" | "warn" | "danger" {
  if (coverage === "complete") return "ok";
  if (coverage === "none") return "danger";
  return "warn";
}

function LargeDocumentRow({ progress }: { progress: LargeDocumentJobProgress }): ReactNode {
  return (
    <li className="lkd-source-card">
      <div className="lkd-source-card-head">
        <div className="lkd-source-name" title={progress.safeDisplayName}>
          {progress.safeDisplayName}
        </div>
        <span className="lkd-source-scope">{PHASE_LABELS[progress.phase]}</span>
      </div>
      <div className="lkd-metric-meta">
        <span data-tone={coverageTone(progress.coverage)}>{progress.coverage} coverage</span>
        {" · "}
        {progress.processedPages.toString()} pages {" · "}
        {progress.embeddedChunkCount.toString()}/{progress.chunkCount.toString()} chunks embedded
        {progress.resumable ? " · resumable" : ""}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (health.progress.length === 0) return null;

  const activePhases = health.progress
    .filter((p) => !isTerminalExtractionPhase(p.phase))
    .map((p) => PHASE_LABELS[p.phase]);

  async function handleResume(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await (resumeImpl ?? resumeCapsuleLargeDocuments)(capsuleId);
      onActionComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Resume failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="lkd-large-doc-heading" className="lkd-status-section">
      <div className="lkd-section-title-row">
        <SectionHeading>
          <span id="lkd-large-doc-heading">Large documents</span>
        </SectionHeading>
        <span className="lkd-live-note" role="status" aria-live="polite">
          {activePhases.length > 0 ? `In progress: ${activePhases.join(", ")}` : "Idle"}
        </span>
      </div>
      {health.partialCoverageDocuments > 0 ? (
        <p className="lkd-status-callout" data-tone="warn">
          {health.partialCoverageDocuments.toString()} document
          {health.partialCoverageDocuments === 1 ? "" : "s"} indexed with partial coverage. The
          pipeline is stable; retrieval quality is limited for these documents.
        </p>
      ) : null}
      <ul className="lkd-list lkd-source-list" aria-label="Large-document progress">
        {health.progress.map((progress) => (
          <LargeDocumentRow key={progress.documentId} progress={progress} />
        ))}
      </ul>
      {health.qualityWarnings.length > 0 ? (
        <ul className="lkd-stale-reasons" aria-label="Retrieval quality warnings">
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
          aria-label="Resume interrupted large-document indexing"
          className="lk-action-button"
        >
          {busy
            ? "Resuming…"
            : `Resume ${health.resumableDocuments.length.toString()} document${
                health.resumableDocuments.length === 1 ? "" : "s"
              }`}
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
        Loading Knowledge Pod…
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
          No Knowledge Pod selected. Open a pod from the Local Knowledge overview.
          <Link href="/local-knowledge" className="lk-alert-retry">
            Back to Local Knowledge
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
          This Knowledge Pod no longer exists. Return to the Local Knowledge overview.
          <Link href="/local-knowledge" className="lk-alert-retry">
            Back to Knowledge Pods
          </Link>
        </div>
      );
    }
    return (
      <div role="alert" aria-live="assertive" className="lk-alert">
        {loadError ?? "Failed to load Knowledge Pod."}
        <button
          type="button"
          onClick={reload}
          aria-label="Retry loading Knowledge Pod detail"
          className="lk-alert-retry"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="lkd-content">
      <header className="lk-header">
        <h1 className="lk-title">{data.capsule.displayName}</h1>
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
      <OverviewSection data={data} />
      <PrivacySection />
      <SourcesSection capsuleId={capsuleId} sources={data.sources} onActionComplete={reload} />
      <HealthDiagnosticsSection diagnostics={data.parserDiagnostics} />
      <IndexingJobsSection jobs={data.indexingJobs} />
    </div>
  );
}
