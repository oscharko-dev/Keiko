"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { BrowserApprovalDialog } from "./BrowserApprovalDialog";
import { useBrowserApprovalInventory } from "./useBrowserApprovalInventory";
import styles from "./BrowserApproval.module.css";

export function BrowserApprovalNotice(): ReactNode {
  const t = useTranslate();
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
        <aside className={styles.cmpNotice} aria-label={t("browserApproval.title")}>
          <span>{t(inventory.failed ? "browserApproval.failed" : "browserApproval.notice")}</span>
          <button
            type="button"
            onClick={inventory.failed ? inventory.refresh : (): void => setOpen(true)}
          >
            {t(inventory.failed ? "browserApproval.retry" : "browserApproval.open")}
          </button>
        </aside>
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
