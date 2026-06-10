"use client";

// Issue #189 Slice 4 — "beschriften": inline rename of a capsule's display name and
// description. Renders a compact Rename toggle in the capsule detail header; on save it
// PATCHes /capsules/:id and asks the parent to reload so every section reflects the new
// label. Metadata editing is intentionally not exposed yet (no store migration).

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { renameCapsule, type RenameCapsulePatch } from "@/lib/local-knowledge-api";
import { formatError } from "../format-error";

// Minimal patch: only fields that actually changed. Returns null when nothing changed so
// the caller can close the editor without a no-op request (the BFF rejects empty patches).
function buildPatch(
  name: string,
  description: string,
  originalName: string,
  originalDescription: string | undefined,
): RenameCapsulePatch | null {
  const patch: { displayName?: string; description?: string } = {};
  if (name !== originalName) patch.displayName = name;
  const trimmedDescription = description.trim();
  if (trimmedDescription !== (originalDescription ?? "")) patch.description = trimmedDescription;
  if (patch.displayName === undefined && patch.description === undefined) return null;
  return patch;
}

interface RenameFieldsProps {
  readonly name: string;
  readonly description: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly nameInputRef: Ref<HTMLInputElement>;
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function RenameFields({
  name,
  description,
  busy,
  error,
  nameInputRef,
  onNameChange,
  onDescriptionChange,
  onCancel,
  onSubmit,
}: RenameFieldsProps): ReactNode {
  const formRef = useRef<HTMLFormElement>(null);
  // Escape cancels the inline edit (#712 pattern): a document keydown listener scoped to this
  // form's lifetime — not a JSX handler on the non-interactive <form> (jsx-a11y). Only cancels
  // while focus is inside the form, and never mid-save, so a stray Escape can't tear the form
  // down under an in-flight PATCH.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      const form = formRef.current;
      if (form !== null && form.contains(document.activeElement)) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [busy, onCancel]);
  return (
    <form className="lkd-rename-form" aria-label="Rename capsule" onSubmit={onSubmit} ref={formRef}>
      <div className="dlg-field">
        <label htmlFor="lkd-rename-name" className="dlg-label">
          Display name
        </label>
        <input
          id="lkd-rename-name"
          type="text"
          className="dlg-input"
          ref={nameInputRef}
          value={name}
          disabled={busy}
          autoComplete="off"
          aria-label="Capsule display name"
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      <div className="dlg-field">
        <label htmlFor="lkd-rename-desc" className="dlg-label">
          Description
        </label>
        <input
          id="lkd-rename-desc"
          type="text"
          className="dlg-input"
          value={description}
          disabled={busy}
          autoComplete="off"
          aria-label="Capsule description"
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
      </div>
      {error !== null ? (
        <div role="alert" aria-live="assertive" className="lk-alert">
          {error}
        </div>
      ) : null}
      <div className="lkd-rename-actions">
        <button type="button" className="lk-btn lk-btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="lk-btn lk-btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export interface CapsuleRenameProps {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly displayName: string;
  readonly description?: string;
  readonly onRenamed: () => void;
  readonly renameImpl?: typeof renameCapsule;
}

export function CapsuleRename({
  capsuleId,
  displayName,
  description,
  onRenamed,
  renameImpl = renameCapsule,
}: CapsuleRenameProps): ReactNode {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(displayName);
  const [draftDescription, setDraftDescription] = useState(description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasEditingRef = useRef(false);

  // Focus management (WCAG 2.4.3, #712 pattern): opening replaces the focused Rename button
  // with the form — move focus into the first field; closing (cancel OR successful save)
  // unmounts the form — return focus to the re-mounted Rename button.
  useEffect(() => {
    if (editing) {
      nameInputRef.current?.focus();
    } else if (wasEditingRef.current) {
      renameButtonRef.current?.focus();
    }
    wasEditingRef.current = editing;
  }, [editing]);

  function open(): void {
    setName(displayName);
    setDraftDescription(description ?? "");
    setError(null);
    setEditing(true);
  }

  function cancel(): void {
    if (busy) return;
    setEditing(false);
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Display name is required.");
      return;
    }
    const patch = buildPatch(trimmedName, draftDescription, displayName, description);
    if (patch === null) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameImpl(capsuleId, patch);
      setEditing(false);
      onRenamed();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="lk-btn lk-btn-ghost"
        aria-label={`Rename capsule ${displayName}`}
        ref={renameButtonRef}
        onClick={open}
      >
        Rename
      </button>
    );
  }

  return (
    <RenameFields
      name={name}
      description={draftDescription}
      busy={busy}
      error={error}
      nameInputRef={nameInputRef}
      onNameChange={setName}
      onDescriptionChange={setDraftDescription}
      onCancel={cancel}
      onSubmit={(event) => void handleSubmit(event)}
    />
  );
}
