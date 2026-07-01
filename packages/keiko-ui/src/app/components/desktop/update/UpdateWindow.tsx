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
  "checking" | "starting" | "retrying" | "cancelling" | "restart" | "remediation" | undefined;

interface ManualCommand {
  readonly id: string;
  readonly label: string;
  readonly command: string;
}

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

function versionText(
  report: UpdatePreflightReport,
  t: I18nTranslate,
  manualInstallVerified = false,
): string {
  if (manualInstallVerified)
    return t("updates.versionInstalled", { version: report.currentVersion });
  const target = report.targetVersion ?? t("updates.versionUnknown");
  return t("updates.versionLine", { current: report.currentVersion, target });
}

function hasReleaseNotes(report: UpdatePreflightReport): boolean {
  return report.patchNotes !== undefined || report.release !== undefined;
}

function patchNotesReportFor(
  report: UpdatePreflightReport,
  session: ReturnType<typeof sessionForDisplay>,
  cachedReport: UpdatePreflightReport | undefined,
): UpdatePreflightReport {
  if (hasReleaseNotes(report)) return report;
  if (
    session?.phase === "succeeded" &&
    cachedReport !== undefined &&
    cachedReport.targetVersion === session.targetVersion &&
    hasReleaseNotes(cachedReport)
  ) {
    return cachedReport;
  }
  return report;
}

function primaryActionText(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
  t: I18nTranslate,
  manualInstallVerified = false,
): string {
  const visibleSession = sessionForDisplay(session, report);
  if (manualInstallVerified) return t("updates.primary.installed");
  if (visibleSession?.phase === "succeeded") return t("updates.primary.installed");
  if (visibleSession?.phase === "cancelled") return t("updates.primary.cancelled");
  if (visibleSession?.phase === "failed") return t("updates.primary.failed");
  if (visibleSession?.phase === "restart-required") return t("updates.primary.restart");
  if (isManualUpdatePath(report, session)) return t("updates.primary.manual");
  if (report.updateAvailable) return t("updates.primary.available");
  return t("updates.primary.current");
}

async function writeTextWithFallback(text: string): Promise<void> {
  const writeText = typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return;
    } catch {
      // Restricted clipboard contexts can still use the manual textarea fallback.
    }
  }

  if (typeof document === "undefined" || document.body === null) {
    throw new Error("clipboard-unavailable");
  }

  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    if (!copied) throw new Error("clipboard-fallback-failed");
  } finally {
    textarea.remove();
    previousFocus?.focus();
  }
}

function manualCommands(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
  t: I18nTranslate,
): readonly ManualCommand[] {
  const targetVersion = report.targetVersion;
  if (targetVersion === undefined) return [];
  const spec = `${session.installMode.packageName}@${targetVersion}`;
  const npm = {
    id: "npm",
    label: t("updates.manual.commandNpm"),
    command: `npm install --global --ignore-scripts ${spec}`,
  };
  const yarn = {
    id: "yarn",
    label: t("updates.manual.commandYarn"),
    command: `yarn global add --ignore-scripts ${spec}`,
  };
  if (session.installMode.packageManager === "yarn") return [yarn, npm];
  return [npm, yarn];
}

