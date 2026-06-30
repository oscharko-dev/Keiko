"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  cancelUpdateSession,
  checkUpdatePreflight,
  fetchStartupUpdatePreflight,
  fetchUpdateRemediationStatus,
  fetchUpdateSessionStatus,
  prepareUpdateRemediationStatus,
  retryUpdateSession,
  runUpdateRemediationAction,
  startUpdateSession,
  verifyUpdateRestart,
} from "@/lib/api";
import { useI18n, type I18nTranslate } from "@/lib/i18n";
import type {
  UpdatePreflightReport,
  UpdateRemediationAction,
  UpdateRemediationStatusReport,
  UpdateSessionStatus,
} from "@/lib/types";
import { Icons } from "../Icons";
import {
  actionStatusLabel,
  featureStateLabel,
  impactInput,
  isManualUpdatePath,
  isSessionInProgress,
  remediationLabel,
  sessionForDisplay,
  sessionPhaseLabel,
  statusTitle,
  storeLabel,
  updateTone,
} from "./update-copy";

export interface UpdateWindowApi {
  readonly fetchPreflight: () => Promise<UpdatePreflightReport>;
  readonly checkPreflight: () => Promise<UpdatePreflightReport>;
  readonly fetchSessionStatus: () => Promise<UpdateSessionStatus>;
  readonly startSession: typeof startUpdateSession;
  readonly retrySession: typeof retryUpdateSession;
  readonly cancelSession: typeof cancelUpdateSession;
  readonly verifyRestart: typeof verifyUpdateRestart;
  readonly fetchRemediationStatus: () => Promise<UpdateRemediationStatusReport>;
  readonly prepareRemediationStatus: typeof prepareUpdateRemediationStatus;
  readonly runRemediationAction: typeof runUpdateRemediationAction;
}

interface UpdateWindowProps {
  readonly api?: UpdateWindowApi;
}

type LoadState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly report: UpdatePreflightReport;
      readonly session: UpdateSessionStatus;
      readonly remediation: UpdateRemediationStatusReport;
    }
  | { readonly status: "error"; readonly message: string };

type BusyAction =
  | "checking"
  | "starting"
  | "retrying"
  | "cancelling"
  | "restart"
  | "remediation"
  | undefined;

const DEFAULT_API: UpdateWindowApi = {
  fetchPreflight: fetchStartupUpdatePreflight,
  checkPreflight: checkUpdatePreflight,
  fetchSessionStatus: fetchUpdateSessionStatus,
  startSession: startUpdateSession,
  retrySession: retryUpdateSession,
  cancelSession: cancelUpdateSession,
  verifyRestart: verifyUpdateRestart,
  fetchRemediationStatus: fetchUpdateRemediationStatus,
  prepareRemediationStatus: prepareUpdateRemediationStatus,
  runRemediationAction: runUpdateRemediationAction,
};

function errorMessage(error: unknown, t: I18nTranslate): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return t("updates.error.load");
}

async function loadRemediation(
  api: UpdateWindowApi,
  report: UpdatePreflightReport,
): Promise<UpdateRemediationStatusReport> {
  const impact = impactInput(report);
  if (report.targetVersion !== undefined && impact !== undefined) {
    return api.prepareRemediationStatus({
      targetVersion: report.targetVersion,
      impact,
      persist: true,
    });
  }
  return api.fetchRemediationStatus();
}

function versionText(report: UpdatePreflightReport, t: I18nTranslate): string {
  const target = report.targetVersion ?? t("updates.versionUnknown");
  return t("updates.versionLine", { current: report.currentVersion, target });
}

function SummaryCard({
  report,
  session,
  remediation,
  titleRef,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
  readonly remediation: UpdateRemediationStatusReport;
  readonly titleRef: RefObject<HTMLHeadingElement>;
}): ReactNode {
  const { t } = useI18n();
  const visibleSession = sessionForDisplay(session);
  const tone = updateTone(report, visibleSession, remediation);
  return (
    <div className="upd-summary" data-tone={tone}>
      <span className="upd-summary-icon" aria-hidden="true">
        {tone === "success" ? <Icons.check size={18} /> : <Icons.info size={18} />}
      </span>
      <div>
        <p className="upd-kicker">{t("updates.window.kicker")}</p>
        <h2 id="updates-window-title" ref={titleRef} tabIndex={-1} className="upd-title">
          {statusTitle(report, visibleSession, t)}
        </h2>
        <p className="upd-body">{versionText(report, t)}</p>
      </div>
    </div>
  );
}

