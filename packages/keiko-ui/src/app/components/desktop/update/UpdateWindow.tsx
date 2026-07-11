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
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type {
  UpdatePreflightReport,
  UpdateRemediationAction,
  UpdateRemediationAffectedFeature,
  UpdateRemediationStatusReport,
  UpdateSession,
  UpdateSessionStatus,
} from "@/lib/types";
import { Icons } from "../Icons";
import {
  actionStatusLabel,
  featureStateLabel,
  impactInput,
  isManualUpdatePath,
  isPortableBootstrapSetupRequired,
  isPortableExternallyManaged,
  isPortableIntegrityBlocked,
  isPortableManagedInstall,
  isPortableManagedManualPath,
  isPortableManagedOneClickPath,
  isPortableManagedPolicyDisabled,
  isPortableReleaseMetadataUnavailable,
  isSessionInProgress,
  isUpdateCheckUnavailable,
  remediationLabel,
  sessionForDisplay,
  sessionPhaseLabel,
  statusTitle,
  storeLabel,
  updateTone,
} from "./update-copy";
import styles from "./UpdateWindow.module.css";

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

type ManualCopyState = "idle" | "pressed" | "copied" | "selected" | "failed";
type ManualCopyResult = Exclude<ManualCopyState, "idle" | "pressed" | "failed">;

const COPY_PRESSED_RESET_MS = 240;
const COPY_FEEDBACK_RESET_MS = 900;

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

function selectCopyTarget(target: HTMLElement | null): boolean {
  if (target === null || typeof window === "undefined") return false;
  const selection = window.getSelection();
  if (selection === null || typeof document === "undefined") return false;
  const range = document.createRange();
  range.selectNodeContents(target);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

async function writeTextWithFallback(
  text: string,
  visibleTarget: HTMLElement | null,
): Promise<ManualCopyResult> {
  const writeText = typeof navigator === "undefined" ? undefined : navigator.clipboard?.writeText;
  if (writeText !== undefined && navigator.clipboard !== undefined) {
    try {
      await writeText.call(navigator.clipboard, text);
      return "copied";
    } catch {
      // Restricted clipboard contexts can still allow the selection-backed fallback.
    }
  }
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const target = document.createElement("textarea");
    target.value = text;
    target.setAttribute("readonly", "");
    target.style.position = "fixed";
    target.style.left = "-9999px";
    document.body.appendChild(target);
    target.select();
    try {
      if (document.execCommand("copy")) return "copied";
    } finally {
      target.remove();
    }
  }
  if (selectCopyTarget(visibleTarget)) return "selected";
  throw new Error("clipboard-unavailable");
}

