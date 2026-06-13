"use client";

// Issue #211 — Destructive confirmation dialog for forget and delete flows.
//
// WCAG: aria-modal dialog, focus trapped to the dialog (cancel button focuses first),
// Escape closes. Danger button uses --danger color with sufficient contrast on --inset.
// Target size ≥ 24×24 px on both buttons.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { deleteMemory, forgetMemory } from "@/lib/memory-api";
import { formatError } from "./format-error";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

interface ForgetConfirmDialogProps {
  readonly record: MemoryRecord;
  readonly mode?: "forget" | "delete";
  readonly onComplete: () => void;
  readonly onClose: () => void;
  readonly forgetMemoryImpl?: typeof forgetMemory;
  readonly deleteMemoryImpl?: typeof deleteMemory;
}

export function ForgetConfirmDialog({
  record,
  mode = "forget",
  onComplete,
  onClose,
  forgetMemoryImpl = forgetMemory,
  deleteMemoryImpl = deleteMemory,
}: ForgetConfirmDialogProps): ReactNode {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const isDeleteMode = mode === "delete";

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable === undefined || focusable.length === 0) {
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  const handleConfirm = useCallback(async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      if (isDeleteMode) {
        await deleteMemoryImpl(record.id as MemoryId, "user-initiated delete from MemoriaViva");
      } else {
        await forgetMemoryImpl(record.id as MemoryId, "user-initiated forget from MemoriaViva");
      }
      onComplete();
    } catch (err) {
      setError(formatError(err));
      setSubmitting(false);
    }
  }, [deleteMemoryImpl, forgetMemoryImpl, isDeleteMode, onComplete, record.id]);

  return (
    <div
      ref={backdropRef}
      className="mc-dialog-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA dialog pattern: role="dialog" is the canonical key-handler host; tabIndex={-1} makes it focusable for Escape capture */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forget-dialog-title"
        aria-describedby="forget-dialog-desc"
        tabIndex={-1}
        className="mc-dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id="forget-dialog-title" className="mc-dialog-title">
          {isDeleteMode ? "Delete this memory?" : "Forget this memory?"}
        </h2>

        <p id="forget-dialog-desc" className="mc-dialog-body">
          {isDeleteMode ? (
            <>
              This action is <strong>permanent</strong>. The memory will be removed and a tombstone
              audit record will be created. You cannot undo this.
            </>
          ) : (
            <>
              This action is <strong>permanent</strong>. The memory will be removed and a tombstone
              audit record will be created. You cannot undo this.
            </>
          )}
        </p>

        <blockquote className="mc-dialog-quote" aria-label="Memory content to be removed">
          {record.body.length > 120 ? `${record.body.slice(0, 120)}…` : record.body}
        </blockquote>

        {error !== null ? (
          <p role="alert" className="mc-dialog-error">
            {error}
          </p>
        ) : null}

        <div className="mc-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="lk-btn lk-btn-ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-danger"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting
              ? isDeleteMode
                ? "Deleting…"
                : "Forgetting…"
              : isDeleteMode
                ? "Delete permanently"
                : "Forget permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}