function PrimaryActions({
  report,
  session,
  remediation,
  busy,
  onCheck,
  onStart,
  onRetry,
  onCancel,
  onVerifyRestart,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
  readonly remediation: UpdateRemediationStatusReport;
  readonly busy: BusyAction;
  readonly onCheck: () => void;
  readonly onStart: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly onVerifyRestart: () => void;
}): ReactNode {
  const { t } = useI18n();
  const visibleSession = sessionForDisplay(session);
  const disabled = busy !== undefined;
  const manual = isManualUpdatePath(report, session);
  if (visibleSession?.phase === "restart-required") {
    return (
      <button type="button" className="upd-primary-btn" disabled={disabled} onClick={onVerifyRestart}>
        {t("updates.action.verifyRestart")}
      </button>
    );
  }
  if (visibleSession?.phase === "failed" && visibleSession.retryable) {
    return (
      <button type="button" className="upd-primary-btn" disabled={disabled} onClick={onRetry}>
        {t("updates.action.retry")}
      </button>
    );
  }
  if (visibleSession?.phase === "succeeded" || visibleSession?.phase === "cancelled") {
    return (
      <button type="button" className="upd-secondary-btn" disabled={disabled} onClick={onCheck}>
        {t("updates.action.check")}
      </button>
    );
  }
  if (visibleSession !== undefined && isSessionInProgress(visibleSession)) {
    return visibleSession.cancelable ? (
      <button type="button" className="upd-secondary-btn" disabled={disabled} onClick={onCancel}>
        {t("updates.action.cancel")}
      </button>
    ) : null;
  }
  if (manual || !report.updateAvailable || remediation.overallStatus === "manual-review-required") {
    return (
      <button type="button" className="upd-secondary-btn" disabled={disabled} onClick={onCheck}>
        {t("updates.action.check")}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="upd-primary-btn"
      disabled={disabled || report.targetVersion === undefined}
      onClick={onStart}
    >
      {t("updates.action.install")}
    </button>
  );
}

function ProgressPanel({ session }: { readonly session: ReturnType<typeof sessionForDisplay> }) {
  const { t } = useI18n();
  if (session === undefined || !isSessionInProgress(session)) return null;
  const value = session.phase === "preparing" ? 18 : 58;
  return (
    <section className="upd-panel" role="status" aria-live="polite">
      <div className="upd-panel-head">
        <strong>{sessionPhaseLabel(session, t)}</strong>
        <span>{session.message}</span>
      </div>
      <progress className="upd-progress" max={100} value={value} aria-label={t("updates.progress.label")} />
    </section>
  );
}

function SessionOutcomePanel({
  session,
}: {
  readonly session: ReturnType<typeof sessionForDisplay>;
}): ReactNode {
  const { t } = useI18n();
  if (session === undefined || isSessionInProgress(session)) return null;
  if (
    session.phase !== "restart-required" &&
    session.phase !== "succeeded" &&
    session.phase !== "failed" &&
    session.phase !== "cancelled"
  ) {
    return null;
  }
  return (
    <section
      className="upd-panel"
      role={session.phase === "failed" ? "alert" : "status"}
      aria-live={session.phase === "failed" ? "assertive" : "polite"}
    >
      <div className="upd-panel-head">
        <strong>{sessionPhaseLabel(session, t)}</strong>
        <span>{session.message}</span>
      </div>
    </section>
  );
}

function ImpactPanel({
  report,
  remediation,
}: {
  readonly report: UpdatePreflightReport;
  readonly remediation: UpdateRemediationStatusReport;
}): ReactNode {
  const { t } = useI18n();
  const impacts = report.impact?.stateImpact ?? [];
  const remediations = report.impact?.remediations ?? [];
  if (impacts.length === 0 && remediation.affectedFeatures.length === 0) return null;
  return (
    <section className="upd-panel" aria-labelledby="updates-impact-title">
      <div className="upd-panel-head">
        <strong id="updates-impact-title">{t("updates.impact.title")}</strong>
        <span>{t("updates.impact.body")}</span>
      </div>
      {impacts.length > 0 ? (
        <ul className="upd-impact-list">
          {impacts.map((impact) => (
            <li key={`${impact.store}:${impact.remediation}`}>
              <span className="upd-impact-store">{storeLabel(impact.store)}</span>
              <span>{impact.description}</span>
              <span className="upd-chip">{remediationLabel(impact.remediation, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {remediations.length > 0 ? (
        <p className="upd-muted">
          {t("updates.impact.required", {
            remediation: remediations.map((entry) => remediationLabel(entry, t)).join(", "),
          })}
        </p>
      ) : null}
    </section>
  );
}

function RemediationPanel({
  report,
  remediation,
  busy,
  onAction,
}: {
  readonly report: UpdatePreflightReport;
  readonly remediation: UpdateRemediationStatusReport;
  readonly busy: BusyAction;
  readonly onAction: (action: UpdateRemediationAction, decision: "run" | "defer") => void;
}): ReactNode {
  const { t } = useI18n();
  if (remediation.actions.length === 0 && remediation.affectedFeatures.length === 0) return null;
  return (
    <section className="upd-panel" aria-labelledby="updates-remediation-title">
      <div className="upd-panel-head">
        <strong id="updates-remediation-title">{t("updates.remediation.title")}</strong>
        <span>{remediation.updateCanComplete ? t("updates.remediation.canComplete") : t("updates.remediation.needsAction")}</span>
      </div>
      {remediation.affectedFeatures.length > 0 ? (
        <ul className="upd-feature-list">
          {remediation.affectedFeatures.map((feature) => (
            <li key={feature.featureId}>
              <span>{feature.label}</span>
              <span className="upd-chip">{featureStateLabel(feature.state, t)}</span>
              <small>{feature.reason}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {remediation.actions.map((action) => (
        <div className="upd-action" key={action.actionId}>
          <div>
            <strong>{action.message}</strong>
            <span>{actionStatusLabel(action.status, t)}</span>
            {action.instructions !== undefined ? <small>{action.instructions}</small> : null}
          </div>
          <div className="upd-action-buttons">
            {action.canRun ? (
              <button
                type="button"
                className="upd-secondary-btn"
                disabled={busy !== undefined}
                onClick={() => onAction(action, "run")}
              >
                {t("updates.action.runRemediation")}
              </button>
            ) : null}
            {action.canDefer ? (
              <button
                type="button"
                className="upd-ghost-btn"
                disabled={busy !== undefined}
                onClick={() => onAction(action, "defer")}
              >
                {t("updates.action.defer")}
              </button>
            ) : null}
          </div>
        </div>
      ))}
      {report.impact?.userActionRequired === true ? (
        <p className="upd-muted">{t("updates.remediation.userActionRequired")}</p>
      ) : null}
    </section>
  );
}

function ManualPath({
  report,
  session,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
}): ReactNode {
  const { t } = useI18n();
  if (!isManualUpdatePath(report, session)) return null;
  const instructions = session.installMode.manualInstructions ?? t("updates.manual.default");
  return (
    <section className="upd-panel upd-manual" aria-labelledby="updates-manual-title">
      <div className="upd-panel-head">
        <strong id="updates-manual-title">{t("updates.manual.title")}</strong>
        <span>{instructions}</span>
      </div>
      {report.release?.url !== undefined ? (
        <a className="upd-link" href={report.release.url} target="_blank" rel="noreferrer">
          {t("updates.manual.releaseLink")}
          <Icons.external size={13} aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

function PatchNotes({ report }: { readonly report: UpdatePreflightReport }): ReactNode {
  const { t } = useI18n();
  const notes = report.patchNotes;
  if (notes === undefined && report.release === undefined) return null;
  const bullets = notes?.bullets ?? report.release?.notes ?? [];
  return (
    <details className="upd-details">
      <summary>{t("updates.patchNotes.summary")}</summary>
      {notes?.summary !== undefined ? <p>{notes.summary}</p> : null}
      <ul>
        {bullets.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      {notes?.details.map((entry) => <p key={entry}>{entry}</p>)}
    </details>
  );
}

function TechnicalDetails({
  report,
  session,
  remediation,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
  readonly remediation: UpdateRemediationStatusReport;
}): ReactNode {
  const { t } = useI18n();
  const visibleSession = sessionForDisplay(session);
  return (
    <details className="upd-details">
      <summary>{t("updates.details.summary")}</summary>
      <dl className="upd-tech">
        <div><dt>{t("updates.details.registry")}</dt><dd>{report.registryStatus}</dd></div>
        <div><dt>{t("updates.details.releaseMetadata")}</dt><dd>{report.releaseMetadataStatus}</dd></div>
        <div><dt>{t("updates.details.installMode")}</dt><dd>{session.installMode.status}</dd></div>
        <div><dt>{t("updates.details.remediation")}</dt><dd>{remediation.overallStatus}</dd></div>
      </dl>
      {session.installMode.commandPreview !== undefined ? (
        <pre className="upd-log">{session.installMode.commandPreview.label}</pre>
      ) : null}
      {visibleSession?.logs !== undefined ? (
        <pre className="upd-log">{[visibleSession.logs.stdoutPreview, visibleSession.logs.stderrPreview].filter(Boolean).join("\n")}</pre>
      ) : null}
      {[...report.blockers.map((b) => b.message), ...report.warnings, ...remediation.warnings].map((entry) => (
        <p key={entry} className="upd-muted">{entry}</p>
      ))}
    </details>
  );
}

export function UpdateWindow({ api = DEFAULT_API }: UpdateWindowProps): ReactNode {
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = useState<BusyAction>();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusedRef = useRef(false);

  const refresh = useCallback(
    async (manual: boolean): Promise<void> => {
      setBusy(manual ? "checking" : undefined);
      try {
        const report = manual ? await api.checkPreflight() : await api.fetchPreflight();
        const [session, remediation] = await Promise.all([
          api.fetchSessionStatus(),
          loadRemediation(api, report),
        ]);
        setState({ status: "ready", report, session, remediation });
      } catch (error) {
        setState({ status: "error", message: errorMessage(error, t) });
      } finally {
        setBusy(undefined);
      }
    },
    [api, t],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const visibleSession = state.status === "ready" ? sessionForDisplay(state.session) : undefined;
  useEffect(() => {
    if (state.status !== "ready" || !isSessionInProgress(visibleSession)) return undefined;
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refresh, state.status, visibleSession]);

  useEffect(() => {
    if (state.status === "loading" || focusedRef.current) return;
    focusedRef.current = true;
    titleRef.current?.focus();
  }, [state.status]);

  const targetVersion = state.status === "ready" ? state.report.targetVersion : undefined;
  const releaseImpact = useMemo(
    () => (state.status === "ready" ? impactInput(state.report) : undefined),
    [state],
  );

  const runAndRefresh = useCallback(
    async (nextBusy: BusyAction, action: () => Promise<unknown>): Promise<void> => {
      setBusy(nextBusy);
      try {
        await action();
        await refresh(false);
      } catch (error) {
        setState({ status: "error", message: errorMessage(error, t) });
      } finally {
        setBusy(undefined);
      }
    },
    [refresh, t],
  );

  if (state.status === "loading") {
    return <div className="upd-loading" role="status">{t("updates.loading")}</div>;
  }

  if (state.status === "error") {
    return (
      <section className="upd" aria-labelledby="updates-window-title">
        <h2 id="updates-window-title" ref={titleRef} tabIndex={-1} className="upd-title">
          {t("updates.error.title")}
        </h2>
        <div className="upd-panel upd-error" role="alert">{state.message}</div>
        <button type="button" className="upd-secondary-btn" onClick={() => void refresh(true)}>
          {t("updates.action.check")}
        </button>
      </section>
    );
  }

  const { report, session, remediation } = state;
  return (
    <section className="upd" aria-labelledby="updates-window-title">
      <SummaryCard
        report={report}
        session={session}
        remediation={remediation}
        titleRef={titleRef}
      />
      <div className="upd-primary">
        <div>
          <strong>{t("updates.primary.title")}</strong>
          <span>
            {isManualUpdatePath(report, session)
              ? t("updates.primary.manual")
              : report.updateAvailable
                ? t("updates.primary.available")
                : t("updates.primary.current")}
          </span>
        </div>
        <PrimaryActions
          report={report}
          session={session}
          remediation={remediation}
          busy={busy}
          onCheck={() => void refresh(true)}
          onStart={() => {
            if (targetVersion !== undefined) {
              void runAndRefresh("starting", () => api.startSession({ targetVersion }));
            }
          }}
          onRetry={() => void runAndRefresh("retrying", api.retrySession)}
          onCancel={() => void runAndRefresh("cancelling", api.cancelSession)}
          onVerifyRestart={() => void runAndRefresh("restart", () => api.verifyRestart({ targetVersion }))}
        />
      </div>
      <ProgressPanel session={visibleSession} />
      <SessionOutcomePanel session={visibleSession} />
      <ManualPath report={report} session={session} />
      <ImpactPanel report={report} remediation={remediation} />
      <RemediationPanel
        report={report}
        remediation={remediation}
        busy={busy}
        onAction={(action, decision) => {
          void runAndRefresh("remediation", () =>
            api.runRemediationAction({
              actionId: action.actionId,
              targetVersion,
              impact: releaseImpact,
              decision,
            }),
          );
        }}
      />
      <PatchNotes report={report} />
      <TechnicalDetails report={report} session={session} remediation={remediation} />
    </section>
  );
}
