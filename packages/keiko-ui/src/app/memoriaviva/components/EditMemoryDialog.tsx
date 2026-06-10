"use client";

// Issue #211 — Inline edit form for memory body, tags, and sensitivity.
// Controlled: caller owns the record; this dialog calls editMemory/correctMemory and reports back.
//
// WCAG: focus is trapped while open, first field receives focus on open, Escape closes.
// focus-visible rings on all interactive elements. aria-modal on the dialog.
// Sensitivity select uses <select> — native keyboard fully accessible.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import type { MemoryId, MemoryRecord, MemorySensitivity } from "@oscharko-dev/keiko-contracts";
import { MEMORY_SENSITIVITIES } from "@oscharko-dev/keiko-contracts";
import { correctMemory, editMemory } from "@/lib/memory-api";
import { ApiError } from "@/lib/api";

const SENSITIVITY_LABELS: Readonly<Record<MemorySensitivity, string>> = {
  public: "Public",
  confidential: "Confidential",
  restricted: "Restricted",
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

interface EditMemoryDialogProps {
  readonly record: MemoryRecord;
  readonly mode?: "edit" | "correct";
  readonly onSave: (updated: MemoryRecord) => void;
  readonly onClose: () => void;
  readonly editMemoryImpl?: typeof editMemory;
  readonly correctMemoryImpl?: typeof correctMemory;
}

export function EditMemoryDialog({
  record,
  mode = "edit",
  onSave,
  onClose,
  editMemoryImpl = editMemory,
  correctMemoryImpl = correctMemory,
}: EditMemoryDialogProps): ReactNode {
  const [body, setBody] = useState(record.body);
  const [tagsRaw, setTagsRaw] = useState(record.tags.join(", "));
  const [sensitivity, setSensitivity] = useState<MemorySensitivity>(record.provenance.sensitivity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const firstRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const isCorrectMode = mode === "correct";

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    firstRef.current?.focus();
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

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      setError("Body cannot be empty.");
      return;
    }

    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    setSaving(true);
    setError(null);
    try {
      if (isCorrectMode) {
        const res = await correctMemoryImpl(record.id as MemoryId, trimmedBody);
        onSave(res.correction);
      } else {
        const res = await editMemoryImpl(record.id as MemoryId, {
          body: trimmedBody,
          tags,
          sensitivity,
        });
        onSave(res.memory);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(`${err.code}: ${err.message}`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred.");
      }
    } finally {
      setSaving(false);
    }
  }, [
    body,
    tagsRaw,
    sensitivity,
    record.id,
    isCorrectMode,
    correctMemoryImpl,
    editMemoryImpl,
    onSave,
  ]);

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
        aria-labelledby={titleId}
        tabIndex={-1}
        className="mc-dialog"
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="mc-dialog-title">
          {isCorrectMode ? "Correct memory" : "Edit memory"}
        </h2>

        <div className="mc-dialog-field">
          <label htmlFor="edit-body" className="mc-dialog-label">
            {isCorrectMode ? "Corrected body" : "Body"}
          </label>
          <textarea
            id="edit-body"
            ref={firstRef}
            className="mc-dialog-textarea"
            value={body}
            rows={5}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              setBody(e.target.value);
            }}
            disabled={saving}
            aria-required="true"
          />
        </div>

        {isCorrectMode ? null : (
          <>
            <div className="mc-dialog-field">
              <label htmlFor="edit-tags" className="mc-dialog-label">
                Tags <span className="mc-dialog-hint">(comma-separated)</span>
              </label>
              <input
                id="edit-tags"
                type="text"
                className="mc-dialog-input"
                value={tagsRaw}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setTagsRaw(e.target.value);
                }}
                disabled={saving}
              />
            </div>

            <div className="mc-dialog-field">
              <label htmlFor="edit-sensitivity" className="mc-dialog-label">
                Sensitivity
              </label>
              <select
                id="edit-sensitivity"
                className="mc-dialog-select"
                value={sensitivity}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  setSensitivity(e.target.value as MemorySensitivity);
                }}
                disabled={saving}
              >
                {MEMORY_SENSITIVITIES.map((s) => (
                  <option key={s} value={s}>
                    {SENSITIVITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {error !== null ? (
          <p role="alert" className="mc-dialog-error">
            {error}
          </p>
        ) : null}

        <div className="mc-dialog-actions">
          <button type="button" className="lk-btn lk-btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            onClick={() => {
              void handleSave();
            }}
            disabled={saving}
            aria-busy={saving}
          >
            {saving
              ? isCorrectMode
                ? "Submitting…"
                : "Saving…"
              : isCorrectMode
                ? "Submit correction"
                : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
