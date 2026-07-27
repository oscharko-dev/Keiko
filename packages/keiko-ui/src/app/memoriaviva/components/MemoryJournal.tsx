"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import {
  acceptMemoryProposal,
  fetchRecentCaptures,
  forgetMemory,
  type MemoryRecentCapture,
} from "@/lib/memory-api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { MemoryListState, MemoryRowScaffold, StatusBadge } from "./MemoryList";
import { formatError } from "./format-error";
import styles from "./MemoryJournal.module.css";

interface PersistedJournalCapture extends MemoryRecentCapture {
  readonly outcome: Exclude<MemoryRecentCapture["outcome"], "rejected">;
  readonly memoryId: MemoryId;
}

type RefusedJournalCapture = MemoryRecentCapture & { readonly outcome: "rejected" };
type JournalCapture = PersistedJournalCapture | RefusedJournalCapture;

interface JournalRowState {
  readonly capture: JournalCapture;
  readonly acknowledged: boolean;
}

interface JournalLoadState {
  readonly rows: readonly JournalRowState[];
  readonly loading: boolean;
  readonly error: string | null;
}

// Mirrors memory-consolidation-handlers.ts's DEFAULT_MAX_AGE_MS: bounding the query keeps the
// server's audit-ledger replay (memory-capture-projection.ts) from growing with total ledger size
// on every Journal load instead of with the visible history window.
const JOURNAL_HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

interface MemoryJournalProps {
  readonly onBack: () => void;
  readonly fetchRecentCapturesImpl?: typeof fetchRecentCaptures;
  readonly forgetMemoryImpl?: typeof forgetMemory;
  readonly acceptMemoryProposalImpl?: typeof acceptMemoryProposal;
}

function isJournalCapture(capture: MemoryRecentCapture): capture is JournalCapture {
  return capture.outcome === "rejected" || capture.memoryId !== undefined;
}

// Non-rejected rows key by memoryId, matching JournalRow's own registerRow/key usage below.
// Rejected captures have no memoryId; eventId is the server-minted per-decision UUID (present on
// every projected decision, see memory-capture-projection.ts) and is the only value guaranteed
// unique across two rejected decisions that share the same turn occurredAt/mode/reason — the
// previous occurredAt/mode/reason-derived fallback could collide.
function journalCaptureKey(capture: JournalCapture): string {
  return capture.memoryId ?? capture.eventId;
}

export function orderJournalCaptures(
  captures: readonly MemoryRecentCapture[],
): readonly JournalCapture[] {
  return captures
    .filter(isJournalCapture)
    .slice()
    .sort((left, right) => right.occurredAt - left.occurredAt);
}

function modeLabel(capture: JournalCapture, t: I18nTranslate): string {
  switch (capture.mode) {
    case "governed-assist":
      return t("memoria.journal.mode.governedAssist");
    case "supervised-coding":
      return t("memoria.journal.mode.supervisedCoding");
    case "autonomous-delivery":
      return t("memoria.journal.mode.autonomousDelivery");
    default:
      return t("memoria.journal.mode.unknown");
  }
}

function surfaceLabel(capture: JournalCapture, t: I18nTranslate): string {
  return capture.provenance.initiatorSurface === "voice"
    ? t("memoria.journal.surface.voice")
    : t("memoria.journal.surface.conversationCenter");
}

function statusForCapture(capture: PersistedJournalCapture): MemoryRecord["status"] {
  return capture.outcome === "proposed" ? "proposed" : "accepted";
}

function captureTime(occurredAt: number): string {
  const date = new Date(occurredAt);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString();
}