function SummaryCard({
  report,
  session,
  remediation,
  manualInstallVerified,
  titleRef,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
  readonly remediation: UpdateRemediationStatusReport;
  readonly manualInstallVerified: boolean;
  readonly titleRef: RefObject<HTMLHeadingElement>;
}): ReactNode {
  const { t } = useI18n();
  const visibleSession = sessionForDisplay(session, report);
  const tone = updateTone(report, visibleSession, remediation);
  return (
    <div className="upd-summary" data-tone={tone}>
      <span className="upd-summary-icon" aria-hidden="true">
        {tone === "success" ? <Icons.check size={18} /> : <Icons.info size={18} />}
      </span>
      <div>
        <p className="upd-kicker">{t("updates.window.kicker")}</p>
        <h2 id="updates-window-title" ref={titleRef} tabIndex={-1} className="upd-title">
          {manualInstallVerified
            ? t("updates.status.success")
            : statusTitle(report, visibleSession, t)}
        </h2>
        <p className="upd-body">{versionText(report, t, manualInstallVerified)}</p>
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
  onShowManualCommands,
  manualCommandsOpen,
  canVerifyRestart,
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
  readonly onShowManualCommands: () => void;
  readonly manualCommandsOpen: boolean;
  readonly canVerifyRestart: boolean;
}): ReactNode {
  const { t } = useI18n();
  const visibleSession = sessionForDisplay(session, report);
  const disabled = busy !== undefined;
  const manual = isManualUpdatePath(report, session);
  if (visibleSession?.phase === "restart-required") {
    return (
      <div className="upd-restart-action">
        <button
          type="button"
          className="upd-primary-btn"
          aria-describedby="updates-restart-verification-help"
          disabled={disabled || !canVerifyRestart}
          onClick={onVerifyRestart}
        >
          {t("updates.action.verifyRestart")}
        </button>
        <span id="updates-restart-verification-help" className="upd-restart-help">
          {t("updates.restart.verifyHelp")}
        </span>
      </div>
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
    if (manual) {
      return (
        <button
          type="button"
          className="upd-primary-btn"
          disabled={disabled}
          onClick={onShowManualCommands}
        >
          {manualCommandsOpen ? t("updates.action.hideCommands") : t("updates.action.showCommands")}
        </button>
      );
    }
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
  return (
    <section className="upd-panel" role="status" aria-live="polite">
      <div className="upd-panel-head">
        <strong>{sessionPhaseLabel(session, t)}</strong>
        <span>{session.message}</span>
      </div>
      <progress className="upd-progress" aria-label={t("updates.progress.label")} />
    </section>
  );
}

function SessionOutcomePanel({
  session,
  patchNotesReport,
}: {
  readonly session: ReturnType<typeof sessionForDisplay>;
  readonly patchNotesReport: UpdatePreflightReport;
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
  if (session.phase === "succeeded" && hasReleaseNotes(patchNotesReport)) {
    return (
      <details className="upd-panel upd-outcome-details">
        <summary className="upd-outcome-summary">
          <div className="upd-panel-head">
            <strong>{sessionPhaseLabel(session, t)}</strong>
            <span>{session.message}</span>
          </div>
          <span className="upd-secondary-btn upd-outcome-patch-trigger">
            {t("updates.patchNotes.summary")}
          </span>
        </summary>
        <div className="upd-outcome-notes">
          <PatchNotesContent report={patchNotesReport} />
        </div>
      </details>
    );
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
  if (remediation.actions.length > 0) return null;
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
              <span>{impact.description}</span>
              <small>{storeLabel(impact.store)}</small>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function actionStatusOpen(action: UpdateRemediationAction): boolean {
  return action.status === "pending" || action.status === "failed" || action.status === "deferred";
}

function actionVisible(action: UpdateRemediationAction): boolean {
  return action.status !== "completed" && action.status !== "not-needed";
}

function remediationRunnable(session: ReturnType<typeof sessionForDisplay>): boolean {
  return session?.phase === "restart-required" || session?.phase === "succeeded";
}

function featureForAction(
  remediation: UpdateRemediationStatusReport,
  action: UpdateRemediationAction,
) {
  return remediation.affectedFeatures.find((feature) =>
    feature.actionIds.includes(action.actionId),
  );
}

function PlannedRemediationPanel({
  remediation,
}: {
  readonly remediation: UpdateRemediationStatusReport;
}): ReactNode {
  const { t } = useI18n();
  const visibleActions = remediation.actions.filter(actionVisible);
  if (visibleActions.length === 0) return null;
  return (
    <section className="upd-panel" aria-labelledby="updates-planned-remediation-title">
      <div className="upd-panel-head">
        <strong id="updates-planned-remediation-title">
          {t("updates.remediation.plannedTitle")}
        </strong>
        <span>{t("updates.remediation.plannedBody")}</span>
      </div>
      {visibleActions.map((action) => {
        const feature = featureForAction(remediation, action);
        return (
          <div className="upd-action" key={action.actionId}>
            <div>
              <div className="upd-action-title">
                <strong>{remediationLabel(action.remediation, t)}</strong>
              </div>
              <small>{feature?.reason ?? action.message}</small>
            </div>
          </div>
        );
      })}
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
  const visibleActions = remediation.actions.filter(actionVisible);
  if (remediation.actions.length > 0 && visibleActions.length === 0) return null;
  const showFeatureSummary = remediation.actions.length === 0;
  const hasDeferredAction = visibleActions.some((action) => action.status === "deferred");
  const showDecisionCopy =
    report.impact?.userActionRequired === true && !remediation.updateCanComplete;
  return (
    <section className="upd-panel" aria-labelledby="updates-remediation-title">
      <div className="upd-panel-head">
        <strong id="updates-remediation-title">
          {hasDeferredAction
            ? t("updates.remediation.deferredTitle")
            : t("updates.remediation.title")}
        </strong>
        <span>
          {hasDeferredAction
            ? t("updates.remediation.deferredBody")
            : remediation.updateCanComplete
              ? t("updates.remediation.canComplete")
              : t("updates.remediation.needsAction")}
        </span>
      </div>
      {showFeatureSummary && remediation.affectedFeatures.length > 0 ? (
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
      {visibleActions.map((action) => {
        const feature = featureForAction(remediation, action);
        const open = actionStatusOpen(action);
        return (
          <div className="upd-action" key={action.actionId}>
            <div>
              <div className="upd-action-title">
                <strong>{remediationLabel(action.remediation, t)}</strong>
                <span className="upd-chip">{actionStatusLabel(action.status, t)}</span>
              </div>
              <small>{feature?.reason ?? action.message}</small>
              {action.instructions !== undefined ? <small>{action.instructions}</small> : null}
            </div>
            {open ? (
              <div className="upd-action-buttons">
                {action.canRun ? (
                  <button
                    type="button"
                    className="upd-secondary-btn"
                    disabled={busy !== undefined}
                    onClick={() => onAction(action, "run")}
                  >
                    {action.status === "deferred"
                      ? t("updates.action.runDeferred")
                      : t("updates.action.runRemediation")}
                  </button>
                ) : null}
                {action.canDefer && action.status !== "deferred" ? (
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
            ) : null}
          </div>
        );
      })}
      {showDecisionCopy ? (
        <p className="upd-muted">{t("updates.remediation.userActionRequired")}</p>
      ) : null}
    </section>
  );
}

function ManualPath({
  report,
  session,
  busy,
  commandsOpen,
  onCommandsOpenChange,
  onCheck,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
  readonly busy: BusyAction;
  readonly commandsOpen: boolean;
  readonly onCommandsOpenChange: (open: boolean) => void;
  readonly onCheck: () => void;
}): ReactNode {
  const { t } = useI18n();
  if (!isManualUpdatePath(report, session)) return null;
  const instructions = session.installMode.manualInstructions ?? t("updates.manual.default");
  const commands = manualCommands(report, session, t);
  return (
    <section className="upd-panel upd-manual" aria-labelledby="updates-manual-title">
      <div className="upd-panel-head">
        <strong id="updates-manual-title">{t("updates.manual.title")}</strong>
        <span>{t("updates.manual.body")}</span>
      </div>
      <ol className="upd-manual-steps">
        <li>{t("updates.manual.stepCommand")}</li>
        <li>{t("updates.manual.stepRestart")}</li>
        <li>{t("updates.manual.stepCheck")}</li>
      </ol>
      <details
        className="upd-manual-commands"
        open={commandsOpen}
        onToggle={(event) => onCommandsOpenChange(event.currentTarget.open)}
      >
        <summary>{t("updates.manual.commandsSummary")}</summary>
        <p>{instructions}</p>
        <div className="upd-command-list">
          {commands.map((command) => (
            <ManualCommandRow key={command.id} command={command} />
          ))}
        </div>
      </details>
      <div className="upd-manual-finish">
        <span>{t("updates.manual.finish")}</span>
        <button
          type="button"
          className="upd-secondary-btn"
          disabled={busy !== undefined}
          onClick={onCheck}
        >
          {t("updates.action.check")}
        </button>
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

function ManualCommandRow({ command }: { readonly command: ManualCommand }): ReactNode {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const handleCopy = useCallback(() => {
    void writeTextWithFallback(command.command).then(
      () => {
        setCopyState("copied");
        window.setTimeout(() => setCopyState("idle"), 1500);
      },
      () => setCopyState("failed"),
    );
  }, [command.command]);

  const copied = copyState === "copied";
  const failed = copyState === "failed";
  return (
    <div className="upd-command-row">
      <div className="upd-command-copy">
        <strong>{command.label}</strong>
        <code>{command.command}</code>
      </div>
      <button
        type="button"
        className="upd-secondary-btn upd-command-copy-btn"
        aria-label={t("updates.manual.copyCommand", { label: command.label })}
        data-copied={copied ? "true" : "false"}
        data-failed={failed ? "true" : "false"}
        onClick={handleCopy}
      >
        <Icons.copy size={15} aria-hidden="true" />
        {copied ? t("updates.manual.copied") : t("chat.copy.short")}
      </button>
      <span className="upd-copy-status" role="status">
        {copied ? t("updates.manual.copiedStatus") : failed ? t("chat.copy.failedStatus") : ""}
      </span>
    </div>
  );
}

function PatchNotesContent({ report }: { readonly report: UpdatePreflightReport }): ReactNode {
  const notes = report.patchNotes;
  const bullets = notes?.bullets ?? report.release?.notes ?? [];
  return (
    <>
      {notes?.summary !== undefined ? <p>{notes.summary}</p> : null}
      <ul>
        {bullets.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      {notes?.details.map((entry) => (
        <p key={entry}>{entry}</p>
      ))}
    </>
  );
}

function PatchNotes({ report }: { readonly report: UpdatePreflightReport }): ReactNode {
  const { t } = useI18n();
  const notes = report.patchNotes;
  if (notes === undefined && report.release === undefined) return null;
  return (
    <details className="upd-details">
      <summary>{t("updates.patchNotes.summary")}</summary>
      <PatchNotesContent report={report} />
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
  const visibleSession = sessionForDisplay(session, report);
  return (
    <details className="upd-details">
      <summary>{t("updates.details.summary")}</summary>
      <dl className="upd-tech">
        <div>
          <dt>{t("updates.details.registry")}</dt>
          <dd>{report.registryStatus}</dd>
        </div>
        <div>
          <dt>{t("updates.details.releaseMetadata")}</dt>
          <dd>{report.releaseMetadataStatus}</dd>
        </div>
        <div>
          <dt>{t("updates.details.installMode")}</dt>
          <dd>{session.installMode.status}</dd>
        </div>
        <div>
          <dt>{t("updates.details.remediation")}</dt>
          <dd>{remediation.overallStatus}</dd>
        </div>
      </dl>
      {session.installMode.commandPreview !== undefined ? (
        <pre className="upd-log">{session.installMode.commandPreview.label}</pre>
      ) : null}
      {visibleSession?.logs !== undefined ? (
        <pre className="upd-log">
          {[visibleSession.logs.stdoutPreview, visibleSession.logs.stderrPreview]
            .filter(Boolean)
            .join("\n")}
        </pre>
      ) : null}
      {[...report.blockers.map((b) => b.message), ...report.warnings, ...remediation.warnings].map(
        (entry) => (
          <p key={entry} className="upd-muted">
            {entry}
          </p>
        ),
      )}
    </details>
  );
}

export function UpdateWindow({ api = DEFAULT_API }: UpdateWindowProps): ReactNode {
  const { t } = useI18n();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = useState<BusyAction>();
  const [checkFeedback, setCheckFeedback] = useState<string>();
  const [releaseNotesReport, setReleaseNotesReport] = useState<UpdatePreflightReport>();
  const [manualCommandsOpen, setManualCommandsOpen] = useState(false);
  const [verifiedManualTargetVersion, setVerifiedManualTargetVersion] = useState<string>();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusedRef = useRef(false);
  const readyStateRef = useRef<Extract<LoadState, { status: "ready" }> | undefined>(undefined);

  const refresh = useCallback(
    async (manual: boolean): Promise<void> => {
      setBusy(manual ? "checking" : undefined);
      setCheckFeedback(manual ? t("updates.check.checking") : undefined);
      try {
        const previousReady = readyStateRef.current;
        const previousManualTarget =
          manual &&
          previousReady !== undefined &&
          isManualUpdatePath(previousReady.report, previousReady.session)
            ? previousReady.report.targetVersion
            : undefined;
        const report = manual ? await api.checkPreflight() : await api.fetchPreflight();
        const [session, remediation] = await Promise.all([
          api.fetchSessionStatus(),
          loadRemediation(api, report),
        ]);
        const manualInstallVerified =
          previousManualTarget !== undefined &&
          !report.updateAvailable &&
          report.currentVersion === previousManualTarget;
        setState({ status: "ready", report, session, remediation });
        if (hasReleaseNotes(report) && report.targetVersion !== undefined) {
          setReleaseNotesReport(report);
        }
        if (manualInstallVerified) {
          setVerifiedManualTargetVersion(previousManualTarget);
          setManualCommandsOpen(false);
        } else if (report.updateAvailable) {
          setVerifiedManualTargetVersion(undefined);
        }
        if (manual) {
          const manualStillRequired = report.updateAvailable && isManualUpdatePath(report, session);
          setCheckFeedback(
            manualInstallVerified
              ? t("updates.check.manualInstalled", { version: report.currentVersion })
              : report.updateAvailable
                ? manualStillRequired
                  ? t("updates.check.manualStillRequired")
                  : t("updates.check.available")
                : t("updates.check.current"),
          );
        }
      } catch (error) {
        setCheckFeedback(undefined);
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

  const visibleSession =
    state.status === "ready" ? sessionForDisplay(state.session, state.report) : undefined;
  useEffect(() => {
    if (state.status === "ready") readyStateRef.current = state;
  }, [state]);
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
    return (
      <div className="upd-loading" role="status">
        {t("updates.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <section className="upd" aria-labelledby="updates-window-title">
        <h2 id="updates-window-title" ref={titleRef} tabIndex={-1} className="upd-title">
          {t("updates.error.title")}
        </h2>
        <div className="upd-panel upd-error" role="alert">
          {state.message}
        </div>
        <button type="button" className="upd-secondary-btn" onClick={() => void refresh(true)}>
          {t("updates.action.check")}
        </button>
      </section>
    );
  }

  const { report, session, remediation } = state;
  const manualInstallVerified =
    verifiedManualTargetVersion !== undefined &&
    !report.updateAvailable &&
    report.currentVersion === verifiedManualTargetVersion;
  const patchNotesReport = patchNotesReportFor(report, visibleSession, releaseNotesReport);
  const outcomePatchNotesVisible =
    visibleSession?.phase === "succeeded" && hasReleaseNotes(patchNotesReport);
  const canRunRemediation = remediationRunnable(visibleSession);
  return (
    <section className="upd" aria-labelledby="updates-window-title">
      <SummaryCard
        report={report}
        session={session}
        remediation={remediation}
        manualInstallVerified={manualInstallVerified}
        titleRef={titleRef}
      />
      <div className="upd-primary">
        <div>
          <strong>{t("updates.primary.title")}</strong>
          <span>{primaryActionText(report, session, t, manualInstallVerified)}</span>
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
          onVerifyRestart={() => {
            if (targetVersion !== undefined) {
              void runAndRefresh("restart", () => api.verifyRestart({ targetVersion }));
            }
          }}
          onShowManualCommands={() => setManualCommandsOpen((open) => !open)}
          manualCommandsOpen={manualCommandsOpen}
          canVerifyRestart={targetVersion !== undefined}
        />
      </div>
      {checkFeedback !== undefined ? (
        <div className="upd-check-feedback" role="status" aria-live="polite">
          {checkFeedback}
        </div>
      ) : null}
      <ProgressPanel session={visibleSession} />
      <SessionOutcomePanel session={visibleSession} patchNotesReport={patchNotesReport} />
      <ManualPath
        report={report}
        session={session}
        busy={busy}
        commandsOpen={manualCommandsOpen}
        onCommandsOpenChange={setManualCommandsOpen}
        onCheck={() => void refresh(true)}
      />
      <ImpactPanel report={report} remediation={remediation} />
      {canRunRemediation ? (
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
      ) : (
        <PlannedRemediationPanel remediation={remediation} />
      )}
      {outcomePatchNotesVisible ? null : <PatchNotes report={patchNotesReport} />}
      <TechnicalDetails report={report} session={session} remediation={remediation} />
    </section>
  );
}
