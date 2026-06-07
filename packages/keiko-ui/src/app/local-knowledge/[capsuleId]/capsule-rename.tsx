"use client";

// Issue #189 Slice 4 — "beschriften": inline rename of a capsule's display name and
// description. Renders a compact Rename toggle in the capsule detail header; on save it
// PATCHes /capsules/:id and asks the parent to reload so every section reflects the new
// label. Metadata editing is intentionally not exposed yet (no store migration).

import { useState, type FormEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { renameCapsule, type RenameCapsulePatch } from "@/lib/local-knowledge-api";
import { ApiError } from "@/lib/api";

function formatError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

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
  onNameChange,
  onDescriptionChange,
  onCancel,
  onSubmit,
}: RenameFieldsProps): ReactNode {
  return (
    <form className="lkd-rename-form" aria-label="Rename capsule" onSubmit={onSubmit}>
      <div className="dlg-field">
        <label htmlFor="lkd-rename-name" className="dlg-label">
          Display name
        </label>
        <input
          id="lkd-rename-name"
          type="text"
          className="dlg-input"
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
      onNameChange={setName}
      onDescriptionChange={setDraftDescription}
      onCancel={cancel}
      onSubmit={(event) => void handleSubmit(event)}
    />
  );
}