function JournalMetadata({
  capture,
  t,
}: {
  readonly capture: JournalCapture;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <>
      <span className={styles.mvJournalMetaBadge}>{modeLabel(capture, t)}</span>
      <span>{t("memoria.journal.surface", { surface: surfaceLabel(capture, t) })}</span>
      <span>{t("memoria.journal.source", { source: capture.provenance.sourceKind })}</span>
      <span>{t("memoria.journal.reason", { reason: capture.reason })}</span>
      <time dateTime={captureTime(capture.occurredAt)}>
        {t("memoria.journal.capturedAt", { time: captureTime(capture.occurredAt) })}
      </time>
    </>
  );
}

interface JournalActionsProps {
  readonly capture: PersistedJournalCapture;
  readonly acknowledged: boolean;
  readonly busyAction: "keep" | "forget" | null;
  readonly onKeep: (capture: PersistedJournalCapture) => void;
  readonly onForget: (capture: PersistedJournalCapture) => void;
  readonly t: I18nTranslate;
}

function journalIndicatorLabel(acknowledged: boolean, proposed: boolean, t: I18nTranslate): string {
  if (acknowledged) return t("memoria.journal.indicator.kept");
  if (proposed) return t("memoria.journal.indicator.proposed");
  return t("memoria.journal.indicator.auto");
}

function JournalActions({
  capture,
  acknowledged,
  busyAction,
  onKeep,
  onForget,
  t,
}: JournalActionsProps): ReactNode {
  const proposed = capture.outcome === "proposed";
  const busy = busyAction !== null;
  const indicator = journalIndicatorLabel(acknowledged, proposed, t);
  return (
    <div className={styles.mvJournalTrailing}>
      <StatusBadge status={statusForCapture(capture)} t={t} />
      <span className={styles.mvJournalIndicator}>{indicator}</span>
      <div className={styles.mvJournalActions}>
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-pressed={acknowledged}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onKeep(capture);
          }}
        >
          {busyAction === "keep" ? t("memoria.journal.keeping") : t("memoria.journal.keep")}
        </button>
        <button
          type="button"
          className="lk-btn lk-btn-danger"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onForget(capture);
          }}
        >
          {busyAction === "forget" ? t("memoria.journal.forgetting") : t("memoria.journal.forget")}
        </button>
      </div>
    </div>
  );
}

interface JournalRowProps extends JournalActionsProps {
  readonly registerRow: (id: string, node: HTMLLIElement | null) => void;
}

interface RefusedJournalRowProps {
  readonly capture: RefusedJournalCapture;
  readonly registerRow: (id: string, node: HTMLLIElement | null) => void;
  readonly t: I18nTranslate;
}

function RefusedJournalRow({ capture, registerRow, t }: RefusedJournalRowProps): ReactNode {
  const key = journalCaptureKey(capture);
  return (
    <li
      ref={(node) => registerRow(key, node)}
      className={`mc-row ${styles.mvJournalRow}`}
      data-testid="memory-journal-row"
      data-outcome="rejected"
      data-created-at={String(capture.occurredAt)}
      tabIndex={-1}
    >
      <MemoryRowScaffold
        body={t("memoria.journal.refusedBody")}
        metadata={<JournalMetadata capture={capture} t={t} />}
        trailing={
          <div className={styles.mvJournalTrailing}>
            <span className={styles.mvJournalIndicator}>
              {t("memoria.journal.indicator.refused")}
            </span>
          </div>
        }
      />
    </li>
  );
}

function JournalRow({
  capture,
  acknowledged,
  busyAction,
  onKeep,
  onForget,
  registerRow,
  t,
}: JournalRowProps): ReactNode {
  const body = capture.bodyExcerpt ?? t("memoria.journal.contentUnavailable");
  return (
    <li
      ref={(node) => registerRow(capture.memoryId, node)}
      className={`mc-row ${styles.mvJournalRow}`}
      data-testid="memory-journal-row"
      data-memory-id={capture.memoryId}
      data-outcome={capture.outcome}
      data-created-at={String(capture.occurredAt)}
      tabIndex={-1}
    >
      <MemoryRowScaffold
        body={body}
        metadata={<JournalMetadata capture={capture} t={t} />}
        trailing={
          <JournalActions
            capture={capture}
            acknowledged={acknowledged}
            busyAction={busyAction}
            onKeep={onKeep}
            onForget={onForget}
            t={t}
          />
        }
      />
    </li>
  );
}

