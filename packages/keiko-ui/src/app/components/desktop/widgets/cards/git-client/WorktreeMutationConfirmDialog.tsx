"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import { useDialogTabTrap } from "../../../hooks/useDialogTabTrap";
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
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDialogTabTrap(dialogRef);
  const branchSwitch = request.kind === "branch-switch";
  const label = branchSwitch
    ? t("gitClientWindow.confirm.branchSwitch.title")
    : t("gitClientWindow.confirm.pull.title");

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) dialogRef.current?.focus();
    });
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      active = false;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  const dialog = (
    <dialog
      open
      ref={dialogRef}
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        width: "auto",
        height: "auto",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: 0,
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
        <p style={{ margin: 0, color: "var(--fg-muted)" }}>
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
    </dialog>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
