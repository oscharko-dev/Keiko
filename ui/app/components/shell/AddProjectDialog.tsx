"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode, FormEvent } from "react";
import { createProject, ApiError } from "@/lib/api";
import type { CreateProjectInput } from "@/lib/api";
import { projectErrorMessage } from "@/lib/error-messages";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AddProjectDialogProps {
  /** Called after a project is successfully created. */
  onSuccess: () => void;
  /** Called when the dialog is dismissed without creating a project. */
  onClose: () => void;
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

/**
 * Modal dialog for adding a local project directory.
 * Uses native <dialog> element — showModal() provides focus trap + ESC close.
 * Error codes from BFF are mapped to human-readable messages (D3).
 */
export function AddProjectDialog({ onSuccess, onClose }: AddProjectDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const errorId = "add-project-error";
  const titleId = "add-project-title";

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (!el.open) {
      el.showModal();
      // Initial focus on path input
      pathInputRef.current?.focus();
    }
    function handleCancel(e: Event): void {
      e.preventDefault();
      onClose();
    }
    el.addEventListener("cancel", handleCancel);
    return () => {
      el.removeEventListener("cancel", handleCancel);
    };
  }, [onClose]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const path = (data.get("path") as string).trim();
    const name = (data.get("name") as string).trim();

    if (!path) {
      setSubmitState({ kind: "error", message: "Path is required." });
      pathInputRef.current?.focus();
      return;
    }

    setSubmitState({ kind: "submitting" });
    try {
      const payload: CreateProjectInput = name ? { path, name } : { path };
      await createProject(payload);
      onSuccess();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setSubmitState({
          kind: "error",
          message: projectErrorMessage(err.code, err.message),
        });
      } else {
        setSubmitState({ kind: "error", message: "An unexpected error occurred." });
      }
    }
  }

  const isSubmitting = submitState.kind === "submitting";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="rounded-lg bg-panel p-6 shadow-xl backdrop:bg-canvas/60
        focus:outline-none"
      style={{ border: "1px solid #3a4052", minWidth: "22rem", maxWidth: "32rem", width: "90vw" }}
    >
      <h2 id={titleId} className="text-sm font-semibold text-ink">
        Add a local project directory
      </h2>
      <p className="mt-1 text-xs text-ink-muted">
        Enter the absolute path to a directory on this machine.
      </p>

      <form onSubmit={(e) => { void handleSubmit(e); }} noValidate className="mt-4 space-y-3">
        <div>
          <label htmlFor="add-project-path" className="block text-xs font-medium text-ink-muted">
            Directory path <span aria-hidden="true" className="text-red-400">*</span>
          </label>
          <input
            ref={pathInputRef}
            id="add-project-path"
            name="path"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="/home/user/my-project"
            aria-describedby={submitState.kind === "error" ? errorId : undefined}
            aria-invalid={submitState.kind === "error" ? "true" : undefined}
            disabled={isSubmitting}
            className="mt-1 w-full rounded bg-elevated px-3 py-2 font-mono text-xs text-ink
              placeholder:text-ink-dim
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
              disabled:opacity-50"
            style={{ border: "1px solid #3a4052" }}
          />
        </div>

        <div>
          <label htmlFor="add-project-name" className="block text-xs font-medium text-ink-muted">
            Display name <span className="text-ink-dim">(optional)</span>
          </label>
          <input
            id="add-project-name"
            name="name"
            type="text"
            autoComplete="off"
            placeholder="My project"
            disabled={isSubmitting}
            className="mt-1 w-full rounded bg-elevated px-3 py-2 text-xs text-ink
              placeholder:text-ink-dim
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
              disabled:opacity-50"
            style={{ border: "1px solid #3a4052" }}
          />
        </div>

        {submitState.kind === "error" && (
          <p id={errorId} role="alert" className="text-xs text-red-400">
            {submitState.message}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded px-3 py-1.5 text-xs text-ink-muted
              hover:bg-elevated hover:text-ink
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
              disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-ink-inverse
              hover:bg-accent-strong
              focus:outline-none focus-visible:ring-2 focus-visible:ring-focus
              disabled:opacity-50"
          >
            {isSubmitting ? "Adding…" : "Add project"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default AddProjectDialog;
