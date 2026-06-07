"use client";

// Issue #280 (Epic #270) — Quality Intelligence panel client component.
// Three-column layout: run list (left), selected run summary (centre), findings list (right).
// Fetches from BFF routes added in M2; wires data in M3.
//
// Accessibility:
//   - WCAG 2.2 AA: all interactive elements have focus-visible rings, 24×24 min target.
//   - role="status" + aria-live="polite" on async state regions.
//   - aria-pressed on the run list selector buttons.
//   - Keyboard navigation via standard button / focus flow.
//
// Design tokens (ADR-0014):
//   - var(--bg), var(--surface), var(--card) for backgrounds.
//   - var(--fg), var(--fg-muted), var(--fg-dim) for text hierarchy.
//   - var(--accent) for selected/active state.
//   - var(--line) for borders.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  QualityIntelligenceUiRunSummary,
  QualityIntelligenceUiRunDetail,
} from "@oscharko-dev/keiko-contracts";
import { fetchQiRuns, fetchQiRunDetail } from "@/lib/quality-intelligence-api";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

const STATUS_LABEL: Readonly<Record<RunStatus, string>> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_CLASS: Readonly<Record<RunStatus, string>> = {
  running: "qi-badge-running",
  succeeded: "qi-badge-succeeded",
  failed: "qi-badge-failed",
  cancelled: "qi-badge-cancelled",
};

function isRunStatus(s: string): s is RunStatus {
  return s === "running" || s === "succeeded" || s === "failed" || s === "cancelled";
}

