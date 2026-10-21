"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { useDialogTabTrap } from "../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../hooks/useModalInteractionLock";
import { useBrowserApproval, type BrowserApprovalController } from "./useBrowserApproval";
import styles from "./BrowserApproval.module.css";

interface DialogProps {
  readonly onClose: () => void;
}

function useEscapeClose(ref: { current: HTMLElement | null }, close: () => void): void {
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    const element = ref.current;
    element?.addEventListener("keydown", handle);
    return (): void => element?.removeEventListener("keydown", handle);
  }, [ref, close]);
}

export function BrowserApprovalDialog({ onClose }: DialogProps): ReactNode {
  const t = useTranslate();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const approval = useBrowserApproval();
  useDialogTabTrap(dialog);
  useModalInteractionLock({ initialFocusRef: dialog });
  useEscapeClose(dialog, onClose);
  return createPortal(
    <div className={styles.cmpBackdrop}>
      <dialog
        open
        ref={dialog}
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className={styles.cmpDialog}
      >
        <header className={styles.cmpHeading}>
          <h2 id={id}>{t("browserApproval.title")}</h2>
          <button type="button" onClick={onClose}>
            {t("browserApproval.close")}
          </button>
        </header>
        <ApprovalContent approval={approval} />
      </dialog>
    </div>,
    document.body,
  );
}

function ApprovalContent({
  approval,
}: {
  readonly approval: BrowserApprovalController;
}): ReactNode {
  const t = useTranslate();
  const { view } = approval;
  if (view.phase === "active")
    return (
      <p>
        <output>{t(`browserApproval.success.${view.persistence}`)}</output>
      </p>
    );
  if (view.phase === "pending" || view.phase === "failed")
    return (
      <section aria-live="polite">
        <p>{t("browserApproval.compare")}</p>
        <output className={styles.cmpCode} aria-label={t("browserApproval.code")}>
          {view.request.comparisonCode}
        </output>
        <p>{t("browserApproval.instructions")}</p>
        <p className={styles.cmpMetadata}>{t("browserApproval.expiresSoon")}</p>
        {view.phase === "failed" ? (
          <>
            <p role="alert">{t("browserApproval.failed")}</p>
            <button
              type="button"
              onClick={() => {
                void approval.retry();
              }}
            >
              {t("browserApproval.retry")}
            </button>
          </>
        ) : (
          <p>
            <output>{t("browserApproval.waiting")}</output>
          </p>
        )}
      </section>
    );
  return <ApprovalRequest approval={approval} />;
}

function ApprovalRequest({
  approval,
}: {
  readonly approval: BrowserApprovalController;
}): ReactNode {
  const t = useTranslate();
  const [remember, setRemember] = useState(false);
  const { phase } = approval.view;
  return (
    <section>
      <p>{t("browserApproval.description")}</p>
      <p>{t("browserApproval.launcherFallback")}</p>
      {phase === "unavailable" || phase === "expired" ? (
        <p role="alert">{t(`browserApproval.${phase}`)}</p>
      ) : null}
      <label className={styles.cmpRemember}>
        <input
          type="checkbox"
          checked={remember}
          disabled={phase === "working"}
          onChange={(event) => setRemember(event.target.checked)}
        />
        {t("browserApproval.remember")}
      </label>
      <button
        type="button"
        disabled={phase === "working"}
        onClick={() => {
          void approval.begin(remember);
        }}
      >
        {t(phase === "working" ? "browserApproval.working" : "browserApproval.request")}
      </button>
    </section>
  );
}
