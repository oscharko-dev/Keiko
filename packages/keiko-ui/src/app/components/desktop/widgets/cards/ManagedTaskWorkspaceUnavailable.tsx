"use client";

import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { Icons } from "../../Icons";
import styles from "./ManagedTaskWorkspaceUnavailable.module.css";

const BranchIcon = Icons.branch;

export type ManagedTaskWorkspaceAccess = "checking" | "unpaired" | "unavailable";

export function ManagedTaskWorkspaceUnavailable(props: {
  readonly access: ManagedTaskWorkspaceAccess;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useTranslate();
  const checking = props.access === "checking";
  return (
    <div className={styles.root} role="note" aria-label={t("editor.taskWorkspaceAccess.title")}>
      <span className={styles.icon} aria-hidden="true">
        <BranchIcon size={20} />
      </span>
      <span className={styles.copy}>
        <strong>
          {checking
            ? t("editor.taskWorkspaceAccess.checking")
            : t("editor.taskWorkspaceAccess.title")}
        </strong>
        <span>
          {checking
            ? t("editor.taskWorkspaceAccess.checkingDescription")
            : t("editor.taskWorkspaceAccess.description")}
        </span>
      </span>
      {checking ? null : (
        <button type="button" className={styles.button} onClick={props.onRetry}>
          {t("editor.taskWorkspaceAccess.retry")}
        </button>
      )}
    </div>
  );
}
