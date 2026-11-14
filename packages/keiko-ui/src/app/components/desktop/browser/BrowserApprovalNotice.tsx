"use client";

import { useEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { openLauncherBrowser } from "@/lib/launcher-browser-client";
import { inspectBrowserApprovals } from "@/lib/browser-approval-api";
import { noteConnectedServerInstance, sessionEndedByRestart } from "@/lib/server-restart";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { useBrowserApprovalInventory } from "./useBrowserApprovalInventory";
import styles from "./BrowserApproval.module.css";

interface BrowserConnection {
  readonly inventory: ReturnType<typeof useBrowserApprovalInventory>;
  readonly working: boolean;
  readonly launchFailed: boolean;
  readonly connect: () => Promise<void>;
}
function useBrowserConnection(): BrowserConnection {
  const [working, setWorking] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const inventory = useBrowserApprovalInventory(working);
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => {
      reportClientDiagnostic("Native browser connection was not confirmed.", {
        errorKind: "unavailable",
      });
      setWorking(false);
      setLaunchFailed(true);
    }, 15_000);
    return (): void => clearTimeout(timer);
  }, [working]);
  useEffect(() => {
    if (inventory.result?.state === "active") {
      setWorking(false);
      setLaunchFailed(false);
    }
  }, [inventory.result?.state]);
  const connect = async (): Promise<void> => {
    setWorking(true);
    setLaunchFailed(false);
    try {
      await openLauncherBrowser();
      inventory.refresh();
    } catch (error) {
      setWorking(false);
      setLaunchFailed(true);
      reportClientDiagnostic("Native browser connection failed.", {
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
    }
  };
  return { inventory, working, launchFailed, connect };
}

function useSessionAvailabilityChange(state: string | undefined): void {
  const previous = useRef(state);
  useEffect(() => {
    if (previous.current !== undefined && state !== undefined && previous.current !== state)
      notifyCodingAppSessionChanged();
    previous.current = state;
  }, [state]);
}

// While connected the page keeps the server instance it last saw current, so a restart that the
// session survived (a remembered browser renews on its own) is not blamed for a later, unrelated loss.
const CONNECTED_INSTANCE_REFRESH_MS = 30_000;
const sessionStillActive = async (): Promise<boolean> =>
  (await inspectBrowserApprovals()).state === "active";

/**
 * Whether the session ended because Keiko was restarted. While connected the page remembers which
 * server process it was talking to, refreshed on every active read and on a timer; once the session
 * is gone it compares (see `server-restart`).
 */
function useServerRestarted(
  result: ReturnType<typeof useBrowserApprovalInventory>["result"],
): boolean {
  const [restarted, setRestarted] = useState(false);
  const state = result?.state;
  useEffect(() => {
    if (state !== "active") return;
    setRestarted(false);
    // A result that just arrived is itself a fresh active observation. The timer is not: after a
    // restart nothing may have inspected yet, so each tick confirms the session before it records.
    void noteConnectedServerInstance();
    const timer = setInterval(() => {
      void noteConnectedServerInstance(sessionStillActive);
    }, CONNECTED_INSTANCE_REFRESH_MS);
    return (): void => clearInterval(timer);
  }, [state, result]);
  useEffect(() => {
    if (state !== "unavailable") return;
    let cancelled = false;
    void sessionEndedByRestart().then((ended) => {
      if (!cancelled) setRestarted(ended);
    });
    return (): void => {
      cancelled = true;
    };
  }, [state]);
  return restarted;
}

export function BrowserApprovalNotice({
  compact = false,
}: {
  readonly compact?: boolean;
}): ReactNode {
  const { inventory, working, launchFailed, connect } = useBrowserConnection();
  useSessionAvailabilityChange(inventory.result?.state);
  const restarted = useServerRestarted(inventory.result);
  const unavailable = inventory.result?.state === "unavailable";
  return (
    <>
      {unavailable || inventory.failed ? (
        <BrowserApprovalBanner
          compact={compact}
          failed={inventory.failed}
          working={working}
          launchFailed={launchFailed}
          restarted={restarted}
          onRetry={inventory.refresh}
          onOpen={(event): void => {
            event.currentTarget.focus();
            void connect();
          }}
        />
      ) : null}
    </>
  );
}

interface BannerProps {
  readonly compact: boolean;
  readonly failed: boolean;
  readonly working: boolean;
  readonly launchFailed: boolean;
  readonly restarted: boolean;
  readonly onRetry: () => void;
  readonly onOpen: MouseEventHandler<HTMLButtonElement>;
}

type NoticeMessageKey =
  | "browserApproval.launchNotice"
  | "browserApproval.restarted"
  | "browserApproval.failed"
  | "browserApproval.launchFailed";

function noticeMessageKey(state: {
  readonly failed: boolean;
  readonly launchFailed: boolean;
  readonly restarted: boolean;
}): NoticeMessageKey {
  if (state.launchFailed) return "browserApproval.launchFailed";
  if (state.failed) return "browserApproval.failed";
  return state.restarted ? "browserApproval.restarted" : "browserApproval.launchNotice";
}

/**
 * The compact header keeps its ordinary message visually hidden, but a restart is a rare state the
 * person has to be able to read: it shows one short line there, with the full text as the tooltip.
 */
function NoticeMessage({
  message,
  compact,
  alert,
  showRestart,
}: {
  readonly message: string;
  readonly compact: boolean;
  readonly alert: boolean;
  readonly showRestart: boolean;
}): ReactNode {
  const t = useTranslate();
  const roleProps = alert ? { role: "alert" } : {};
  if (compact && showRestart)
    return (
      <span className={styles.cmpCompactMessage} {...roleProps}>
        {t("browserApproval.restartedCompact")}
      </span>
    );
  return (
    <span className={compact ? "visually-hidden" : undefined} {...roleProps}>
      {message}
    </span>
  );
}

function BrowserApprovalBanner({
  compact,
  failed,
  working,
  launchFailed,
  restarted,
  onRetry,
  onOpen,
}: BannerProps): ReactNode {
  const t = useTranslate();
  const messageKey = noticeMessageKey({ failed, launchFailed, restarted });
  const message = t(messageKey);
  let buttonKey: "browserApproval.retry" | "browserApproval.open" | "browserApproval.working" =
    failed || launchFailed ? "browserApproval.retry" : "browserApproval.open";
  if (working) buttonKey = "browserApproval.working";
  return (
    <aside
      className={`${styles.cmpNotice} ${compact ? styles.cmpCompactNotice : ""}`}
      aria-label={t("browserApproval.title")}
    >
      <NoticeMessage
        message={message}
        compact={compact}
        alert={launchFailed}
        showRestart={restarted && !failed && !launchFailed}
      />
      <button type="button" disabled={working} title={message} onClick={failed ? onRetry : onOpen}>
        {t(buttonKey)}
      </button>
    </aside>
  );
}
