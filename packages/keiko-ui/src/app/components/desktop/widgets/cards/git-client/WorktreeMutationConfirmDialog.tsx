"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { useDialogTabTrap } from "../../../hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../../../hooks/useModalInteractionLock";
import { PRIMARY_BTN, SECONDARY_BTN } from "./git-client-styles";

export type WorktreeMutationConfirmation =
  { readonly kind: "branch-switch"; readonly branchName: string } | { readonly kind: "pull" };

interface WorktreeMutationConfirmDialogProps {
  readonly request: WorktreeMutationConfirmation;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function WorktreeMutationConfirmDialog({
  request,
  onCancel,
  onConfirm,
}: WorktreeMutationConfirmDialogProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  // KEIKO-0228: drop the native <dialog open> shell — it advertised aria-modal="true" without any
  // of the modality machinery showModal() promises (jsdom does not implement showModal at all).
  // Use the div+role="alertdialog"+useDialogTabTrap pattern the three sibling dialogs already ship.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogTabTrap(dialogRef);
  useModalInteractionLock({ initialFocusRef: dialogRef });
  const descriptionId = useId();
  const branchSwitch = request.kind === "branch-switch";
  const label = branchSwitch
    ? t("gitClientWindow.confirm.branchSwitch.title")
    : t("gitClientWindow.confirm.pull.title");

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  const dialog = (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={label}
      aria-describedby={descriptionId}
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "grid",
        placeItems: "center",
        background: "color-mix(in oklch, var(--surface-primary) 45%, transparent)",
      }}
    >
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          width: "min(440px, calc(100vw - 48px))",
          padding: "var(--space-5)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-lg)",
          background: "var(--surface-primary)",
          boxShadow: "var(--shadow-pop)",
        }}
      >
        <h2 style={{ margin: 0, font: "var(--weight-semibold) var(--text-body) var(--font-ui)" }}>
          {label}
        </h2>
        <p id={descriptionId} style={{ margin: 0, color: "var(--fg-muted)" }}>
          {branchSwitch
            ? t("gitClientWindow.confirm.branchSwitch.body", { branch: request.branchName })
            : t("gitClientWindow.confirm.pull.body")}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)" }}>
          <button type="button" style={SECONDARY_BTN} onClick={onCancel}>
            {t("gitClientWindow.confirm.cancel")}
          </button>
          <button type="button" style={PRIMARY_BTN} onClick={onConfirm}>
            {branchSwitch
              ? t("gitClientWindow.confirm.branchSwitch.action")
              : t("gitClientWindow.confirm.pull.action")}
          </button>
        </div>
      </section>
    </div>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
