"use client";

import { useEffect, useState, type ReactNode } from "react";
import { fetchStartupUpdatePreflight } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import type { UpdatePreflightReport } from "@/lib/types";
import { Icons } from "../Icons";
import {
  hasStartupUpdateSignal,
  isPortableBootstrapSetupRequired,
  isPortableExternallyManaged,
  isPortableReleaseMetadataUnavailable,
} from "./update-copy";

interface UpdateStartupNoticeProps {
  readonly ready: boolean;
  readonly openUpdates: () => void;
  readonly fetchReport?: () => Promise<UpdatePreflightReport>;
}

type NoticeState =
  | { readonly status: "idle" }
  | { readonly status: "ready"; readonly report: UpdatePreflightReport }
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
      .sort()
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
  if (
    report.installabilitySource === "github-release-asset" &&
    report.portableAsset?.status === "eligible"
  ) {
    return t("updates.notice.portableBody", { version: targetVersion });
  }
  return t("updates.notice.body", { version: targetVersion });
}

function noticeTitle(report: UpdatePreflightReport, critical: boolean, t: I18nTranslate): string {
  if (critical) return t("updates.notice.criticalTitle");
  if (isPortableReleaseMetadataUnavailable(report))
    return t("updates.notice.releaseUnavailableTitle");
  return t("updates.notice.title");
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
        if (cancelled || !hasStartupUpdateSignal(report)) return;
        if (isDismissed(report)) {
          setState({ status: "dismissed" });
          return;
        }
        setState({ status: "ready", report });
      })
      .catch(() => undefined);
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
        {critical ? <Icons.info size={17} /> : <Icons.activity size={17} />}
      </span>
      <div className="update-notice-body">
        <strong>{noticeTitle(state.report, critical, t)}</strong>
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
          {t("updates.notice.review")}
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
