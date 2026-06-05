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
  acceptMemoryProposal,
  fetchMemoryReviewQueue,
  rejectMemoryProposal,
  type MemoryReviewQueueResponse,
} from "@/lib/memory-api";
import { ApiError } from "@/lib/api";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

interface ReviewRowProps {
  readonly record: MemoryRecord;
  readonly busyAction: "accept" | "reject" | null;
  readonly rowError: string | null;
  readonly onAccept: (record: MemoryRecord) => void;
  readonly onReject: (record: MemoryRecord) => void;
}

function ReviewRow({
  record,
  busyAction,
  rowError,
  onAccept,
  onReject,
}: ReviewRowProps): ReactNode {
  const labelId = `memory-review-body-${record.id}`;
  return (
    <li>
      <article className="mc-review-row">
        <div className="mc-review-body">
          <p id={labelId} className="mc-row-body">
            {record.body}
          </p>
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
        <div className="mc-review-actions" role="group" aria-labelledby={labelId}>
          {record.status === "proposed" ? (
            <>
              <button
                type="button"
                className="lk-btn lk-btn-primary"
                disabled={busyAction !== null}
                aria-busy={busyAction === "accept"}
                onClick={() => {
                  onAccept(record);
                }}
              >
                {busyAction === "accept" ? "Accepting…" : "Accept"}
              </button>
              <button
                type="button"
                className="lk-btn lk-btn-ghost"
                disabled={busyAction !== null}
                aria-busy={busyAction === "reject"}
                onClick={() => {
                  onReject(record);
                }}
              >
                {busyAction === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busyAction !== null}
              aria-busy={busyAction === "reject"}
              onClick={() => {
                onReject(record);
              }}
            >
              {busyAction === "reject" ? "Dismissing…" : "Dismiss"}
            </button>
          )}
        </div>
      </article>
    </li>
  );
}

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
  const [busyById, setBusyById] = useState<Partial<Record<string, "accept" | "reject">>>({});
  const [rowErrorsById, setRowErrorsById] = useState<Partial<Record<string, string>>>({});

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res: MemoryReviewQueueResponse = await fetchQueueImpl();
      setRecords(res.memories);
      setBusyById({});
      setRowErrorsById({});
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchQueueImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  const clearRowState = useCallback((id: MemoryId): void => {
    setBusyById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setRowErrorsById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const removeRecord = useCallback(
    (id: MemoryId): void => {
      setRecords((prev) => prev.filter((r) => r.id !== id));
      clearRowState(id);
    },
    [clearRowState],
  );

  const runRowAction = useCallback(
    async (record: MemoryRecord, action: "accept" | "reject"): Promise<void> => {
      const id = record.id as MemoryId;
      setBusyById((prev) => ({ ...prev, [id]: action }));
      setRowErrorsById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });

      try {
        if (action === "accept") {
          await acceptImpl(id);
        } else {
          await rejectImpl(
            id,
            record.status === "conflicted"
              ? "dismissed conflict from review queue"
              : "rejected from review queue",
          );
        }
        removeRecord(id);
      } catch (err) {
        setRowErrorsById((prev) => ({ ...prev, [id]: formatError(err) }));
        setBusyById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [acceptImpl, rejectImpl, removeRecord],
  );

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
                busyAction={busyById[record.id] ?? null}
                rowError={rowErrorsById[record.id] ?? null}
                onAccept={(row) => {
                  void runRowAction(row, "accept");
                }}
                onReject={(row) => {
                  void runRowAction(row, "reject");
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