function StatusBadge({ status }: { readonly status: string }): ReactNode {
  const label = isRunStatus(status) ? STATUS_LABEL[status] : status;
  const cls = isRunStatus(status) ? STATUS_CLASS[status] : "qi-badge-default";
  return (
    <span role="status" aria-label={`Status: ${label}`} className={`qi-badge ${cls}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SeverityBadge
// ---------------------------------------------------------------------------

type FindingSeverity = "critical" | "high" | "medium" | "low";

const SEVERITY_CLASS: Readonly<Record<FindingSeverity, string>> = {
  critical: "qi-sev-critical",
  high: "qi-sev-high",
  medium: "qi-sev-medium",
  low: "qi-sev-low",
};

function isFindingSeverity(s: string): s is FindingSeverity {
  return s === "critical" || s === "high" || s === "medium" || s === "low";
}

function SeverityBadge({ severity }: { readonly severity: string }): ReactNode {
  const cls = isFindingSeverity(severity) ? SEVERITY_CLASS[severity] : "qi-sev-low";
  return (
    <span aria-label={`Severity: ${severity}`} className={`qi-sev ${cls}`}>
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SkeletonBlock
// ---------------------------------------------------------------------------

function SkeletonBlock({
  height = 20,
  width = "100%",
}: {
  height?: number;
  width?: string | number;
}): ReactNode {
  return <div aria-hidden="true" className="qi-skeleton" style={{ height, width }} />;
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState(): ReactNode {
  return (
    <div data-testid="qi-empty-state" className="lk-empty">
      <div>
        <p className="lk-empty-title">No runs yet</p>
        <p className="lk-empty-body">
          Quality Intelligence runs will appear here once the first analysis has been initiated.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LoadingSkeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton(): ReactNode {
  return (
    <div
      data-testid="qi-loading-state"
      aria-busy="true"
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0" }}
    >
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "12px 16px",
            borderRadius: "var(--radius-sm)",
            background: "var(--card)",
          }}
        >
          <SkeletonBlock height={14} width="60%" />
          <SkeletonBlock height={12} width="40%" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorState
// ---------------------------------------------------------------------------

function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div role="alert" aria-live="assertive" className="lk-alert" data-testid="qi-error-state">
      {message}
      <button type="button" className="lk-alert-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RunListItem
// ---------------------------------------------------------------------------

function RunListItem({
  run,
  selected,
  onSelect,
}: {
  readonly run: QualityIntelligenceUiRunSummary;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}): ReactNode {
  return (
    <li>
      <button
        type="button"
        className={`qi-run-item${selected ? " qi-run-item-selected" : ""}`}
        aria-pressed={selected}
        onClick={() => {
          onSelect(run.id);
        }}
        title={`Run ${run.id}`}
      >
        <span className="qi-run-id">{run.id.slice(0, 12)}</span>
        <StatusBadge status={run.status} />
        <span className="qi-run-meta">{formatDate(run.requestedAt)}</span>
        {run.totals !== undefined ? (
          <span className="qi-run-totals">
            {run.totals.findings.toString()} finding{run.totals.findings !== 1 ? "s" : ""}
          </span>
        ) : null}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// RunList (left column)
// ---------------------------------------------------------------------------

function RunList({
  runs,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  readonly runs: readonly QualityIntelligenceUiRunSummary[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <section className="qi-col qi-col-runs" aria-label="Quality Intelligence runs">
      <header className="qi-col-header">
        <h2 className="qi-col-title">Runs</h2>
        {loading ? (
          <span role="status" aria-live="polite" className="qi-col-status">
            Loading…
          </span>
        ) : null}
      </header>
      <div className="qi-col-body" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <LoadingSkeleton />
        ) : error !== null ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : runs.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="qi-run-list" aria-label="Run list">
            {runs.map((run) => (
              <RunListItem
                key={run.id}
                run={run}
                selected={selectedId === run.id}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// RunSummaryPane (centre column)
// ---------------------------------------------------------------------------

function RunSummaryPane({
  selectedId,
  detail,
  loading,
  error,
}: {
  readonly selectedId: string | null;
  readonly detail: QualityIntelligenceUiRunDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
}): ReactNode {
  if (selectedId === null) {
    return (
      <section className="qi-col qi-col-detail" aria-label="Run detail">
        <div className="lk-empty">
          <p className="lk-empty-title">No run selected</p>
          <p className="lk-empty-body">Select a run from the list to view its details.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="qi-col qi-col-detail" aria-label="Run detail">
      <header className="qi-col-header">
        <h2 className="qi-col-title">Run detail</h2>
      </header>
      <div
        className="qi-col-body"
        role="status"
        aria-live="polite"
        aria-busy={loading}
        data-testid="qi-detail-region"
      >
        {loading ? (
          <div data-testid="qi-detail-loading">
            <LoadingSkeleton />
          </div>
        ) : error !== null ? (
          <p className="lk-alert" data-testid="qi-detail-error">
            {error}
          </p>
        ) : detail === null ? (
          <p className="lk-loading">Loading run…</p>
        ) : (
          <dl className="qi-detail-list" data-testid="qi-detail-content">
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Run ID</dt>
              <dd className="qi-detail-value qi-monospace">{detail.id}</dd>
            </div>
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Status</dt>
              <dd className="qi-detail-value">
                <StatusBadge status={detail.status} />
              </dd>
            </div>
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Requested</dt>
              <dd className="qi-detail-value">{formatDate(detail.requestedAt)}</dd>
            </div>
            {detail.completedAt !== null ? (
              <div className="qi-detail-row">
                <dt className="qi-detail-label">Completed</dt>
                <dd className="qi-detail-value">{formatDate(detail.completedAt)}</dd>
              </div>
            ) : null}
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Schema version</dt>
              <dd className="qi-detail-value">{detail.manifestSchemaVersion.toString()}</dd>
            </div>
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Candidates</dt>
              <dd className="qi-detail-value">{detail.totals.candidates.toString()}</dd>
            </div>
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Findings</dt>
              <dd className="qi-detail-value">{detail.totals.findings.toString()}</dd>
            </div>
            <div className="qi-detail-row">
              <dt className="qi-detail-label">Exports</dt>
              <dd className="qi-detail-value">{detail.totals.exports.toString()}</dd>
            </div>
            {detail.candidateIds.length > 0 ? (
              <div className="qi-detail-row">
                <dt className="qi-detail-label">Candidate IDs</dt>
                <dd className="qi-detail-value">
                  <ul className="qi-ref-list">
                    {detail.candidateIds.map((id: string) => (
                      <li key={id} className="qi-monospace">
                        {id}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
            {detail.evidenceRefs.length > 0 ? (
              <div className="qi-detail-row">
                <dt className="qi-detail-label">Evidence refs</dt>
                <dd className="qi-detail-value">
                  <ul className="qi-ref-list">
                    {detail.evidenceRefs.map((ref: QualityIntelligenceUiRunDetail["evidenceRefs"][number]) => (
                      <li key={`${ref.envelopeId}:${ref.atomId}`} className="qi-monospace">
                        {ref.envelopeId.slice(0, 16)}…/{ref.atomId.slice(0, 12)}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
          </dl>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// FindingsPane (right column)
// ---------------------------------------------------------------------------

function FindingsPane({
  detail,
  loading,
}: {
  readonly detail: QualityIntelligenceUiRunDetail | null;
  readonly loading: boolean;
}): ReactNode {
  const findings = detail?.findingRefs ?? [];

  return (
    <section className="qi-col qi-col-findings" aria-label="Findings">
      <header className="qi-col-header">
        <h2 className="qi-col-title">Findings</h2>
        {!loading && detail !== null ? (
          <span role="status" aria-live="polite" className="qi-col-count">
            {findings.length.toString()} finding{findings.length !== 1 ? "s" : ""}
          </span>
        ) : null}
      </header>
      <div className="qi-col-body" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <LoadingSkeleton />
        ) : detail === null ? (
          <div className="lk-empty">
            <p className="lk-empty-body">Select a run to view findings.</p>
          </div>
        ) : findings.length === 0 ? (
          <div className="lk-empty">
            <p className="lk-empty-title">No findings</p>
            <p className="lk-empty-body">This run produced no validation findings.</p>
          </div>
        ) : (
          <ul className="qi-finding-list" aria-label="Findings list">
            {findings.map((f: QualityIntelligenceUiRunDetail["findingRefs"][number]) => (
              <li key={f.id} className="qi-finding-item">
                <div className="qi-finding-header">
                  <span className="qi-finding-kind">{f.kind}</span>
                  <SeverityBadge severity={f.severity} />
                </div>
                <p className="qi-finding-summary">{f.summaryRedacted}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// QualityIntelligencePanel
// ---------------------------------------------------------------------------

export interface QualityIntelligencePanelProps {
  /** Seam for tests: swap out the real BFF fetchers. */
  readonly fetchRunsImpl?: typeof fetchQiRuns;
  readonly fetchRunDetailImpl?: typeof fetchQiRunDetail;
}

export function QualityIntelligencePanel({
  fetchRunsImpl = fetchQiRuns,
  fetchRunDetailImpl = fetchQiRunDetail,
}: QualityIntelligencePanelProps): ReactNode {
  const [runs, setRuns] = useState<readonly QualityIntelligenceUiRunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QualityIntelligenceUiRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadRuns = useCallback(async (): Promise<void> => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await fetchRunsImpl();
      setRuns(res);
    } catch (err) {
      setRunsError(formatError(err));
    } finally {
      setRunsLoading(false);
    }
  }, [fetchRunsImpl]);

  // Issue #643 — guard against stale QI detail responses overwriting active UI state.
  // Each detail fetch claims a monotonically increasing sequence number; results / errors that
  // arrive after a newer selection are dropped. This is the QI counterpart to the Desktop Chat
  // active-id guard and applies to rapid run-switching (user clicks run A, then B before A
  // resolves) and to the request-of-record race when the same id is re-fetched.
  const detailRequestSeqRef = useRef(0);

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      const requestSeq = detailRequestSeqRef.current + 1;
      detailRequestSeqRef.current = requestSeq;
      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      try {
        const res = await fetchRunDetailImpl(id);
        if (detailRequestSeqRef.current !== requestSeq) return;
        setDetail(res);
      } catch (err) {
        if (detailRequestSeqRef.current !== requestSeq) return;
        setDetailError(formatError(err));
      } finally {
        if (detailRequestSeqRef.current === requestSeq) {
          setDetailLoading(false);
        }
      }
    },
    [fetchRunDetailImpl],
  );

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const handleSelect = useCallback(
    (id: string): void => {
      setSelectedId(id);
      void loadDetail(id);
    },
    [loadDetail],
  );

  return (
    <>
      <header className="lk-header">
        <h1 className="lk-title">Quality Intelligence</h1>
      </header>
      <div className="qi-layout">
        <RunList
          runs={runs}
          loading={runsLoading}
          error={runsError}
          selectedId={selectedId}
          onSelect={handleSelect}
          onRetry={() => {
            void loadRuns();
          }}
        />
        <RunSummaryPane
          selectedId={selectedId}
          detail={detail}
          loading={detailLoading}
          error={detailError}
        />
        <FindingsPane detail={detail} loading={detailLoading} />
      </div>
    </>
  );
}
