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
import type { MessageKey } from "@/lib/i18n-messages.en";
import {
  MAX_SUPPORT_REPORT_BYTES,
  isActivityLogCorrelationId,
  type DesktopSupportReportResponse,
  type ClientOnlySupportReportInput,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SupportReportDownload } from "@/lib/support-report-api";
import {
  originalSupportReportFailure,
  prepareCachedSupportReport,
  prepareLocalSupportReport,
} from "@/lib/support-report-local";
import { ApiError } from "@/lib/api";
import {
  currentGlobalClientFailure,
  dismissGlobalClientFailure,
  reportClientDiagnostic,
  subscribeGlobalClientFailure,
} from "@/lib/client-diagnostics";
import { clientErrorSummary, correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";
import styles from "./SupportReportButton.module.css";

const REPORT_DEADLINE_MS = 35_000;
const MAX_FULFILLED_REPORTS = 128;
interface ReadyReport {
  readonly report: DesktopSupportReportResponse;
  readonly download: SupportReportDownload | undefined;
  readonly bytes: number;
  readonly pending?: AbortController;
}
type ReportOutcome = AbortController | ReadyReport;
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

/** Observes the existing bounded outcome while its owning surface recovers. */
export function useSupportReportPresence(key: string): boolean {
  return useSyncExternalStore(
    subscribeOutcomes,
    () => outcomes.has(key),
    () => false,
  );
}

function beginReport(key: string, regenerate: boolean): AbortController | undefined {
  const prior = outcomes.get(key);
  if (prior instanceof AbortController) return undefined;
  if (prior !== undefined && (!regenerate || prior.pending !== undefined)) return undefined;
  const controller = new AbortController();
  outcomes.set(key, prior === undefined ? controller : { ...prior, pending: controller });
  notifyOutcomes();
  return controller;
}

function releaseReport(key: string, controller: AbortController): void {
  const outcome = outcomes.get(key);
  if (outcome === controller) outcomes.delete(key);
  else if (
    outcome !== undefined &&
    !(outcome instanceof AbortController) &&
    outcome.pending === controller
  ) {
    const { report, download, bytes } = outcome;
    outcomes.set(key, { report, download, bytes });
  } else return;
  notifyOutcomes();
}

function fulfilledReports(): readonly (readonly [string, ReadyReport])[] {
  return [...outcomes].flatMap(([key, outcome]) =>
    outcome instanceof AbortController ? [] : [[key, outcome] as const],
  );
}

function disposeReadyReport(ready: ReadyReport): void {
  ready.pending?.abort();
  ready.download?.dispose();
}

function forgetReadyReport(key: string): void {
  const outcome = outcomes.get(key);
  if (outcome === undefined || outcome instanceof AbortController) return;
  disposeReadyReport(outcome);
  outcomes.delete(key);
  notifyOutcomes();
}

function expireServerDownload(key: string): void {
  const outcome = outcomes.get(key);
  if (outcome === undefined || outcome instanceof AbortController) return;
  outcome.download?.dispose();
  outcomes.set(key, { ...outcome, download: undefined });
  notifyOutcomes();
}

function fulfillReport(
  key: string,
  report: DesktopSupportReportResponse,
  download: SupportReportDownload,
): number {
  const bytes = new TextEncoder().encode(report.reportJson).byteLength;
  if (bytes > MAX_SUPPORT_REPORT_BYTES) {
    download.dispose();
    throw new TypeError("Support report cache budget exceeded");
  }
  const prior = outcomes.get(key);
  if (prior !== undefined && !(prior instanceof AbortController)) disposeReadyReport(prior);
  outcomes.set(key, { report, download, bytes });
  let retainedBytes = fulfilledReports().reduce((total, [, ready]) => total + ready.bytes, 0);
  const ready = fulfilledReports();
  for (const [expired, entry] of ready) {
    if (retainedBytes <= MAX_SUPPORT_REPORT_BYTES && outcomes.size <= MAX_FULFILLED_REPORTS) break;
    if (expired === key) continue;
    retainedBytes -= entry.bytes;
    disposeReadyReport(entry);
    outcomes.delete(expired);
  }
  notifyOutcomes();
  return bytes;
}

export function resetSupportReportOutcomesForTests(): void {
  for (const outcome of outcomes.values()) {
    if (outcome instanceof AbortController) outcome.abort();
    else disposeReadyReport(outcome);
  }
  outcomes.clear();
  notifyOutcomes();
}

interface SupportReportButtonProps {
  readonly correlationId?: string | undefined;
  readonly errorKey?: string | undefined;
  readonly compact?: boolean;
  readonly clientOnly?: boolean;
  readonly disposeOnUnmount?: boolean;
  readonly failure?: ClientOnlySupportReportInput["failure"];
}

type ReportFailure = "error" | "session-denied" | "service-unavailable" | "rate-limited";
type ReportStatus = "idle" | "busy" | "saved" | "expired" | ReportFailure;

interface ReportFeedback {
  readonly key: string;
  readonly state: "idle" | "saved" | ReportFailure;
}

interface ReportRequestRef {
  current: { key: string; controller: AbortController } | null;
}

function reportRequestIsCurrent(
  request: ReportRequestRef,
  pending: NonNullable<ReportRequestRef["current"]>,
): boolean {
  return !pending.controller.signal.aborted && request.current === pending;
}

function waitForReportStep<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject): void => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value): void => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown): void => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function isReportDeliveryUnavailable(
  error: unknown,
  api: typeof import("@/lib/support-report-api") | undefined,
  signal: AbortSignal,
): boolean {
  return signal.aborted || localReportFallbackAllowed(error, api);
}