function versionText(
  report: UpdatePreflightReport,
  t: I18nTranslate,
  manualInstallVerified = false,
  session?: UpdateSessionStatus | undefined,
  visibleSession?: UpdateSession | undefined,
): string {
  if (manualInstallVerified)
    return t("updates.versionInstalled", { version: report.currentVersion });
  if (isPortableExternallyManaged(report, session)) {
    return t("updates.versionExternallyManaged", { current: report.currentVersion });
  }
  if (isPortableBootstrapSetupRequired(report, session)) {
    return t("updates.versionSetupRequired", { current: report.currentVersion });
  }
  if (isPortableReleaseMetadataUnavailable(report)) {
    return t("updates.versionReleaseUnavailable", { current: report.currentVersion });
  }
  if (visibleSession?.phase === "succeeded") {
    return t("updates.versionLine", {
      current: visibleSession.targetVersion,
      target: visibleSession.targetVersion,
    });
  }
  if (isUpdateCheckUnavailable(report)) {
    return t("updates.versionUnavailable", { current: report.currentVersion });
  }
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

function ManualInstructionCopyFrame({
  text,
  command,
  label,
  copyLabel,
}: {
  readonly text: string;
  readonly command: boolean;
  readonly label?: string | undefined;
  readonly copyLabel?: string | undefined;
}): ReactNode {
  const t = useTranslate();
  const [copyState, setCopyState] = useState<ManualCopyState>("idle");
  const copyTargetRef = useRef<HTMLElement>(null);
  const frameLabel =
    label ??
    (command ? t("updates.manual.copyCommandLabel") : t("updates.manual.copyInstructionLabel"));
  const buttonLabel =
    copyLabel ?? (command ? t("updates.manual.copyCommand") : t("updates.manual.copyInstructions"));
  const buttonFeedbackLabel =
    copyState === "copied"
      ? t("updates.manual.copyCopied")
      : copyState === "selected"
        ? t("updates.manual.copySelectedShort")
        : copyState === "failed"
          ? t("updates.manual.copyFailedShort")
          : buttonLabel;
  const copyStatusLabel =
    copyState === "copied" || copyState === "selected" || copyState === "failed"
      ? buttonFeedbackLabel
      : "";
  useEffect(() => {
    if (copyState === "idle" || typeof window === "undefined") return;
    const resetMs = copyState === "pressed" ? COPY_PRESSED_RESET_MS : COPY_FEEDBACK_RESET_MS;
    const timer = window.setTimeout(() => setCopyState("idle"), resetMs);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const handleCopy = (): void => {
    setCopyState("pressed");
    void writeTextWithFallback(text, copyTargetRef.current).then(
      (result) => setCopyState(result),
      () => setCopyState("failed"),
    );
  };
  return (
    <div className="upd-command-copy" data-kind={command ? "command" : "instruction"}>
      <strong>{frameLabel}</strong>
      <div className="upd-command-line">
        {command ? (
          <code ref={copyTargetRef}>{text}</code>
        ) : (
          <span ref={copyTargetRef} className="upd-command-copy-text">
            {text}
          </span>
        )}
        <button
          type="button"
          className="upd-command-copy-btn"
          data-copied={copyState === "copied" ? "true" : "false"}
          data-pressed={copyState === "pressed" ? "true" : "false"}
          data-selected={copyState === "selected" ? "true" : "false"}
          data-failed={copyState === "failed" ? "true" : "false"}
          aria-label={buttonLabel}
          title={buttonFeedbackLabel}
          onClick={handleCopy}
        >
          <Icons.copy size={14} aria-hidden="true" />
          <span className="sr-only">{buttonLabel}</span>
        </button>
        <span className="sr-only" role="status" aria-live="polite">
          {copyStatusLabel}
        </span>
      </div>
    </div>
  );
}

type ManualPackageManager = "npm" | "yarn";

interface ManualPackageCommand {
  readonly manager: ManualPackageManager;
  readonly text: string;
}

function detectedManualPackageManager(
  session: UpdateSessionStatus,
): ManualPackageManager | undefined {
  const manager = session.installMode.packageManager;
  return manager === "npm" || manager === "yarn" ? manager : undefined;
}

function packageCommandText(
  manager: ManualPackageManager,
  packageName: string,
  packageVersion: string,
): string {
  const packageSpec = `${packageName}@${packageVersion}`;
  return manager === "npm"
    ? `npm install --global --ignore-scripts ${packageSpec}`
    : `yarn global add --ignore-scripts ${packageSpec}`;
}

function packageManagerLabel(manager: ManualPackageManager): string {
  return manager === "npm" ? "npm" : "Yarn";
}

function manualPackageManagerCommands(
  session: UpdateSessionStatus,
  targetVersion: string | undefined,
): readonly ManualPackageCommand[] {
  if (targetVersion === undefined) return [];
  const detectedManager = detectedManualPackageManager(session);
  const managers: readonly ManualPackageManager[] =
    detectedManager === undefined ? ["npm", "yarn"] : [detectedManager];
  return managers.map((manager) => ({
    manager,
    text: packageCommandText(manager, session.installMode.packageName, targetVersion),
  }));
}

interface RestartCommand {
  readonly id: "restart";
  readonly label: string;
  readonly text: string;
}

function restartCommands(session: UpdateSession, t: I18nTranslate): readonly RestartCommand[] {
  const preview = session.restartCommandPreview;
  if (preview === undefined) return [];
  return [{ id: "restart", label: t("updates.restart.commandLabel"), text: preview.label }];
}

function installModeDetailText(session: UpdateSessionStatus, t: I18nTranslate): string {
  const kind = session.installMode.installKind;
  if (kind === "portable-managed") return t("updates.details.installModePortableManaged");
  return kind ?? session.installMode.status;
}

function primaryActionTextForSession(
  visibleSession: ReturnType<typeof sessionForDisplay>,
  remediation: UpdateRemediationStatusReport,
  t: I18nTranslate,
): string | undefined {
  if (visibleSession?.phase === "succeeded" && !remediation.updateCanComplete) {
    return t("updates.primary.followUp");
  }
  if (visibleSession?.phase === "succeeded") return t("updates.primary.installed");
  if (visibleSession?.phase === "cancelled") return t("updates.primary.cancelled");
  if (visibleSession?.phase === "failed") return t("updates.primary.failed");
  if (visibleSession?.phase === "restart-required") return t("updates.primary.restart");
  return undefined;
}

function primaryActionTextForPortable(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
  t: I18nTranslate,
): string | undefined {
  if (isPortableExternallyManaged(report, session)) {
    return t("updates.primary.portableExternallyManaged");
  }
  if (isPortableBootstrapSetupRequired(report, session)) {
    return t("updates.primary.portableSetupRequired");
  }
  if (isPortableReleaseMetadataUnavailable(report)) {
    return t("updates.primary.releaseUnavailable");
  }
  if (report.updateAvailable && isPortableManagedPolicyDisabled(session)) {
    return t("updates.primary.policyDisabled");
  }
  return undefined;
}

function primaryActionText(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
  remediation: UpdateRemediationStatusReport,
  t: I18nTranslate,
  manualInstallVerified = false,
): string {
  const visibleSession = sessionForDisplay(session, report);
  if (manualInstallVerified) return t("updates.primary.installed");
  const sessionText = primaryActionTextForSession(visibleSession, remediation, t);
  if (sessionText !== undefined) return sessionText;
  const portableText = primaryActionTextForPortable(report, session, t);
  if (portableText !== undefined) return portableText;
  if (isUpdateCheckUnavailable(report)) return t("updates.primary.unavailable");
  if (isManualUpdatePath(report, session)) return t("updates.primary.manual");
  if (remediation.overallStatus === "manual-review-required") {
    return t("updates.primary.manualReview");
  }
  if (isPortableManagedOneClickPath(report, session)) return t("updates.primary.portableAvailable");
  if (report.updateAvailable) return t("updates.primary.available");
  return t("updates.primary.current");
}

function classNames(...values: readonly (string | false | undefined)[]): string {
  return values
    .filter((value): value is string => value !== false && value !== undefined)
    .join(" ");
}

function blocksAutomaticInstall(remediation: UpdateRemediationStatusReport): boolean {
  return (
    remediation.overallStatus === "manual-review-required" || remediation.overallStatus === "failed"
  );
}

function manualReviewRisk(feature: UpdateRemediationAffectedFeature, t: I18nTranslate): string {
  const reason = feature.reason.trim();
  return reason.length > 0
    ? reason
    : t("updates.manualReview.featureRisk", { feature: feature.label });
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
  const t = useTranslate();
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
            : isPortableExternallyManaged(report, session)
              ? t("updates.status.portableExternallyManaged")
              : isPortableBootstrapSetupRequired(report, session)
                ? t("updates.status.portableSetupRequired")
                : statusTitle(report, visibleSession, t)}
        </h2>
        <p className="upd-body">
          {versionText(report, t, manualInstallVerified, session, visibleSession)}
        </p>
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
  readonly canVerifyRestart: boolean;
}): ReactNode {
  const t = useTranslate();
  const visibleSession = sessionForDisplay(session, report);
  const disabled = busy !== undefined;
  const manual = isManualUpdatePath(report, session);
  const portableManaged = isPortableManagedOneClickPath(report, session);
  if (visibleSession?.phase === "restart-required") {
    return (
      <>
        <button
          type="button"
          className="upd-primary-btn"
          aria-describedby="updates-restart-verification-help"
          disabled={disabled || !canVerifyRestart}
          onClick={onVerifyRestart}
        >
          {t("updates.action.verifyRestart")}
        </button>
        <span id="updates-restart-verification-help" className="sr-only">
          {t("updates.restart.verifyHelp")}
        </span>
      </>
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
  if (manual || !report.updateAvailable || blocksAutomaticInstall(remediation)) {
    if (manual) return null;
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
      {portableManaged ? t("updates.action.updatePortable") : t("updates.action.install")}
    </button>
  );
}

function ProgressPanel({ session }: { readonly session: ReturnType<typeof sessionForDisplay> }) {
  const t = useTranslate();
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

function RestartRequiredDetails({ session }: { readonly session: UpdateSession }): ReactNode {
  const t = useTranslate();
  const commands = restartCommands(session, t);
  return (
    <details className="upd-details upd-restart-details" open>
      <summary>{t("updates.restart.summary")}</summary>
      <div className="upd-details-body">
        <p>{t("updates.restart.ready", { version: session.targetVersion })}</p>
        <p>
          {commands.length > 0
            ? t("updates.restart.instructions")
            : t("updates.restart.genericInstructions")}
        </p>
        {commands.length > 0 ? (
          <div className="upd-command-list" aria-label={t("updates.restart.commandListLabel")}>
            {commands.map((command) => (
              <ManualInstructionCopyFrame
                key={command.id}
                text={command.text}
                command
                label={command.label}
                copyLabel={t("updates.manual.copyCommand")}
              />
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function RestartVerificationFeedback({
  session,
}: {
  readonly session: ReturnType<typeof sessionForDisplay>;
}): ReactNode {
  const t = useTranslate();
  if (session?.phase !== "restart-required" || session.failureReason !== "restart-version-mismatch")
    return null;
  return (
    <div className="upd-restart-verification-feedback" role="status" aria-live="polite">
      {t("updates.restart.notDetected")}
    </div>
  );
}

function SessionOutcomePanel({
  session,
  patchNotesReport,
}: {
  readonly session: ReturnType<typeof sessionForDisplay>;
  readonly patchNotesReport: UpdatePreflightReport;
}): ReactNode {
  const t = useTranslate();
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
  if (session.phase === "restart-required") {
    return <RestartRequiredDetails session={session} />;
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
  const t = useTranslate();
  const impacts = report.impact?.stateImpact ?? [];
  if (remediation.overallStatus === "manual-review-required") return null;
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

function remediationHasFailure(remediation: UpdateRemediationStatusReport): boolean {
  return (
    remediation.overallStatus === "failed" ||
    remediation.actions.some((action) => action.status === "failed")
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
  const t = useTranslate();
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

function remediationHeaderTitle(
  isManualReview: boolean,
  hasFailedAction: boolean,
  hasDeferredAction: boolean,
  t: I18nTranslate,
): string {
  if (isManualReview) return t("updates.manualReview.title");
  if (hasFailedAction) return t("updates.remediation.failedTitle");
  if (hasDeferredAction) return t("updates.remediation.deferredTitle");
  return t("updates.remediation.title");
}

function remediationHeaderBody(
  isManualReview: boolean,
  hasFailedAction: boolean,
  hasDeferredAction: boolean,
  remediation: UpdateRemediationStatusReport,
  t: I18nTranslate,
): string {
  if (isManualReview) return t("updates.manualReview.body");
  if (hasFailedAction) return t("updates.remediation.failedBody");
  if (hasDeferredAction) return t("updates.remediation.deferredBody");
  if (remediation.updateCanComplete) return t("updates.remediation.canComplete");
  return t("updates.remediation.needsAction");
}

function RemediationFeatureSummary({
  showFeatureSummary,
  isManualReview,
  remediation,
  t,
}: {
  readonly showFeatureSummary: boolean;
  readonly isManualReview: boolean;
  readonly remediation: UpdateRemediationStatusReport;
  readonly t: I18nTranslate;
}): ReactNode {
  if (!showFeatureSummary) return null;
  if (isManualReview) {
    return (
      <>
        {remediation.affectedFeatures.map((feature) => (
          <div className="upd-action" key={feature.featureId}>
            <div>
              <div className="upd-action-title">
                <strong>{feature.label}</strong>
              </div>
              <small>{manualReviewRisk(feature, t)}</small>
            </div>
          </div>
        ))}
      </>
    );
  }
  if (remediation.affectedFeatures.length === 0) return null;
  return (
    <ul className="upd-feature-list">
      {remediation.affectedFeatures.map((feature) => (
        <li key={feature.featureId}>
          <span>{feature.label}</span>
          <span className="upd-chip">{featureStateLabel(feature.state, t)}</span>
          <small>{feature.reason}</small>
        </li>
      ))}
    </ul>
  );
}

function actionTitleText(
  action: UpdateRemediationAction,
  feature: UpdateRemediationAffectedFeature | undefined,
  manualReviewAction: boolean,
  t: I18nTranslate,
): string {
  if (manualReviewAction) return feature?.label ?? remediationLabel(action.remediation, t);
  return remediationLabel(action.remediation, t);
}

function actionDescriptionText(
  action: UpdateRemediationAction,
  feature: UpdateRemediationAffectedFeature | undefined,
  manualReviewAction: boolean,
  t: I18nTranslate,
): string {
  if (manualReviewAction && feature !== undefined) return manualReviewRisk(feature, t);
  return feature?.reason ?? action.message;
}

function RemediationActionButtons({
  action,
  busy,
  onAction,
  t,
}: {
  readonly action: UpdateRemediationAction;
  readonly busy: BusyAction;
  readonly onAction: (action: UpdateRemediationAction, decision: "run" | "defer") => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
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
  );
}

function RemediationActionItem({
  action,
  remediation,
  busy,
  onAction,
  t,
}: {
  readonly action: UpdateRemediationAction;
  readonly remediation: UpdateRemediationStatusReport;
  readonly busy: BusyAction;
  readonly onAction: (action: UpdateRemediationAction, decision: "run" | "defer") => void;
  readonly t: I18nTranslate;
}): ReactNode {
  const feature = featureForAction(remediation, action);
  const manualReviewAction = action.status === "manual-review-required";
  const open = actionStatusOpen(action);
  return (
    <div className={classNames("upd-action", action.status === "failed" && styles.failedAction)}>
      <div>
        <div className="upd-action-title">
          <strong>{actionTitleText(action, feature, manualReviewAction, t)}</strong>
          {manualReviewAction ? null : (
            <span className="upd-chip">{actionStatusLabel(action.status, t)}</span>
          )}
        </div>
        <small>{actionDescriptionText(action, feature, manualReviewAction, t)}</small>
        {action.instructions !== undefined ? <small>{action.instructions}</small> : null}
        {action.status === "failed" ? (
          <small className={styles.failedCopy}>{t("updates.remediation.failedActionHelp")}</small>
        ) : null}
      </div>
      {open ? (
        <RemediationActionButtons action={action} busy={busy} onAction={onAction} t={t} />
      ) : null}
    </div>
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
  const t = useTranslate();
  if (remediation.actions.length === 0 && remediation.affectedFeatures.length === 0) return null;
  const visibleActions = remediation.actions.filter(actionVisible);
  if (remediation.actions.length > 0 && visibleActions.length === 0) return null;
  const showFeatureSummary = remediation.actions.length === 0;
  const isManualReview = remediation.overallStatus === "manual-review-required";
  const hasFailedAction = remediationHasFailure(remediation);
  const hasDeferredAction = visibleActions.some((action) => action.status === "deferred");
  const showDecisionCopy =
    !isManualReview && report.impact?.userActionRequired === true && !remediation.updateCanComplete;
  return (
    <section
      className={classNames(
        "upd-panel",
        isManualReview && styles.warningRemediation,
        hasFailedAction && styles.failedRemediation,
      )}
      aria-labelledby="updates-remediation-title"
      aria-live={hasFailedAction ? "assertive" : "polite"}
      role={hasFailedAction ? "alert" : "status"}
    >
      <div className="upd-panel-head">
        <strong id="updates-remediation-title">
          {remediationHeaderTitle(isManualReview, hasFailedAction, hasDeferredAction, t)}
        </strong>
        <span>
          {remediationHeaderBody(
            isManualReview,
            hasFailedAction,
            hasDeferredAction,
            remediation,
            t,
          )}
        </span>
      </div>
      <RemediationFeatureSummary
        showFeatureSummary={showFeatureSummary}
        isManualReview={isManualReview}
        remediation={remediation}
        t={t}
      />
      {visibleActions.map((action) => (
        <RemediationActionItem
          key={action.actionId}
          action={action}
          remediation={remediation}
          busy={busy}
          onAction={onAction}
          t={t}
        />
      ))}
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
  instructionsOpen,
  onInstructionsOpenChange,
  onCheck,
}: {
  readonly report: UpdatePreflightReport;
  readonly session: UpdateSessionStatus;
  readonly busy: BusyAction;
  readonly instructionsOpen: boolean;
  readonly onInstructionsOpenChange: (open: boolean) => void;
  readonly onCheck: () => void;
}): ReactNode {
  const t = useTranslate();
  if (isPortableExternallyManaged(report, session)) {
    return <PortableExternallyManagedPath />;
  }
  if (isPortableBootstrapSetupRequired(report, session)) {
    return <PortableSetupRequiredPath />;
  }
  if (!isManualUpdatePath(report, session)) return null;
  if (report.updateAvailable && isPortableManagedPolicyDisabled(session)) {
    return <PortablePolicyDisabledPath busy={busy} onCheck={onCheck} />;
  }
  if (isPortableManagedManualPath(report, session)) {
    return <PortableManualPath report={report} busy={busy} onCheck={onCheck} />;
  }
  const instructions = session.installMode.manualInstructions ?? t("updates.manual.default");
  const commands = manualPackageManagerCommands(session, report.targetVersion);
  const releaseUrl = report.release?.url;
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
        open={instructionsOpen}
        onToggle={(event) => onInstructionsOpenChange(event.currentTarget.open)}
      >
        <summary>{t("updates.manual.instructionsSummary")}</summary>
        <div className="upd-manual-commands-body">
          <p>{instructions}</p>
          {commands.length > 0 ? (
            <div className="upd-command-list" aria-label={t("updates.manual.commandListLabel")}>
              {commands.map((command) => (
                <ManualInstructionCopyFrame
                  key={command.manager}
                  text={command.text}
                  command
                  label={packageManagerLabel(command.manager)}
                  copyLabel={
                    command.manager === "npm"
                      ? t("updates.manual.copyNpmCommand")
                      : t("updates.manual.copyYarnCommand")
                  }
                />
              ))}
            </div>
          ) : (
            <ManualInstructionCopyFrame text={instructions} command={false} />
          )}
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
      {releaseUrl !== undefined ? (
        <a className="upd-link" href={releaseUrl} target="_blank" rel="noopener noreferrer">
          {t("updates.manual.releaseLink")}
          <Icons.external size={13} aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

function PortableSetupRequiredPath(): ReactNode {
  const t = useTranslate();
  return (
    <section className="upd-panel upd-manual" aria-labelledby="updates-portable-setup-title">
      <div className="upd-panel-head">
        <strong id="updates-portable-setup-title">{t("updates.portableSetup.title")}</strong>
        <span>{t("updates.portableSetup.body")}</span>
      </div>
      <ul className="upd-manual-steps">
        <li>{t("updates.portableSetup.useLauncher")}</li>
        <li>{t("updates.portableSetup.keepUsing")}</li>
        <li>{t("updates.portableSetup.checkAgain")}</li>
      </ul>
    </section>
  );
}

function PortableExternallyManagedPath(): ReactNode {
  const t = useTranslate();
  return (
    <section
      className="upd-panel upd-manual"
      aria-labelledby="updates-portable-externally-managed-title"
    >
      <div className="upd-panel-head">
        <strong id="updates-portable-externally-managed-title">
          {t("updates.portableExternallyManaged.title")}
        </strong>
        <span>{t("updates.portableExternallyManaged.body")}</span>
      </div>
      <ul className="upd-manual-steps">
        <li>{t("updates.portableExternallyManaged.keepUsing")}</li>
        <li>{t("updates.portableExternallyManaged.admin")}</li>
        <li>{t("updates.portableExternallyManaged.checkAgain")}</li>
      </ul>
    </section>
  );
}

function PortablePolicyDisabledPath({
  busy,
  onCheck,
}: {
  readonly busy: BusyAction;
  readonly onCheck: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <section className="upd-panel upd-manual" aria-labelledby="updates-portable-policy-title">
      <div className="upd-panel-head">
        <strong id="updates-portable-policy-title">{t("updates.portablePolicy.title")}</strong>
        <span>{t("updates.portablePolicy.body")}</span>
      </div>
      <ul className="upd-manual-steps">
        <li>{t("updates.portablePolicy.keepUsing")}</li>
        <li>{t("updates.portablePolicy.admin")}</li>
        <li>{t("updates.portablePolicy.checkAgain")}</li>
      </ul>
      <div className="upd-manual-finish">
        <span>{t("updates.portablePolicy.finish")}</span>
        <button
          type="button"
          className="upd-secondary-btn"
          disabled={busy !== undefined}
          onClick={onCheck}
        >
          {t("updates.action.check")}
        </button>
      </div>
    </section>
  );
}

function PortableManualPath({
  report,
  busy,
  onCheck,
}: {
  readonly report: UpdatePreflightReport;
  readonly busy: BusyAction;
  readonly onCheck: () => void;
}): ReactNode {
  const t = useTranslate();
  const integrityBlocked = isPortableIntegrityBlocked(report);
  const releaseUrl = integrityBlocked ? undefined : report.release?.url;
  return (
    <section className="upd-panel upd-manual" aria-labelledby="updates-portable-manual-title">
      <div className="upd-panel-head">
        <strong id="updates-portable-manual-title">
          {integrityBlocked
            ? t("updates.portableManual.integrityTitle")
            : t("updates.portableManual.title")}
        </strong>
        <span>
          {integrityBlocked
            ? t("updates.portableManual.integrityBody")
            : t("updates.portableManual.body")}
        </span>
      </div>
      <ul className="upd-manual-steps">
        {integrityBlocked ? (
          <>
            <li>{t("updates.portableManual.integrityKeepUsing")}</li>
            <li>{t("updates.portableManual.integrityRetry")}</li>
            <li>{t("updates.portableManual.integrityDoNotInstall")}</li>
            <li>{t("updates.portableManual.integrityDetails")}</li>
          </>
        ) : (
          <>
            <li>{t("updates.portableManual.retry")}</li>
            <li>{t("updates.portableManual.current")}</li>
            <li>{t("updates.portableManual.details")}</li>
            <li>{t("updates.portableManual.download")}</li>
          </>
        )}
      </ul>
      <div className="upd-manual-finish">
        <span>{t("updates.portableManual.finish")}</span>
        <button
          type="button"
          className="upd-secondary-btn"
          disabled={busy !== undefined}
          onClick={onCheck}
        >
          {t("updates.action.check")}
        </button>
      </div>
      {releaseUrl !== undefined ? (
        <a className="upd-link" href={releaseUrl} target="_blank" rel="noopener noreferrer">
          {t("updates.portableManual.releaseLink")}
          <Icons.external size={13} aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

function PatchNotesContent({ report }: { readonly report: UpdatePreflightReport }): ReactNode {
  const notes = report.patchNotes;
  const sections = notes?.sections ?? report.release?.noteSections ?? [];
  const bullets = notes?.bullets ?? report.release?.notes ?? [];
  const hasSections = sections.length > 0;
  return (
    <>
      {hasSections ? (
        <div className="upd-note-sections">
          {sections.map((section) => (
            <section className="upd-note-section" key={section.title}>
              <h3>{section.title}</h3>
              <ul>
                {section.bullets.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <>
          {notes?.summary !== undefined ? <p>{notes.summary}</p> : null}
          <ul>
            {bullets.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </>
      )}
      {notes?.details.map((entry) => (
        <p key={entry}>{entry}</p>
      ))}
    </>
  );
}

function PatchNotes({ report }: { readonly report: UpdatePreflightReport }): ReactNode {
  const t = useTranslate();
  const notes = report.patchNotes;
  if (notes === undefined && report.release === undefined) return null;
  return (
    <details className="upd-details">
      <summary>{t("updates.patchNotes.summary")}</summary>
      <div className="upd-details-body">
        <PatchNotesContent report={report} />
      </div>
    </details>
  );
}

function SessionLogPreview({ session }: { readonly session: UpdateSession }): ReactNode {
  const t = useTranslate();
  if (session.logs === undefined) return null;
  const output = [session.logs.stdoutPreview, session.logs.stderrPreview]
    .filter(Boolean)
    .join("\n");
  if (output.trim().length === 0) return null;
  return (
    <div className="upd-log-preview">
      <strong>{t("updates.details.installLog")}</strong>
      <pre className="upd-log">{output}</pre>
    </div>
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
  const t = useTranslate();
  const visibleSession = sessionForDisplay(session, report);
  const diagnostics = Array.from(
    new Set([
      ...report.blockers.map((b) => b.message),
      ...report.warnings,
      ...remediation.warnings,
    ]),
  );
  return (
    <details className="upd-details">
      <summary>{t("updates.details.summary")}</summary>
      <div className="upd-details-body">
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
            <dd>{installModeDetailText(session, t)}</dd>
          </div>
          <div>
            <dt>{t("updates.details.remediation")}</dt>
            <dd>{remediation.overallStatus}</dd>
          </div>
        </dl>
        {visibleSession?.logs !== undefined ? <SessionLogPreview session={visibleSession} /> : null}
        {diagnostics.map((entry) => (
          <p key={entry} className="upd-diagnostic">
            {entry}
          </p>
        ))}
      </div>
    </details>
  );
}

function computePreviousManualTarget(
  manual: boolean,
  previousReady: Extract<LoadState, { status: "ready" }> | undefined,
): string | undefined {
  if (
    manual &&
    previousReady !== undefined &&
    isManualUpdatePath(previousReady.report, previousReady.session)
  ) {
    return previousReady.report.targetVersion;
  }
  return undefined;
}

function computeManualInstallVerified(
  previousManualTarget: string | undefined,
  report: UpdatePreflightReport,
): boolean {
  return (
    previousManualTarget !== undefined &&
    !report.updateAvailable &&
    report.currentVersion === previousManualTarget
  );
}

function applyReleaseNotesState(
  report: UpdatePreflightReport,
  setReleaseNotesReport: (report: UpdatePreflightReport) => void,
): void {
  if (hasReleaseNotes(report) && report.targetVersion !== undefined) {
    setReleaseNotesReport(report);
  }
}

function applyManualInstallState(
  manualInstallVerified: boolean,
  previousManualTarget: string | undefined,
  report: UpdatePreflightReport,
  setVerifiedManualTargetVersion: (value: string | undefined) => void,
  setManualInstructionsOpen: (open: boolean) => void,
): void {
  if (manualInstallVerified) {
    setVerifiedManualTargetVersion(previousManualTarget);
    setManualInstructionsOpen(false);
  } else if (report.updateAvailable) {
    setVerifiedManualTargetVersion(undefined);
  }
}

function checkFeedbackMessage(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
  manualInstallVerified: boolean,
  t: I18nTranslate,
): string {
  if (manualInstallVerified) {
    return t("updates.check.manualInstalled", { version: report.currentVersion });
  }
  if (isPortableExternallyManaged(report, session)) {
    return t("updates.check.portableExternallyManaged");
  }
  if (isPortableBootstrapSetupRequired(report, session)) {
    return t("updates.check.portableSetupRequired");
  }
  if (isPortableReleaseMetadataUnavailable(report)) {
    return t("updates.check.releaseUnavailable");
  }
  if (isUpdateCheckUnavailable(report)) return t("updates.check.unavailable");
  if (!report.updateAvailable) return t("updates.check.current");
  if (isPortableManagedPolicyDisabled(session)) return t("updates.check.policyDisabled");
  if (isManualUpdatePath(report, session)) return t("updates.check.manualStillRequired");
  return t("updates.check.available");
}

export function UpdateWindow({ api = DEFAULT_API }: UpdateWindowProps): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [busy, setBusy] = useState<BusyAction>();
  const [checkFeedback, setCheckFeedback] = useState<string>();
  const [releaseNotesReport, setReleaseNotesReport] = useState<UpdatePreflightReport>();
  const [manualInstructionsOpen, setManualInstructionsOpen] = useState(false);
  const [verifiedManualTargetVersion, setVerifiedManualTargetVersion] = useState<string>();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusedRef = useRef(false);
  const readyStateRef = useRef<Extract<LoadState, { status: "ready" }> | undefined>(undefined);

  const refresh = useCallback(
    async (manual: boolean): Promise<void> => {
      setBusy(manual ? "checking" : undefined);
      setCheckFeedback(manual ? t("updates.check.checking") : undefined);
      try {
        const previousManualTarget = computePreviousManualTarget(manual, readyStateRef.current);
        const report = manual ? await api.checkPreflight() : await api.fetchPreflight();
        const [session, remediation] = await Promise.all([
          api.fetchSessionStatus(),
          loadRemediation(api, report),
        ]);
        const manualInstallVerified = computeManualInstallVerified(previousManualTarget, report);
        setState({ status: "ready", report, session, remediation });
        applyReleaseNotesState(report, setReleaseNotesReport);
        applyManualInstallState(
          manualInstallVerified,
          previousManualTarget,
          report,
          setVerifiedManualTargetVersion,
          setManualInstructionsOpen,
        );
        if (manual) {
          setCheckFeedback(checkFeedbackMessage(report, session, manualInstallVerified, t));
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

  const reportTargetVersion = state.status === "ready" ? state.report.targetVersion : undefined;
  const actionTargetVersion = visibleSession?.targetVersion ?? reportTargetVersion;
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
  const canShowManualReview =
    remediation.overallStatus === "manual-review-required" &&
    report.updateAvailable &&
    visibleSession === undefined;
  const shouldShowRemediation =
    canShowManualReview ||
    (canRunRemediation && remediation.overallStatus !== "manual-review-required");
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
          <span>{primaryActionText(report, session, remediation, t, manualInstallVerified)}</span>
        </div>
        <PrimaryActions
          report={report}
          session={session}
          remediation={remediation}
          busy={busy}
          onCheck={() => void refresh(true)}
          onStart={() => {
            if (reportTargetVersion !== undefined) {
              void runAndRefresh("starting", () =>
                api.startSession({ targetVersion: reportTargetVersion }),
              );
            }
          }}
          onRetry={() => void runAndRefresh("retrying", api.retrySession)}
          onCancel={() => void runAndRefresh("cancelling", api.cancelSession)}
          onVerifyRestart={() => {
            if (actionTargetVersion !== undefined) {
              void runAndRefresh("restart", () =>
                api.verifyRestart({ targetVersion: actionTargetVersion }),
              );
            }
          }}
          canVerifyRestart={actionTargetVersion !== undefined}
        />
      </div>
      <RestartVerificationFeedback session={visibleSession} />
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
        instructionsOpen={manualInstructionsOpen}
        onInstructionsOpenChange={setManualInstructionsOpen}
        onCheck={() => void refresh(true)}
      />
      <ImpactPanel report={report} remediation={remediation} />
      {shouldShowRemediation ? (
        <RemediationPanel
          report={report}
          remediation={remediation}
          busy={busy}
          onAction={(action, decision) => {
            if (actionTargetVersion === undefined) return;
            void runAndRefresh("remediation", () =>
              api.runRemediationAction({
                actionId: action.actionId,
                targetVersion: actionTargetVersion,
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
