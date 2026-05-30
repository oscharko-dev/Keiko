"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reusable small confirm dialog using the native <dialog> element.
 * showModal() gives focus trap + ESC close natively.
 * Focus returns to the triggering element via the onCancel/onConfirm callbacks.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = "confirm-dialog-title";

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (!el.open) {
      el.showModal();
    }
    // ESC closes via native dialog behavior; we hook cancel event to sync state
    function handleCancel(e: Event): void {
      e.preventDefault();
      onCancel();
    }
    el.addEventListener("cancel", handleCancel);
    return () => {
      el.removeEventListener("cancel", handleCancel);
    };
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="rounded-lg bg-panel p-6 shadow-xl backdrop:bg-canvas/60
        focus:outline-none"
      style={{ border: "1px solid #3a4052", minWidth: "20rem", maxWidth: "28rem" }}
    >
      <h2 id={titleId} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      <p className="mt-2 text-xs text-ink-muted">{description}</p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-ink-muted
            hover:bg-elevated hover:text-ink
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-red-700 px-3 py-1.5 text-xs text-white
            hover:bg-red-600
            focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export default ConfirmDialog;
