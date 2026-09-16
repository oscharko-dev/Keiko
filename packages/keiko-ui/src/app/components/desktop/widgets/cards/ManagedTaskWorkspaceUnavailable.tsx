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
  const unpaired = props.access === "unpaired";
  const title = unpaired
    ? t("editor.taskWorkspaceAccess.unpairedTitle")
    : t("editor.taskWorkspaceAccess.title");
  let description = t("editor.taskWorkspaceAccess.description");
  if (checking) description = t("editor.taskWorkspaceAccess.checkingDescription");
  else if (unpaired) description = t("editor.taskWorkspaceAccess.unpairedDescription");
  return (
    <div className={styles.root} role="note" aria-label={title}>
      <span className={styles.icon} aria-hidden="true">
        <BranchIcon size={20} />
      </span>
      <span className={styles.copy}>
        <strong>{checking ? t("editor.taskWorkspaceAccess.checking") : title}</strong>
        <span>{description}</span>
      </span>
      {checking || unpaired ? null : (
        <button type="button" className={styles.button} onClick={props.onRetry}>
          {t("editor.taskWorkspaceAccess.retry")}
        </button>
      )}
    </div>
  );
}
