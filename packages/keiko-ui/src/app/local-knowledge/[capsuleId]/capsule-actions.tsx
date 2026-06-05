"use client";

// Issue #198 — Destructive-action buttons for the capsule detail page.
// Three actions: Delete, Refresh changed files, Repair failed files.
// Each is gated behind a confirmation modal (aria-modal="true", focus-trapped).
// Delete requires typing the capsule display name before confirming (Foundry IQ pattern).
// Refresh and Repair use a single "Are you sure?" step.
//
// Focus trap: Tab/Shift+Tab cycle within the dialog; Escape cancels.
// WCAG: min 30×30 button targets, focus-visible ring, colour tokens for danger text.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  deleteCapsule,
  refreshCapsuleChangedFiles,
  repairCapsuleFailedFiles,
} from "@/lib/local-knowledge-api";
import type { CapsuleActionResponse } from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActionKind = "delete" | "refresh" | "repair";

interface ConfirmState {
  readonly kind: ActionKind;
  readonly nameInput: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

function actionTitle(kind: ActionKind): string {
  if (kind === "delete") return "Delete capsule";
  if (kind === "refresh") return "Refresh changed files";
  return "Repair failed files";
}

function actionDescription(kind: ActionKind, capsuleDisplayName: string): string {
  if (kind === "delete") {
    return `This permanently deletes the capsule index. The source files on disk are NOT deleted. Type "${capsuleDisplayName}" to confirm.`;
  }
  if (kind === "refresh") {
    return "This runs an incremental refresh. Unchanged files stay in place, changed files are re-indexed, and removed files are cleaned up.";
  }
  return "This retries files that previously failed indexing and also picks up any newly changed files in the same incremental pass.";
}

function confirmButtonLabel(kind: ActionKind, busy: boolean): string {
  if (busy) return "Working…";
  if (kind === "delete") return "Delete";
  if (kind === "refresh") return "Refresh";
  return "Repair";
}

// ---------------------------------------------------------------------------
// Focus-trap hook (mirrors GatewaySetupDialog pattern)
// ---------------------------------------------------------------------------

function useFocusTrap(
  dialogRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;

    // Move focus into the dialog on mount
    const firstFocusable = dialog.querySelector<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
    );
    firstFocusable?.focus();

    // Capture the narrowed non-null reference so the inner handler can use it
    // without TypeScript losing the narrowing across the closure boundary.
    const narrowedDialog: HTMLDivElement = dialog;

    function focusablesIn(root: HTMLDivElement): readonly HTMLElement[] {
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
        ),
      );
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesIn(narrowedDialog);
      if (focusables.length === 0) return;
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    narrowedDialog.addEventListener("keydown", handleKeyDown);
    return () => narrowedDialog.removeEventListener("keydown", handleKeyDown);
  }, [active, dialogRef, onEscape]);
}

// ---------------------------------------------------------------------------
// ConfirmModal
// ---------------------------------------------------------------------------

