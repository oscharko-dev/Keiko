"use client";

// Issue #198 — Capsule detail Client Component.
// Four sections: Overview, Sources, Health Diagnostics, Indexing Job History.
// Parser diagnostics NEVER render raw extracted text — only severity/code/message/page_number.
// State is split into capsule-detail-state.ts to keep each file under 400 LOC.

import { useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  KnowledgeCapsuleId,
  ParserDiagnostic,
  IndexingJobRecord,
  ParserDiagnosticSeverity,
  IndexingJobStatus,
} from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleDetail as CapsuleDetailData,
  CapsuleActionResponse,
  SourceIndexStats,
} from "@/lib/local-knowledge-api";
import Link from "next/link";
import { STATUS_LABELS } from "../connector-graph-types";
import { useCapsuleDetail } from "./capsule-detail-state";
import { CapsuleActions } from "./capsule-actions";
import { CapsuleRename } from "./capsule-rename";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds.toString()}s`;
  return `${minutes.toString()}m ${seconds.toString().padStart(2, "0")}s`;
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
          tone={job?.status === "failed" ? "danger" : job?.status === "running" ? "warn" : "neutral"}
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
              <ul className="lkd-tags" aria-label="Capsule tags">
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
        <OverviewRow
          label="Embedding model"
          value={`${embId.provider} / ${embId.modelId} (${embId.vectorDimensions.toString()}d, ${embId.vectorMetric})`}
        />
        <OverviewRow label="Storage size" value={formatBytes(health.storageSizeBytes)} />
        <OverviewRow label="Unsupported documents" value={health.unsupportedDocuments.toString()} />
        {health.lastIndexedAt !== undefined ? (
          <OverviewRow label="Last indexed" value={formatTs(health.lastIndexedAt)} />
        ) : null}
        <OverviewRow
          label="Vector compatible"
          value={health.vectorCompatible ? "Yes" : "No — re-index required"}
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
// SourcesSection
// ---------------------------------------------------------------------------

function SourcesSection({ sources }: { sources: readonly SourceIndexStats[] }): ReactNode {
  if (sources.length === 0) {
    return (
      <section aria-labelledby="lkd-sources-heading">
        <SectionHeading>
          <span id="lkd-sources-heading">Sources</span>
        </SectionHeading>
        <p className="lkd-empty-note">No sources attached to this capsule.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="lkd-sources-heading">
      <SectionHeading>
        <span id="lkd-sources-heading">Sources</span>
      </SectionHeading>
      <ul className="lkd-list lkd-source-list" aria-label="Capsule sources">
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
                <span className="lkd-source-scope">{src.scope.kind}</span>
              </div>
              <div className="lkd-source-coverage" role="img" aria-label="Source document coverage">
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
          indexing and for grounded answers when you ask questions against this capsule.
        </li>
        <li className="lkd-source-row">
          Deleting a capsule removes its local index data and capsule-set memberships. Source files
          on disk are not deleted.
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
    <li className="lkd-diag-group" data-severity={group.severity}>
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

export interface CapsuleDetailProps {
  readonly capsuleId?: KnowledgeCapsuleId;
  readonly onDeleted?: (response: CapsuleActionResponse) => void;
  // Injectable fetch seam — defaults to the real BFF helper. Tests pass a mock
  // so they never hit the network, following the ConnectorGraph seam pattern.
  readonly fetchDetailImpl?: typeof import("@/lib/local-knowledge-api").fetchCapsuleDetail;
}

export function CapsuleDetail({
  capsuleId: providedCapsuleId,
  onDeleted,
  fetchDetailImpl,
}: CapsuleDetailProps = {}): ReactNode {
  const searchParams = useSearchParams();
  const router = useRouter();
  const capsuleId =
    providedCapsuleId ?? ((searchParams.get("capsuleId") ?? "") as KnowledgeCapsuleId);

  const { data, loadStatus, loadError, reload } = useCapsuleDetail(capsuleId, fetchDetailImpl);

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
        Loading capsule…
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
          No capsule selected. Open a capsule from the Local Knowledge overview.
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
          This capsule no longer exists. Return to the Local Knowledge overview.
          <Link href="/local-knowledge" className="lk-alert-retry">
            Back to capsules
          </Link>
        </div>
      );
    }
    return (
      <div role="alert" aria-live="assertive" className="lk-alert">
        {loadError ?? "Failed to load capsule."}
        <button
          type="button"
          onClick={reload}
          aria-label="Retry loading capsule detail"
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
        onActionComplete={reload}
        onDeleted={handleDeleted}
      />

      <IndexingStatusSection data={data} />
      <OverviewSection data={data} />
      <PrivacySection />
      <SourcesSection sources={data.sources} />
      <HealthDiagnosticsSection diagnostics={data.parserDiagnostics} />
      <IndexingJobsSection jobs={data.indexingJobs} />
    </div>
  );
}
