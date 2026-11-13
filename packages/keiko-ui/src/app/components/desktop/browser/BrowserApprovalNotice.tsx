"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { openLauncherBrowser } from "@/lib/launcher-browser-client";
import { createLocalBrowserApprovalClient } from "@/lib/browser-approval-client";
import { noteConnectedServerInstance, sessionEndedByRestart } from "@/lib/server-restart";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { bffRequestErrorKind } from "@/lib/http";
import { useBrowserApprovalInventory } from "./useBrowserApprovalInventory";
import styles from "./BrowserApproval.module.css";

const REMEMBER_RESULT_VISIBLE_MS = 10_000;

type RememberResult = "remembered" | "not-remembered";

/** Remember this browser after the connection, only when the human chose it (#4370). */
async function rememberChosenBrowser(): Promise<RememberResult> {
  try {
    const outcome = await createLocalBrowserApprovalClient().rememberCurrent();
    return outcome === "stored" ? "remembered" : "not-remembered";
  } catch (error) {
    reportClientDiagnostic("Remembering this browser failed.", {
      errorKind: bffRequestErrorKind(error),
      errorEvidence: clientErrorEvidence(error),
    });
    return "not-remembered";
  }
}

/** Clear a transient result after a while; `setValue` is a state setter, so it is stable. */
function useAutoClear<T>(value: T | undefined, setValue: (next: undefined) => void): void {
  useEffect(() => {
    if (value === undefined) return;
    const timer = setTimeout(() => setValue(undefined), REMEMBER_RESULT_VISIBLE_MS);
    return (): void => clearTimeout(timer);
  }, [value, setValue]);
}

interface BrowserConnection {
  readonly inventory: ReturnType<typeof useBrowserApprovalInventory>;
  readonly working: boolean;
  readonly launchFailed: boolean;
  readonly remember: boolean;
  readonly setRemember: (value: boolean) => void;
  readonly rememberResult: RememberResult | undefined;
  readonly connect: () => Promise<void>;
}
function useBrowserConnection(): BrowserConnection {
  const [working, setWorking] = useState(false);
  const [launchFailed, setLaunchFailed] = useState(false);
  const [remember, setRemember] = useState(false);
  const [rememberResult, setRememberResult] = useState<RememberResult>();
  const rememberOnConnect = useRef(false);
  const inventory = useBrowserApprovalInventory(working);
  useEffect(() => {
    if (!working) return;
    const timer = setTimeout(() => {
      reportClientDiagnostic("Native browser connection was not confirmed.", {
        errorKind: "unavailable",
      });
      rememberOnConnect.current = false;
      setWorking(false);
      setLaunchFailed(true);
    }, 15_000);
    return (): void => clearTimeout(timer);
  }, [working]);
  useEffect(() => {
    if (inventory.result?.state !== "active") return;
    setWorking(false);
    setLaunchFailed(false);
    if (!rememberOnConnect.current) return;
    rememberOnConnect.current = false;
    void rememberChosenBrowser().then(setRememberResult);
  }, [inventory.result?.state]);
  useAutoClear(rememberResult, setRememberResult);
  const connect = async (): Promise<void> => {
    rememberOnConnect.current = remember;
    setWorking(true);
    setLaunchFailed(false);
    try {
      await openLauncherBrowser();
      inventory.refresh();
    } catch (error) {
      rememberOnConnect.current = false;
      setWorking(false);
      setLaunchFailed(true);
      reportClientDiagnostic("Native browser connection failed.", {
        errorKind: bffRequestErrorKind(error),
        errorEvidence: clientErrorEvidence(error),
      });
    }
  };
  return { inventory, working, launchFailed, remember, setRemember, rememberResult, connect };
}

function useSessionAvailabilityChange(state: string | undefined): void {
  const previous = useRef(state);
  useEffect(() => {
    if (previous.current !== undefined && state !== undefined && previous.current !== state)
      notifyCodingAppSessionChanged();
    previous.current = state;
  }, [state]);
}