interface ConfirmModalProps {
  readonly kind: ActionKind;
  readonly capsuleDisplayName: string;
  readonly nameInput: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onNameChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function ConfirmModal({
  kind,
  capsuleDisplayName,
  nameInput,
  busy,
  error,
  onNameChange,
  onConfirm,
  onCancel,
}: ConfirmModalProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  useFocusTrap(dialogRef, true, onCancel);

  // Auto-focus the confirmation input when the modal opens. Done via ref + effect (not
  // autoFocus) so the focus only fires when the dialog mounts and not on every re-render —
  // satisfies jsx-a11y/no-autofocus while preserving the "type the capsule name" flow.
  useEffect(() => {
    if (kind === "delete" && confirmInputRef.current !== null) {
      confirmInputRef.current.focus();
    }
  }, [kind]);

  const requiresTypedName = kind === "delete";
  const confirmEnabled = !busy && (!requiresTypedName || nameInput === capsuleDisplayName);

  const titleId = "lkd-confirm-title";
  const descId = "lkd-confirm-desc";

  return (
    <div
      className="dlg-overlay in"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="dlg"
      >
        <div className="dlg-head">
          <div className="dlg-htext">
            <div id={titleId} className="dlg-title">
              {actionTitle(kind)}
            </div>
            <div id={descId} className="dlg-sub">
              {actionDescription(kind, capsuleDisplayName)}
            </div>
          </div>
        </div>

        {requiresTypedName ? (
          <div className="dlg-body">
            <div className="dlg-field">
              <label htmlFor="lkd-confirm-name-input" className="dlg-label">
                Type the capsule name to confirm
              </label>
              <input
                id="lkd-confirm-name-input"
                type="text"
                className="dlg-input"
                value={nameInput}
                autoComplete="off"
                ref={confirmInputRef}
                disabled={busy}
                placeholder={capsuleDisplayName}
                aria-label={`Type "${capsuleDisplayName}" to confirm deletion`}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onNameChange(e.target.value)}
              />
            </div>
            {error !== null ? (
              <div role="alert" className="lk-alert" style={{ marginTop: 4 }}>
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="dlg-body">
            {error !== null ? (
              <div role="alert" className="lk-alert">
                {error}
              </div>
            ) : null}
          </div>
        )}

        <div className="dlg-foot">
          <button type="button" className="dlg-btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="dlg-btn lkd-btn-destructive"
            disabled={!confirmEnabled}
            aria-disabled={!confirmEnabled}
            onClick={onConfirm}
          >
            {confirmButtonLabel(kind, busy)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapsuleActions — root export
// ---------------------------------------------------------------------------

export interface CapsuleActionsProps {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly capsuleDisplayName: string;
  readonly onActionComplete: () => void;
  // Injectable seams for tests
  readonly deleteCapsuleImpl?: typeof deleteCapsule;
  readonly refreshCapsuleImpl?: typeof refreshCapsuleChangedFiles;
  readonly repairCapsuleImpl?: typeof repairCapsuleFailedFiles;
}

export function CapsuleActions({
  capsuleId,
  capsuleDisplayName,
  onActionComplete,
  deleteCapsuleImpl = deleteCapsule,
  refreshCapsuleImpl = refreshCapsuleChangedFiles,
  repairCapsuleImpl = repairCapsuleFailedFiles,
}: CapsuleActionsProps): ReactNode {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function openModal(kind: ActionKind): void {
    setActionError(null);
    setConfirm({ kind, nameInput: "" });
  }

  function handleCancel(): void {
    if (busy) return;
    setConfirm(null);
    setActionError(null);
  }

  function handleNameChange(value: string): void {
    setConfirm((prev) => (prev !== null ? { ...prev, nameInput: value } : null));
  }

  async function runAction(action: () => Promise<CapsuleActionResponse>): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setConfirm(null);
      onActionComplete();
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  function handleConfirm(): void {
    if (confirm === null || busy) return;
    const { kind } = confirm;
    if (kind === "delete") {
      void runAction(() => deleteCapsuleImpl(capsuleId));
    } else if (kind === "refresh") {
      void runAction(() => refreshCapsuleImpl(capsuleId));
    } else {
      void runAction(() => repairCapsuleImpl(capsuleId));
    }
  }

  return (
    <>
      <div
        role="group"
        aria-label={`Actions for capsule ${capsuleDisplayName}`}
        className="lkd-actions-group"
      >
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-label={`Refresh changed files for capsule ${capsuleDisplayName}`}
          onClick={() => openModal("refresh")}
        >
          Refresh changed files
        </button>
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-label={`Repair failed files for capsule ${capsuleDisplayName}`}
          onClick={() => openModal("repair")}
        >
          Repair failed files
        </button>
        <button
          type="button"
          className="lk-btn lk-btn-danger"
          aria-label={`Delete capsule ${capsuleDisplayName}`}
          onClick={() => openModal("delete")}
        >
          Delete
        </button>
      </div>

      {confirm !== null ? (
        <ConfirmModal
          kind={confirm.kind}
          capsuleDisplayName={capsuleDisplayName}
          nameInput={confirm.nameInput}
          busy={busy}
          error={actionError}
          onNameChange={handleNameChange}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : null}
    </>
  );
}
