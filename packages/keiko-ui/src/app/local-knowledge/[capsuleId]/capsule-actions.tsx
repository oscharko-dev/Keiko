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

import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { KnowledgeCapsuleId, CapsuleLifecycleState } from "@oscharko-dev/keiko-contracts";
import {
  connectCapsuleSource,
  deleteCapsule,
  fetchCapsuleDetail,
  reembedCapsuleForCurrentModel,
  refreshCapsuleChangedFiles,
  repairCapsuleFailedFiles,
  startIndexing,
} from "@/lib/local-knowledge-api";
import type {
  CapsuleActionResponse,
  CapsuleDetail,
  ConnectCapsuleSourceScope,
} from "@/lib/local-knowledge-api";
import type { FilesTreeEntry } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import {
  LOCAL_KNOWLEDGE_MAX_FILE_BYTES,
  LOCAL_KNOWLEDGE_MAX_OBJECTS_PER_DOCUMENT,
  LOCAL_KNOWLEDGE_PARSER_TIMEOUT_MS,
} from "@/lib/local-knowledge-limits";
import { useModalInteractionLock } from "@/app/components/desktop/hooks/useModalInteractionLock";
import { LocalFileBrowserDialog } from "@/app/components/desktop/local-files/LocalFileBrowserDialog";
import KeikoSelect from "@/app/components/desktop/KeikoSelect";
import { formatError } from "../format-error";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActionKind = "delete" | "refresh" | "repair" | "reembed";
type ProgressActionKind = Exclude<ActionKind, "delete"> | "index";

interface ConfirmState {
  readonly kind: ActionKind;
  readonly nameInput: string;
}

interface ProgressState {
  readonly detail: CapsuleDetail | null;
  readonly startedAt: number;
  readonly now: number;
  readonly pollError: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionTitle(kind: ActionKind): string {
  if (kind === "delete") return "Delete capsule";
  if (kind === "reembed") return "Re-index for current embedding model";
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
  if (kind === "reembed") {
    return "This rebuilds every vector for the current embedding model. Use it after changing the configured embedding model or gateway.";
  }
  return "This retries files that previously failed indexing and also picks up any newly changed files in the same incremental pass.";
}

function confirmButtonLabel(kind: ActionKind, busy: boolean): string {
  if (busy) return "Working…";
  if (kind === "delete") return "Delete";
  if (kind === "reembed") return "Re-index";
  if (kind === "refresh") return "Refresh";
  return "Repair";
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100).toString()}%`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds.toString()}s`;
  return `${minutes.toString()}m ${seconds.toString().padStart(2, "0")}s`;
}

function completedDocuments(job: CapsuleDetail["indexingJobs"][number] | undefined): number {
  if (job === undefined) return 0;
  return job.processedDocuments + job.failedDocuments + job.skippedDocuments;
}

function progressStyle(value: number): { readonly width: string } {
  return { width: formatPercent(value) };
}

function initialProgressState(now = Date.now()): ProgressState {
  return { detail: null, startedAt: now, now, pollError: null };
}

function formatLimitDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes.toString()} min`;
  const hours = minutes / 60;
  return `${hours.toString()} h`;
}

function localKnowledgeLimitSummary(): string {
  return `Maximum single file size: ${formatBytes(LOCAL_KNOWLEDGE_MAX_FILE_BYTES)}. Parser budget: ${LOCAL_KNOWLEDGE_MAX_OBJECTS_PER_DOCUMENT.toLocaleString("en-US")} objects, ${formatLimitDuration(LOCAL_KNOWLEDGE_PARSER_TIMEOUT_MS)} per document.`;
}

function isOversizedPickerFile(entry: FilesTreeEntry): boolean {
  return entry.kind === "file" && entry.sizeBytes > LOCAL_KNOWLEDGE_MAX_FILE_BYTES;
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

function pickerModeForScope(kind: ConnectCapsuleSourceScope["kind"]): "files" | "folder-or-files" {
  return kind === "files" ? "files" : "folder-or-files";
}

function pickerFileDisabledReason(entry: FilesTreeEntry): string | undefined {
  if (isOversizedPickerFile(entry)) {
    return `File is ${formatBytes(entry.sizeBytes)}; maximum is ${formatBytes(LOCAL_KNOWLEDGE_MAX_FILE_BYTES)}.`;
  }
  if (!entry.readable) return "File is not readable.";
  return undefined;
}

function pickerFileMeta(entry: FilesTreeEntry): ReactNode {
  const oversized = isOversizedPickerFile(entry);
  return (
    <>
      {formatBytes(entry.sizeBytes)}
      {oversized ? " · too large" : ""}
    </>
  );
}

const SOURCE_KIND_OPTIONS = [
  {
    value: "folder",
    label: "Folder",
    description: "Index every supported document under one folder.",
  },
  {
    value: "repository",
    label: "Repository",
    description: "Connect a repository root as a capsule source.",
  },
  {
    value: "files",
    label: "Files",
    description: "Choose specific files below a shared root.",
  },
] as const;

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const sourceKindLabelId = useId();
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
      <span id={sourceKindLabelId} className="lkd-connect-label">
        Connect source
      </span>
      <div className="lkd-connect-row">
        <KeikoSelect
          value={scopeKind}
          sections={[{ options: SOURCE_KIND_OPTIONS }]}
          onValueChange={(next) => {
            setScopeKind(next as ConnectCapsuleSourceScope["kind"]);
            setConnectError(null);
          }}
          disabled={busy}
          ariaLabelledBy={sourceKindLabelId}
          triggerClassName="lkd-source-kind-select"
          menuClassName="lkd-source-kind-menu"
          menuTitle="Source type"
          showMenuHeader={false}
        />
      </div>
      <div className="lkd-connect-row">
        <label htmlFor="lkd-connect-path-input" className="dlg-label">
          {rootPathLabel(scopeKind)}
        </label>
        <div className="lkd-connect-path-group">
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
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            disabled={busy}
            onClick={() => setPickerOpen(true)}
          >
            Browse
          </button>
        </div>
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
      {pickerOpen ? (
        <LocalFileBrowserDialog
          mode={pickerModeForScope(scopeKind)}
          title="Choose local source"
          description={`Select a local ${scopeKind === "files" ? "file or files" : "folder"} for this capsule.`}
          note={localKnowledgeLimitSummary()}
          initialRootPath={rootPath}
          initialFiles={parseFilesInput(filesInput)}
          isFileDisabled={isOversizedPickerFile}
          fileDisabledReason={pickerFileDisabledReason}
          fileMeta={pickerFileMeta}
          onApply={(selection) => {
            if (selection.files.length > 0) {
              setScopeKind("files");
              setRootPath(selection.rootPath);
              setFilesInput(selection.files.join("\n"));
            } else {
              setRootPath(selection.folderPath);
              if (scopeKind !== "files") setFilesInput("");
            }
            setConnectError(null);
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
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
  readonly progress: ProgressState | null;
  readonly onNameChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function ActionProgress({
  kind,
  progress,
}: {
  kind: ProgressActionKind;
  progress: ProgressState;
}): ReactNode {
  const detail = progress.detail;
  const latestJob = detail?.indexingJobs[0];
  const totalDocuments = latestJob?.totalDocuments ?? detail?.health.documentCount ?? 0;
  const completed = completedDocuments(latestJob);
  const documentProgress = totalDocuments > 0 ? completed / totalDocuments : 0;
  const chunkCount = detail?.health.chunkCount ?? 0;
  const vectorCount = detail?.health.vectorCount ?? 0;
  const vectorProgress = chunkCount > 0 ? vectorCount / chunkCount : 0;
  const elapsedMs = progress.now - progress.startedAt;
  const docsPerMs = completed > 0 ? completed / Math.max(elapsedMs, 1) : 0;
  const etaMs = docsPerMs > 0 ? Math.max(0, totalDocuments - completed) / docsPerMs : 0;
  const statusLabel = latestJob?.status ?? detail?.capsule.lifecycleState ?? "starting";
  const actionLabel =
    kind === "index"
      ? "Indexing documents"
      : kind === "reembed"
        ? "Re-indexing for current embedding model"
      : kind === "refresh"
        ? "Refreshing changed files"
        : "Repairing failed files";
  const etaLabel =
    docsPerMs > 0 && totalDocuments > completed
      ? `Estimated remaining ${formatDuration(etaMs)}`
      : "Estimating remaining time";

  return (
    <div className="lkd-action-progress" role="status" aria-live="polite">
      <div className="lkd-action-progress-head">
        <span>{actionLabel}</span>
        <span>{statusLabel}</span>
      </div>
      <div className="lkd-action-progress-note">
        Still working. Elapsed {formatDuration(elapsedMs)}. {etaLabel}.
      </div>
      <div className="lkd-status-bars">
        <div className="lkd-status-bar-row">
          <span>Documents</span>
          <ProgressBar value={documentProgress} label="Action document progress" />
          <span>
            {completed.toString()} / {totalDocuments.toString()}
          </span>
        </div>
        <div className="lkd-status-bar-row">
          <span>Vectors</span>
          <ProgressBar value={vectorProgress} label="Action vector progress" />
          <span>
            {vectorCount.toString()} / {chunkCount.toString()}
          </span>
        </div>
      </div>
      {progress.pollError !== null ? (
        <div className="lkd-action-progress-note">
          Progress refresh is delayed: {progress.pollError}
        </div>
      ) : null}
    </div>
  );
}

function ProgressBar({ value, label }: { value: number; label: string }): ReactNode {
  return (
    <div className="lkd-progress" role="img" aria-label={`${label}: ${formatPercent(value)}`}>
      <span className="lkd-progress-fill" data-tone="ok" style={progressStyle(value)} />
    </div>
  );
}

function ConfirmModal({
  kind,
  capsuleDisplayName,
  nameInput,
  busy,
  error,
  progress,
  onNameChange,
  onConfirm,
  onCancel,
}: ConfirmModalProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  useModalInteractionLock();
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

  return createPortal(
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
            {busy && progress !== null ? <ActionProgress kind={kind} progress={progress} /> : null}
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
    </div>,
    document.body,
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
  readonly vectorCompatible?: boolean;
  readonly onActionComplete: () => void;
  readonly onDeleted?: (response: CapsuleActionResponse) => void;
  // Injectable seams for tests
  readonly connectCapsuleSourceImpl?: typeof connectCapsuleSource;
  readonly deleteCapsuleImpl?: typeof deleteCapsule;
  readonly refreshCapsuleImpl?: typeof refreshCapsuleChangedFiles;
  readonly repairCapsuleImpl?: typeof repairCapsuleFailedFiles;
  readonly reembedCapsuleImpl?: typeof reembedCapsuleForCurrentModel;
  readonly startIndexingImpl?: typeof startIndexing;
  readonly fetchCapsuleDetailImpl?: typeof fetchCapsuleDetail;
}

export function CapsuleActions({
  capsuleId,
  capsuleDisplayName,
  sourceCount,
  lifecycleState,
  vectorCompatible = true,
  onActionComplete,
  onDeleted,
  connectCapsuleSourceImpl = connectCapsuleSource,
  deleteCapsuleImpl = deleteCapsule,
  refreshCapsuleImpl = refreshCapsuleChangedFiles,
  repairCapsuleImpl = repairCapsuleFailedFiles,
  reembedCapsuleImpl = reembedCapsuleForCurrentModel,
  startIndexingImpl = startIndexing,
  fetchCapsuleDetailImpl = fetchCapsuleDetail,
}: CapsuleActionsProps): ReactNode {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [indexBusy, setIndexBusy] = useState(false);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const progressActive =
    progress !== null && (indexBusy || (busy && confirm !== null && confirm.kind !== "delete"));

  useEffect(() => {
    if (!progressActive) return undefined;
    const tick = window.setInterval(() => {
      setProgress((current) => (current === null ? current : { ...current, now: Date.now() }));
    }, 1_000);
    return () => window.clearInterval(tick);
  }, [progressActive]);

  useEffect(() => {
    if (!progressActive) return undefined;
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const detail = await fetchCapsuleDetailImpl(capsuleId);
        if (cancelled) return;
        setProgress((current) =>
          current === null
            ? {
                detail,
                startedAt: Date.now(),
                now: Date.now(),
                pollError: null,
              }
            : { ...current, detail, now: Date.now(), pollError: null },
        );
      } catch (error) {
        if (cancelled) return;
        setProgress((current) =>
          current === null
            ? current
            : { ...current, now: Date.now(), pollError: formatError(error) },
        );
      }
    }
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [capsuleId, fetchCapsuleDetailImpl, progressActive]);

  async function handleIndex(): Promise<void> {
    if (indexBusy) return;
    setProgress(initialProgressState());
    setIndexBusy(true);
    setIndexError(null);
    try {
      await startIndexingImpl(capsuleId);
      setProgress(null);
      onActionComplete();
    } catch (error) {
      setIndexError(formatError(error));
    } finally {
      setIndexBusy(false);
    }
  }

  function openModal(kind: ActionKind): void {
    setActionError(null);
    setProgress(null);
    setConfirm({ kind, nameInput: "" });
  }

  function handleCancel(): void {
    if (busy) return;
    setConfirm(null);
    setActionError(null);
    setProgress(null);
  }

  function handleNameChange(value: string): void {
    setConfirm((prev) => (prev !== null ? { ...prev, nameInput: value } : null));
  }

  async function runAction(
    kind: ActionKind,
    action: () => Promise<CapsuleActionResponse>,
  ): Promise<void> {
    if (kind !== "delete") setProgress(initialProgressState());
    setBusy(true);
    setActionError(null);
    try {
      const response = await action();
      setProgress(null);
      setConfirm(null);
      if (kind === "delete") {
        if (onDeleted !== undefined) onDeleted(response);
        else onActionComplete();
      } else {
        onActionComplete();
      }
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
      void runAction(kind, () => deleteCapsuleImpl(capsuleId));
    } else if (kind === "refresh") {
      void runAction(kind, () => refreshCapsuleImpl(capsuleId));
    } else if (kind === "reembed") {
      void runAction(kind, () => reembedCapsuleImpl(capsuleId));
    } else {
      void runAction(kind, () => repairCapsuleImpl(capsuleId));
    }
  }

  const showIndexButton = sourceCount > 0 && lifecycleState !== "ready";
  const showReembedButton = sourceCount > 0 && !vectorCompatible;
  const actionDisabled = busy || indexBusy || lifecycleState === "indexing";

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
      <p className="lkd-limit-note">{localKnowledgeLimitSummary()}</p>

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
          {indexBusy && progress !== null ? (
            <ActionProgress kind="index" progress={progress} />
          ) : null}
        </div>
      ) : null}

      <div
        role="group"
        aria-label={`Actions for capsule ${capsuleDisplayName}`}
        className="lkd-actions-group"
      >
        {showReembedButton ? (
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-label={`Re-index capsule ${capsuleDisplayName} for current embedding model`}
            disabled={actionDisabled}
            onClick={() => openModal("reembed")}
          >
            Re-index for current model
          </button>
        ) : null}
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-label={`Refresh changed files for capsule ${capsuleDisplayName}`}
          disabled={actionDisabled}
          onClick={() => openModal("refresh")}
        >
          Refresh changed files
        </button>
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          aria-label={`Repair failed files for capsule ${capsuleDisplayName}`}
          disabled={actionDisabled}
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
          progress={progress}
          onNameChange={handleNameChange}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      ) : null}
    </section>
  );
}