interface JournalBodyProps {
  readonly state: JournalLoadState;
  readonly keepBusyId: string | null;
  readonly forgetBusyId: string | null;
  readonly onRetry: () => void;
  readonly onKeep: (capture: PersistedJournalCapture) => void;
  readonly onForget: (capture: PersistedJournalCapture) => void;
  readonly registerRow: (id: string, node: HTMLLIElement | null) => void;
  readonly t: I18nTranslate;
}

function JournalBody(props: JournalBodyProps): ReactNode {
  const { state, onRetry, t } = props;
  return (
    <MemoryListState
      loading={state.loading}
      hasItems={state.rows.length > 0}
      error={state.error}
      loadingLabel={t("memoria.journal.loading")}
      retryLabel={t("memoria.retry")}
      emptyState={
        <div data-testid="memory-journal-empty" className="lk-empty">
          <div>
            <p className="lk-empty-title">{t("memoria.journal.emptyTitle")}</p>
            <p className="lk-empty-body">{t("memoria.journal.emptyBody")}</p>
          </div>
        </div>
      }
      onRetry={onRetry}
    >
      <JournalRows {...props} />
    </MemoryListState>
  );
}

function busyActionFor(
  memoryId: string,
  keepBusyId: string | null,
  forgetBusyId: string | null,
): "keep" | "forget" | null {
  if (keepBusyId === memoryId) return "keep";
  if (forgetBusyId === memoryId) return "forget";
  return null;
}

type JournalRowsProps = Omit<JournalBodyProps, "onRetry">;

function JournalRows({
  state,
  keepBusyId,
  forgetBusyId,
  onKeep,
  onForget,
  registerRow,
  t,
}: JournalRowsProps): ReactNode {
  return (
    <ul className={styles.mvJournalList} aria-label={t("memoria.journal.list")}>
      {state.rows.map((row) =>
        row.capture.outcome === "rejected" ? (
          <RefusedJournalRow
            key={journalCaptureKey(row.capture)}
            capture={row.capture}
            registerRow={registerRow}
            t={t}
          />
        ) : (
          <JournalRow
            key={row.capture.memoryId}
            capture={row.capture}
            acknowledged={row.acknowledged}
            busyAction={busyActionFor(row.capture.memoryId, keepBusyId, forgetBusyId)}
            onKeep={onKeep}
            onForget={onForget}
            registerRow={registerRow}
            t={t}
          />
        ),
      )}
    </ul>
  );
}

function useJournalRows(
  fetchImpl: typeof fetchRecentCaptures,
  forgottenIds: RefObject<Set<string>>,
  keptIds: RefObject<Set<string>>,
  setAnnouncement: Dispatch<SetStateAction<string>>,
  t: I18nTranslate,
): readonly [JournalLoadState, () => void, Dispatch<SetStateAction<readonly JournalRowState[]>>] {
  const [state, setState] = useState<JournalLoadState>({ rows: [], loading: true, error: null });
  const requestSeqRef = useRef(0);
  const sinceRef = useRef(Date.now() - JOURNAL_HISTORY_WINDOW_MS);
  const load = useCallback((): void => {
    const seq = (requestSeqRef.current += 1);
    setState((current) => ({ ...current, loading: true, error: null }));
    void fetchImpl({ since: sinceRef.current })
      .then((response) => {
        if (seq !== requestSeqRef.current) return;
        const rows = orderJournalCaptures(response.captures)
          .filter(({ memoryId }) => memoryId === undefined || !forgottenIds.current.has(memoryId))
          .map((capture) => ({
            capture,
            acknowledged: capture.memoryId !== undefined && keptIds.current.has(capture.memoryId),
          }));
        setState({ rows, loading: false, error: null });
        setAnnouncement(t("memoria.journal.loaded", { count: rows.length }));
      })
      .catch((error: unknown) => {
        if (seq !== requestSeqRef.current) return;
        setState((current) => ({ ...current, loading: false, error: formatError(error) }));
      });
  }, [fetchImpl, forgottenIds, keptIds, setAnnouncement, t]);
  useEffect(load, [load]);
  const setRows = useCallback((next: SetStateAction<readonly JournalRowState[]>): void => {
    setState((current) => ({
      ...current,
      rows: typeof next === "function" ? next(current.rows) : next,
    }));
  }, []);
  return [state, load, setRows];
}

