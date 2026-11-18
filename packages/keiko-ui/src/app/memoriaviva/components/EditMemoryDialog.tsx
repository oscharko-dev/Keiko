"use client";

import { ApiError } from "@/lib/api-shared-primitives";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";

// Issue #211 — Inline edit form for memory body, tags, and sensitivity.
// Controlled: caller owns the record; this dialog calls editMemory/correctMemory and reports back.
//
// WCAG: focus is trapped while open, first field receives focus on open, Escape closes.
// focus-visible rings on all interactive elements. aria-modal on the dialog.
// Sensitivity select uses <select> — native keyboard fully accessible.

import { useCallback, useId, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import type { MemoryId, MemoryRecord, MemorySensitivity } from "@oscharko-dev/keiko-contracts";
import {
  MEMORY_SENSITIVITIES,
  personMemoryTags,
} from "@oscharko-dev/keiko-contracts/runtime/memory";
import { correctMemory, editMemory, type EditMemoryInput } from "@/lib/memory-api";

import { useDialogTabTrap } from "../../components/desktop/hooks/useDialogTabTrap";
import { useModalInteractionLock } from "../../components/desktop/hooks/useModalInteractionLock";
import { NATIVE_DIALOG_STYLE } from "../../components/desktop/native-element-styles";
import { formatError } from "./format-error";
import { sensitivityLabel } from "./MemoryFilters";

interface EditMemoryDialogProps {
  readonly record: MemoryRecord;
  readonly mode?: "edit" | "correct";
  readonly onSave: (updated: MemoryRecord) => void;
  readonly onClose: () => void;
  readonly editMemoryImpl?: typeof editMemory;
  readonly correctMemoryImpl?: typeof correctMemory;
}

function editableFieldsChanged(
  original: MemoryRecord,
  current: MemoryRecord,
  versionConflict: boolean,
): boolean {
  return (
    versionConflict ||
    original.body !== current.body ||
    original.provenance.sensitivity !== current.provenance.sensitivity ||
    JSON.stringify(personMemoryTags(original.tags)) !==
      JSON.stringify(personMemoryTags(current.tags))
  );
}

function changedFields(
  original: MemoryRecord,
  body: string,
  tagsRaw: string,
  sensitivity: MemorySensitivity,
): EditMemoryInput {
  const originalTags = personMemoryTags(original.tags);
  const tags =
    tagsRaw === originalTags.join(", ")
      ? originalTags
      : tagsRaw
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
  return {
    ...(body === original.body.trim() ? {} : { body }),
    ...(JSON.stringify(tags) === JSON.stringify(originalTags) ? {} : { tags }),
    ...(sensitivity === original.provenance.sensitivity ? {} : { sensitivity }),
  };
}

export function EditMemoryDialog({
  record,
  mode = "edit",
  onSave,
  onClose,
  editMemoryImpl = editMemory,
  correctMemoryImpl = correctMemory,
}: EditMemoryDialogProps): ReactNode {
  const t = useTranslate();
  const [original] = useState(record);
  const [versionConflict, setVersionConflict] = useState(false);
  const contentChanged = editableFieldsChanged(original, record, versionConflict);
  const [body, setBody] = useState(record.body);
  const [tagsRaw, setTagsRaw] = useState(personMemoryTags(record.tags).join(", "));
  const [sensitivity, setSensitivity] = useState<MemorySensitivity>(record.provenance.sensitivity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while the body field itself failed validation — drives aria-invalid +
  // aria-describedby on the textarea so SR users find the offending field
  // (uiux-fix F005, WCAG 3.3.1; pattern from PR #823).
  const [bodyInvalid, setBodyInvalid] = useState(false);

  const firstRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const errorId = useId();
  const isCorrectMode = mode === "correct";

  useDialogTabTrap(dialogRef);
  useModalInteractionLock({ initialFocusRef: firstRef });

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDialogElement>): void => {
      if (e.key === "Escape") {
        onClose();
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
    if (contentChanged) return;
    const trimmedBody = body.trim();
    if (trimmedBody.length === 0) {
      setError(t("memoria.dialog.bodyRequired"));
      setBodyInvalid(true);
      // Return focus to the offending field instead of leaving it on Save.
      firstRef.current?.focus();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (isCorrectMode) {
        const res = await correctMemoryImpl(record.id as MemoryId, trimmedBody);
        onSave(res.correction);
      } else {
        const patch = changedFields(original, trimmedBody, tagsRaw, sensitivity);
        const saved =
          Object.keys(patch).length === 0
            ? record
            : (await editMemoryImpl(record.id, { ...patch, expectedUpdatedAt: record.updatedAt }))
                .memory;
        onSave(saved);
      }
    } catch (err) {
      if (!isCorrectMode && err instanceof ApiError && err.status === 409) setVersionConflict(true);
      else setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }, [
    contentChanged,
    body,
    tagsRaw,
    sensitivity,
    original,
    record,
    isCorrectMode,
    correctMemoryImpl,
    editMemoryImpl,
    onSave,
    t,
  ]);

  function saveErrorMessage(): string | null {
    return contentChanged ? t("memoria.dialog.editConflict") : error;
  }
  const errorMessage = saveErrorMessage();

  // One of four mutually exclusive save-button labels — extracted as early
  // returns instead of a nested ternary chain (mirrors ReviewRowActions in
  // ReviewQueue.tsx).
  function resolveSaveButtonLabel(): string {
    if (saving && isCorrectMode) return t("memoria.dialog.submitting");
    if (saving) return t("memoria.dialog.saving");
    if (isCorrectMode) return t("memoria.dialog.submitCorrection");
    return t("memoria.dialog.save");
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer-only backdrop dismissal is additive; Escape and explicit Close provide keyboard dismissal. */}
      <div ref={backdropRef} className="mc-dialog-backdrop" onClick={handleBackdropClick}>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- native dialog owns the modal semantics and receives the established Escape handler. */}
        <dialog
          ref={dialogRef}
          open
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="mc-dialog"
          style={NATIVE_DIALOG_STYLE}
          onKeyDown={handleKeyDown}
        >
          <h2 id={titleId} className="mc-dialog-title">
            {isCorrectMode ? t("memoria.dialog.correctTitle") : t("memoria.dialog.editTitle")}
          </h2>

          <div className="mc-dialog-field">
            <label htmlFor="edit-body" className="mc-dialog-label">
              {isCorrectMode ? t("memoria.dialog.correctedBody") : t("memoria.dialog.body")}
            </label>
            <textarea
              id="edit-body"
              ref={firstRef}
              className="mc-dialog-textarea"
              value={body}
              rows={5}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                setBody(e.target.value);
                // Typing clears the field-level validation state.
                if (bodyInvalid) {
                  setBodyInvalid(false);
                  setError(null);
                }
              }}
              disabled={saving}
              aria-required="true"
              aria-invalid={bodyInvalid}
              aria-describedby={bodyInvalid ? errorId : undefined}
            />
          </div>

          {isCorrectMode ? null : (
            <>
              <div className="mc-dialog-field">
                <label htmlFor="edit-tags" className="mc-dialog-label">
                  {t("memoria.dialog.tags")}{" "}
                  <span className="mc-dialog-hint">{t("memoria.dialog.commaSeparated")}</span>
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
                  {t("memoria.sensitivity")}
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
                      {sensitivityLabel(s, t)}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}

          {errorMessage !== null ? (
            <p id={errorId} role="alert" className="mc-dialog-error">
              {errorMessage}
            </p>
          ) : null}

          <div className="mc-dialog-actions">
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              onClick={onClose}
              disabled={saving}
            >
              {t("memoria.cancel")}
            </button>
            <button
              type="button"
              className="lk-btn lk-btn-primary"
              onClick={() => {
                void handleSave();
              }}
              disabled={saving || contentChanged}
              aria-busy={saving}
            >
              {resolveSaveButtonLabel()}
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}
