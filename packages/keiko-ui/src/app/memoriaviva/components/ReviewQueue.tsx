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
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";

function typeLabel(type: MemoryRecord["type"], t: I18nTranslate): string {
  switch (type) {
    case "episodic":
      return t("memoria.type.episodic");
    case "semantic-fact":
      return t("memoria.type.semanticFact");
    case "procedural":
      return t("memoria.type.procedural");
    case "preference":
      return t("memoria.type.preference");
    case "correction":
      return t("memoria.type.correction");
    case "decision":
      return t("memoria.type.decision");
    case "negative":
      return t("memoria.type.negative");
    case "pinned":
      return t("memoria.type.pinned");
  }
}

function scopeLabel(scope: MemoryRecord["scope"]["kind"], t: I18nTranslate): string {
  switch (scope) {
    case "user":
      return t("memoria.scope.user");
    case "workspace":
      return t("memoria.scope.workspace");
    case "project":
      return t("memoria.scope.project");
    case "workflow":
      return t("memoria.scope.workflow");
    case "global":
      return t("memoria.scope.global");
  }
}

function statusLabel(status: MemoryRecord["status"], t: I18nTranslate): string {
  switch (status) {
    case "proposed":
      return t("memoria.status.proposed");
    case "accepted":
      return t("memoria.status.accepted");
    case "rejected":
      return t("memoria.status.rejected");
    case "superseded":
      return t("memoria.status.superseded");
    case "archived":
      return t("memoria.status.archived");
    case "forgotten":
      return t("memoria.status.forgotten");
    case "conflicted":
      return t("memoria.status.conflicted");
    case "expired":
      return t("memoria.status.expired");
  }
}

function sensitivityLabel(
  sensitivity: MemoryRecord["provenance"]["sensitivity"],
  t: I18nTranslate,
): string {
  switch (sensitivity) {
    case "public":
      return t("memoria.sensitivity.public");
    case "confidential":
      return t("memoria.sensitivity.confidential");
    case "restricted":
      return t("memoria.sensitivity.restricted");
  }
}

interface ReviewRowProps {
  readonly record: MemoryRecord;
  readonly busyAction: "accept" | "reject" | "archive" | null;
  readonly rowError: string | null;
  readonly onAccept: (record: MemoryRecord) => void;
  readonly onReject: (record: MemoryRecord) => void;
  readonly onArchive: (record: MemoryRecord) => void;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly t: I18nTranslate;
}

// ---------------------------------------------------------------------------
// StaleIndicator / CaptureRationale / RowDetailLink / RowError
// ---------------------------------------------------------------------------
// Small conditional-render pieces of a row's meta block, each extracted as an
// early-return component instead of an inline ternary (mirrors StatusBadge /
// HeaderActionLink in MemoryList.tsx).

function StaleIndicator({
  record,
  t,
}: {
  readonly record: MemoryRecord;
  readonly t: I18nTranslate;
}): ReactNode {
  const isStale = record.staleReason !== undefined || record.status === "expired";
  if (!isStale) return null;
  return (
    <span className="mc-row-stale">
      {record.staleReason !== undefined
        ? t("memoria.staleWithReason", { reason: record.staleReason })
        : t("memoria.stale")}
    </span>
  );
}

function CaptureRationale({
  record,
  t,
}: {
  readonly record: MemoryRecord;
  readonly t: I18nTranslate;
}): ReactNode {
  if (record.provenance.captureRationale === undefined) return null;
  return (
    <span>
      {t("memoria.rationale")}: {record.provenance.captureRationale}
    </span>
  );
}

// Full text + provenance/conflict context before deciding — unlike the list,
// queue rows are not links (uiux-fix F035).
function RowDetailLink({
  record,
  onOpenDetail,
  label,
  t,
}: {
  readonly record: MemoryRecord;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly label: string;
  readonly t: I18nTranslate;
}): ReactNode {
  if (onOpenDetail !== undefined) {
    return (
      <button
        type="button"
        className="mc-row-detail-link mc-link-button"
        aria-label={label}
        onClick={() => onOpenDetail(record.id)}
      >
        {t("memoria.viewDetails")}
      </button>
    );
  }
  return (
    <Link
      href={`/memoriaviva/detail?id=${encodeURIComponent(record.id)}`}
      className="mc-row-detail-link"
      aria-label={label}
    >
      {t("memoria.viewDetails")}
    </Link>
  );
}