function useJournalFocus(
  rows: readonly JournalRowState[],
  headingRef: RefObject<HTMLHeadingElement | null>,
): readonly [(id: string, node: HTMLLIElement | null) => void, (targetId: string | null) => void] {
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const pendingTarget = useRef<string | null | undefined>(undefined);
  const registerRow = useCallback((id: string, node: HTMLLIElement | null): void => {
    if (node === null) rowRefs.current.delete(id);
    else rowRefs.current.set(id, node);
  }, []);
  const requestFocus = useCallback((targetId: string | null): void => {
    pendingTarget.current = targetId;
  }, []);
  useEffect(() => {
    const target = pendingTarget.current;
    if (target === undefined) return;
    pendingTarget.current = undefined;
    if (target === null) headingRef.current?.focus();
    else rowRefs.current.get(target)?.focus();
  }, [headingRef, rows]);
  return [registerRow, requestFocus];
}

interface ActionHookOptions {
  readonly rows: readonly JournalRowState[];
  readonly setRows: Dispatch<SetStateAction<readonly JournalRowState[]>>;
  readonly setActionError: Dispatch<SetStateAction<string | null>>;
  readonly setAnnouncement: Dispatch<SetStateAction<string>>;
  readonly t: I18nTranslate;
}

function acknowledgeJournalRow(row: JournalRowState, memoryId: string): JournalRowState {
  const capture = row.capture;
  if (capture.outcome === "rejected" || capture.memoryId !== memoryId) return row;
  if (capture.outcome !== "proposed") return { capture, acknowledged: true };
  return {
    capture: { ...capture, outcome: "auto-accepted" },
    acknowledged: true,
  };
}

function acknowledgeRows(
  rows: readonly JournalRowState[],
  memoryId: string,
): readonly JournalRowState[] {
  return rows.map((row) => acknowledgeJournalRow(row, memoryId));
}

function useKeepAction(
  options: ActionHookOptions,
  keptIds: RefObject<Set<string>>,
  acceptImpl: typeof acceptMemoryProposal,
): readonly [string | null, (capture: PersistedJournalCapture) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const keep = useCallback(
    (capture: PersistedJournalCapture): void => {
      const current = options.rows.find((row) => row.capture.memoryId === capture.memoryId);
      if (busyId !== null || current?.acknowledged === true) return;
      setBusyId(capture.memoryId);
      options.setActionError(null);
      const accept =
        capture.outcome === "proposed" ? acceptImpl(capture.memoryId) : Promise.resolve();
      void accept
        .then(() => {
          keptIds.current.add(capture.memoryId);
          options.setRows((rows) => acknowledgeRows(rows, capture.memoryId));
          options.setAnnouncement(options.t("memoria.journal.kept"));
        })
        .catch(() => options.setActionError(options.t("memoria.journal.keepError")))
        .finally(() => setBusyId(null));
    },
    [acceptImpl, busyId, keptIds, options],
  );
  return [busyId, keep];
}

