"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { WorkspaceTrustReason, WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { useTranslate } from "@/lib/i18n";
import { useDialogTabTrap } from "../hooks/useDialogTabTrap";
import styles from "./WorkspaceTrust.module.css";

export type WorkspaceTrustSurface = "editor" | "commands" | "languages";
export type WorkspaceTrustDecision = "grant" | "revoke";

const REASON_KEYS: Readonly<Record<WorkspaceTrustReason, MessageKey>> = {
  "human-grant": "workspaceTrust.reason.humanGrant",
  "human-revocation": "workspaceTrust.reason.humanRevocation",
  "identity-changed": "workspaceTrust.reason.identityChanged",
  "manifest-changed": "workspaceTrust.reason.manifestChanged",
  "trust-basis-changed": "workspaceTrust.reason.trustBasisChanged",
  policy: "workspaceTrust.reason.policy",
  "state-unavailable": "workspaceTrust.reason.stateUnavailable",
};

const SURFACE_KEYS: Readonly<Record<WorkspaceTrustSurface, MessageKey>> = {
  editor: "workspaceTrust.banner.editor",
  commands: "workspaceTrust.banner.commands",
  languages: "workspaceTrust.banner.languages",
};

export function workspaceTrustReasonKey(reason: WorkspaceTrustReason): MessageKey {
  return REASON_KEYS[reason];
}

export function WorkspaceTrustBanner({
  status,
  issue,
  surface,
  onManage,
  editor = false,
}: {
  readonly status: WorkspaceTrustStatus | undefined;
  readonly issue: "load" | "update" | undefined;
  readonly surface: WorkspaceTrustSurface;
  readonly onManage?: (() => void) | undefined;
  readonly editor?: boolean | undefined;
}): ReactNode {
  const t = useTranslate();
  if (status?.trust === "trusted") return null;
  const reason =
    status === undefined
      ? t("workspaceTrust.reason.stateUnavailable")
      : t(workspaceTrustReasonKey(status.reason));
  return (
    <div
      role="note"
      className={`${styles.cmpBanner} ${editor ? styles.cmpEditorBanner : ""}`}
      aria-label={t("workspaceTrust.restrictedMode")}
      data-testid={`workspace-trust-banner-${surface}`}
    >
      <div className={styles.cmpBannerCopy}>
        <div className={styles.cmpBannerTitle}>{t("workspaceTrust.restrictedMode")}</div>
        <p className={styles.cmpBannerReason}>{reason}</p>
        <p className={styles.cmpBannerReason}>{t(SURFACE_KEYS[surface])}</p>
        {issue === "update" ? (
          <p className={styles.cmpBannerReason} role="alert">
            {t("workspaceTrust.updateFailed")}
          </p>
        ) : null}
      </div>
      {onManage === undefined ? null : (
        <button type="button" className={styles.cmpButton} onClick={onManage}>
          {t("workspaceTrust.manage")}
        </button>
      )}
    </div>
  );
}

export function WorkspaceTrustDecisionDialog({
  action,
  initialPrompt,
  mutating,
  onCancel,
  onConfirm,
}: {
  readonly action: WorkspaceTrustDecision;
  readonly initialPrompt: boolean;
  readonly mutating: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<boolean>;
}): ReactNode {
  const t = useTranslate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogTabTrap(dialogRef);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !mutating) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mutating, onCancel]);

  const title =
    action === "grant"
      ? t("workspaceTrust.dialog.grantTitle")
      : t("workspaceTrust.dialog.revokeTitle");
  const description =
    action === "grant"
      ? t("workspaceTrust.dialog.grantBody")
      : t("workspaceTrust.dialog.revokeBody");
  return (
    <div className={styles.cmpDialogBackdrop}>
      <div
        className={styles.cmpDialog}
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="workspace-trust-dialog-title"
        aria-describedby="workspace-trust-dialog-description"
        tabIndex={-1}
      >
        <h2 className={styles.cmpDialogTitle} id="workspace-trust-dialog-title">
          {title}
        </h2>
        <p className={styles.cmpIntro} id="workspace-trust-dialog-description">
          {description}
        </p>
        <p className={styles.cmpHelp}>{t("workspaceTrust.dialog.serverConfirmed")}</p>
        <div className={styles.cmpDialogActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.cmpButton}
            disabled={mutating}
            onClick={onCancel}
          >
            {initialPrompt
              ? t("workspaceTrust.dialog.stayRestricted")
              : t("workspaceTrust.dialog.cancel")}
          </button>
          <button
            type="button"
            className={`${styles.cmpButton} ${
              action === "grant" ? styles.cmpPrimary : styles.cmpDanger
            }`}
            disabled={mutating}
            onClick={() => {
              void onConfirm();
            }}
          >
            {mutating
              ? t("workspaceTrust.dialog.waiting")
              : action === "grant"
                ? t("workspaceTrust.dialog.trust")
                : t("workspaceTrust.dialog.revoke")}
          </button>
        </div>
      </div>
    </div>
  );
}
