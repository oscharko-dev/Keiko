"use client";

import type { ReactNode } from "react";
import type { ClientUpdateNoticeKind } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import {
  useOptionalWidgetTranslate as useTranslate,
  type OptionalWidgetTranslate as I18nTranslate,
} from "@/lib/optional-widget-i18n";
import type { UpdatePreflightReport } from "@/lib/types";
import { Icons } from "../Icons";
import {
  startupUpdateNoticeKind,
  isPortableBootstrapSetupRequired,
  isPortableExternallyManaged,
  isPortableReleaseMetadataUnavailable,
} from "./update-copy";

const InfoIcon = Icons.info;
const ActivityIcon = Icons.activity;

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

export interface UpdateStartupNoticeContentProps {
  readonly report: UpdatePreflightReport;
  readonly dismiss: (report: UpdatePreflightReport) => void;
  readonly openUpdates: () => void;
}

function NoticeActions({
  report,
  dismiss,
  openUpdates,
  t,
}: UpdateStartupNoticeContentProps & { readonly t: I18nTranslate }): ReactNode {
  return (
    <div className="update-notice-actions">
      <button
        type="button"
        className="update-notice-primary"
        onClick={() => {
          dismiss(report);
          openUpdates();
        }}
      >
        {t(report.updateAvailable ? "updates.notice.review" : "updates.notice.reviewDetails")}
      </button>
      <button
        type="button"
        className="update-notice-dismiss"
        onClick={() => {
          dismiss(report);
        }}
      >
        {t("updates.notice.notNow")}
      </button>
    </div>
  );
}

export function UpdateStartupNoticeContent(props: UpdateStartupNoticeContentProps): ReactNode {
  const { report } = props;
  const t = useTranslate();
  const critical = report.severity === "critical";
  const targetVersion = report.targetVersion ?? t("updates.versionUnknown");
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
        <strong>{t(NOTICE_TITLE_KEYS[startupUpdateNoticeKind(report)])}</strong>
        <span>{noticeBody(report, targetVersion, t)}</span>
      </div>
      <NoticeActions {...props} t={t} />
    </aside>
  );
}
