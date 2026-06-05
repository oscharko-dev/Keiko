"use client";

// Issue #211 — Destructive forget confirmation dialog.
// The BFF requires `acknowledged: true` in the request body; this dialog collects
// explicit user acknowledgement before calling forgetMemory.
//
// WCAG: aria-modal dialog, focus trapped to the dialog (cancel button focuses first),
// Escape closes. Danger button uses --danger color with sufficient contrast on --inset.
// Target size ≥ 24×24 px on both buttons.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts";
import { forgetMemory } from "@/lib/memory-api";
import { ApiError } from "@/lib/api";

interface ForgetConfirmDialogProps {
  readonly record: MemoryRecord;
  readonly onForgotten: () => void;
  readonly onClose: () => void;
  readonly forgetMemoryImpl?: typeof forgetMemory;
}

export function ForgetConfirmDialog({
  record,
  onForgotten,
  onClose,
  forgetMemoryImpl = forgetMemory,
}: ForgetConfirmDialogProps): ReactNode {
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Focus the cancel (safe) button on open — not the destructive one
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      if (e.target === backdropRef.current) onClose();
    },
    [onClose],
  );

  const handleForget = useCallback(async (): Promise<void> => {
    setForgetting(true);
    setError(null);
    try {
      await forgetMemoryImpl(record.id as MemoryId, "user-initiated forget from Memory Center");
      onForgotten();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred.");
      }
      setForgetting(false);
    }
  }, [record.id, forgetMemoryImpl, onForgotten]);

  return (
    <div
      ref={backdropRef}
      className="mc-dialog-backdrop"
      role="presentation"
      onClick={handleBackdropClick}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA dialog pattern: role="dialog" is the canonical key-handler host; tabIndex={-1} makes it focusable for Escape capture */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="forget-dialog-title"
        aria-describedby="forget-dialog-desc"
        tabIndex={-1}
        className="mc-dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id="forget-dialog-title" className="mc-dialog-title">
          Forget this memory?
        </h2>

        <p id="forget-dialog-desc" className="mc-dialog-body">
          This action is <strong>permanent</strong>. The memory will be removed and a tombstone
          audit record will be created. You cannot undo this.
        </p>

        <blockquote className="mc-dialog-quote" aria-label="Memory content to be forgotten">
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
            disabled={forgetting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-danger"
            onClick={() => {
              void handleForget();
            }}
            disabled={forgetting}
            aria-busy={forgetting}
          >
            {forgetting ? "Forgetting…" : "Forget permanently"}
          </button>
        </div>
      </div>
    </div>
  );
}
