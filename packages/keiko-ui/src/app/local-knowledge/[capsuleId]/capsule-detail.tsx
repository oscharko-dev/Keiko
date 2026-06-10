"use client";

// Issue #198 — Capsule detail Client Component.
// Four sections: Overview, Sources, Health Diagnostics, Indexing Job History.
// Parser diagnostics NEVER render raw extracted text — only severity/code/message/page_number.
// State is split into capsule-detail-state.ts to keep each file under 400 LOC.

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import type {
  KnowledgeCapsuleId,
  ParserDiagnostic,
  IndexingJobRecord,
  ParserDiagnosticSeverity,
  IndexingJobStatus,
} from "@oscharko-dev/keiko-contracts";
import type {
  CapsuleDetail as CapsuleDetailData,
  SourceIndexStats,
} from "@/lib/local-knowledge-api";
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
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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
              aria-label={`Status: ${capsule.lifecycleState}`}
            >
              {capsule.lifecycleState}
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
      <ul className="lkd-list" aria-label="Capsule sources">
        {sources.map((src) => (
          <li key={src.sourceId} className="lkd-source-row">
            <div className="lkd-source-name">{src.displayName}</div>
            <div className="lkd-source-scope">{src.scope.kind}</div>
            <div className="lkd-source-counts" aria-label="Document counts">
              <span className="lkd-count lkd-count-ok" title="Indexed">
                {src.indexedCount.toString()} indexed
              </span>
              <span className="lkd-count lkd-count-fail" title="Failed">
                {src.failedCount.toString()} failed
              </span>
              <span className="lkd-count lkd-count-skip" title="Skipped">
                {src.skippedCount.toString()} skipped
              </span>
            </div>
          </li>
        ))}
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
      <div className="lkd-source-counts" aria-label="Document counts">
        <span className="lkd-count lkd-count-ok">
          {job.processedDocuments.toString()} processed
        </span>
        <span className="lkd-count lkd-count-fail">{job.failedDocuments.toString()} failed</span>
        <span className="lkd-count lkd-count-skip">{job.skippedDocuments.toString()} skipped</span>
      </div>
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
  // Injectable fetch seam — defaults to the real BFF helper. Tests pass a mock
  // so they never hit the network, following the ConnectorGraph seam pattern.
  readonly fetchDetailImpl?: typeof import("@/lib/local-knowledge-api").fetchCapsuleDetail;
}

export function CapsuleDetail({ fetchDetailImpl }: CapsuleDetailProps = {}): ReactNode {
  const searchParams = useSearchParams();
  const capsuleId = (searchParams.get("capsuleId") ?? "") as KnowledgeCapsuleId;

  const { data, loadStatus, loadError, reload } = useCapsuleDetail(capsuleId, fetchDetailImpl);

  if (loadStatus === "loading") {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        Loading capsule…
      </p>
    );
  }

  if (loadStatus === "error" || data === null) {
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
        <CapsuleActions
          capsuleId={capsuleId}
          capsuleDisplayName={data.capsule.displayName}
          sourceCount={data.sources.length}
          lifecycleState={data.capsule.lifecycleState}
          onActionComplete={reload}
        />
      </header>

      <OverviewSection data={data} />
      <PrivacySection />
      <SourcesSection sources={data.sources} />
      <HealthDiagnosticsSection diagnostics={data.parserDiagnostics} />
      <IndexingJobsSection jobs={data.indexingJobs} />
    </div>
  );
}