function isReportResponseInvalid(
  error: unknown,
  api: typeof import("@/lib/support-report-api") | undefined,
): boolean {
  return (
    api?.SupportReportResponseInvalid !== undefined &&
    error instanceof api.SupportReportResponseInvalid
  );
}

function localReportFallbackAllowed(
  error: unknown,
  api: typeof import("@/lib/support-report-api") | undefined,
): boolean {
  // No API module means preparation failed while loading its chunk, before any server result.
  // The already loaded canonical local producer can still describe this availability failure.
  if (api === undefined) return true;
  if (error instanceof api.SupportReportEvidenceUnavailable) return true;
  if (isReportResponseInvalid(error, api)) return false;
  if (error instanceof ApiError)
    return error.status >= 500 && error.code !== "CONTRACT_VALIDATION_FAILED";
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")
  );
}

function reportLocalPreparation(
  report: DesktopSupportReportResponse,
  correlationId: string | undefined,
  reportBytes: number,
): void {
  const summary = report.summary;
  if (summary?.completeness === undefined || summary.loss === undefined) return;
  if (report.evidenceScope === "client-only" && summary.availabilityReason === undefined) return;
  reportClientDiagnostic("Keiko support report prepared locally.", {
    correlationId,
    supportReportPreparation: {
      reportBytes,
      evidenceScope: report.evidenceScope ?? "server",
      completeness: summary.completeness,
      loss: summary.loss,
      ...(report.evidenceScope === "client-only" && summary.availabilityReason !== undefined
        ? { availabilityReason: summary.availabilityReason }
        : {}),
    },
  });
}

function localPreparationContext(
  error: unknown,
  api: typeof import("@/lib/support-report-api") | undefined,
  context: Pick<ClientOnlySupportReportInput, "correlationId" | "failure">,
): Pick<ClientOnlySupportReportInput, "correlationId" | "failure"> &
  Partial<Pick<ClientOnlySupportReportInput, "availabilityReason">> {
  return {
    ...context,
    ...(api !== undefined
      ? { availabilityReason: api.supportReportAvailabilityReason(error) }
      : {}),
  };
}

