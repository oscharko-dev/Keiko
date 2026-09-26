"use client";

// Issue #211 — MemoriaViva review queue: proposed, conflicted, and stale records needing action.
//
// WCAG: role="status" aria-live="polite" on the count badge.
// Approve/Reject action buttons inline per row (≥ 24px target via lk-btn).
// Empty state when queue is clear. motion-safe on any animated element.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import type {
  AcceptMemoryProposalOptions,
  MemoryId,
  MemoryRecord,
} from "@oscharko-dev/keiko-contracts";
import { isMemoryRecord } from "@oscharko-dev/keiko-contracts/runtime/memory";
import {
  acceptMemoryProposal,
  archiveMemory,
  fetchCorrectionPredecessors,
  fetchMemoryReviewQueue,
  rejectMemoryProposal,
  type MemoryReviewQueueResponse,
} from "@/lib/memory-api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { formatError } from "./format-error";

type ReviewAction = "accept" | "reject" | "archive";

const REVIEW_ACTION_FIELDSET_STYLE: CSSProperties = {
  border: 0,
  margin: 0,
  minInlineSize: 0,
  padding: 0,
};

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

// Announcement text for the completed action — extracted as a switch instead
// of a nested ternary chain (mirrors typeLabel/scopeLabel/statusLabel above).
function actionStatusMessage(action: ReviewAction, t: I18nTranslate): string {
  switch (action) {
    case "accept":
      return t("memoria.memoryApproved");
    case "archive":
      return t("memoria.memoryArchived");
    case "reject":
      return t("memoria.memoryRejected");
  }
}

interface ReviewRowProps {
  readonly record: MemoryRecord;
  readonly predecessors: readonly MemoryRecord[] | undefined;
  readonly predecessorsLoading: boolean;
  readonly busyAction: ReviewAction | null;
  readonly rowError: string | null;
  readonly onAccept: (record: MemoryRecord, options: AcceptMemoryProposalOptions) => void;
  readonly onReject: (record: MemoryRecord) => void;
  readonly onArchive: (record: MemoryRecord) => void;
  readonly onRequestPredecessors: (record: MemoryRecord) => void;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly t: I18nTranslate;
}

type CorrectionPredecessorsById = ReadonlyMap<string, readonly MemoryRecord[]>;

function acceptsOptions(options: AcceptMemoryProposalOptions): boolean {
  return options.bodyOverride !== undefined || options.predecessorId !== undefined;
}

