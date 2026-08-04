"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceTrustReason, WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import type { MessageKey } from "@/lib/i18n-messages.en";
import { useTranslate } from "@/lib/i18n";
import type { WorkspaceTrustFailure } from "@/lib/workspace-trust-api";
import { useDialogTabTrap } from "../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../hooks/useModalInteractionLock";
import styles from "./WorkspaceTrust.module.css";

function confirmButtonLabel(
  t: ReturnType<typeof useTranslate>,
  mutating: boolean,
  action: "grant" | "revoke",
): string {
  if (mutating) return t("workspaceTrust.dialog.waiting");
  return action === "grant" ? t("workspaceTrust.dialog.trust") : t("workspaceTrust.dialog.revoke");
}

function bannerTitle(
  t: ReturnType<typeof useTranslate>,
  state: { readonly unavailable: boolean; readonly trusted: boolean },
): string {
  if (state.unavailable) return t("workspaceTrust.unavailable");
  return state.trusted ? t("workspaceTrust.trustedMode") : t("workspaceTrust.restrictedMode");
}

export type WorkspaceTrustSurface = "editor" | "commands" | "languages";
export type WorkspaceTrustDecision = "grant" | "revoke";
type WorkspaceTrustIssue = "load" | "update";
type WorkspaceTrustBadgeState = "trusted" | "restricted" | "unavailable";

const REASON_KEYS: Readonly<Record<WorkspaceTrustReason, MessageKey>> = {
  "human-grant": "workspaceTrust.reason.humanGrant",
  "derived-from-trusted-root": "workspaceTrust.reason.derivedFromTrustedRoot",
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

export function WorkspaceTrustFailureDetails({
  failure,
}: {
  readonly failure: WorkspaceTrustFailure | undefined;
}): ReactNode {
  const t = useTranslate();
  if (failure === undefined) return null;
  return (
    <p className={styles.cmpFailureDetails} data-testid="workspace-trust-failure-details">
      <span>{t("workspaceTrust.errorCode", { code: failure.code })}</span>
      {failure.correlationId === undefined ? null : (
        <span>{t("workspaceTrust.supportId", { correlationId: failure.correlationId })}</span>
      )}
    </p>
  );
}

function workspaceTrustBadgeState(
  status: WorkspaceTrustStatus | undefined,
  issue: WorkspaceTrustIssue | undefined,
): WorkspaceTrustBadgeState {
  if (issue === "load") return "unavailable";
  return status?.trust === "trusted" ? "trusted" : "restricted";
}

function workspaceTrustBadgeLabel(
  trust: WorkspaceTrustBadgeState,
  t: ReturnType<typeof useTranslate>,
): string {
  switch (trust) {
    case "unavailable":
      return t("workspaceTrust.unavailable");
    case "trusted":
      return t("workspaceTrust.trustedMode");
    case "restricted":
      return t("workspaceTrust.restrictedMode");
  }
}

export function WorkspaceTrustBadge({
  status,
  issue,
}: {
  readonly status: WorkspaceTrustStatus | undefined;
  readonly issue?: WorkspaceTrustIssue | undefined;
}): ReactNode {
  const t = useTranslate();
  const trust = workspaceTrustBadgeState(status, issue);
  const label = workspaceTrustBadgeLabel(trust, t);
  return (
    <span className={styles.cmpBadge} data-trust={trust} aria-label={label}>
      {label}
    </span>
  );
}

export function WorkspaceTrustBanner({
  status,
  issue,
  failure,
  surface,
  onManage,
  editor = false,
}: {
  readonly status: WorkspaceTrustStatus | undefined;
  readonly issue: WorkspaceTrustIssue | undefined;
  readonly failure?: WorkspaceTrustFailure | undefined;
  readonly surface: WorkspaceTrustSurface;
  readonly onManage?: (() => void) | undefined;
  readonly editor?: boolean | undefined;
}): ReactNode {
  const t = useTranslate();
  const trust = workspaceTrustBadgeState(status, issue);
  const trusted = trust === "trusted";
  // A trusted workspace renders nothing — unless a transition was refused. The guard used to send
  // every trusted state home before the `issue === "update"` alert below could run, which made a
  // failed REVOKE completely silent: the human asked to withdraw trust, the server refused, and the
  // UI showed a still-trusted workspace with no indication the request had not been applied.
  if (trusted && issue === undefined) return null;
  const unavailable = trust === "unavailable";
  const title = bannerTitle(t, { unavailable, trusted });
  const reason =
    status === undefined
      ? t("workspaceTrust.reason.stateUnavailable")
      : t(workspaceTrustReasonKey(status.reason));
  return (
    <div
      role="note"
      className={`${styles.cmpBanner} ${editor ? styles.cmpEditorBanner : ""}`}
      aria-label={title}
      data-trust={trust}
      data-testid={`workspace-trust-banner-${surface}`}
    >
      <div className={styles.cmpBannerCopy}>
        <div className={styles.cmpBannerTitle}>{title}</div>
        {unavailable ? (
          <p className={styles.cmpBannerReason}>{t("workspaceTrust.loadFailed")}</p>
        ) : (
          <p className={styles.cmpBannerReason}>{reason}</p>
        )}
        <p className={styles.cmpBannerReason}>{t(SURFACE_KEYS[surface])}</p>
        {issue === "update" ? (
          <p className={styles.cmpBannerReason} role="alert">
            {/* Direction-aware: the shared copy asserts the workspace "remains restricted", which is
                false for a refused revoke and would tell the human the opposite of what happened. */}
            {t(trusted ? "workspaceTrust.updateFailedTrusted" : "workspaceTrust.updateFailed")}
          </p>
        ) : null}
        <WorkspaceTrustFailureDetails failure={failure} />
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
  useModalInteractionLock({ initialFocusRef: cancelRef });
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
  const dialog = (
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
            {confirmButtonLabel(t, mutating, action)}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