async function recoverLocalReport(
  key: string,
  controller: AbortController,
  error: unknown,
  api: typeof import("@/lib/support-report-api") | undefined,
  context: Pick<ClientOnlySupportReportInput, "correlationId" | "failure">,
): Promise<boolean> {
  const previous = outcomes.get(key);
  if (
    previous !== undefined &&
    !(previous instanceof AbortController) &&
    previous.download !== undefined
  )
    return false;
  if (!localReportFallbackAllowed(error, api)) return false;
  const startedAt = performance.now();
  try {
    const localSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    const prepared =
      previous !== undefined && !(previous instanceof AbortController)
        ? await prepareCachedSupportReport(previous.report, localSignal)
        : await prepareLocalSupportReport(
            localSignal,
            localPreparationContext(error, api, context),
          );
    if (controller.signal.aborted) {
      prepared.download.dispose();
      return false;
    }
    const bytes = fulfillReport(key, prepared.report, prepared.download);
    reportLocalPreparation(prepared.report, context.correlationId, bytes);
    return true;
  } catch (error_) {
    if (!controller.signal.aborted)
      reportClientDiagnostic("Keiko local support report preparation failed.", {
        correlationId: context.correlationId,
        supportReportPreparation: {
          outcome: "failed",
          errorKind: bffRequestErrorKind(error_),
          durationMs: Math.round(Math.max(0, performance.now() - startedAt)),
        },
      });
    return false;
  }
}

function useReportCancellation(key: string, disposeOnUnmount: boolean): ReportRequestRef {
  const request = useRef<ReportRequestRef["current"]>(null);
  useEffect(
    () => (): void => {
      const pending = request.current;
      if (pending !== null) {
        pending.controller.abort();
        releaseReport(pending.key, pending.controller);
        request.current = null;
      }
      if (disposeOnUnmount) forgetReadyReport(key);
    },
    [key, disposeOnUnmount],
  );
  return request;
}

function useReportExpiry(key: string, outcome: ReportOutcome | undefined): void {
  useEffect((): (() => void) | undefined => {
    if (outcome === undefined || outcome instanceof AbortController) return undefined;
    const expiresAtMs = outcome.download?.expiresAtMs;
    if (expiresAtMs === undefined) return undefined;
    const timeout = window.setTimeout(
      () => expireServerDownload(key),
      Math.max(0, expiresAtMs - Date.now()),
    );
    return (): void => window.clearTimeout(timeout);
  }, [key, outcome]);
}

function readyReportStatus(ready: ReadyReport, feedback: ReportFeedback["state"]): ReportStatus {
  if (ready.pending !== undefined) return "busy";
  if (ready.download === undefined) return "expired";
  if (feedback !== "idle" && feedback !== "saved") return feedback;
  return "saved";
}

function useSupportReportAction({
  correlationId,
  errorKey,
  failure,
  clientOnly = false,
  disposeOnUnmount = false,
}: SupportReportButtonProps): {
  readonly status: ReportStatus;
  readonly create: () => Promise<void>;
  readonly regenerate: () => Promise<void>;
  readonly ready?: ReadyReport;
} {
  const localId = useId();
  const key = correlationId ?? errorKey ?? localId;
  const outcome = useSyncExternalStore(
    subscribeOutcomes,
    () => outcomes.get(key),
    () => undefined,
  );
  useReportExpiry(key, outcome);
  const [feedback, setFeedback] = useState<ReportFeedback>({
    key,
    state: "idle",
  });
  const request = useReportCancellation(key, disposeOnUnmount);
  const currentFeedback = feedback.key === key ? feedback.state : "idle";
  const create = (): Promise<void> =>
    runReport(key, correlationId, request, setFeedback, false, failure, clientOnly);
  const regenerate = (): Promise<void> =>
    runReport(key, correlationId, request, setFeedback, true, failure, clientOnly);
  if (outcome !== undefined && !(outcome instanceof AbortController)) {
    return {
      status: readyReportStatus(outcome, currentFeedback),
      create,
      regenerate,
      ready: outcome,
    };
  }
  const idleFeedback = currentFeedback === "saved" ? "idle" : currentFeedback;
  return { status: outcome === undefined ? idleFeedback : "busy", create, regenerate };
}