function focusTargetAfterRemoval(
  rows: readonly JournalRowState[],
  memoryId: string,
): string | null {
  const index = rows.findIndex((row) => row.capture.memoryId === memoryId);
  const remaining = rows.filter((row) => row.capture.memoryId !== memoryId);
  if (remaining.length === 0) return null;
  const target = remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.capture;
  return target === undefined ? null : journalCaptureKey(target);
}

function removeRow(rows: readonly JournalRowState[], memoryId: string): readonly JournalRowState[] {
  return rows.filter((row) => row.capture.memoryId !== memoryId);
}

function useForgetAction(
  options: ActionHookOptions,
  forgottenIds: RefObject<Set<string>>,
  forgetImpl: typeof forgetMemory,
  requestFocus: (targetId: string | null) => void,
): readonly [string | null, (capture: PersistedJournalCapture) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const forget = useCallback(
    (capture: PersistedJournalCapture): void => {
      if (busyId !== null || forgottenIds.current.has(capture.memoryId)) return;
      setBusyId(capture.memoryId);
      options.setActionError(null);
      void forgetImpl(capture.memoryId, "forgotten from the Memory Journal")
        .then(() => {
          const target = focusTargetAfterRemoval(options.rows, capture.memoryId);
          forgottenIds.current.add(capture.memoryId);
          requestFocus(target);
          options.setRows((rows) => removeRow(rows, capture.memoryId));
          options.setAnnouncement(options.t("memoria.journal.forgotten"));
        })
        .catch(() => options.setActionError(options.t("memoria.journal.forgetError")))
        .finally(() => setBusyId(null));
    },
    [busyId, forgetImpl, forgottenIds, options, requestFocus],
  );
  return [busyId, forget];
}

export function MemoryJournal({
  onBack,
  fetchRecentCapturesImpl = fetchRecentCaptures,
  forgetMemoryImpl = forgetMemory,
  acceptMemoryProposalImpl = acceptMemoryProposal,
}: MemoryJournalProps): ReactNode {
  const t = useTranslate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const forgottenIds = useRef(new Set<string>());
  const keptIds = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState(t("memoria.journal.loading"));
  const [actionError, setActionError] = useState<string | null>(null);
  const [state, retry, setRows] = useJournalRows(
    fetchRecentCapturesImpl,
    forgottenIds,
    keptIds,
    setAnnouncement,
    t,
  );
  const [registerRow, requestFocus] = useJournalFocus(state.rows, headingRef);
  const actionOptions = { rows: state.rows, setRows, setActionError, setAnnouncement, t };
  const [keepBusyId, onKeep] = useKeepAction(actionOptions, keptIds, acceptMemoryProposalImpl);
  const [forgetBusyId, onForget] = useForgetAction(
    actionOptions,
    forgottenIds,
    forgetMemoryImpl,
    requestFocus,
  );
  return (
    <section className={styles.mvJournal} aria-labelledby="memory-journal-title">
      <header className={`lk-header ${styles.mvJournalHeader}`}>
        <div className={styles.mvJournalHeading}>
          <h1 id="memory-journal-title" className="lk-title" ref={headingRef} tabIndex={-1}>
            {t("memoria.journal.title")}
          </h1>
          <p className={styles.mvJournalDescription}>{t("memoria.journal.description")}</p>
        </div>
        <button type="button" className="lk-btn lk-btn-ghost lk-btn-lg" onClick={onBack}>
          {t("memoria.back")}
        </button>
      </header>
      <p role="status" aria-live="polite" className="visually-hidden">
        {announcement}
      </p>
      {actionError === null ? null : (
        <p role="alert" className="lk-alert">
          {actionError}
        </p>
      )}
      <div className={styles.mvJournalScroll} aria-busy={state.loading}>
        <JournalBody
          state={state}
          keepBusyId={keepBusyId}
          forgetBusyId={forgetBusyId}
          onRetry={retry}
          onKeep={onKeep}
          onForget={onForget}
          registerRow={registerRow}
          t={t}
        />
      </div>
    </section>
  );
}
