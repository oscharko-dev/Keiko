"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ClientUpdateNoticeKind } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { fetchStartupUpdatePreflight } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";
import type { UpdatePreflightReport } from "@/lib/types";
import { Icons } from "../Icons";
import {
  hasStartupUpdateSignal,
  startupUpdateNoticeKind,
  isPortableBootstrapSetupRequired,
  isPortableExternallyManaged,
  isPortableReleaseMetadataUnavailable,
} from "./update-copy";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const InfoIcon = Icons.info;
const ActivityIcon = Icons.activity;

interface UpdateStartupNoticeProps {
  readonly ready: boolean;
  readonly openUpdates: () => void;
  readonly fetchReport?: () => Promise<UpdatePreflightReport>;
}

type NoticeState =
  | { readonly status: "idle" }
  | { readonly status: "ready"; readonly report: UpdatePreflightReport }
  | { readonly status: "failed" }
  | { readonly status: "dismissed" };

const DISMISSED_NOTICE_KEY_PREFIX = "keiko.updateStartupNotice.dismissed.";

function dismissalFingerprint(report: UpdatePreflightReport): string {
  return [
    report.currentVersion,
    report.targetVersion ?? "no-target",
    report.status,
    report.severity,
    report.manualUpdateRequired ? "manual" : "automatic",
    report.userActionRequired ? "action" : "no-action",
    report.portableAsset?.status ?? "no-portable-asset",
    report.blockers
      .map((blocker) => blocker.code)
      .slice()
      .sort((left, right) => left.localeCompare(right))
      .join(","),
  ].join("|");
}

function dismissalStorageKey(report: UpdatePreflightReport): string {
  return `${DISMISSED_NOTICE_KEY_PREFIX}${dismissalFingerprint(report)}`;
}

function isDismissed(report: UpdatePreflightReport): boolean {
  try {
    return window.localStorage.getItem(dismissalStorageKey(report)) === "1";
  } catch {
    return false;
  }
}

function persistDismissal(report: UpdatePreflightReport): void {
  try {
    window.localStorage.setItem(dismissalStorageKey(report), "1");
  } catch {
    // Dismissal persistence is a convenience only; keep the update path usable if storage is blocked.
  }
}

function noticeBody(
  report: UpdatePreflightReport,
  targetVersion: string,
  t: I18nTranslate,
): string {
  if (isPortableReleaseMetadataUnavailable(report)) {
    return t("updates.notice.releaseUnavailableBody");
  }
  if (isPortableExternallyManaged(report)) {
    return t("updates.notice.portableExternallyManagedBody");
  }
  if (isPortableBootstrapSetupRequired(report)) {
    return t("updates.notice.portableSetupBody");
  }
  if (!report.updateAvailable) return t("updates.notice.actionBody");
  if (
    report.installabilitySource === "github-release-asset" &&
    report.portableAsset?.status === "eligible"
  ) {
    return t("updates.notice.portableBody", { version: targetVersion });
  }
  return t("updates.notice.body", { version: targetVersion });
}

const NOTICE_TITLE_KEYS: Readonly<Record<ClientUpdateNoticeKind, Parameters<I18nTranslate>[0]>> = {
  "update-available": "updates.notice.title",
  "critical-update-available": "updates.notice.criticalTitle",
  "portable-setup-required": "updates.status.portableSetupRequired",
  "externally-managed": "updates.status.portableExternallyManaged",
  "check-unavailable": "updates.notice.releaseUnavailableTitle",
  "action-required": "updates.notice.actionTitle",
  "no-update-signal": "updates.notice.actionTitle",
};

function reportNoticePresentation(
  report: UpdatePreflightReport,
  presentation: "shown" | "dismissed" | "suppressed",
): void {
  reportClientDiagnostic("Keiko startup update notice classified.", {
    correlationId: newClientCorrelationId(),
    updateNotice: {
      blockerCount: report.blockers.length,
      noticeKind: startupUpdateNoticeKind(report),
      presentation,
      updateAvailable: report.updateAvailable,
    },
  });
}

export function UpdateStartupNotice({
  ready,
  openUpdates,
  fetchReport = fetchStartupUpdatePreflight,
}: UpdateStartupNoticeProps): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<NoticeState>({ status: "idle" });

  useEffect(() => {
    if (!ready || state.status !== "idle") return;
    let cancelled = false;
    fetchReport()
      .then((report) => {
        if (cancelled) return;
        if (!hasStartupUpdateSignal(report)) {
          reportNoticePresentation(report, "suppressed");
          return;
        }
        if (isDismissed(report)) {
          reportNoticePresentation(report, "dismissed");
          setState({ status: "dismissed" });
          return;
        }
        reportNoticePresentation(report, "shown");
        setState({ status: "ready", report });
      })
      .catch(() => {
        if (cancelled) return;
        // Startup can race a BFF restart. Keep the notice non-blocking, but retain a bounded,
        // body-free diagnostic so the failure is observable without exposing transport details.
        reportClientDiagnostic("update-startup-notice: preflight-fetch-failed");
        setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchReport, ready, state.status]);

  if (state.status !== "ready") return null;

  const critical = state.report.severity === "critical";
  const targetVersion = state.report.targetVersion ?? t("updates.versionUnknown");

  return (
    <aside
      className="update-notice"
      data-severity={critical ? "critical" : "normal"}
      role={critical ? "alert" : "status"}
      aria-live={critical ? "assertive" : "polite"}
      aria-label={t("updates.notice.aria")}
    >
      <span className="update-notice-icon" aria-hidden="true">
        {critical ? <InfoIcon size={17} /> : <ActivityIcon size={17} />}
      </span>
      <div className="update-notice-body">
        <strong>{t(NOTICE_TITLE_KEYS[startupUpdateNoticeKind(state.report)])}</strong>
        <span>{noticeBody(state.report, targetVersion, t)}</span>
      </div>
      <div className="update-notice-actions">
        <button
          type="button"
          className="update-notice-primary"
          onClick={() => {
            persistDismissal(state.report);
            openUpdates();
            setState({ status: "dismissed" });
          }}
        >
          {t(
            state.report.updateAvailable ? "updates.notice.review" : "updates.notice.reviewDetails",
          )}
        </button>
        <button
          type="button"
          className="update-notice-dismiss"
          onClick={() => {
            persistDismissal(state.report);
            setState({ status: "dismissed" });
          }}
        >
          {t("updates.notice.notNow")}
        </button>
      </div>
    </aside>
  );
}
