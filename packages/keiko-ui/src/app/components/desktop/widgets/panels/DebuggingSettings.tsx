"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  DebugActivationReasonCode,
  DebugActivationSummary,
} from "@oscharko-dev/keiko-contracts";
import styles from "./DebuggingSettings.module.css";
import { type DebuggingTranslate, useDebuggingTranslate as useTranslate } from "./debugging-i18n";
import { useDebuggingSettings } from "./useDebuggingSettings";

type PanelState = DebugActivationSummary["state"] | "unavailable";

function stateFor(summary: DebugActivationSummary | undefined): PanelState {
  return summary?.state ?? "unavailable";
}

function stateLabel(state: PanelState, t: DebuggingTranslate): string {
  if (state === "disabled") return t("stateDisabled");
  if (state === "disabledByPolicy") return t("stateDisabledByPolicy");
  if (state === "notProvisioned") return t("stateNotProvisioned");
  if (state === "available") return t("stateAvailable");
  return t("stateUnavailable");
}

function reasonLabel(reason: DebugActivationReasonCode | undefined, t: DebuggingTranslate): string {
  if (reason === "PRODUCT_UNSUPPORTED") return t("reasonProductUnsupported");
  if (reason === "POLICY_DENIED") return t("reasonPolicyDenied");
  if (reason === "POLICY_UNAVAILABLE") return t("reasonPolicyUnavailable");
  if (reason === "WORKSPACE_DISABLED") return t("reasonWorkspaceDisabled");
  if (reason === "WORKSPACE_ACTIVATION_UNSET") return t("reasonWorkspaceUnset");
  if (reason === "NOT_PROVISIONED") return t("reasonNotProvisioned");
  if (reason === "AVAILABLE") return t("reasonAvailable");
  return t("reasonUnavailable");
}

function guidance(summary: DebugActivationSummary | undefined, t: DebuggingTranslate): string {
  const reason = summary?.reasonCode;
  if (reason === "PRODUCT_UNSUPPORTED") return t("guidanceProductUnsupported");
  if (reason === "POLICY_DENIED" || reason === "POLICY_UNAVAILABLE") return t("guidancePolicy");
  if (reason === "WORKSPACE_DISABLED" || reason === "WORKSPACE_ACTIVATION_UNSET")
    return t("guidanceOptIn");
  if (reason === "NOT_PROVISIONED") return t("guidanceProvisioning");
  if (reason === "AVAILABLE") return t("guidanceAvailable");
  return t("guidanceUnavailable");
}

function issueLabel(issue: "load" | "mutation" | "conflict", t: DebuggingTranslate): string {
  return issue === "load" ? t("loadFailed") : t("mutationFailed");
}

export function DebuggingSettings({ root }: { readonly root?: string | undefined }): ReactNode {
  const t = useTranslate();
  const view = useDebuggingSettings(root);
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLInputElement>(null);
  const wasConfirmingRef = useRef(false);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirmingRef.current) openerRef.current?.focus();
    wasConfirmingRef.current = confirming;
  }, [confirming]);

  const submitToggle = (next: boolean): void => {
    if (!next) {
      setConfirming(true);
      return;
    }
    void view.setEnabled(true);
  };

  const confirmDisable = (): void => {
    setConfirming(false);
    void view.setEnabled(false);
  };

  const state = stateFor(view.summary);
  const controlDisabled = !(view.enabled ? view.canDisable : view.canEnable);
  return (
    <section className={styles.section} aria-labelledby="debugging-settings-title">
      <header className={styles.header}>
        <h3 className={styles.title} id="debugging-settings-title">
          {t("title")}
        </h3>
        <p className={styles.description}>{t("description")}</p>
      </header>
      <output className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {view.mutating ? t("applying") : ""}
        {view.announcement.length > 0 && view.enabled ? t("appliedEnable") : ""}
        {view.announcement.length > 0 && !view.enabled ? t("appliedDisable") : ""}
      </output>
      {root === undefined ? <p className={styles.empty}>{t("noWorkspace")}</p> : null}
      {root !== undefined && view.loading && view.summary === undefined ? (
        <p className={styles.empty} role="status">
          {t("loading")}
        </p>
      ) : null}
      {view.issue === undefined ? null : (
        <div className={styles.alert} role="alert">
          <span>{issueLabel(view.issue, t)}</span>
          <button type="button" className={styles.button} onClick={() => void view.refresh()}>
            {t("retry")}
          </button>
        </div>
      )}
      {root === undefined ? null : (
        <article className={styles.card} aria-labelledby="debugging-state-title">
          <div className={styles.cardHeader}>
            <div className={styles.copy}>
              <div className={styles.title} id="debugging-state-title">
                {t("title")}
              </div>
              <p className={styles.reason}>{reasonLabel(view.summary?.reasonCode, t)}</p>
            </div>
            <output className={styles.state} data-state={state}>
              {stateLabel(state, t)}
            </output>
          </div>
          <p className={styles.guidance}>{guidance(view.summary, t)}</p>
          <div className={styles.optIn}>
            <div className={styles.copy}>
              <label className={styles.optInLabel} htmlFor="debugging-workspace-opt-in">
                {t("optInLabel")}
              </label>
              <p className={styles.optInHelp} id="debugging-workspace-opt-in-help">
                {t("optInHelp")}
              </p>
            </div>
            <input
              ref={openerRef}
              className={styles.toggle}
              id="debugging-workspace-opt-in"
              type="checkbox"
              role="switch"
              aria-describedby="debugging-workspace-opt-in-help"
              checked={view.enabled}
              disabled={controlDisabled || view.mutating}
              onChange={(event) => submitToggle(event.target.checked)}
            />
          </div>
        </article>
      )}
      {!confirming ? null : (
        <div className={styles.dialogBackdrop}>
          <div
            className={styles.dialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="debugging-confirm-title"
            aria-describedby="debugging-confirm-body"
          >
            <div className={styles.dialogTitle} id="debugging-confirm-title">
              {t("confirmTitle")}
            </div>
            <p className={styles.reason} id="debugging-confirm-body">
              {t("confirmBody")}
            </p>
            <div className={styles.dialogActions}>
              <button
                ref={cancelRef}
                type="button"
                className={styles.button}
                onClick={() => setConfirming(false)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.danger}`}
                onClick={confirmDisable}
              >
                {t("confirmDisable")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
