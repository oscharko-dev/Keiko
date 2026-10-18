"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type ReactNode } from "react";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { fetchStartupUpdatePreflight } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import type { UpdateStartupNoticeContentProps } from "./UpdateStartupNoticeContent";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import type { UpdatePreflightReport } from "@/lib/types";
import { hasStartupUpdateSignal, startupUpdateNoticeKind } from "./update-copy";

const NoticeContent = dynamic(
  () =>
    import("./UpdateStartupNoticeContent")
      .then((module) => module.UpdateStartupNoticeContent)
      .catch((error: unknown) => {
        reportClientDiagnostic("update-startup-notice: presentation-load-failed", {
          kind: "other",
          errorKind: "unavailable",
          correlationId: newClientCorrelationId(),
          errorEvidence: clientErrorEvidence(error),
        });
        return NoticeLoadFailure;
      }),
  { ssr: false, loading: () => null },
);

function NoticeLoadFailure({
  report,
  dismiss,
  openUpdates,
}: UpdateStartupNoticeContentProps): ReactNode {
  const t = useTranslate();
  return (
    <output className="update-notice" aria-label={t("window.type.updates.title")}>
      <span className="update-notice-body">
        <span>{t("updates.notice.loadFailed")}</span>
      </span>
      <span className="update-notice-actions">
        <button
          type="button"
          className="update-notice-primary"
          onClick={() => {
            dismiss(report);
            openUpdates();
          }}
        >
          {t("window.type.updates.title")}
        </button>
        <button
          type="button"
          className="update-notice-dismiss"
          onClick={() => {
            dismiss(report);
          }}
        >
          {t("common.dismissError")}
        </button>
      </span>
    </output>
  );
}

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

function useNoticeState(
  ready: boolean,
  fetchReport: () => Promise<UpdatePreflightReport>,
): { readonly state: NoticeState; readonly dismiss: (report: UpdatePreflightReport) => void } {
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
    return (): void => {
      cancelled = true;
    };
  }, [fetchReport, ready, state.status]);

  return {
    state,
    dismiss: (report): void => {
      persistDismissal(report);
      setState({ status: "dismissed" });
    },
  };
}

/** Optional catalogs load only after preflight admits a visible notice. */
export function UpdateStartupNotice({
  ready,
  openUpdates,
  fetchReport = fetchStartupUpdatePreflight,
}: UpdateStartupNoticeProps): ReactNode {
  const { state, dismiss } = useNoticeState(ready, fetchReport);
  if (state.status !== "ready") return null;
  return <NoticeContent report={state.report} dismiss={dismiss} openUpdates={openUpdates} />;
}
