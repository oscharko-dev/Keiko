"use client";

import { useEffect, useRef, useState, type MouseEventHandler, type ReactNode } from "react";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { BrowserApprovalDialog } from "./BrowserApprovalDialog";
import { useBrowserApprovalInventory } from "./useBrowserApprovalInventory";
import styles from "./BrowserApproval.module.css";

export function BrowserApprovalNotice({
  compact = false,
}: {
  readonly compact?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const inventory = useBrowserApprovalInventory();
  const previous = useRef(inventory.result?.state);
  const state = inventory.result?.state;
  useEffect(() => {
    if (previous.current !== undefined && state !== undefined && previous.current !== state)
      notifyCodingAppSessionChanged();
    previous.current = state;
  }, [state]);
  const unavailable = inventory.result?.state === "unavailable";
  return (
    <>
      {unavailable || inventory.failed ? (
        <BrowserApprovalBanner
          compact={compact}
          failed={inventory.failed}
          onRetry={inventory.refresh}
          onOpen={(event): void => {
            event.currentTarget.focus();
            setOpen(true);
          }}
        />
      ) : null}
      {open ? (
        <BrowserApprovalDialog
          onClose={() => {
            setOpen(false);
            inventory.refresh();
          }}
        />
      ) : null}
    </>
  );
}

interface BannerProps {
  readonly compact: boolean;
  readonly failed: boolean;
  readonly onRetry: () => void;
  readonly onOpen: MouseEventHandler<HTMLButtonElement>;
}

function BrowserApprovalBanner({ compact, failed, onRetry, onOpen }: BannerProps): ReactNode {
  const t = useTranslate();
  const message = t(failed ? "browserApproval.failed" : "browserApproval.notice");
  return (
    <aside
      className={`${styles.cmpNotice} ${compact ? styles.cmpCompactNotice : ""}`}
      aria-label={t("browserApproval.title")}
    >
      <span className={compact ? "visually-hidden" : undefined}>{message}</span>
      <button type="button" title={message} onClick={failed ? onRetry : onOpen}>
        {t(failed ? "browserApproval.retry" : "browserApproval.open")}
      </button>
    </aside>
  );
}
