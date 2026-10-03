"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslate } from "@/lib/i18n";
import { createSupportReport, downloadSupportReport } from "@/lib/support-report-api";
import {
  currentGlobalClientFailure,
  dismissGlobalClientFailure,
  reportClientDiagnostic,
  subscribeGlobalClientFailure,
} from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import styles from "./SupportReportButton.module.css";

const FEEDBACK_MS = 1500;
const MAX_FULFILLED_REPORTS = 128;
type ReportOutcome = AbortController | "fulfilled";
const outcomes = new Map<string, ReportOutcome>();
const outcomeListeners = new Set<() => void>();

function notifyOutcomes(): void {
  for (const listener of outcomeListeners) listener();
}

function subscribeOutcomes(listener: () => void): () => void {
  outcomeListeners.add(listener);
  return (): void => {
    outcomeListeners.delete(listener);
  };
}

function beginReport(key: string): AbortController | undefined {
  if (outcomes.has(key)) return undefined;
  const controller = new AbortController();
  outcomes.set(key, controller);
  notifyOutcomes();
  return controller;
}

function releaseReport(key: string, controller: AbortController): void {
  if (outcomes.get(key) !== controller) return;
  outcomes.delete(key);
  notifyOutcomes();
}

function fulfillReport(key: string): void {
  outcomes.set(key, "fulfilled");
  const fulfilled = [...outcomes].filter(([, outcome]) => outcome === "fulfilled");
  for (const [expired] of fulfilled.slice(0, -MAX_FULFILLED_REPORTS)) outcomes.delete(expired);
  notifyOutcomes();
}

export function resetSupportReportOutcomesForTests(): void {
  for (const outcome of outcomes.values()) if (outcome !== "fulfilled") outcome.abort();
  outcomes.clear();
  notifyOutcomes();
}

interface SupportReportButtonProps {
  readonly correlationId?: string | undefined;
  readonly errorKey?: string | undefined;
  readonly compact?: boolean;
  readonly onFulfilled?: (() => void) | undefined;
}

interface ReportFeedback {
  readonly key: string;
  readonly state: "idle" | "saved" | "error" | "fulfilled";
}

interface ReportRequestRef {
  current: { key: string; controller: AbortController } | null;
}

function useReportCancellation(key: string): ReportRequestRef {
  const request = useRef<ReportRequestRef["current"]>(null);
  useEffect(
    () => () => {
      const pending = request.current;
      if (pending === null) return;
      pending.controller.abort();
      releaseReport(pending.key, pending.controller);
      request.current = null;
    },
    [key],
  );
  return request;
}

function useSupportReportAction({
  correlationId,
  errorKey,
  onFulfilled,
}: SupportReportButtonProps): {
  readonly status: "idle" | "busy" | "saved" | "error" | "hidden";
  readonly create: () => Promise<void>;
} {
  const localId = useId();
  const key = correlationId ?? errorKey ?? localId;
  const outcome = useSyncExternalStore(
    subscribeOutcomes,
    () => outcomes.get(key),
    () => undefined,
  );
  const [feedback, setFeedback] = useState<ReportFeedback>({
    key,
    state: "idle",
  });
  const request = useReportCancellation(key);
  const currentFeedback = feedback.key === key ? feedback.state : "idle";
  useEffect(() => {
    if (outcome !== "fulfilled") return;
    if (currentFeedback !== "saved") {
      onFulfilled?.();
      return;
    }
    const timer = window.setTimeout(() => {
      setFeedback({ key, state: "fulfilled" });
      onFulfilled?.();
    }, FEEDBACK_MS);
    return (): void => window.clearTimeout(timer);
  }, [currentFeedback, key, onFulfilled, outcome]);
  const create = (): Promise<void> => runReport(key, correlationId, request, setFeedback);
  if (currentFeedback === "saved") return { status: "saved", create };
  if (outcome === "fulfilled" || currentFeedback === "fulfilled")
    return { status: "hidden", create };
  return { status: outcome === undefined ? currentFeedback : "busy", create };
}

async function runReport(
  key: string,
  correlationId: string | undefined,
  request: ReportRequestRef,
  setFeedback: (feedback: ReportFeedback) => void,
): Promise<void> {
  const controller = beginReport(key);
  if (controller === undefined) return;
  const pending = { key, controller };
  request.current = pending;
  try {
    const report = await createSupportReport(correlationId, controller.signal);
    if (controller.signal.aborted || request.current !== pending) return;
    downloadSupportReport(report);
    setFeedback({ key, state: "saved" });
    fulfillReport(key);
  } catch (error) {
    if (controller.signal.aborted || request.current !== pending) return;
    releaseReport(key, controller);
    setFeedback({ key, state: "error" });
    reportClientDiagnostic(`[keiko] support report failed: ${clientErrorSummary(error)}`, {
      correlationId: correlationIdOf(error),
      errorKind: bffRequestErrorKind(error),
    });
  } finally {
    if (request.current === pending) request.current = null;
  }
}

export function SupportReportButton(props: SupportReportButtonProps): ReactNode {
  const t = useTranslate();
  const { status, create } = useSupportReportAction(props);
  if (status === "hidden") return null;
  return (
    <span className={styles.control}>
      {status !== "saved" ? (
        <button
          type="button"
          className={`${props.compact === true ? "ft-seg" : "lk-btn"} ${styles.action}`}
          disabled={status === "busy"}
          onClick={() => void create()}
        >
          {t(status === "busy" ? "supportReport.creating" : "supportReport.create")}
        </button>
      ) : null}
      {status === "saved" || status === "error" ? (
        <span role="status" className={styles.feedback}>
          {t(status === "saved" ? "supportReport.saved" : "supportReport.failed")}
        </span>
      ) : null}
    </span>
  );
}

export function GlobalSupportReportAction(): ReactNode {
  const t = useTranslate();
  const failure = useSyncExternalStore(
    subscribeGlobalClientFailure,
    currentGlobalClientFailure,
    () => null,
  );
  const ordinal = failure?.ordinal;
  const dismiss = useCallback((): void => {
    if (ordinal !== undefined) dismissGlobalClientFailure(ordinal);
  }, [ordinal]);
  if (failure === null) return null;
  return (
    <span className={styles.control} role="group" aria-label={t("supportReport.create")}>
      <SupportReportButton
        compact
        correlationId={failure.correlationId}
        errorKey={`global-error-${failure.ordinal}`}
        onFulfilled={dismiss}
      />
      <button
        className={`ft-seg ${styles.action}`}
        type="button"
        aria-label={t("common.close")}
        onClick={dismiss}
      >
        ×
      </button>
    </span>
  );
}
