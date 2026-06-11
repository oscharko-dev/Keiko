"use client";

// Issue #198 — Destructive-action buttons for the capsule detail page.
// Issue #189 / #682 — SOURCE-CONNECT: connect folder/repository/files scopes + Index now actions.
// Three modal actions: Delete, Refresh changed files, Repair failed files.
// Two inline actions: Connect a source (manual scope input), Index now (button).
// Delete requires typing the capsule display name before confirming (Foundry IQ pattern).
// Refresh and Repair use a single "Are you sure?" step.
//
// Focus trap: Tab/Shift+Tab cycle within the dialog; Escape cancels.
// WCAG: min 30×30 button targets, focus-visible ring, colour tokens for danger text.

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { KnowledgeCapsuleId, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import {
  connectCapsuleSource,
  deleteCapsule,
  refreshCapsuleChangedFiles,
  repairCapsuleFailedFiles,
  startIndexing,
} from "@/lib/local-knowledge-api";
import type { CapsuleActionResponse, ConnectCapsuleSourceScope } from "@/lib/local-knowledge-api";
import { Icons } from "@/app/components/desktop/Icons";
import { formatError } from "../format-error";

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
// ConnectSourceForm — Issue #189 / #682 source connect affordance
// ---------------------------------------------------------------------------

interface ConnectSourceFormProps {
  readonly capsuleId: KnowledgeCapsuleId;
  readonly onConnected: () => void;
  readonly connectImpl?: typeof connectCapsuleSource;
}

function parseFilesInput(value: string): readonly string[] {
  return Array.from(
    new Set(
      value
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

function rootPathPlaceholder(kind: ConnectCapsuleSourceScope["kind"]): string {
  if (kind === "repository") return "/absolute/path/to/repository";
  if (kind === "files") return "/absolute/path/to/root";
  return "/absolute/path/to/folder";
}

function rootPathLabel(kind: ConnectCapsuleSourceScope["kind"]): string {
  if (kind === "repository") return "Absolute repository path to connect";
  if (kind === "files") return "Absolute root path for the selected files";
  return "Absolute folder path to connect";
}

function buildScope(
  kind: ConnectCapsuleSourceScope["kind"],
  rootPath: string,
  filesInput: string,
): ConnectCapsuleSourceScope | null {
  const trimmedRoot = rootPath.trim();
  if (trimmedRoot === "") return null;
  if (kind === "folder") {
    return { kind: "folder", rootPath: trimmedRoot, recursive: true };
  }
  if (kind === "repository") {
    return { kind: "repository", repositoryRoot: trimmedRoot };
  }
  const files = parseFilesInput(filesInput);
  if (files.length === 0) return null;
  return { kind: "files", rootPath: trimmedRoot, files };
}

function ConnectSourceForm({
  capsuleId,
  onConnected,
  connectImpl = connectCapsuleSource,
}: ConnectSourceFormProps): ReactNode {
  const [scopeKind, setScopeKind] = useState<ConnectCapsuleSourceScope["kind"]>("folder");
  const [rootPath, setRootPath] = useState("");
  const [filesInput, setFilesInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const scope = buildScope(scopeKind, rootPath, filesInput);

  async function handleConnect(): Promise<void> {
    if (scope === null || busy) return;
    setBusy(true);
    setConnectError(null);
    try {
      await connectImpl(capsuleId, scope);
      setRootPath("");
      setFilesInput("");
      onConnected();
    } catch (error) {
      setConnectError(formatError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lkd-connect-form" aria-label="Connect a source">
      <label htmlFor="lkd-connect-kind" className="lkd-connect-label">
        Connect source
      </label>
      <div className="lkd-connect-row">
        {/* No aria-label here: the visible "Connect source" label (htmlFor above)
            provides the accessible name, so WCAG 2.5.3 Label in Name holds
            (uiux-fix F033, C365). The select sits in the app's .dlg-selwrap
            chevron wrapper so it is recognisable as a dropdown (C234). */}
        <span className="dlg-selwrap">
          <select
            id="lkd-connect-kind"
            className="dlg-input"
            value={scopeKind}
            disabled={busy}
            onChange={(e) => {
              setScopeKind(e.target.value as ConnectCapsuleSourceScope["kind"]);
              setConnectError(null);
            }}
          >
            <option value="folder">Folder</option>
            <option value="repository">Repository</option>
            <option value="files">Files</option>
          </select>
          <span className="dlg-selchev">
            <Icons.chevron size={15} />
          </span>
        </span>
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-connect-path-input" className="dlg-label">
          {rootPathLabel(scopeKind)}
        </label>
        <input
          id="lkd-connect-path-input"
          type="text"
          className="dlg-input lkd-connect-input"
          value={rootPath}
          disabled={busy}
          placeholder={rootPathPlaceholder(scopeKind)}
          autoComplete="off"
          onChange={(e: ChangeEvent<HTMLInputElement>) => setRootPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && scopeKind !== "files") void handleConnect();
          }}
        />
      </div>
      {scopeKind === "files" ? (
        <div className="lkd-connect-row">
          <label htmlFor="lkd-connect-files-input" className="dlg-label">
            Relative files to connect
          </label>
          <textarea
            id="lkd-connect-files-input"
            className="dlg-input lkd-connect-input"
            value={filesInput}
            disabled={busy}
            placeholder={"src/app.ts\nREADME.md"}
            rows={4}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setFilesInput(e.target.value)}
          />
        </div>
      ) : null}
      <div className="lkd-connect-row">
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          disabled={busy || scope === null}
          aria-busy={busy}
          onClick={() => void handleConnect()}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      {connectError !== null ? (
        <div role="alert" aria-live="assertive" className="lk-alert">
          {connectError}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Focus-trap hook (mirrors GatewaySetupDialog pattern)
// ---------------------------------------------------------------------------

function useFocusTrap(
  dialogRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  // Remember the element that opened the dialog and give focus back to it when
  // the dialog unmounts — WCAG 2.4.3; mirrors useComposeFocusTrap in
  // capsule-set-compose.tsx (uiux-fix F033, C036). Kept in a separate effect:
  // the keydown effect below re-runs whenever `onEscape` gets a new identity,
  // and restoring focus on every re-render would yank focus out of the form.
  useEffect(() => {
    if (!active) return undefined;
    const trigger = document.activeElement as HTMLElement | null;
    return () => trigger?.focus?.();
  }, [active]);

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
      if (focusables.length === 0) {
        // All controls are disabled while busy — keep Tab from escaping
        // behind the backdrop (uiux-fix F033, C036).
        event.preventDefault();
        return;
      }
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
      dialog.querySelector<HTMLElement>("button:not([disabled]),input:not([disabled])")?.focus();
    }
  }, [busy]);

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
        tabIndex={-1}
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
  readonly sourceCount: number;
  readonly lifecycleState: CapsuleLifecycleState;
  readonly onActionComplete: () => void;
  // Injectable seams for tests
  readonly connectCapsuleSourceImpl?: typeof connectCapsuleSource;
  readonly deleteCapsuleImpl?: typeof deleteCapsule;
  readonly refreshCapsuleImpl?: typeof refreshCapsuleChangedFiles;
  readonly repairCapsuleImpl?: typeof repairCapsuleFailedFiles;
  readonly startIndexingImpl?: typeof startIndexing;
}

export function CapsuleActions({
  capsuleId,
  capsuleDisplayName,
  sourceCount,
  lifecycleState,
  onActionComplete,
  connectCapsuleSourceImpl = connectCapsuleSource,
  deleteCapsuleImpl = deleteCapsule,
  refreshCapsuleImpl = refreshCapsuleChangedFiles,
  repairCapsuleImpl = repairCapsuleFailedFiles,
  startIndexingImpl = startIndexing,
}: CapsuleActionsProps): ReactNode {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);

  async function handleIndex(): Promise<void> {
    if (indexBusy) return;
    setIndexBusy(true);
    setIndexError(null);
    try {
      await startIndexingImpl(capsuleId);
      onActionComplete();
    } catch (error) {
      setIndexError(formatError(error));
    } finally {
      setIndexBusy(false);
    }
  }

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

  const showIndexButton = sourceCount > 0 && lifecycleState !== "ready";

  // Rendered as its own block BELOW the .lk-header row (capsule-detail.tsx):
  // the multi-line connect form used to be squeezed into the header flex row
  // next to the H1 (uiux-fix F033, C104).
  return (
    <section className="lkd-tools" aria-label="Capsule tools">
      <ConnectSourceForm
        capsuleId={capsuleId}
        onConnected={onActionComplete}
        connectImpl={connectCapsuleSourceImpl}
      />

      {showIndexButton ? (
        <div className="lkd-index-row">
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-label="Index this capsule now"
            aria-busy={indexBusy}
            disabled={indexBusy}
            onClick={() => void handleIndex()}
          >
            {indexBusy ? "Indexing…" : "Index now"}
          </button>
          {indexError !== null ? (
            <div role="alert" aria-live="assertive" className="lk-alert">
              {indexError}
            </div>
          ) : null}
        </div>
      ) : null}

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
    </section>
  );
}