function RowError({ rowError }: { readonly rowError: string | null }): ReactNode {
  if (rowError === null) return null;
  return (
    <p role="alert" className="mc-action-error">
      {rowError}
    </p>
  );
}

// ---------------------------------------------------------------------------
// ReviewRowActions
// ---------------------------------------------------------------------------

// aria-disabled + click guard instead of native disabled: disabling the
// focused button would throw keyboard focus to <body> (uiux-fix F005, pattern
// from PR #823).
function RowActionButton({
  variant,
  busyAction,
  isBusy,
  busyLabel,
  idleLabel,
  onClick,
}: {
  readonly variant: "primary" | "ghost";
  readonly busyAction: "accept" | "reject" | "archive" | null;
  readonly isBusy: boolean;
  readonly busyLabel: string;
  readonly idleLabel: string;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`lk-btn lk-btn-${variant}`}
      aria-disabled={busyAction !== null}
      aria-busy={isBusy}
      onClick={() => {
        if (busyAction !== null) return;
        onClick();
      }}
    >
      {isBusy ? busyLabel : idleLabel}
    </button>
  );
}

// One of three mutually exclusive action sets per row status — extracted as
// early returns instead of a nested ternary chain (mirrors MemoryListBody).
function ReviewRowActions({
  record,
  busyAction,
  labelId,
  onAccept,
  onReject,
  onArchive,
  t,
}: {
  readonly record: MemoryRecord;
  readonly busyAction: "accept" | "reject" | "archive" | null;
  readonly labelId: string;
  readonly onAccept: (record: MemoryRecord) => void;
  readonly onReject: (record: MemoryRecord) => void;
  readonly onArchive: (record: MemoryRecord) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (record.status === "proposed") {
    return (
      <div className="mc-review-actions" role="group" aria-labelledby={labelId}>
        <RowActionButton
          variant="primary"
          busyAction={busyAction}
          isBusy={busyAction === "accept"}
          busyLabel={t("memoria.approving")}
          idleLabel={t("memoria.approve")}
          onClick={() => onAccept(record)}
        />
        <RowActionButton
          variant="ghost"
          busyAction={busyAction}
          isBusy={busyAction === "reject"}
          busyLabel={t("memoria.rejecting")}
          idleLabel={t("memoria.reject")}
          onClick={() => onReject(record)}
        />
      </div>
    );
  }

  if (record.status === "conflicted") {
    return (
      <div className="mc-review-actions" role="group" aria-labelledby={labelId}>
        {/* Honest label: this action permanently sets status=rejected (no UI
            path back) — "Dismiss" suggested a mere hide (uiux-fix F035). */}
        <RowActionButton
          variant="ghost"
          busyAction={busyAction}
          isBusy={busyAction === "reject"}
          busyLabel={t("memoria.rejecting")}
          idleLabel={t("memoria.rejectConflict")}
          onClick={() => onReject(record)}
        />
      </div>
    );
  }

  return (
    <div className="mc-review-actions" role="group" aria-labelledby={labelId}>
      <RowActionButton
        variant="ghost"
        busyAction={busyAction}
        isBusy={busyAction === "archive"}
        busyLabel={t("memoria.archiving")}
        idleLabel={t("memoria.archiveStale")}
        onClick={() => onArchive(record)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReviewRow
// ---------------------------------------------------------------------------

function ReviewRow({
  record,
  busyAction,
  rowError,
  onAccept,
  onReject,
  onArchive,
  onOpenDetail,
  t,
}: ReviewRowProps): ReactNode {
  const labelId = `memory-review-body-${record.id}`;
  const detailLinkLabel = t("memoria.viewDetailsFor", {
    id: record.id,
    preview: record.body.slice(0, 80),
  });
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
            <span className="mc-row-type">{typeLabel(record.type, t)}</span>
            <span className="mc-row-scope">{scopeLabel(record.scope.kind, t)}</span>
            {/* static metadata label — role="status" would create one live
                region per row (uiux-fix F005) */}
            <span className={`mc-badge mc-badge-${record.status}`}>
              {statusLabel(record.status, t)}
            </span>
            <span>
              {t("memoria.confidence")}: {(record.provenance.confidence * 100).toFixed(0)}%
            </span>
            <span>
              {t("memoria.sensitivity")}: {sensitivityLabel(record.provenance.sensitivity, t)}
            </span>
            <span>
              {t("memoria.sourceKind")}: {record.provenance.sourceKind}
            </span>
            <CaptureRationale record={record} t={t} />
            <StaleIndicator record={record} t={t} />
            <RowDetailLink
              record={record}
              onOpenDetail={onOpenDetail}
              label={detailLinkLabel}
              t={t}
            />
          </div>
          <RowError rowError={rowError} />
        </div>
        <ReviewRowActions
          record={record}
          busyAction={busyAction}
          labelId={labelId}
          onAccept={onAccept}
          onReject={onReject}
          onArchive={onArchive}
          t={t}
        />
      </article>
    </li>
  );
}

interface ReviewQueueProps {
  readonly fetchQueueImpl?: typeof fetchMemoryReviewQueue;
  readonly acceptImpl?: typeof acceptMemoryProposal;
  readonly rejectImpl?: typeof rejectMemoryProposal;
  readonly archiveImpl?: typeof archiveMemory;
  readonly onBack?: (() => void) | undefined;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}

export function ReviewQueue({
  fetchQueueImpl = fetchMemoryReviewQueue,
  acceptImpl = acceptMemoryProposal,
  rejectImpl = rejectMemoryProposal,
  archiveImpl = archiveMemory,
  onBack,
  onOpenDetail,
}: ReviewQueueProps): ReactNode {
  const t = useTranslate();
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
            ? t("memoria.memoryApproved")
            : action === "archive"
              ? t("memoria.memoryArchived")
              : t("memoria.memoryRejected"),
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
    [acceptImpl, archiveImpl, rejectImpl, removeRecord, t],
  );

  return (
    <>
      <header className="lk-header mc-review-header">
        {/* tabIndex -1: programmatic focus target when the queue empties
            (uiux-fix F035) */}
        <h1 className="lk-title" tabIndex={-1} ref={headingRef}>
          {t("memoria.reviewQueue")}
        </h1>
        {/* visible label instead of aria-label-only: a bare number pill was
            unexplained for sighted users (uiux-fix F035) */}
        <span role="status" aria-live="polite" className="mc-badge-count">
          {t("memoria.awaitingReview", { count: records.length })}
        </span>
        {onBack !== undefined ? (
          <button
            type="button"
            className="lk-btn lk-btn-ghost lk-btn-lg"
            aria-label={t("memoria.backToMemoria")}
            onClick={onBack}
          >
            {t("memoria.back")}
          </button>
        ) : (
          <Link
            href="/memoriaviva"
            className="lk-btn lk-btn-ghost lk-btn-lg"
            aria-label={t("memoria.backToMemoria")}
          >
            {t("memoria.back")}
          </Link>
        )}
      </header>

      {/* Dedicated live region: row removals are not announced by the list
          (aria-relevant defaults to additions/text) — uiux-fix F035. */}
      <p role="status" className="visually-hidden">
        {actionStatus}
      </p>

      <section
        aria-label={t("memoria.reviewRegion")}
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {loading ? (
          <p role="status" aria-live="polite" className="lk-loading">
            {t("memoria.loadingReviewQueue")}
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
              {t("memoria.retry")}
            </button>
          </div>
        ) : records.length === 0 ? (
          <div data-testid="review-queue-empty" className="lk-empty">
            {/* wrapper div mirrors MemoryList's empty state so the title/body
                gap matches (the flex gap + title margin added up to ~20px
                without it — uiux-fix F035) */}
            <div>
              <p className="lk-empty-title">{t("memoria.queueClearTitle")}</p>
              <p className="lk-empty-body">{t("memoria.queueClearBody")}</p>
            </div>
          </div>
        ) : (
          <ul
            ref={listRef}
            aria-label={t("memoria.reviewQueue")}
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
                onOpenDetail={onOpenDetail}
                t={t}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
