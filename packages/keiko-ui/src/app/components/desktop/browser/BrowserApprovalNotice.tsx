"use client";

import { useEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { openLauncherBrowser } from "@/lib/launcher-browser-client";
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

export function BrowserApprovalNotice({
  compact = false,
}: {
  readonly compact?: boolean;
}): ReactNode {
  const { inventory, working, launchFailed, connect } = useBrowserConnection();
  useSessionAvailabilityChange(inventory.result?.state);
  const unavailable = inventory.result?.state === "unavailable";
  return (
    <>
      {unavailable || inventory.failed ? (
        <BrowserApprovalBanner
          compact={compact}
          failed={inventory.failed}
          working={working}
          launchFailed={launchFailed}
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
  readonly onRetry: () => void;
  readonly onOpen: MouseEventHandler<HTMLButtonElement>;
}

function BrowserApprovalBanner({
  compact,
  failed,
  working,
  launchFailed,
  onRetry,
  onOpen,
}: BannerProps): ReactNode {
  const t = useTranslate();
  let messageKey:
    "browserApproval.launchNotice" | "browserApproval.failed" | "browserApproval.launchFailed" =
    "browserApproval.launchNotice";
  if (failed) messageKey = "browserApproval.failed";
  if (launchFailed) messageKey = "browserApproval.launchFailed";
  const message = t(messageKey);
  let buttonKey: "browserApproval.retry" | "browserApproval.open" | "browserApproval.working" =
    failed || launchFailed ? "browserApproval.retry" : "browserApproval.open";
  if (working) buttonKey = "browserApproval.working";
  return (
    <aside
      className={`${styles.cmpNotice} ${compact ? styles.cmpCompactNotice : ""}`}
      aria-label={t("browserApproval.title")}
    >
      <span
        role={launchFailed ? "alert" : undefined}
        className={compact ? "visually-hidden" : undefined}
      >
        {message}
      </span>
      <button type="button" disabled={working} title={message} onClick={failed ? onRetry : onOpen}>
        {t(buttonKey)}
      </button>
    </aside>
  );
}