interface ReportFailureContext {
  readonly pending: { readonly key: string; readonly controller: AbortController };
  readonly correlationId: string | undefined;
  readonly request: ReportRequestRef;
  readonly setFeedback: (feedback: ReportFeedback) => void;
  readonly failure: ClientOnlySupportReportInput["failure"];
}

function diagnoseReportFailure(
  error: unknown,
  correlationId: string | undefined,
  availabilityFallback: boolean,
): void {
  reportClientDiagnostic(`[keiko] support report failed: ${clientErrorSummary(error)}`, {
    correlationId: correlationIdOf(error),
    ...(isActivityLogCorrelationId(correlationId) ? { parentCorrelationId: correlationId } : {}),
    errorKind: availabilityFallback ? bffRequestErrorKind(error) : "internal",
  });
}

async function reportPreparationFailure(
  context: ReportFailureContext,
  error: unknown,
  api: typeof import("@/lib/support-report-api") | undefined,
  availabilityFallback: boolean,
  signal: AbortSignal,
): Promise<void> {
  const { pending, correlationId, request, setFeedback, failure } = context;
  const { key, controller } = pending;
  if (
    availabilityFallback &&
    (await recoverLocalReport(key, controller, error, api, { correlationId, failure }))
  ) {
    setFeedback({ key, state: "saved" });
    return;
  }
  if (!reportRequestIsCurrent(request, pending)) return;
  releaseReport(key, controller);
  setFeedback({ key, state: availabilityFallback ? reportFailure(error) : "error" });
  // Transport loss is already counted; artifact failures remain diagnosable under their parent.
  if (signal.aborted || (availabilityFallback && isReportDeliveryUnavailable(error, api, signal)))
    return;
  diagnoseReportFailure(error, correlationId, availabilityFallback);
}

function createReportForNotice(
  api: typeof import("@/lib/support-report-api"),
  correlationId: string | undefined,
  signal: AbortSignal,
  original: ClientOnlySupportReportInput["failure"],
  clientOnly: boolean,
): Promise<DesktopSupportReportResponse> {
  if (clientOnly) return api.createSupportReport(correlationId, signal, original, "client-only");
  if (original === undefined) return api.createSupportReport(correlationId, signal);
  return api.createSupportReport(correlationId, signal, original);
}

async function runReport(
  key: string,
  correlationId: string | undefined,
  request: ReportRequestRef,
  setFeedback: (feedback: ReportFeedback) => void,
  regenerate: boolean,
  failure: ClientOnlySupportReportInput["failure"],
  clientOnly: boolean,
): Promise<void> {
  const controller = beginReport(key, regenerate);
  if (controller === undefined) return;
  const pending = { key, controller };
  request.current = pending;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REPORT_DEADLINE_MS)]);
  let api: typeof import("@/lib/support-report-api") | undefined;
  let phase: "module" | "facts" | "request" | "artifact" = "module";
  try {
    api = await waitForReportStep(import("@/lib/support-report-api"), signal);
    phase = "facts";
    const original = originalSupportReportFailure({ correlationId, failure });
    phase = "request";
    const creation = createReportForNotice(api, correlationId, signal, original, clientOnly);
    const report = await waitForReportStep(creation, signal);
    if (!reportRequestIsCurrent(request, pending)) return;
    signal.throwIfAborted();
    phase = "artifact";
    const download = api.createSupportReportDownload(report);
    fulfillReport(key, report, download);
    setFeedback({ key, state: "saved" });
  } catch (error) {
    if (!reportRequestIsCurrent(request, pending)) return;
    await reportPreparationFailure(
      { pending, correlationId, request, setFeedback, failure },
      error,
      api,
      (phase === "module" || phase === "request") && !isReportResponseInvalid(error, api),
      signal,
    );
  } finally {
    if (request.current === pending) request.current = null;
  }
}

function reportSupportDownload(correlationId: string | undefined): void {
  reportClientDiagnostic("[keiko] support report download initiated", {
    correlationId,
    supportReportDelivery: "manual",
  });
}

