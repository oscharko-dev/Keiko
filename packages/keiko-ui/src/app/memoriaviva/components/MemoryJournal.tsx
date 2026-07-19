"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, ReactNode, RefObject, SetStateAction } from "react";
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

interface JournalCapture extends MemoryRecentCapture {
  readonly memoryId: string;
}

interface JournalRowState {
  readonly capture: JournalCapture;
  readonly acknowledged: boolean;
}

interface JournalLoadState {
  readonly rows: readonly JournalRowState[];
  readonly loading: boolean;
  readonly error: string | null;
}

interface MemoryJournalProps {
  readonly onBack: () => void;
  readonly fetchRecentCapturesImpl?: typeof fetchRecentCaptures;
  readonly forgetMemoryImpl?: typeof forgetMemory;
  readonly acceptMemoryProposalImpl?: typeof acceptMemoryProposal;
}

function isJournalCapture(capture: MemoryRecentCapture): capture is JournalCapture {
  return capture.outcome !== "rejected" && capture.memoryId !== undefined;
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

function statusForCapture(capture: JournalCapture): MemoryRecord["status"] {
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
      <span>{t("memoria.journal.source", { source: capture.provenance.sourceKind })}</span>
      <span>{t("memoria.journal.reason", { reason: capture.reason })}</span>
      <time dateTime={captureTime(capture.occurredAt)}>
        {t("memoria.journal.capturedAt", { time: captureTime(capture.occurredAt) })}
      </time>
    </>
  );
}

interface JournalActionsProps {
  readonly row: JournalRowState;
  readonly busyAction: "keep" | "forget" | null;
  readonly onKeep: (capture: JournalCapture) => void;
  readonly onForget: (capture: JournalCapture) => void;
  readonly t: I18nTranslate;
}

function JournalActions({ row, busyAction, onKeep, onForget, t }: JournalActionsProps): ReactNode {
  const proposed = row.capture.outcome === "proposed";
  const busy = busyAction !== null;
  const indicator = row.acknowledged
    ? t("memoria.journal.indicator.kept")
    : proposed
      ? t("memoria.journal.indicator.proposed")
      : t("memoria.journal.indicator.auto");
  return (
    <div className={styles.mvJournalTrailing}>
      <StatusBadge status={statusForCapture(row.capture)} t={t} />
      <span className={styles.mvJournalIndicator}>{indicator}</span>
      <div className={styles.mvJournalActions}>
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-pressed={row.acknowledged}
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onKeep(row.capture);
          }}
        >
          {busyAction === "keep" ? t("memoria.journal.keeping") : t("memoria.journal.keep")}
        </button>
        <button
          type="button"
          className="lk-btn lk-btn-danger"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) onForget(row.capture);
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

function JournalRow({
  row,
  busyAction,
  onKeep,
  onForget,
  registerRow,
  t,
}: JournalRowProps): ReactNode {
  const body = row.capture.bodyExcerpt ?? t("memoria.journal.contentUnavailable");
  return (
    <li
      ref={(node) => registerRow(row.capture.memoryId, node)}
      className={`mc-row ${styles.mvJournalRow}`}
      data-testid="memory-journal-row"
      data-memory-id={row.capture.memoryId}
      data-created-at={String(row.capture.occurredAt)}
      tabIndex={-1}
    >
      <MemoryRowScaffold
        body={body}
        metadata={<JournalMetadata capture={row.capture} t={t} />}
        trailing={
          <JournalActions
            row={row}
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
  readonly onKeep: (capture: JournalCapture) => void;
  readonly onForget: (capture: JournalCapture) => void;
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

function JournalRows({
  state,
  keepBusyId,
  forgetBusyId,
  onKeep,
  onForget,
  registerRow,
  t,
}: JournalBodyProps): ReactNode {
  return (
    <ul className={styles.mvJournalList} aria-label={t("memoria.journal.list")}>
      {state.rows.map((row) => (
        <JournalRow
          key={row.capture.memoryId}
          row={row}
          busyAction={
            keepBusyId === row.capture.memoryId
              ? "keep"
              : forgetBusyId === row.capture.memoryId
                ? "forget"
                : null
          }
          onKeep={onKeep}
          onForget={onForget}
          registerRow={registerRow}
          t={t}
        />
      ))}
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
  const load = useCallback((): void => {
    const seq = (requestSeqRef.current += 1);
    setState((current) => ({ ...current, loading: true, error: null }));
    void fetchImpl()
      .then((response) => {
        if (seq !== requestSeqRef.current) return;
        const rows = orderJournalCaptures(response.captures)
          .filter(({ memoryId }) => !forgottenIds.current.has(memoryId))
          .map((capture) => ({ capture, acknowledged: keptIds.current.has(capture.memoryId) }));
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

function useKeepAction(
  options: ActionHookOptions,
  keptIds: MutableRefObject<Set<string>>,
  acceptImpl: typeof acceptMemoryProposal,
): readonly [string | null, (capture: JournalCapture) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const keep = useCallback(
    (capture: JournalCapture): void => {
      const current = options.rows.find((row) => row.capture.memoryId === capture.memoryId);
      if (busyId !== null || current?.acknowledged === true) return;
      setBusyId(capture.memoryId);
      options.setActionError(null);
      const accept =
        capture.outcome === "proposed" ? acceptImpl(capture.memoryId) : Promise.resolve();
      void accept
        .then(() => {
          keptIds.current.add(capture.memoryId);
          options.setRows((rows) =>
            rows.map((row) =>
              row.capture.memoryId === capture.memoryId
                ? { capture: { ...row.capture, outcome: "auto-accepted" }, acknowledged: true }
                : row,
            ),
          );
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
  return remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.capture.memoryId ?? null;
}

function useForgetAction(
  options: ActionHookOptions,
  forgottenIds: MutableRefObject<Set<string>>,
  forgetImpl: typeof forgetMemory,
  requestFocus: (targetId: string | null) => void,
): readonly [string | null, (capture: JournalCapture) => void] {
  const [busyId, setBusyId] = useState<string | null>(null);
  const forget = useCallback(
    (capture: JournalCapture): void => {
      if (busyId !== null || forgottenIds.current.has(capture.memoryId)) return;
      setBusyId(capture.memoryId);
      options.setActionError(null);
      void forgetImpl(capture.memoryId as MemoryId, "forgotten from the Memory Journal")
        .then(() => {
          const target = focusTargetAfterRemoval(options.rows, capture.memoryId);
          forgottenIds.current.add(capture.memoryId);
          requestFocus(target);
          options.setRows((rows) =>
            rows.filter((row) => row.capture.memoryId !== capture.memoryId),
          );
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
