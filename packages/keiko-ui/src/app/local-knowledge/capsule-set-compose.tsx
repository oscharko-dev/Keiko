"use client";

// Issue #189 Slice 4 — "zusammenlegen": non-destructive composition of existing capsules
// into a named CapsuleSet. The user picks a name and 1..CAPSULE_SET_MAX_MEMBERS capsules;
// POST /capsule-sets creates a set that references the members by id (no documents are
// moved or copied). Incompatible embedding identities across members are rejected
// server-side and surfaced here as a 400 — the UI cannot pre-validate identity.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CAPSULE_SET_MAX_MEMBERS, type KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { createCapsuleSet, type CapsuleListEntry } from "@/lib/local-knowledge-api";
import { STATUS_LABELS } from "./connector-graph-types";
import { formatError } from "./format-error";

function focusablesIn(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex='-1'])",
    ),
  );
}

function useComposeFocusTrap(
  dialogRef: React.RefObject<HTMLDivElement | null>,
  busy: boolean,
  onCancel: () => void,
): void {
  // Capture the opener ONCE and restore focus to it when the dialog unmounts.
  // This must not depend on `busy`: the previous single effect re-ran on every
  // busy flip, and its cleanup refocused the trigger BEHIND the backdrop
  // mid-request (uiux-fix F033, C036).
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog !== null) focusablesIn(dialog)[0]?.focus();
    return () => trigger?.focus?.();
  }, [dialogRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusablesIn(dialog as HTMLDivElement);
      if (focusables.length === 0) {
        // All controls are disabled while busy — keep Tab from escaping
        // behind the backdrop (uiux-fix F033, C036).
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    dialog.addEventListener("keydown", handleKeyDown);
    return () => dialog.removeEventListener("keydown", handleKeyDown);
  }, [dialogRef, busy, onCancel]);

  // While busy every control is disabled, which blurs the focused element to
  // document.body. Park focus on the dialog container (tabIndex={-1}) instead;
  // when the request ends and the dialog is still open (error path), move it
  // back to the first control (uiux-fix F033, C036).
  const wasBusyRef = useRef(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (busy) {
      wasBusyRef.current = true;
      dialog.focus();
    } else if (wasBusyRef.current) {
      wasBusyRef.current = false;
      focusablesIn(dialog)[0]?.focus();
    }
  }, [dialogRef, busy]);
}

function MemberCheckbox({
  capsule,
  checked,
  disabled,
  onToggle,
}: {
  capsule: CapsuleListEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: KnowledgeCapsuleId) => void;
}): ReactNode {
  return (
    <li className="lk-compose-member">
      <label className="lk-compose-member-label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(capsule.id)}
        />
        <span className="lk-compose-member-name" title={capsule.displayName}>
          {capsule.displayName}
        </span>
        <span className="lk-badge" data-state={capsule.lifecycleState}>
          {STATUS_LABELS[capsule.lifecycleState]}
        </span>
      </label>
    </li>
  );
}

function validateSelection(name: string, count: number): string | null {
  if (name.trim().length === 0) return "Set name is required.";
  if (count === 0) return "Select at least one capsule to combine.";
  if (count > CAPSULE_SET_MAX_MEMBERS) {
    return `A set can hold at most ${CAPSULE_SET_MAX_MEMBERS.toString()} capsules.`;
  }
  return null;
}

export interface CapsuleSetComposeDialogProps {
  readonly capsules: readonly CapsuleListEntry[];
  readonly onCancel: () => void;
  readonly onCreated: () => void;
  readonly createImpl?: typeof createCapsuleSet;
}

export function CapsuleSetComposeDialog({
  capsules,
  onCancel,
  onCreated,
  createImpl = createCapsuleSet,
}: CapsuleSetComposeDialogProps): ReactNode {
  const titleId = useId();
  const nameId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<KnowledgeCapsuleId>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useComposeFocusTrap(dialogRef, busy, onCancel);

  function toggle(id: KnowledgeCapsuleId): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (error !== null) setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const validation = validateSelection(name, selected.size);
    if (validation !== null) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createImpl({ displayName: name.trim(), capsuleIds: [...selected] });
      onCreated();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  const nameInvalid = error === "Set name is required.";
  const selectionInvalid = error === "Select at least one capsule to combine.";

  return createPortal(
    <div className="mc-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="mc-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="mc-dialog-title">
          Combine capsules into a set
        </h2>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label className="mc-dialog-field" htmlFor={nameId}>
            <span className="mc-dialog-label">Set name</span>
            <input
              id={nameId}
              className="mc-dialog-input"
              value={name}
              disabled={busy}
              autoComplete="off"
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (error !== null) setError(null);
              }}
            />
          </label>
          <fieldset
            className="lk-compose-fieldset"
            disabled={busy}
            aria-invalid={selectionInvalid}
            aria-describedby={selectionInvalid ? errorId : undefined}
          >
            <legend className="mc-dialog-label">
              Capsules ({selected.size.toString()}/{CAPSULE_SET_MAX_MEMBERS.toString()})
            </legend>
            {capsules.length === 0 ? (
              <p className="lkd-empty-note">No capsules available to combine.</p>
            ) : (
              <ul className="lk-compose-member-list" aria-label="Selectable capsules">
                {capsules.map((capsule) => (
                  <MemberCheckbox
                    key={capsule.id}
                    capsule={capsule}
                    checked={selected.has(capsule.id)}
                    disabled={busy}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            )}
          </fieldset>
          {error !== null ? (
            <div id={errorId} role="alert" aria-live="assertive" className="mc-dialog-error">
              {error}
            </div>
          ) : null}
          <div className="mc-dialog-actions">
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="lk-btn lk-btn-primary"
              disabled={busy}
              aria-busy={busy}
            >
              {/* One verb through the whole flow — header "Combine capsules",
                  dialog title, submit and busy label all say Combine
                  (uiux-fix F048, C368). */}
              {busy ? "Combining…" : "Combine"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