/**
 * Whether the session ended because Keiko was restarted. While connected the page remembers which
 * server process it was talking to; once the session is gone it compares (see `server-restart`).
 */
function useServerRestarted(state: string | undefined): boolean {
  const [restarted, setRestarted] = useState(false);
  useEffect(() => {
    if (state === "active") {
      setRestarted(false);
      void noteConnectedServerInstance();
      return;
    }
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
  const connection = useBrowserConnection();
  const { inventory, working, launchFailed, connect } = connection;
  useSessionAvailabilityChange(inventory.result?.state);
  const restarted = useServerRestarted(inventory.result?.state);
  const unavailable = inventory.result?.state === "unavailable";
  if (unavailable || inventory.failed)
    return (
      <BrowserApprovalBanner
        compact={compact}
        failed={inventory.failed}
        working={working}
        launchFailed={launchFailed}
        restarted={restarted}
        remember={connection.remember}
        onRememberChange={connection.setRemember}
        onRetry={inventory.refresh}
        onOpen={(event): void => {
          event.currentTarget.focus();
          void connect();
        }}
      />
    );
  return <RememberResultNotice result={connection.rememberResult} />;
}

function RememberResultNotice({
  result,
}: {
  readonly result: RememberResult | undefined;
}): ReactNode {
  const t = useTranslate();
  if (result === undefined) return null;
  return (
    <aside className={styles.cmpNotice} aria-label={t("browserApproval.title")}>
      <output>
        {t(
          result === "remembered"
            ? "browserApproval.rememberDone"
            : "browserApproval.rememberNotDone",
        )}
      </output>
    </aside>
  );
}

interface BannerProps {
  readonly compact: boolean;
  readonly failed: boolean;
  readonly working: boolean;
  readonly launchFailed: boolean;
  readonly restarted: boolean;
  readonly remember: boolean;
  readonly onRememberChange: (value: boolean) => void;
  readonly onRetry: () => void;
  readonly onOpen: MouseEventHandler<HTMLButtonElement>;
}

type NoticeMessageKey =
  | "browserApproval.launchNotice"
  | "browserApproval.failed"
  | "browserApproval.launchFailed"
  | "browserApproval.restarted";

function noticeMessageKey({
  failed,
  launchFailed,
  restarted,
}: Pick<BannerProps, "failed" | "launchFailed" | "restarted">): NoticeMessageKey {
  if (launchFailed) return "browserApproval.launchFailed";
  if (failed) return "browserApproval.failed";
  return restarted ? "browserApproval.restarted" : "browserApproval.launchNotice";
}

function RememberChoice({
  checked,
  disabled,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}): ReactNode {
  const t = useTranslate();
  const descriptionId = useId();
  const change: ChangeEventHandler<HTMLInputElement> = (event) => onChange(event.target.checked);
  return (
    <div className={styles.cmpRememberChoice}>
      <label className={styles.cmpRemember}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={descriptionId}
          onChange={change}
        />
        {t("browserApproval.rememberChoice")}
      </label>
      <span id={descriptionId} className={styles.cmpMetadata}>
        {t("browserApproval.rememberDescription")}
      </span>
    </div>
  );
}

function BrowserApprovalBanner({
  compact,
  failed,
  working,
  launchFailed,
  restarted,
  remember,
  onRememberChange,
  onRetry,
  onOpen,
}: BannerProps): ReactNode {
  const t = useTranslate();
  const message = t(noticeMessageKey({ failed, launchFailed, restarted }));
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
      {compact || failed ? null : (
        <RememberChoice checked={remember} disabled={working} onChange={onRememberChange} />
      )}
      <button type="button" disabled={working} title={message} onClick={failed ? onRetry : onOpen}>
        {t(buttonKey)}
      </button>
    </aside>
  );
}
