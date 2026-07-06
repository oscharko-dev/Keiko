import type { I18nTranslate } from "@/lib/i18n";
import type {
  ReleaseImpactRemediation,
  UpdatePreflightReport,
  UpdateReleaseImpactInput,
  UpdateRemediationActionStatus,
  UpdateRemediationFeatureState,
  UpdateRemediationStatusReport,
  UpdateSession,
  UpdateSessionStatus,
} from "@/lib/types";

export type UpdateTone = "neutral" | "info" | "success" | "warning" | "danger";

export function sessionForDisplay(
  status: UpdateSessionStatus,
  report?: UpdatePreflightReport,
): UpdateSession | undefined {
  const session = status.activeSession ?? status.lastSession;
  if (session === undefined || report === undefined || status.activeSession !== undefined) {
    return session;
  }
  if (
    report.updateAvailable &&
    report.targetVersion !== undefined &&
    session.targetVersion !== report.targetVersion
  ) {
    return undefined;
  }
  return session;
}

export function isSessionInProgress(session: UpdateSession | undefined): boolean {
  return session?.phase === "preparing" || session?.phase === "running";
}

export function hasStartupUpdateSignal(report: UpdatePreflightReport): boolean {
  return (
    report.updateAvailable ||
    report.severity === "critical" ||
    report.manualUpdateRequired ||
    report.userActionRequired
  );
}

export function isManualUpdatePath(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
): boolean {
  return (
    report.updateAvailable &&
    (report.manualUpdateRequired ||
      !report.oneClickEligible ||
      session.installMode.status === "unsupported" ||
      !session.policy.enabled)
  );
}

export function isPortableManagedInstall(session: UpdateSessionStatus): boolean {
  const mode = session.installMode;
  return (
    mode.installKind === "portable-managed" ||
    mode.recommendedAction === "portable-managed-update" ||
    mode.portable?.status === "managed"
  );
}

export function isPortableManagedOneClickPath(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
): boolean {
  return (
    report.updateAvailable &&
    report.oneClickEligible &&
    report.installabilitySource === "github-release-asset" &&
    report.portableAsset?.status === "eligible" &&
    session.policy.enabled &&
    session.installMode.status === "supported" &&
    isPortableManagedInstall(session)
  );
}

export function isPortableManagedManualPath(
  report: UpdatePreflightReport,
  session: UpdateSessionStatus,
): boolean {
  return isManualUpdatePath(report, session) && isPortableManagedInstall(session);
}

export function isUpdateCheckUnavailable(report: UpdatePreflightReport): boolean {
  return report.status === "degraded" && !report.updateAvailable;
}

export function updateTone(
  report: UpdatePreflightReport,
  session: UpdateSession | undefined,
  remediation: UpdateRemediationStatusReport,
): UpdateTone {
  if (session?.phase === "failed") return "danger";
  if (report.severity === "critical" || report.blockers.some((item) => item.userActionRequired)) {
    return "warning";
  }
  if (session?.phase === "succeeded" || remediation.overallStatus === "completed") return "success";
  if (report.updateAvailable || isUpdateCheckUnavailable(report)) return "info";
  return "neutral";
}

export function dominantRemediation(
  remediations: readonly ReleaseImpactRemediation[] | undefined,
): ReleaseImpactRemediation | undefined {
  const actionable = remediations?.find((entry) => entry !== "no-action-required");
  return actionable ?? remediations?.[0];
}

export function impactInput(report: UpdatePreflightReport): UpdateReleaseImpactInput | undefined {
  if (report.impact === undefined) return undefined;
  return {
    affectedStateStores: report.impact.affectedStateStores,
    stateImpact: report.impact.stateImpact,
    remediation: dominantRemediation(report.impact.remediations),
    userActionRequired: report.impact.userActionRequired,
  };
}

export function statusTitle(
  report: UpdatePreflightReport,
  session: UpdateSession | undefined,
  t: I18nTranslate,
): string {
  if (session?.phase === "failed") return t("updates.status.failed");
  if (session?.phase === "restart-required") return t("updates.status.restart");
  if (session?.phase === "succeeded") return t("updates.status.success");
  if (session?.phase === "preparing" || session?.phase === "running") {
    return t("updates.status.installing");
  }
  if (report.severity === "critical") return t("updates.status.critical");
  if (isUpdateCheckUnavailable(report)) return t("updates.status.unavailable");
  if (report.updateAvailable) return t("updates.status.available");
  return t("updates.status.current");
}

export function remediationLabel(value: ReleaseImpactRemediation, t: I18nTranslate): string {
  if (value === "restart-required") return t("updates.remediation.restart");
  if (value === "repair-required") return t("updates.remediation.repair");
  if (value === "local-knowledge-reindex-required") {
    return t("updates.remediation.reindex");
  }
  if (value === "migration-required") return t("updates.remediation.migration");
  if (value === "manual-review-required") return t("updates.remediation.manualReview");
  return t("updates.remediation.none");
}

export function actionStatusLabel(status: UpdateRemediationActionStatus, t: I18nTranslate): string {
  if (status === "not-needed") return t("updates.actionStatus.notNeeded");
  if (status === "pending") return t("updates.actionStatus.pending");
  if (status === "running") return t("updates.actionStatus.running");
  if (status === "completed") return t("updates.actionStatus.completed");
  if (status === "failed") return t("updates.actionStatus.failed");
  if (status === "deferred") return t("updates.actionStatus.deferred");
  return t("updates.actionStatus.manualReview");
}

export function featureStateLabel(state: UpdateRemediationFeatureState, t: I18nTranslate): string {
  if (state === "ready") return t("updates.featureState.ready");
  if (state === "degraded") return t("updates.featureState.degraded");
  if (state === "unavailable") return t("updates.featureState.unavailable");
  return t("updates.featureState.manualReview");
}

export function sessionPhaseLabel(session: UpdateSession, t: I18nTranslate): string {
  if (session.phase === "preparing") return t("updates.phase.preparing");
  if (session.phase === "running") return t("updates.phase.running");
  if (session.phase === "restart-required") return t("updates.phase.restartRequired");
  if (session.phase === "succeeded") return t("updates.phase.succeeded");
  if (session.phase === "failed") return t("updates.phase.failed");
  return t("updates.phase.cancelled");
}

export function storeLabel(store: string): string {
  return store.replace(/[-_]+/gu, " ");
}