function reportFailure(error: unknown): ReportFailure {
  switch (bffRequestErrorKind(error)) {
    case "authority-denied":
      return "session-denied";
    case "unavailable":
      return "service-unavailable";
    case "rate-limited":
      return "rate-limited";
    default:
      return "error";
  }
}

function reportFeedbackKey(status: ReportStatus): MessageKey | undefined {
  switch (status) {
    case "saved":
      return "supportReport.saved";
    case "expired":
      return "supportReport.expired";
    case "error":
      return "supportReport.failed";
    case "session-denied":
      return "supportReport.sessionDenied";
    case "service-unavailable":
      return "supportReport.serviceUnavailable";
    case "rate-limited":
      return "supportReport.rateLimited";
    default:
      return undefined;
  }
}

export function SupportReportButton(props: SupportReportButtonProps): ReactNode {
  const t = useTranslate();
  const { status, create, regenerate, ready } = useSupportReportAction(props);
  const feedbackKey =
    status === "saved" && ready?.report.evidenceScope === "client-only"
      ? "supportReport.limitedReady"
      : reportFeedbackKey(status);
  return (
    <span className={styles.cmpControl}>
      {ready === undefined ? (
        <button
          type="button"
          className={`${props.compact === true ? "ft-seg" : "lk-btn"} ${styles.cmpAction}`}
          disabled={status === "busy"}
          onClick={() => void create()}
        >
          {t(status === "busy" ? "supportReport.creating" : "supportReport.create")}
        </button>
      ) : null}
      {ready !== undefined ? (
        <ReadyReportActions
          ready={ready}
          props={props}
          busy={status === "busy"}
          regenerate={regenerate}
        />
      ) : null}
      {feedbackKey !== undefined ? (
        <output className={styles.cmpFeedback}>{t(feedbackKey)}</output>
      ) : null}
    </span>
  );
}

function ReadyReportActions({
  ready,
  props,
  busy,
  regenerate,
}: {
  readonly ready: ReadyReport;
  readonly props: SupportReportButtonProps;
  readonly busy: boolean;
  readonly regenerate: () => Promise<void>;
}): ReactNode {
  const t = useTranslate();
  const className = `${props.compact === true ? "ft-seg" : "lk-btn"} ${styles.cmpAction}`;
  return (
    <>
      {ready.download !== undefined ? (
        <a
          className={className}
          href={ready.download.href}
          download={ready.download.fileName ?? ready.report.fileName}
          onClick={() => reportSupportDownload(props.correlationId)}
        >
          {t("supportReport.download")}
        </a>
      ) : null}
      <button type="button" className={className} disabled={busy} onClick={() => void regenerate()}>
        {t(busy ? "supportReport.creating" : "supportReport.regenerate")}
      </button>
    </>
  );
}

export function GlobalSupportReportAction({
  onlyForFailure = false,
}: {
  readonly onlyForFailure?: boolean;
}): ReactNode {
  const t = useTranslate();
  const failure = useSyncExternalStore(
    subscribeGlobalClientFailure,
    currentGlobalClientFailure,
    () => null,
  );
  const ordinal = failure?.ordinal;
  const correlationId = failure?.correlationId;
  const dismiss = useCallback((): void => {
    if (ordinal === undefined) return;
    forgetReadyReport(correlationId ?? `global-error-${ordinal}`);
    dismissGlobalClientFailure(ordinal);
  }, [correlationId, ordinal]);
  if (failure === null) return onlyForFailure ? null : <SupportReportButton compact />;
  const controls = (
    <fieldset className={styles.cmpControl} aria-label={t("supportReport.create")}>
      <SupportReportButton
        compact
        correlationId={failure.correlationId}
        errorKey={`global-error-${failure.ordinal}`}
        failure={failure.failure}
      />
      <button
        className={`ft-seg ${styles.cmpAction}`}
        type="button"
        aria-label={t("common.close")}
        onClick={dismiss}
      >
        ×
      </button>
    </fieldset>
  );
  return onlyForFailure ? (
    <div className="source-limit-alert" role="alert">
      <span>{t("supportReport.globalFailure")}</span>
      {controls}
    </div>
  ) : (
    controls
  );
}
