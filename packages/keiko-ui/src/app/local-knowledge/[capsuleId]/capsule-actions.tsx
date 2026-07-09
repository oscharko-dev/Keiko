"use client";

// Issue #198 — Destructive-action buttons for the capsule detail page.
// Issue #189 / #682 — SOURCE-CONNECT: connect folder/file scopes + Index now actions.
// Three modal actions: Delete, Refresh changed files, Repair failed files.
// Two inline actions: Connect a source (manual scope input), Index now (button).
// Delete requires typing the capsule display name before confirming (Foundry IQ pattern).
// Refresh and Repair use a single "Are you sure?" step.
//
// Focus trap: Tab/Shift+Tab cycle within the dialog; Escape cancels.
// WCAG: min 30×30 button targets, focus-visible ring, colour tokens for danger text.

import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LOCAL_KNOWLEDGE_FILE_FILTERS } from "@oscharko-dev/keiko-contracts";
import type {
  KnowledgeCapsuleId,
  CapsuleLifecycleState,
  LocalKnowledgeFileFilterId,
  NativeFileDialogFilter,
} from "@oscharko-dev/keiko-contracts";
import {
  connectCapsuleSource,
  deleteCapsule,
  fetchCapsuleDetail,
  rebuildCapsuleIndex,
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
import { formatBytes, formatDurationCompact as formatDuration } from "@/lib/format";
import {
  LOCAL_KNOWLEDGE_MAX_FILE_BYTES,
  LOCAL_KNOWLEDGE_MAX_OBJECTS_PER_DOCUMENT,
  LOCAL_KNOWLEDGE_PARSER_TIMEOUT_MS,
} from "@/lib/local-knowledge-limits";
import { useModalInteractionLock } from "@/app/components/desktop/hooks/useModalInteractionLock";
import { useNativeFileDialogCapability } from "@/app/components/desktop/hooks/useNativeFileDialogCapability";
import { nativePathsToRootAndFiles, pickWithNativeDialog } from "@/lib/native-file-dialog";
import { useLocale } from "@/lib/i18n";
import {
  useLocalKnowledgeTranslate as useTranslate,
  type I18nTranslate,
  type LocalKnowledgeMessageKey,
} from "../local-knowledge-i18n";
import { formatError } from "../format-error";
import detailStyles from "../capsule-detail.module.css";
import { Explainable } from "../detail-help";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActionKind = "delete" | "refresh" | "repair" | "reembed" | "rebuild";
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

function actionTitle(kind: ActionKind, t: I18nTranslate): string {
  if (kind === "delete") return t("localKnowledge.detail.actions.delete.title");
  if (kind === "reembed") return t("localKnowledge.detail.actions.reembed.title");
  if (kind === "rebuild") return t("localKnowledge.detail.actions.rebuild.title");
  if (kind === "refresh") return t("localKnowledge.detail.actions.refresh.title");
  return t("localKnowledge.detail.actions.repair.title");
}

function actionDescription(kind: ActionKind, capsuleDisplayName: string, t: I18nTranslate): string {
  if (kind === "delete") {
    return t("localKnowledge.detail.actions.delete.description", { name: capsuleDisplayName });
  }
  if (kind === "refresh") {
    return t("localKnowledge.detail.actions.refresh.description");
  }
  if (kind === "reembed") {
    return t("localKnowledge.detail.actions.reembed.description");
  }
  if (kind === "rebuild") {
    return t("localKnowledge.detail.actions.rebuild.description");
  }
  return t("localKnowledge.detail.actions.repair.description");
}

function confirmButtonLabel(kind: ActionKind, busy: boolean, t: I18nTranslate): string {
  if (busy) return t("common.working");
  if (kind === "delete") return t("common.delete");
  if (kind === "reembed") return t("localKnowledge.detail.actions.reembed.confirm");
  if (kind === "rebuild") return t("localKnowledge.detail.actions.rebuild.confirm");
  if (kind === "refresh") return t("localKnowledge.detail.actions.refresh.confirm");
  return t("localKnowledge.detail.actions.repair.confirm");
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100).toString()}%`;
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

function localKnowledgeLimitSummary(t: I18nTranslate, locale: string): string {
  return t("localKnowledge.detail.connect.limitSummary", {
    size: formatBytes(LOCAL_KNOWLEDGE_MAX_FILE_BYTES, locale),
    objects: LOCAL_KNOWLEDGE_MAX_OBJECTS_PER_DOCUMENT.toLocaleString(locale),
    duration: formatLimitDuration(LOCAL_KNOWLEDGE_PARSER_TIMEOUT_MS),
  });
}

const FILE_FILTER_LABEL_KEYS: Readonly<
  Record<LocalKnowledgeFileFilterId, LocalKnowledgeMessageKey>
> = Object.freeze({
  documents: "localKnowledge.detail.connect.filter.documents",
  structuredData: "localKnowledge.detail.connect.filter.structuredData",
  textDocuments: "localKnowledge.detail.connect.filter.textDocuments",
  webDocuments: "localKnowledge.detail.connect.filter.webDocuments",
  scripts: "localKnowledge.detail.connect.filter.scripts",
  sourceCode: "localKnowledge.detail.connect.filter.sourceCode",
  configuration: "localKnowledge.detail.connect.filter.configuration",
});

function nativeDocumentFilters(t: I18nTranslate): readonly NativeFileDialogFilter[] {
  return LOCAL_KNOWLEDGE_FILE_FILTERS.map((filter) => ({
    name: t(FILE_FILTER_LABEL_KEYS[filter.id]),
    extensions: filter.extensions,
  }));
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

function buildScope(rootPath: string, filesInput: string): ConnectCapsuleSourceScope | null {
  const trimmedRoot = rootPath.trim();
  if (trimmedRoot === "") return null;
  const files = parseFilesInput(filesInput);
  if (files.length === 0) {
    return { kind: "folder", rootPath: trimmedRoot, recursive: true };
  }
  return { kind: "files", rootPath: trimmedRoot, files };
}

function selectedSourceSummary(
  rootPath: string,
  filesInput: string,
  t: I18nTranslate,
): string | null {
  const trimmedRoot = rootPath.trim();
  if (trimmedRoot === "") return null;
  const fileCount = parseFilesInput(filesInput).length;
  if (fileCount > 0) {
    return t("localKnowledge.detail.connect.selectedDocuments", {
      count: fileCount.toString(),
      root: trimmedRoot,
    });
  }
  return t("localKnowledge.detail.connect.selectedSource", { path: trimmedRoot });
}

function ConnectSourceForm({
  capsuleId,
  onConnected,
  connectImpl = connectCapsuleSource,
}: ConnectSourceFormProps): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const [rootPath, setRootPath] = useState("");
  const [filesInput, setFilesInput] = useState("");
  const [specificFilesExpanded, setSpecificFilesExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const nativeNoteId = useId();
  const nativeDialogSupported = useNativeFileDialogCapability();
  const scope = buildScope(rootPath, filesInput);
  const selectedSource = selectedSourceSummary(rootPath, filesInput, t);
  const documentFilters = nativeDocumentFilters(t);

  function handleNativeOutcome(
    outcome: Awaited<ReturnType<typeof pickWithNativeDialog>>,
    onPicked: (paths: readonly string[]) => void,
  ): void {
    if (outcome.kind === "picked") {
      onPicked(outcome.paths);
      setConnectError(null);
      return;
    }
    if (outcome.kind === "busy") setConnectError(t("localKnowledge.nativeDialog.busy"));
    if (outcome.kind === "unsupported") {
      setConnectError(t("localKnowledge.nativeDialog.unavailable"));
    }
    if (outcome.kind === "error") setConnectError(outcome.message);
  }

  // ADR-0118 keeps file and directory native-dialog modes separate. The UI presents both as
  // Knowledgequelle actions and normalizes the selected paths into the single source contract.
  function openNativeFolderPicker(): void {
    void pickWithNativeDialog({
      mode: "open-directory",
      title: t("localKnowledge.detail.connect.chooseFolder"),
      ...(rootPath.trim().length > 0 ? { defaultPath: rootPath.trim() } : {}),
    }).then((outcome) => {
      handleNativeOutcome(outcome, (paths) => {
        const picked = paths[0];
        if (picked !== undefined) setRootPath(picked);
        setFilesInput("");
        setSpecificFilesExpanded(false);
      });
    });
  }

  function openNativeFilesPicker(): void {
    void pickWithNativeDialog({
      mode: "open-files",
      title: t("localKnowledge.detail.connect.chooseFiles"),
      filters: documentFilters,
      ...(rootPath.trim().length > 0 ? { defaultPath: rootPath.trim() } : {}),
    }).then((outcome) => {
      handleNativeOutcome(outcome, (paths) => {
        const mapped = nativePathsToRootAndFiles(paths);
        setRootPath(mapped.rootPath);
        setFilesInput(mapped.files.join("\n"));
        setSpecificFilesExpanded(true);
      });
    });
  }

  async function handleConnect(): Promise<void> {
    if (scope === null || busy) return;
    setBusy(true);
    setConnectError(null);
    try {
      await connectImpl(capsuleId, scope);
      setRootPath("");
      setFilesInput("");
      setSpecificFilesExpanded(false);
      onConnected();
    } catch (error) {
      setConnectError(formatError(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lkd-connect-form" aria-label={t("localKnowledge.detail.connect.region")}>
      <div className={detailStyles.sourcePickerPanel}>
        <div className={detailStyles.sourcePickerCopy}>
          <Explainable description={t("localKnowledge.detail.help.sourceSetup")}>
            <span className={detailStyles.sourcePickerTitle}>
              {t("localKnowledge.detail.connect.sourcePickerTitle")}
            </span>
          </Explainable>
          <span className={detailStyles.sourcePickerDescription}>
            {t("localKnowledge.detail.connect.sourcePickerDescription")}
          </span>
          <span className={detailStyles.sourcePickerFormats}>
            {t("localKnowledge.detail.connect.supportedFormats", {
              size: formatBytes(LOCAL_KNOWLEDGE_MAX_FILE_BYTES, locale),
            })}
          </span>
        </div>
        <div className={detailStyles.sourcePickerActions}>
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            disabled={busy || !nativeDialogSupported}
            aria-describedby={nativeDialogSupported ? undefined : nativeNoteId}
            title={t("localKnowledge.detail.help.sourceSetup")}
            onClick={openNativeFolderPicker}
          >
            {t("localKnowledge.detail.connect.pickFolderSource")}
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            disabled={busy || !nativeDialogSupported}
            aria-describedby={nativeDialogSupported ? undefined : nativeNoteId}
            title={t("localKnowledge.detail.help.sourceSetup")}
            onClick={openNativeFilesPicker}
          >
            {t("localKnowledge.detail.connect.pickDocumentSource")}
          </button>
        </div>
      </div>
      {selectedSource !== null ? (
        <p className={detailStyles.selectedSourceNote}>{selectedSource}</p>
      ) : null}
      {!nativeDialogSupported ? (
        <span id={nativeNoteId} className="dlg-note">
          {t("localKnowledge.nativeDialog.unavailable")}
        </span>
      ) : null}
      <div className="lkd-connect-row">
        <label htmlFor="lkd-connect-path-input" className="dlg-label">
          <Explainable description={t("localKnowledge.detail.help.sourcePath")}>
            {t("localKnowledge.detail.connect.sourcePath")}
          </Explainable>
        </label>
        <div className="lkd-connect-path-group">
          <input
            id="lkd-connect-path-input"
            type="text"
            className="dlg-input lkd-connect-input"
            value={rootPath}
            disabled={busy}
            placeholder="/absolute/path/to/source"
            autoComplete="off"
            onChange={(e: ChangeEvent<HTMLInputElement>) => setRootPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConnect();
            }}
          />
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            disabled={busy || scope === null}
            aria-busy={busy}
            onClick={() => void handleConnect()}
          >
            {busy
              ? t("localKnowledge.detail.connect.connecting")
              : t("localKnowledge.detail.connect.connect")}
          </button>
        </div>
      </div>
      <details
        className={detailStyles.specificFilesDisclosure}
        open={specificFilesExpanded}
        onToggle={(event) => setSpecificFilesExpanded(event.currentTarget.open)}
      >
        <summary className={detailStyles.specificFilesSummary}>
          <span>
            <Explainable description={t("localKnowledge.detail.help.specificFiles")}>
              {t("localKnowledge.detail.connect.specificFiles")}
            </Explainable>
          </span>
          <span className={detailStyles.disclosureIcon} aria-hidden="true" />
        </summary>
        <label htmlFor="lkd-connect-files-input" className="dlg-label">
          {t("localKnowledge.detail.connect.relativeFiles")}
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
      </details>
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
  readonly progress: ProgressState | null;
  readonly onNameChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function ActionProgress({
  kind,
  progress,
  t,
}: {
  kind: ProgressActionKind;
  progress: ProgressState;
  t: I18nTranslate;
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
      ? t("localKnowledge.detail.progress.indexing")
      : kind === "reembed"
        ? t("localKnowledge.detail.progress.reembedding")
        : kind === "refresh"
          ? t("localKnowledge.detail.progress.refreshing")
          : t("localKnowledge.detail.progress.repairing");
  const etaLabel =
    docsPerMs > 0 && totalDocuments > completed
      ? t("localKnowledge.detail.progress.remaining", { duration: formatDuration(etaMs) })
      : t("localKnowledge.detail.progress.estimating");

  return (
    <div
      className="lkd-action-progress"
      role="status"
      aria-live="polite"
      title={t("localKnowledge.detail.help.actionProgress")}
    >
      <div className="lkd-action-progress-head">
        <span>{actionLabel}</span>
        <span>{statusLabel}</span>
      </div>
      <div className="lkd-action-progress-note">
        {t("localKnowledge.detail.progress.elapsed", {
          duration: formatDuration(elapsedMs),
          eta: etaLabel,
        })}
      </div>
      <div className="lkd-status-bars">
        <div className="lkd-status-bar-row" title={t("localKnowledge.detail.help.actionDocuments")}>
          <span>{t("localKnowledge.detail.progress.documents")}</span>
          <ProgressBar
            value={documentProgress}
            label={t("localKnowledge.detail.progress.documentProgress")}
          />
          <span>
            {completed.toString()} / {totalDocuments.toString()}
          </span>
        </div>
        <div className="lkd-status-bar-row" title={t("localKnowledge.detail.help.actionVectors")}>
          <span>{t("localKnowledge.detail.progress.vectors")}</span>
          <ProgressBar
            value={vectorProgress}
            label={t("localKnowledge.detail.progress.vectorProgress")}
          />
          <span>
            {vectorCount.toString()} / {chunkCount.toString()}
          </span>
        </div>
      </div>
      {progress.pollError !== null ? (
        <div className="lkd-action-progress-note">
          {t("localKnowledge.detail.progress.delayed", { error: progress.pollError })}
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
  const t = useTranslate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  useModalInteractionLock();
  useFocusTrap(dialogRef, true, onCancel);

  // Auto-focus the confirmation input when the modal opens. Done via ref + effect (not
  // autoFocus) so the focus only fires when the dialog mounts and not on every re-render —
  // satisfies jsx-a11y/no-autofocus while preserving the "type the pod name" flow.
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
              {actionTitle(kind, t)}
            </div>
            <div id={descId} className="dlg-sub">
              {actionDescription(kind, capsuleDisplayName, t)}
            </div>
          </div>
        </div>

        {requiresTypedName ? (
          <div className="dlg-body">
            <div className="dlg-field">
              <label htmlFor="lkd-confirm-name-input" className="dlg-label">
                {t("localKnowledge.detail.actions.delete.confirmName")}
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
            {busy && progress !== null ? (
              <ActionProgress kind={kind} progress={progress} t={t} />
            ) : null}
            {error !== null ? (
              <div role="alert" className="lk-alert">
                {error}
              </div>
            ) : null}
          </div>
        )}

        <div className="dlg-foot">
          <button type="button" className="dlg-btn" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dlg-btn lkd-btn-destructive"
            disabled={!confirmEnabled}
            aria-disabled={!confirmEnabled}
            onClick={onConfirm}
          >
            {confirmButtonLabel(kind, busy, t)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// AffectedSetsNotice — AUDIT-E1821-001: deleting a capsule that belongs to one or
// more Knowledge Pod Sets cascades the membership row out silently. The delete
// response already carries affectedCapsuleSetIds; this surfaces it as a visible,
// must-acknowledge notice before navigating away, instead of discarding it.
// ---------------------------------------------------------------------------

function AffectedSetsNotice({
  affectedCapsuleSetCount,
  onContinue,
}: {
  readonly affectedCapsuleSetCount: number;
  readonly onContinue: () => void;
}): ReactNode {
  const t = useTranslate();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalInteractionLock();
  useFocusTrap(dialogRef, true, onContinue);

  const titleId = "lkd-affected-sets-title";
  const descId = "lkd-affected-sets-desc";

  return createPortal(
    <div className="dlg-overlay in" role="presentation">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="dlg"
        tabIndex={-1}
      >
        <div className="dlg-head">
          <div className="dlg-htext">
            <div id={titleId} className="dlg-title">
              {t("localKnowledge.detail.deleteAffectedSets.title")}
            </div>
            <div id={descId} className="dlg-sub">
              {t(
                affectedCapsuleSetCount === 1
                  ? "localKnowledge.detail.deleteAffectedSets.description.one"
                  : "localKnowledge.detail.deleteAffectedSets.description.many",
                { count: affectedCapsuleSetCount },
              )}
            </div>
          </div>
        </div>
        <div className="dlg-foot">
          <button type="button" className="dlg-btn" onClick={onContinue}>
            {t("common.continue")}
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
  readonly contextualRebuildRequired?: boolean;
  readonly onActionComplete: () => void;
  readonly onDeleted?: (response: CapsuleActionResponse) => void;
  // Injectable seams for tests
  readonly connectCapsuleSourceImpl?: typeof connectCapsuleSource;
  readonly deleteCapsuleImpl?: typeof deleteCapsule;
  readonly refreshCapsuleImpl?: typeof refreshCapsuleChangedFiles;
  readonly repairCapsuleImpl?: typeof repairCapsuleFailedFiles;
  readonly reembedCapsuleImpl?: typeof reembedCapsuleForCurrentModel;
  readonly rebuildCapsuleImpl?: typeof rebuildCapsuleIndex;
  readonly startIndexingImpl?: typeof startIndexing;
  readonly fetchCapsuleDetailImpl?: typeof fetchCapsuleDetail;
}

export function CapsuleActions({
  capsuleId,
  capsuleDisplayName,
  sourceCount,
  lifecycleState,
  vectorCompatible = true,
  contextualRebuildRequired = false,
  onActionComplete,
  onDeleted,
  connectCapsuleSourceImpl = connectCapsuleSource,
  deleteCapsuleImpl = deleteCapsule,
  refreshCapsuleImpl = refreshCapsuleChangedFiles,
  repairCapsuleImpl = repairCapsuleFailedFiles,
  reembedCapsuleImpl = reembedCapsuleForCurrentModel,
  rebuildCapsuleImpl = rebuildCapsuleIndex,
  startIndexingImpl = startIndexing,
  fetchCapsuleDetailImpl = fetchCapsuleDetail,
}: CapsuleActionsProps): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // AUDIT-E1821-001: delayed onDeleted — when the delete response reports affected
  // Knowledge Pod Sets, hold navigation until the user acknowledges the notice.
  const [pendingDeleteResponse, setPendingDeleteResponse] = useState<CapsuleActionResponse | null>(
    null,
  );
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
            : { ...current, now: Date.now(), pollError: formatError(error, t) },
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
  }, [capsuleId, fetchCapsuleDetailImpl, progressActive, t]);

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
      setIndexError(formatError(error, t));
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
        if ((response.affectedCapsuleSetIds?.length ?? 0) > 0) {
          setPendingDeleteResponse(response);
        } else if (onDeleted !== undefined) {
          onDeleted(response);
        } else {
          onActionComplete();
        }
      } else {
        onActionComplete();
      }
    } catch (error) {
      setActionError(formatError(error, t));
    } finally {
      setBusy(false);
    }
  }

  function handleContinueAfterDelete(): void {
    if (pendingDeleteResponse === null) return;
    const response = pendingDeleteResponse;
    setPendingDeleteResponse(null);
    if (onDeleted !== undefined) onDeleted(response);
    else onActionComplete();
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
    } else if (kind === "rebuild") {
      void runAction(kind, () => rebuildCapsuleImpl(capsuleId));
    } else {
      void runAction(kind, () => repairCapsuleImpl(capsuleId));
    }
  }

  const showIndexButton = sourceCount > 0 && lifecycleState !== "ready";
  const showReembedButton = sourceCount > 0;
  const showRebuildButton = sourceCount > 0;
  const reembedRecommended = sourceCount > 0 && !vectorCompatible;
  const actionDisabled = busy || indexBusy || lifecycleState === "indexing";

  // Rendered as its own block BELOW the .lk-header row (capsule-detail.tsx):
  // the multi-line connect form used to be squeezed into the header flex row
  // next to the H1 (uiux-fix F033, C104).
  return (
    <section
      className={`lkd-tools ${detailStyles.sourceSetup}`}
      aria-labelledby="lkd-source-setup-heading"
    >
      <div className={detailStyles.sourceSetupHeader}>
        <div>
          <h2 id="lkd-source-setup-heading" className={detailStyles.sourceSetupTitle}>
            <Explainable description={t("localKnowledge.detail.help.sourceSetup")}>
              {t("localKnowledge.detail.connect.title")}
            </Explainable>
          </h2>
          <p className={detailStyles.sourceSetupDescription}>
            {t("localKnowledge.detail.connect.description")}
          </p>
        </div>
      </div>
      <ConnectSourceForm
        capsuleId={capsuleId}
        onConnected={onActionComplete}
        connectImpl={connectCapsuleSourceImpl}
      />

      {showIndexButton ? (
        <div className={`lkd-index-row ${detailStyles.indexPrompt}`}>
          <button
            type="button"
            className="lk-btn lk-btn-primary"
            aria-label={t("localKnowledge.detail.actions.index.aria")}
            aria-busy={indexBusy}
            disabled={indexBusy}
            title={t("localKnowledge.detail.help.indexNow")}
            onClick={() => void handleIndex()}
          >
            {indexBusy
              ? t("localKnowledge.detail.actions.index.busy")
              : t("localKnowledge.detail.actions.index.button")}
          </button>
          {indexError !== null ? (
            <div role="alert" aria-live="assertive" className="lk-alert">
              {indexError}
            </div>
          ) : null}
          {indexBusy && progress !== null ? (
            <ActionProgress kind="index" progress={progress} t={t} />
          ) : null}
        </div>
      ) : null}

      <details className={detailStyles.maintenanceDisclosure}>
        <summary className={detailStyles.disclosureSummary}>
          <span>
            <Explainable description={t("localKnowledge.detail.help.maintenance")}>
              {t("localKnowledge.detail.actions.maintenance")}
            </Explainable>
          </span>
          <span>{t("localKnowledge.detail.actions.maintenanceHint")}</span>
          <span className={detailStyles.disclosureIcon} aria-hidden="true" />
        </summary>
        <p className="lkd-limit-note" title={t("localKnowledge.detail.help.maintenanceLimits")}>
          {localKnowledgeLimitSummary(t, locale)}
        </p>
        <div
          role="group"
          aria-label={t("localKnowledge.detail.actions.group", { name: capsuleDisplayName })}
          className="lkd-actions-group"
        >
          {showReembedButton ? (
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              data-recommended={reembedRecommended ? "true" : "false"}
              aria-label={t("localKnowledge.detail.actions.reembed.aria", {
                name: capsuleDisplayName,
              })}
              title={t("localKnowledge.detail.help.actionReembed")}
              disabled={actionDisabled}
              onClick={() => openModal("reembed")}
            >
              {t("localKnowledge.detail.actions.reembed.button")}
            </button>
          ) : null}
          {showRebuildButton ? (
            <button
              type="button"
              className="lk-btn lk-btn-ghost"
              data-recommended={contextualRebuildRequired ? "true" : "false"}
              aria-label={t("localKnowledge.detail.actions.rebuild.aria", {
                name: capsuleDisplayName,
              })}
              title={t("localKnowledge.detail.help.actionRebuild")}
              disabled={actionDisabled}
              onClick={() => openModal("rebuild")}
            >
              {t("localKnowledge.detail.actions.rebuild.button")}
            </button>
          ) : null}
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-label={t("localKnowledge.detail.actions.refresh.aria", {
              name: capsuleDisplayName,
            })}
            title={t("localKnowledge.detail.help.actionRefresh")}
            disabled={actionDisabled}
            onClick={() => openModal("refresh")}
          >
            {t("localKnowledge.detail.actions.refresh.button")}
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-ghost"
            aria-label={t("localKnowledge.detail.actions.repair.aria", {
              name: capsuleDisplayName,
            })}
            title={t("localKnowledge.detail.help.actionRepair")}
            disabled={actionDisabled}
            onClick={() => openModal("repair")}
          >
            {t("localKnowledge.detail.actions.repair.button")}
          </button>
          <button
            type="button"
            className="lk-btn lk-btn-danger"
            aria-label={t("localKnowledge.detail.actions.delete.aria", {
              name: capsuleDisplayName,
            })}
            title={t("localKnowledge.detail.help.actionDelete")}
            onClick={() => openModal("delete")}
          >
            {t("common.delete")}
          </button>
        </div>
      </details>

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

      {pendingDeleteResponse !== null ? (
        <AffectedSetsNotice
          affectedCapsuleSetCount={pendingDeleteResponse.affectedCapsuleSetIds?.length ?? 0}
          onContinue={handleContinueAfterDelete}
        />
      ) : null}
    </section>
  );
}