function verifiedCorrectionPredecessors(response: unknown): readonly MemoryRecord[] | undefined {
  if (typeof response !== "object" || response === null || Array.isArray(response))
    return undefined;
  const candidates = (response as { readonly candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || !candidates.every(isMemoryRecord)) return undefined;
  return candidates;
}

interface CorrectionPredecessorDecision {
  readonly acceptDisabled: boolean;
  readonly effectiveId: MemoryId | undefined;
  readonly loadRequired: boolean;
  readonly selectorCandidates: readonly MemoryRecord[] | undefined;
}

function correctionPredecessorDecision(
  record: MemoryRecord,
  candidates: readonly MemoryRecord[] | undefined,
  selectedId: MemoryId | undefined,
  loading: boolean,
): CorrectionPredecessorDecision {
  const none = { effectiveId: undefined, selectorCandidates: undefined } as const;
  if (record.type !== "correction") {
    return { ...none, acceptDisabled: loading, loadRequired: false };
  }
  if (candidates === undefined) {
    return { ...none, acceptDisabled: loading, loadRequired: true };
  }
  if (candidates.length === 0) {
    return { ...none, acceptDisabled: true, loadRequired: false };
  }
  if (candidates.length === 1) {
    return {
      ...none,
      acceptDisabled: loading,
      effectiveId: candidates[0]?.id,
      loadRequired: false,
    };
  }
  return {
    acceptDisabled: loading || selectedId === undefined,
    effectiveId: selectedId,
    loadRequired: false,
    selectorCandidates: candidates,
  };
}

function reviewAcceptOptions(
  editing: boolean,
  draftBody: string,
  predecessorId: MemoryId | undefined,
): AcceptMemoryProposalOptions {
  return {
    ...(editing ? { bodyOverride: draftBody } : {}),
    ...(predecessorId === undefined ? {} : { predecessorId }),
  };
}

function acceptOrLoadPredecessors(input: {
  readonly decision: CorrectionPredecessorDecision;
  readonly draftBody: string;
  readonly editing: boolean;
  readonly onAccept: ReviewRowProps["onAccept"];
  readonly onRequestPredecessors: ReviewRowProps["onRequestPredecessors"];
  readonly record: MemoryRecord;
}): void {
  if (input.decision.loadRequired) {
    input.onRequestPredecessors(input.record);
    return;
  }
  input.onAccept(
    input.record,
    reviewAcceptOptions(input.editing, input.draftBody, input.decision.effectiveId),
  );
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

function CorrectionPredecessorSelector({
  candidates,
  selectedId,
  onSelect,
  t,
}: {
  readonly candidates: readonly MemoryRecord[] | undefined;
  readonly selectedId: MemoryId | undefined;
  readonly onSelect: (id: MemoryId | undefined) => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (candidates === undefined || candidates.length < 2) return null;
  return (
    <label style={{ display: "grid", gap: "var(--space-1)" }}>
      {t("memoria.correctionPredecessor")}
      <select
        className="lk-input"
        value={selectedId ?? ""}
        onChange={(event) => {
          const selected = candidates.find(
            (candidate) => candidate.id === event.currentTarget.value,
          );
          onSelect(selected?.id);
        }}
      >
        <option value="">{t("memoria.selectCorrectionPredecessor")}</option>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.body.slice(0, 80)} ({candidate.id})
          </option>
        ))}
      </select>
    </label>
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
  disabled = false,
  onClick,
}: {
  readonly variant: "primary" | "ghost";
  readonly busyAction: "accept" | "reject" | "archive" | null;
  readonly isBusy: boolean;
  readonly busyLabel: string;
  readonly idleLabel: string;
  readonly disabled?: boolean | undefined;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`lk-btn lk-btn-${variant}`}
      aria-disabled={busyAction !== null || disabled}
      aria-busy={isBusy}
      onClick={() => {
        if (busyAction !== null || disabled) return;
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
  acceptDisabled,
  editing,
  onEdit,
  onCancelEdit,
  t,
}: {
  readonly record: MemoryRecord;
  readonly busyAction: ReviewAction | null;
  readonly labelId: string;
  readonly onAccept: () => void;
  readonly onReject: (record: MemoryRecord) => void;
  readonly onArchive: (record: MemoryRecord) => void;
  readonly acceptDisabled: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  if (record.status === "proposed") {
    return (
      <fieldset
        className="mc-review-actions"
        aria-labelledby={labelId}
        style={REVIEW_ACTION_FIELDSET_STYLE}
      >
        <RowActionButton
          variant="primary"
          busyAction={busyAction}
          isBusy={busyAction === "accept"}
          busyLabel={t("memoria.approving")}
          idleLabel={editing ? t("memoria.approveEditedProposal") : t("memoria.approve")}
          disabled={acceptDisabled}
          onClick={onAccept}
        />
        <RowActionButton
          variant="ghost"
          busyAction={busyAction}
          isBusy={false}
          busyLabel=""
          idleLabel={editing ? t("memoria.cancelEdit") : t("memoria.editProposal")}
          onClick={editing ? onCancelEdit : onEdit}
        />
        <RowActionButton
          variant="ghost"
          busyAction={busyAction}
          isBusy={busyAction === "reject"}
          busyLabel={t("memoria.rejecting")}
          idleLabel={t("memoria.reject")}
          onClick={() => onReject(record)}
        />
      </fieldset>
    );
  }

  if (record.status === "conflicted") {
    return (
      <fieldset
        className="mc-review-actions"
        aria-labelledby={labelId}
        style={REVIEW_ACTION_FIELDSET_STYLE}
      >
        {/* Archive, not reject: MEMORY_STATUS_TRANSITIONS gives `rejected` exactly one inbound
            edge (from `proposed`), so the server refuses conflicted -> rejected. Archive IS a
            legal exit from `conflicted`, is non-destructive, and keeps the honest-label rule
            (uiux-fix F035) — the button says what the server will actually do. */}
        <RowActionButton
          variant="ghost"
          busyAction={busyAction}
          isBusy={busyAction === "archive"}
          busyLabel={t("memoria.archiving")}
          idleLabel={t("memoria.archiveConflict")}
          onClick={() => onArchive(record)}
        />
      </fieldset>
    );
  }

  return (
    <fieldset
      className="mc-review-actions"
      aria-labelledby={labelId}
      style={REVIEW_ACTION_FIELDSET_STYLE}
    >
      <RowActionButton
        variant="ghost"
        busyAction={busyAction}
        isBusy={busyAction === "archive"}
        busyLabel={t("memoria.archiving")}
        idleLabel={t("memoria.archiveStale")}
        onClick={() => onArchive(record)}
      />
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// ReviewRow
// ---------------------------------------------------------------------------

function ReviewRow({
  record,
  predecessors,
  predecessorsLoading,
  busyAction,
  rowError,
  onAccept,
  onReject,
  onArchive,
  onRequestPredecessors,
  onOpenDetail,
  t,
}: ReviewRowProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(record.body);
  const [predecessorId, setPredecessorId] = useState<MemoryId | undefined>();
  const predecessorDecision = correctionPredecessorDecision(
    record,
    predecessors,
    predecessorId,
    predecessorsLoading,
  );
  const labelId = `memory-review-body-${record.id}`;
  const editorId = `memory-review-editor-${record.id}`;
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
          {editing ? (
            <div style={{ display: "grid", gap: "var(--space-2)" }}>
              <label id={labelId} htmlFor={editorId}>
                {t("memoria.proposalText")}
              </label>
              <textarea
                id={editorId}
                className="lk-input"
                value={draftBody}
                onChange={(event) => setDraftBody(event.currentTarget.value)}
              />
            </div>
          ) : (
            <p id={labelId} className="mc-row-body">
              {record.body}
            </p>
          )}
          <CorrectionPredecessorSelector
            candidates={predecessorDecision.selectorCandidates}
            selectedId={predecessorId}
            onSelect={setPredecessorId}
            t={t}
          />
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
          onAccept={() => {
            acceptOrLoadPredecessors({
              decision: predecessorDecision,
              draftBody,
              editing,
              onAccept,
              onRequestPredecessors,
              record,
            });
          }}
          onReject={onReject}
          onArchive={onArchive}
          acceptDisabled={predecessorDecision.acceptDisabled}
          editing={editing}
          onEdit={() => setEditing(true)}
          onCancelEdit={() => {
            setDraftBody(record.body);
            setEditing(false);
          }}
          t={t}
        />
      </article>
    </li>
  );
}

interface ReviewQueueProps {
  readonly fetchQueueImpl?: typeof fetchMemoryReviewQueue;
  readonly fetchCorrectionPredecessorsImpl?: typeof fetchCorrectionPredecessors;
  readonly acceptImpl?: typeof acceptMemoryProposal;
  readonly rejectImpl?: typeof rejectMemoryProposal;
  readonly archiveImpl?: typeof archiveMemory;
  readonly onBack?: (() => void) | undefined;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}

export function ReviewQueue({
  fetchQueueImpl = fetchMemoryReviewQueue,
  fetchCorrectionPredecessorsImpl = fetchCorrectionPredecessors,
  acceptImpl = acceptMemoryProposal,
  rejectImpl = rejectMemoryProposal,
  archiveImpl = archiveMemory,
  onBack,
  onOpenDetail,
}: ReviewQueueProps): ReactNode {
  const t = useTranslate();
  const [records, setRecords] = useState<readonly MemoryRecord[]>([]);
  const [predecessorsById, setPredecessorsById] = useState<CorrectionPredecessorsById>(
    () => new Map(),
  );
  const [predecessorsLoadingById, setPredecessorsLoadingById] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const predecessorRequestsRef = useRef(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyById, setBusyById] = useState<Partial<Record<string, ReviewAction>>>({});
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
      setPredecessorsById(new Map());
      setPredecessorsLoadingById({});
      predecessorRequestsRef.current.clear();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchQueueImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  const requestCorrectionPredecessors = useCallback(
    async (record: MemoryRecord): Promise<void> => {
      if (predecessorRequestsRef.current.has(record.id)) return;
      predecessorRequestsRef.current.add(record.id);
      setPredecessorsLoadingById((prev) => ({ ...prev, [record.id]: true }));
      try {
        const response = await fetchCorrectionPredecessorsImpl(record.id);
        const candidates = verifiedCorrectionPredecessors(response);
        if (candidates === undefined) {
          reportClientDiagnostic(
            "[keiko] memory correction predecessor response rejected (kind=invalid-response)",
          );
          predecessorRequestsRef.current.delete(record.id);
          setRowErrorsById((prev) => ({
            ...prev,
            [record.id]: t("memoria.correctionPredecessorInvalid"),
          }));
          return;
        }
        setPredecessorsById((prev) => new Map(prev).set(record.id, candidates));
        setRowErrorsById((prev) => {
          const next = { ...prev };
          if (candidates.length === 0) {
            next[record.id] = t("memoria.correctionPredecessorMissing");
          } else {
            delete next[record.id];
          }
          return next;
        });
      } catch (err) {
        predecessorRequestsRef.current.delete(record.id);
        setRowErrorsById((prev) => ({ ...prev, [record.id]: formatError(err) }));
      } finally {
        setPredecessorsLoadingById((prev) => ({ ...prev, [record.id]: false }));
      }
    },
    [fetchCorrectionPredecessorsImpl, t],
  );

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
      setPredecessorsById((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      predecessorRequestsRef.current.delete(id);
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
    async (
      record: MemoryRecord,
      action: "accept" | "reject" | "archive",
      acceptOptions: AcceptMemoryProposalOptions = {},
    ): Promise<void> => {
      const id = record.id as MemoryId;
      setBusyById((prev) => ({ ...prev, [id]: action }));
      setRowErrorsById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });

      try {
        if (action === "accept") {
          if (!acceptsOptions(acceptOptions)) {
            await acceptImpl(id);
          } else {
            await acceptImpl(id, acceptOptions);
          }
        } else if (action === "archive") {
          await archiveImpl(
            id,
            record.status === "conflicted"
              ? "archived conflicting memory from review queue"
              : "archived stale memory from review queue",
          );
        } else {
          await rejectImpl(id, "rejected from review queue");
        }
        removeRecord(id);
        setActionStatus(actionStatusMessage(action, t));
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

  // The section content is one of four mutually exclusive states — loading,
  // error, empty, or populated. Each state's markup is extracted into its own
  // small render helper so renderReviewSection itself stays a short dispatch
  // instead of a nested ternary chain (mirrors MemoryListBody in
  // MemoryList.tsx).
  function renderQueueLoading(): ReactNode {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        {t("memoria.loadingReviewQueue")}
      </p>
    );
  }

  function renderQueueError(): ReactNode {
    return (
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
    );
  }

  function renderQueueEmpty(): ReactNode {
    return (
      <div data-testid="review-queue-empty" className="lk-empty">
        {/* wrapper div mirrors MemoryList's empty state so the title/body
            gap matches (the flex gap + title margin added up to ~20px
            without it — uiux-fix F035) */}
        <div>
          <p className="lk-empty-title">{t("memoria.queueClearTitle")}</p>
          <p className="lk-empty-body">{t("memoria.queueClearBody")}</p>
        </div>
      </div>
    );
  }

  function renderQueueList(): ReactNode {
    return (
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
            predecessors={predecessorsById.get(record.id)}
            predecessorsLoading={predecessorsLoadingById[record.id] === true}
            busyAction={busyById[record.id] ?? null}
            rowError={rowErrorsById[record.id] ?? null}
            onAccept={(row, options) => {
              void runRowAction(row, "accept", options);
            }}
            onReject={(row) => {
              void runRowAction(row, "reject");
            }}
            onArchive={(row) => {
              void runRowAction(row, "archive");
            }}
            onRequestPredecessors={(row) => {
              void requestCorrectionPredecessors(row);
            }}
            onOpenDetail={onOpenDetail}
            t={t}
          />
        ))}
      </ul>
    );
  }

  function renderReviewSection(): ReactNode {
    if (loading) {
      return renderQueueLoading();
    }
    if (error !== null) {
      return renderQueueError();
    }
    if (records.length === 0) {
      return renderQueueEmpty();
    }
    return renderQueueList();
  }

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
      <output className="visually-hidden">{actionStatus}</output>

      <section
        aria-label={t("memoria.reviewRegion")}
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        {renderReviewSection()}
      </section>
    </>
  );
}
