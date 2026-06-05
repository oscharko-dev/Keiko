"use client";

// Issue #211 — Memory Center review queue: proposed + conflicted records needing action.
//
// WCAG: role="status" aria-live="polite" on the count badge.
// Accept/Reject action buttons inline per row (≥ 24px target via lk-btn).
// Empty state when queue is clear. motion-safe on any animated element.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import {
  fetchMemoryReviewQueue,
  acceptMemoryProposal,
  rejectMemoryProposal,
  type MemoryReviewQueueResponse,
} from "@/lib/memory-api";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

// ---------------------------------------------------------------------------
// ReviewRow
// ---------------------------------------------------------------------------

interface ReviewRowProps {
  readonly record: MemoryRecord;
  readonly onAccepted: (id: MemoryId) => void;
  readonly onRejected: (id: MemoryId) => void;
  readonly acceptImpl: typeof acceptMemoryProposal;
  readonly rejectImpl: typeof rejectMemoryProposal;
}

function ReviewRow({
  record,
  onAccepted,
  onRejected,
  acceptImpl,
  rejectImpl,
}: ReviewRowProps): ReactNode {
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const handleAccept = useCallback((): void => {
    setBusy("accept");
    setRowError(null);
    void (async () => {
      try {
        await acceptImpl(record.id as MemoryId);
        onAccepted(record.id as MemoryId);
      } catch (err) {
        setRowError(formatError(err));
        setBusy(null);
      }
    })();
  }, [acceptImpl, record.id, onAccepted]);

  const handleReject = useCallback((): void => {
    setBusy("reject");
    setRowError(null);
    void (async () => {
      try {
        await rejectImpl(record.id as MemoryId, "rejected from review queue");
        onRejected(record.id as MemoryId);
      } catch (err) {
        setRowError(formatError(err));
        setBusy(null);
      }
    })();
  }, [rejectImpl, record.id, onRejected]);

  return (
    <li>
      <article className="mc-review-row" aria-label={`Review: ${record.body.slice(0, 60)}`}>
        <div className="mc-review-body">
          <p className="mc-row-body">{record.body}</p>
          <div className="mc-row-meta">
            <span className="mc-row-type">{record.type}</span>
            <span className="mc-row-scope">{record.scope.kind}</span>
            <span
              role="status"
              aria-label={`Status: ${record.status}`}
              className={`mc-badge mc-badge-${record.status}`}
            >
              {record.status}
            </span>
          </div>
          {rowError !== null ? (
            <p role="alert" className="mc-action-error">
              {rowError}
            </p>
          ) : null}
        </div>
        <div
          className="mc-review-actions"
          role="group"
          aria-label={`Actions for: ${record.body.slice(0, 40)}`}
        >
          {record.status === "proposed" ? (
            <>
              <button
                type="button"
                className="lk-btn lk-btn-primary"
                disabled={busy !== null}
                aria-busy={busy === "accept"}
                onClick={handleAccept}
                aria-label={`Accept memory: ${record.body.slice(0, 40)}`}
              >
                {busy === "accept" ? "Accepting…" : "Accept"}
              </button>
              <button
                type="button"
                className="lk-btn lk-btn-ghost"
                disabled={busy !== null}
                aria-busy={busy === "reject"}
                onClick={handleReject}
                aria-label={`Reject memory: ${record.body.slice(0, 40)}`}
              >
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </>
          ) : (
            // Conflicted — only reject/dismiss available in queue
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busy !== null}
              aria-busy={busy === "reject"}
              onClick={handleReject}
              aria-label={`Dismiss conflict for memory: ${record.body.slice(0, 40)}`}
            >
              {busy === "reject" ? "Dismissing…" : "Dismiss"}
            </button>
          )}
        </div>
      </article>
    </li>
  );
}

// ---------------------------------------------------------------------------
// ReviewQueue
// ---------------------------------------------------------------------------

interface ReviewQueueProps {
  readonly fetchQueueImpl?: typeof fetchMemoryReviewQueue;
  readonly acceptImpl?: typeof acceptMemoryProposal;
  readonly rejectImpl?: typeof rejectMemoryProposal;
}

export function ReviewQueue({
  fetchQueueImpl = fetchMemoryReviewQueue,
  acceptImpl = acceptMemoryProposal,
  rejectImpl = rejectMemoryProposal,
}: ReviewQueueProps): ReactNode {
  const [records, setRecords] = useState<readonly MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res: MemoryReviewQueueResponse = await fetchQueueImpl();
      setRecords(res.memories);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchQueueImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAccepted = useCallback((id: MemoryId): void => {
    setRecords((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleRejected = useCallback((id: MemoryId): void => {
    setRecords((prev) => prev.filter((r) => r.id !== id));
  }, []);

  return (
    <>
      <header className="lk-header">
        <h1 className="lk-title">Review Queue</h1>
        <span
          role="status"
          aria-live="polite"
          aria-label={`${records.length.toString()} items awaiting review`}
          className="mc-badge-count"
        >
          {records.length}
        </span>
      </header>

      <section
        aria-label="Memories awaiting review"
        aria-live="polite"
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {loading ? (
          <p role="status" aria-live="polite" className="lk-loading">
            Loading review queue…
          </p>
        ) : error !== null ? (
          <div role="alert" aria-live="assertive" className="lk-alert">
            {error}
            <button
              type="button"
              className="lk-alert-retry"
              onClick={() => {
                void load();
              }}
            >
              Retry
            </button>
          </div>
        ) : records.length === 0 ? (
          <div data-testid="review-queue-empty" className="lk-empty">
            <p className="lk-empty-title">Queue is clear</p>
            <p className="lk-empty-body">
              No memories are waiting for review. Proposed and conflicted memories appear here.
            </p>
          </div>
        ) : (
          <ul
            aria-label="Review queue"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {records.map((record) => (
              <ReviewRow
                key={record.id}
                record={record}
                onAccepted={handleAccepted}
                onRejected={handleRejected}
                acceptImpl={acceptImpl}
                rejectImpl={rejectImpl}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
