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
  SUPPORT_REPORT_REQUEST_TIMEOUT_MS,
  SUPPORT_REPORT_DELIVERY_TTL_MS,
  isActivityLogCorrelationId,
  type DesktopSupportReportResponse,
  type ClientOnlySupportReportInput,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import type { SupportReportDownload } from "@/lib/support-report-api";
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

const MAX_FULFILLED_REPORTS = 128;
interface ReadyReport {
  readonly report: DesktopSupportReportResponse;
  readonly download: SupportReportDownload | undefined;
  readonly bytes: number;
  readonly source: "server" | "browser";
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
    const { report, download, bytes, source } = outcome;
    outcomes.set(key, { report, download, bytes, source });
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

function expireReportDownload(key: string): void {
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
  source: "server" | "browser" = "server",
): number {
  const bytes = new TextEncoder().encode(report.reportJson).byteLength;
  if (bytes > MAX_SUPPORT_REPORT_BYTES) {
    download.dispose();
    throw new TypeError("Support report cache budget exceeded");
  }
  const prior = outcomes.get(key);
  if (prior !== undefined && !(prior instanceof AbortController)) prior.download?.dispose();
  outcomes.delete(key);
  outcomes.set(key, { report, download, bytes, source });
  const ready = fulfilledReports();
  let retainedBytes = ready.reduce((total, [, entry]) => total + entry.bytes, 0);
  let retainedCount = ready.length;
  for (const [expired, entry] of ready) {
    if (retainedBytes <= MAX_SUPPORT_REPORT_BYTES && retainedCount <= MAX_FULFILLED_REPORTS) break;
    if (expired === key) continue;
    retainedBytes -= entry.bytes;
    retainedCount -= 1;
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
  readonly download?: SupportReportDownload | undefined;
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

function loadLocalReport(
  signal: AbortSignal,
): Promise<typeof import("@/lib/support-report-local")> {
  signal.throwIfAborted();
  return waitForReportStep(import("@/lib/support-report-local"), signal);
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
  // The independent canonical local producer can still describe this availability failure.
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

function reportSource(outcome: ReportOutcome | undefined): "server" | "browser" {
  return outcome === undefined || outcome instanceof AbortController ? "browser" : outcome.source;
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
    const local = await loadLocalReport(localSignal);
    const prepared =
      previous !== undefined && !(previous instanceof AbortController)
        ? await local.prepareCachedSupportReport(previous.report, localSignal)
        : await local.prepareLocalSupportReport(
            localSignal,
            localPreparationContext(error, api, context),
          );
    if (controller.signal.aborted) {
      prepared.download.dispose();
      return false;
    }
    const bytes = fulfillReport(key, prepared.report, prepared.download, reportSource(previous));
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
      () => expireReportDownload(key),
      Math.min(SUPPORT_REPORT_DELIVERY_TTL_MS, Math.max(0, expiresAtMs - Date.now())),
    );
    return (): void => window.clearTimeout(timeout);
  }, [key, outcome]);
}

function readyReportStatus(ready: ReadyReport, feedback: ReportFeedback): ReportStatus {
  if (ready.pending !== undefined) return "busy";
  if (
    feedback.state !== "idle" &&
    feedback.state !== "saved" &&
    feedback.download === ready.download
  )
    return feedback.state;
  if (ready.download === undefined) return "expired";
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
  const currentFeedback: ReportFeedback = feedback.key === key ? feedback : { key, state: "idle" };
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
  const idleFeedback = currentFeedback.state === "saved" ? "idle" : currentFeedback.state;
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
  const outcome = outcomes.get(key);
  const download = outcome instanceof AbortController ? undefined : outcome?.download;
  setFeedback({ key, state: availabilityFallback ? reportFailure(error) : "error", download });
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
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(SUPPORT_REPORT_REQUEST_TIMEOUT_MS),
  ]);
  let api: typeof import("@/lib/support-report-api") | undefined;
  let phase: "module" | "facts" | "request" | "artifact" = "module";
  try {
    api = await waitForReportStep(import("@/lib/support-report-api"), signal);
    const local = await loadLocalReport(signal);
    phase = "facts";
    const original = local.originalSupportReportFailure({ correlationId, failure });
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

function reportSupportDownload(correlationId: string | undefined, ready: ReadyReport): void {
  reportClientDiagnostic("[keiko] support report download initiated", {
    correlationId,
    supportReportDelivery: {
      mode: "manual",
      source: ready.source,
      evidenceScope: ready.report.evidenceScope ?? "server",
      ...(ready.report.summary === undefined
        ? {}
        : { reportDigest: ready.report.summary.reportDigest }),
    },
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

function useReportReadyFocus(): {
  readonly createRef: (element: HTMLButtonElement | null) => void;
  readonly downloadRef: (element: HTMLAnchorElement | null) => void;
} {
  const creating = useRef<HTMLButtonElement | null>(null);
  const transfer = useRef(false);
  const createRef = useCallback((element: HTMLButtonElement | null): void => {
    transfer.current = element === null && document.activeElement === creating.current;
    creating.current = element;
  }, []);
  const downloadRef = useCallback((element: HTMLAnchorElement | null): void => {
    if (element !== null && transfer.current) {
      transfer.current = false;
      element.focus();
    }
  }, []);
  return { createRef, downloadRef };
}

export function SupportReportButton(props: SupportReportButtonProps): ReactNode {
  const t = useTranslate();
  const { status, create, regenerate, ready } = useSupportReportAction(props);
  const focus = useReportReadyFocus();
  const feedbackKey =
    status === "saved" && ready?.report.evidenceScope === "client-only"
      ? "supportReport.limitedReady"
      : reportFeedbackKey(status);
  return (
    <span className={styles.cmpControl}>
      {ready === undefined ? (
        <button
          type="button"
          className={styles.cmpAction}
          ref={focus.createRef}
          aria-disabled={status === "busy"}
          aria-busy={status === "busy"}
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
          downloadRef={focus.downloadRef}
        />
      ) : null}
      <output className={styles.cmpFeedback} aria-live="polite" aria-atomic="true">
        {feedbackKey === undefined ? "" : t(feedbackKey)}
      </output>
    </span>
  );
}

function ReadyReportActions({
  ready,
  props,
  busy,
  regenerate,
  downloadRef,
}: {
  readonly ready: ReadyReport;
  readonly props: SupportReportButtonProps;
  readonly busy: boolean;
  readonly regenerate: () => Promise<void>;
  readonly downloadRef: (element: HTMLAnchorElement | null) => void;
}): ReactNode {
  const t = useTranslate();
  const className = styles.cmpAction;
  return (
    <>
      {ready.download !== undefined ? (
        <a
          ref={downloadRef}
          className={className}
          href={ready.download.href}
          download={ready.download.fileName ?? ready.report.fileName}
          onClick={() => reportSupportDownload(props.correlationId, ready)}
        >
          {t("supportReport.download")}
        </a>
      ) : null}
      <button
        type="button"
        className={className}
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => void regenerate()}
      >
        {t(busy ? "supportReport.creating" : "supportReport.regenerate")}
      </button>
    </>
  );
}

function GlobalReportControls({
  failure,
  labelId,
  onDismiss,
}: {
  readonly failure: NonNullable<ReturnType<typeof currentGlobalClientFailure>>;
  readonly labelId: string;
  readonly onDismiss: () => void;
}): ReactNode {
  const t = useTranslate();
  const group = useRef<HTMLFieldSetElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const dismiss = (): void => {
    const restore = group.current?.contains(document.activeElement);
    onDismiss();
    if (restore && previousFocus.current?.isConnected) previousFocus.current.focus();
  };
  return (
    <fieldset
      ref={group}
      className={styles.cmpControl}
      aria-labelledby={labelId}
      onFocusCapture={(event) => {
        const target = event.relatedTarget;
        if (target instanceof HTMLElement && !event.currentTarget.contains(target)) {
          previousFocus.current = target;
        }
      }}
    >
      <SupportReportButton
        compact
        correlationId={failure.correlationId}
        errorKey={`global-error-${failure.ordinal}`}
        failure={failure.failure}
      />
      <button
        className={styles.cmpAction}
        type="button"
        aria-label={t("common.close")}
        onClick={dismiss}
      >
        ×
      </button>
    </fieldset>
  );
}

export function GlobalSupportReportAction(): ReactNode {
  const t = useTranslate();
  const failure = useSyncExternalStore(
    subscribeGlobalClientFailure,
    currentGlobalClientFailure,
    () => null,
  );
  const labelId = useId();
  const ordinal = failure?.ordinal;
  const correlationId = failure?.correlationId;
  const dismiss = useCallback((): void => {
    if (ordinal === undefined) return;
    forgetReadyReport(correlationId ?? `global-error-${ordinal}`);
    dismissGlobalClientFailure(ordinal);
  }, [correlationId, ordinal]);
  if (failure === null) return null;
  return (
    <div className="source-limit-alert">
      <span id={labelId} role="alert">
        {t("supportReport.globalFailure")}
      </span>
      <GlobalReportControls failure={failure} labelId={labelId} onDismiss={dismiss} />
    </div>
  );
}
