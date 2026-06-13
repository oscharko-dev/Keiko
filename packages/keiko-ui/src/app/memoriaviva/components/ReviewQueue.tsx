"use client";

// Issue #211 — MemoriaViva review queue: proposed, conflicted, and stale records needing action.
//
// WCAG: role="status" aria-live="polite" on the count badge.
// Approve/Reject action buttons inline per row (≥ 24px target via lk-btn).
// Empty state when queue is clear. motion-safe on any animated element.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import {
  acceptMemoryProposal,
  archiveMemory,
  fetchMemoryReviewQueue,
  rejectMemoryProposal,
  type MemoryReviewQueueResponse,
} from "@/lib/memory-api";
import { formatError } from "./format-error";
import { SCOPE_LABELS, TYPE_LABELS } from "./MemoryFilters";

interface ReviewRowProps {
  readonly record: MemoryRecord;
  readonly busyAction: "accept" | "reject" | "archive" | null;
  readonly rowError: string | null;
  readonly onAccept: (record: MemoryRecord) => void;
  readonly onReject: (record: MemoryRecord) => void;
  readonly onArchive: (record: MemoryRecord) => void;
}

function ReviewRow({
  record,
  busyAction,
  rowError,
  onAccept,
  onReject,
  onArchive,
}: ReviewRowProps): ReactNode {
  const labelId = `memory-review-body-${record.id}`;
  const detailLinkLabel = `View details for memory ${record.id}: ${record.body.slice(0, 80)}`;
  const isStale = record.staleReason !== undefined || record.status === "expired";
  return (
    <li data-review-row-id={record.id}>
      <article className="mc-review-row">
        <div className="mc-review-body">
          {/* multi-line clamp via .mc-review-row .mc-row-body — accepting or
              rejecting a memory whose text is hard-truncated to one line is a
              blind decision (uiux-fix F035) */}
          <p id={labelId} className="mc-row-body">
            {record.body}
          </p>
          <div className="mc-row-meta">
            <span className="mc-row-type">{TYPE_LABELS[record.type]}</span>
            <span className="mc-row-scope">{SCOPE_LABELS[record.scope.kind]}</span>
            {/* static metadata label — role="status" would create one live
                region per row (uiux-fix F005) */}
            <span className={`mc-badge mc-badge-${record.status}`}>{record.status}</span>
            {isStale ? (
              <span className="mc-row-stale">
                Stale{record.staleReason !== undefined ? `: ${record.staleReason}` : ""}
              </span>
            ) : null}
            {/* full text + provenance/conflict context before deciding —
                unlike the list, queue rows are not links (uiux-fix F035) */}
            <Link
              href={`/memoriaviva/detail?id=${encodeURIComponent(record.id)}`}
              className="mc-row-detail-link"
              aria-label={detailLinkLabel}
            >
              View details
            </Link>
          </div>
          {rowError !== null ? (
            <p role="alert" className="mc-action-error">
              {rowError}
            </p>
          ) : null}
        </div>
        {/* aria-disabled + click guard instead of native disabled: disabling the
            focused button would throw keyboard focus to <body> (uiux-fix F005,
            pattern from PR #823). */}
        <div className="mc-review-actions" role="group" aria-labelledby={labelId}>
          {record.status === "proposed" ? (
            <>
              <button
                type="button"
                className="lk-btn lk-btn-primary"
                aria-disabled={busyAction !== null}
                aria-busy={busyAction === "accept"}
                onClick={() => {
                  if (busyAction !== null) return;
                  onAccept(record);
                }}
              >
                {busyAction === "accept" ? "Approving…" : "Approve"}
              </button>
              <button
                type="button"
                className="lk-btn lk-btn-ghost"
                aria-disabled={busyAction !== null}
                aria-busy={busyAction === "reject"}
                onClick={() => {
                  if (busyAction !== null) return;
                  onReject(record);
                }}
              >
                {busyAction === "reject" ? "Rejecting…" : "Reject"}
              </button>
            </>
          ) : record.status === "conflicted" ? (
            // Honest label: this action permanently sets status=rejected (no
            // UI path back) — "Dismiss" suggested a mere hide (uiux-fix F035).
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              aria-disabled={busyAction !== null}
              aria-busy={busyAction === "reject"}
              onClick={() => {
                if (busyAction !== null) return;
                onReject(record);
              }}
            >
              {busyAction === "reject" ? "Rejecting…" : "Reject conflict"}
            </button>
          ) : (
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              aria-disabled={busyAction !== null}
              aria-busy={busyAction === "archive"}
              onClick={() => {
                if (busyAction !== null) return;
                onArchive(record);
              }}
            >
              {busyAction === "archive" ? "Archiving…" : "Archive stale"}
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
  readonly archiveImpl?: typeof archiveMemory;
}

export function ReviewQueue({
  fetchQueueImpl = fetchMemoryReviewQueue,
  acceptImpl = acceptMemoryProposal,
  rejectImpl = rejectMemoryProposal,
  archiveImpl = archiveMemory,
}: ReviewQueueProps): ReactNode {
  const [records, setRecords] = useState<readonly MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyById, setBusyById] = useState<
    Partial<Record<string, "accept" | "reject" | "archive">>
  >({});
  const [rowErrorsById, setRowErrorsById] = useState<Partial<Record<string, string>>>({});
  // Result announcement + focus management after a row is removed: the pressed
  // button unmounts with its row, which would drop focus to <body> and leave
  // SR users without a success signal (uiux-fix F035).
  const [actionStatus, setActionStatus] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // null = nothing pending; "" = focus the heading; otherwise a record id.
  const pendingFocusRef = useRef<string | null>(null);

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
      // Pick the focus target before removal: next row's first action button,
      // the previous row if the last one was removed, or the heading when the
      // queue becomes empty (uiux-fix F035).
      const idx = records.findIndex((r) => r.id === id);
      const neighbor = records[idx + 1] ?? records[idx - 1];
      pendingFocusRef.current = neighbor !== undefined ? neighbor.id : "";
      setRecords((prev) => prev.filter((r) => r.id !== id));
      clearRowState(id);
    },
    [records, clearRowState],
  );

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return;
    pendingFocusRef.current = null;
    const row =
      target === ""
        ? null
        : (listRef.current?.querySelector(`[data-review-row-id="${CSS.escape(target)}"]`) ?? null);
    const button = row === null ? null : row.querySelector<HTMLButtonElement>("button");
    if (button !== null) {
      button.focus();
    } else {
      headingRef.current?.focus();
    }
  }, [records]);

  const runRowAction = useCallback(
    async (record: MemoryRecord, action: "accept" | "reject" | "archive"): Promise<void> => {
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
        } else if (action === "archive") {
          await archiveImpl(id, "archived stale memory from review queue");
        } else {
          await rejectImpl(
            id,
            record.status === "conflicted"
              ? "rejected conflict from review queue"
              : "rejected from review queue",
          );
        }
        removeRecord(id);
        setActionStatus(
          action === "accept"
            ? "Memory approved"
            : action === "archive"
              ? "Memory archived"
              : "Memory rejected",
        );
      } catch (err) {
        setRowErrorsById((prev) => ({ ...prev, [id]: formatError(err) }));
        setBusyById((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    [acceptImpl, archiveImpl, rejectImpl, removeRecord],
  );

  return (
    <>
      <header className="lk-header">
        {/* tabIndex -1: programmatic focus target when the queue empties
            (uiux-fix F035) */}
        <h1 className="lk-title" tabIndex={-1} ref={headingRef}>
          Review queue
        </h1>
        {/* visible label instead of aria-label-only: a bare number pill was
            unexplained for sighted users (uiux-fix F035) */}
        <span role="status" aria-live="polite" className="mc-badge-count">
          {records.length.toString()} awaiting review
        </span>
        <Link href="/memoriaviva" className="lk-btn lk-btn-ghost lk-btn-lg">
          Back to MemoriaViva
        </Link>
      </header>

      {/* Dedicated live region: row removals are not announced by the list
          (aria-relevant defaults to additions/text) — uiux-fix F035. */}
      <p role="status" className="visually-hidden">
        {actionStatus}
      </p>

      <section
        aria-label="Memories awaiting review"
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
            {/* wrapper div mirrors MemoryList's empty state so the title/body
                gap matches (the flex gap + title margin added up to ~20px
                without it — uiux-fix F035) */}
            <div>
              <p className="lk-empty-title">Queue is clear</p>
              <p className="lk-empty-body">
                No memories are waiting for review. Proposed, conflicted, and stale memories appear
                here.
              </p>
            </div>
          </div>
        ) : (
          <ul
            ref={listRef}
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
                onArchive={(row) => {
                  void runRowAction(row, "archive");
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
