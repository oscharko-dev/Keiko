"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  buildPatchPreview,
  type EditorPreviewedPatch,
  type PatchPreviewModel,
} from "@oscharko-dev/keiko-editor";
import type {
  EditorLocalHistoryEntry,
  EditorLocalHistoryOrigin,
} from "@oscharko-dev/keiko-contracts";

import {
  ApiError,
  deleteEditorLocalHistory,
  fetchEditorLocalHistory,
  fetchEditorLocalHistoryEntry,
  setEditorLocalHistoryPinned,
} from "../../../../../lib/api";
import { useLocale, useTranslate, type I18nTranslate } from "../../../../../lib/i18n";
import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { Icons } from "../../Icons";

import type { EditorDiffSurfaceProps } from "./EditorDiffSurface";
import styles from "./EditorFileHistoryPanel.module.css";

const CloseIcon = Icons.close;
const PinIcon = Icons.pin;

const HistoryDiffSurface = dynamic<EditorDiffSurfaceProps>(() => import("./EditorDiffSurface"), {
  ssr: false,
  loading: () => <div className={styles.diffLoading} aria-hidden="true" />,
});

const HISTORY_ROW_HEIGHT = 148;
const HISTORY_OVERSCAN = 3;

export interface HistoryVirtualWindow {
  readonly start: number;
  readonly end: number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
}

export function historyVirtualWindow(
  entryCount: number,
  scrollTop: number,
  viewportHeight: number,
): HistoryVirtualWindow {
  const safeCount = Math.max(0, entryCount);
  const first = Math.floor(Math.max(0, scrollTop) / HISTORY_ROW_HEIGHT);
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / HISTORY_ROW_HEIGHT));
  const start = Math.max(0, first - HISTORY_OVERSCAN);
  const end = Math.min(safeCount, first + visible + HISTORY_OVERSCAN);
  return {
    start,
    end,
    paddingStart: start * HISTORY_ROW_HEIGHT,
    paddingEnd: Math.max(0, (safeCount - end) * HISTORY_ROW_HEIGHT),
  };
}

/**
 * Resolve the row a roving-focus key should move to, over the WHOLE history chain rather than the
 * virtualized window (#2617). Returns `null` when the key moves nothing — an unknown key, or an
 * edge the caller is already sitting on — so the caller can leave that key to the browser instead
 * of swallowing it with `preventDefault` and giving the user neither movement nor a fallback.
 */
function historyFocusKeyTarget(key: string, index: number, last: number): number | null {
  switch (key) {
    case "ArrowDown":
      return index + 1;
    case "ArrowUp":
      return index - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

export function historyFocusTarget(index: number, key: string, entryCount: number): number | null {
  const last = entryCount - 1;
  const target = historyFocusKeyTarget(key, index, last);
  if (target === null || target === index || target < 0 || target > last) return null;
  return target;
}

export function editorLocalHistorySizeDelta(
  entries: readonly EditorLocalHistoryEntry[],
  index: number,
): number {
  const entry = entries[index];
  if (entry === undefined) return 0;
  return entry.plaintextByteLength - (entries[index + 1]?.plaintextByteLength ?? 0);
}

interface HistoryContent {
  readonly entry: EditorLocalHistoryEntry;
  readonly content: string;
}

interface HistoryComparison {
  readonly model: PatchPreviewModel;
  readonly description: string;
}

type PendingAction =
  | { readonly kind: "restore"; readonly checkpoint: HistoryContent }
  | { readonly kind: "delete"; readonly entry: EditorLocalHistoryEntry };

interface HistorySnapshot {
  readonly status: "loading" | "ready" | "error";
  readonly session: "active" | "unpaired";
  readonly entries: readonly EditorLocalHistoryEntry[];
}

export interface EditorFileHistoryPanelProps {
  readonly root: string;
  readonly file: string;
  readonly currentContent: string;
  readonly dirty: boolean;
  readonly onClose: () => void;
  readonly onRestore: (content: string) => Promise<boolean>;
}

function textEndPosition(text: string): { readonly line: number; readonly column: number } {
  const lines = text.split("\n");
  return { line: lines.length - 1, column: lines.at(-1)?.length ?? 0 };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function buildEditorHistoryDiffModel(
  file: string,
  left: string,
  right: string,
  patchId: string,
): PatchPreviewModel {
  const patch: EditorPreviewedPatch = {
    patchId,
    status: "previewed",
    provenance: { origin: "applied-patch" },
    changes: [
      {
        uri: file,
        edits: [
          {
            range: { start: { line: 0, column: 0 }, end: textEndPosition(left) },
            newText: right,
          },
        ],
        isNewFile: false,
        isDeletion: false,
      },
    ],
  };
  return buildPatchPreview({
    patch,
    sources: {
      [file]: {
        content: {
          relativePath: file,
          sizeBytes: byteLength(left),
          text: left,
          truncated: false,
        },
      },
    },
  });
}

function originLabel(origin: EditorLocalHistoryOrigin, t: I18nTranslate): string {
  switch (origin) {
    case "user-save":
      return t("editor.fileHistory.origin.userSave");
    case "agent-apply":
      return t("editor.fileHistory.origin.agentApply");
    case "pre-restore":
      return t("editor.fileHistory.origin.restore");
  }
}

function sizeDeltaLabel(delta: number, locale: string): string {
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat(locale).format(delta)} B`;
}

function historyErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.code === "ENTRY_NOT_FOUND" ? "pruned" : fallback;
}

function useHistorySnapshot(
  root: string,
  file: string,
): {
  readonly snapshot: HistorySnapshot;
  readonly reload: () => void;
  readonly replaceEntry: (entry: EditorLocalHistoryEntry) => void;
  readonly removeEntry: (entryRef: string) => void;
} {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<HistorySnapshot>({
    status: "loading",
    session: "active",
    entries: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot((current) => ({ ...current, status: "loading" }));
    void fetchEditorLocalHistory(root, file, controller.signal)
      .then((response) => {
        setSnapshot({ status: "ready", session: response.session, entries: response.entries });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSnapshot({ status: "error", session: "active", entries: [] });
        }
      });
    return () => controller.abort();
  }, [file, revision, root]);

  const replaceEntry = useCallback((entry: EditorLocalHistoryEntry): void => {
    setSnapshot((current) => ({
      ...current,
      entries: current.entries.map((candidate) =>
        candidate.entryRef === entry.entryRef ? entry : candidate,
      ),
    }));
  }, []);
  const removeEntry = useCallback((entryRef: string): void => {
    setSnapshot((current) => ({
      ...current,
      entries: current.entries.filter((entry) => entry.entryRef !== entryRef),
    }));
  }, []);
  return {
    snapshot,
    reload: () => setRevision((current) => current + 1),
    replaceEntry,
    removeEntry,
  };
}

function HistoryHeader({
  file,
  onClose,
}: {
  readonly file: string;
  readonly onClose: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <header className={styles.header}>
      <div className={styles.headingGroup}>
        <span className={styles.heading}>{t("editor.fileHistory.title")}</span>
        <span className={styles.file} title={file}>
          {file}
        </span>
      </div>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={t("editor.fileHistory.close")}
        onClick={onClose}
      >
        <CloseIcon size={16} />
      </button>
    </header>
  );
}

function HistoryEmptyState({
  snapshot,
  reload,
}: {
  readonly snapshot: HistorySnapshot;
  readonly reload: () => void;
}): ReactNode {
  const t = useTranslate();
  if (snapshot.status === "loading") {
    return <p className={styles.state}>{t("editor.fileHistory.loading")}</p>;
  }
  if (snapshot.status === "error") {
    return (
      <div className={styles.state} role="alert">
        <p>{t("editor.fileHistory.loadFailed")}</p>
        <button type="button" className={styles.actionButton} onClick={reload}>
          {t("editor.fileHistory.retry")}
        </button>
      </div>
    );
  }
  if (snapshot.session === "unpaired") {
    return <p className={styles.state}>{t("editor.fileHistory.unpaired")}</p>;
  }
  return <p className={styles.state}>{t("editor.fileHistory.empty")}</p>;
}

interface HistoryRowProps {
  readonly entry: EditorLocalHistoryEntry;
  readonly index: number;
  readonly delta: number;
  readonly compareBaseRef: string | null;
  readonly onFocusRelative: (index: number, key: string) => boolean;
  readonly onCompareCurrent: (entry: EditorLocalHistoryEntry) => void;
  readonly onSelectCompare: (entry: EditorLocalHistoryEntry) => void;
  readonly onCompareSelected: (entry: EditorLocalHistoryEntry) => void;
  readonly onRestore: (entry: EditorLocalHistoryEntry) => void;
  readonly onPin: (entry: EditorLocalHistoryEntry) => void;
  readonly onDelete: (entry: EditorLocalHistoryEntry) => void;
  readonly registerRow: (entryRef: string, element: HTMLButtonElement | null) => void;
}

function HistoryRow(props: HistoryRowProps): ReactNode {
  const t = useTranslate();
  const locale = useLocale();
  const origin = originLabel(props.entry.origin, t);
  const timestamp = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(props.entry.recordedAt));
  const label = t("editor.fileHistory.entryLabel", {
    sequence: props.entry.sequence,
    origin,
    timestamp,
  });
  return (
    <li className={styles.row} data-entry-ref={props.entry.entryRef}>
      <button
        ref={(element) => props.registerRow(props.entry.entryRef, element)}
        type="button"
        className={styles.rowSummary}
        aria-label={label}
        aria-pressed={props.compareBaseRef === props.entry.entryRef}
        title={t("editor.fileHistory.selectCompare")}
        onClick={() => props.onSelectCompare(props.entry)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          // Only a key that actually moved focus is consumed; anything else keeps its default
          // behaviour (the list still scrolls at the edges) instead of dying silently.
          if (props.onFocusRelative(props.index, event.key)) event.preventDefault();
        }}
      >
        <span className={styles.rowTitle}>
          <span>{origin}</span>
          {props.entry.pinned ? (
            <span className={styles.pinnedBadge}>
              <PinIcon size={12} /> {t("editor.fileHistory.pinned")}
            </span>
          ) : null}
        </span>
        <time dateTime={props.entry.recordedAt}>{timestamp}</time>
        <span>
          {t("editor.fileHistory.sizeDelta", { delta: sizeDeltaLabel(props.delta, locale) })}
        </span>
      </button>
      <div className={styles.actions}>
        <button type="button" onClick={() => props.onCompareCurrent(props.entry)}>
          {t("editor.fileHistory.compareCurrent")}
        </button>
        {props.compareBaseRef !== null && props.compareBaseRef !== props.entry.entryRef ? (
          <button type="button" onClick={() => props.onCompareSelected(props.entry)}>
            {t("editor.fileHistory.compareSelected")}
          </button>
        ) : null}
        <button type="button" onClick={() => props.onRestore(props.entry)}>
          {t("editor.fileHistory.restore")}
        </button>
        <button type="button" onClick={() => props.onPin(props.entry)}>
          {props.entry.pinned ? t("editor.fileHistory.unpin") : t("editor.fileHistory.pin")}
        </button>
        <button type="button" onClick={() => props.onDelete(props.entry)}>
          {t("editor.fileHistory.delete")}
        </button>
      </div>
    </li>
  );
}

interface HistoryListProps extends Omit<
  HistoryRowProps,
  "entry" | "index" | "delta" | "onFocusRelative" | "registerRow"
> {
  readonly entries: readonly EditorLocalHistoryEntry[];
}

function HistoryList(props: HistoryListProps): ReactNode {
  const t = useTranslate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // A traversal target outside the mounted window has no element to focus yet; remember it so the
  // row claims focus from `registerRow` at the moment the virtualizer mounts it.
  const pendingFocusRef = useRef<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(HISTORY_ROW_HEIGHT * 3);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const update = (): void => setViewportHeight(viewport.clientHeight);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, []);
  const windowed = historyVirtualWindow(props.entries.length, scrollTop, viewportHeight);
  const visible = props.entries.slice(windowed.start, windowed.end);
  const focusMounted = (button: HTMLButtonElement): void => {
    pendingFocusRef.current = null;
    button.focus();
    button.scrollIntoView?.({ block: "nearest" });
  };
  const focusRelative = (index: number, key: string): boolean => {
    const targetIndex = historyFocusTarget(index, key, props.entries.length);
    if (targetIndex === null) return false;
    const entry = props.entries[targetIndex];
    if (entry === undefined) return false;
    const mounted = rowRefs.current.get(entry.entryRef);
    if (mounted !== undefined) {
      focusMounted(mounted);
      return true;
    }
    // Scroll the target into the virtual window using the same clamp the browser applies, so the
    // committed scroll offset and the window this component derives from it cannot disagree.
    pendingFocusRef.current = entry.entryRef;
    const maxScrollTop = Math.max(
      0,
      props.entries.length * HISTORY_ROW_HEIGHT - Math.max(0, viewportHeight),
    );
    const offset = Math.min(targetIndex * HISTORY_ROW_HEIGHT, maxScrollTop);
    if (viewportRef.current !== null) viewportRef.current.scrollTop = offset;
    setScrollTop(offset);
    return true;
  };
  const registerRow = (entryRef: string, element: HTMLButtonElement | null): void => {
    if (element === null) {
      rowRefs.current.delete(entryRef);
      return;
    }
    rowRefs.current.set(entryRef, element);
    if (pendingFocusRef.current === entryRef) focusMounted(element);
  };
  return (
    <div
      ref={viewportRef}
      className={styles.listViewport}
      data-testid="file-history-virtual-list"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <ul className={styles.list} aria-label={t("editor.fileHistory.listLabel")}>
        <li aria-hidden="true" style={{ height: windowed.paddingStart }} />
        {visible.map((entry, offset) => (
          <HistoryRow
            {...props}
            key={entry.entryRef}
            entry={entry}
            index={windowed.start + offset}
            delta={editorLocalHistorySizeDelta(props.entries, windowed.start + offset)}
            onFocusRelative={focusRelative}
            registerRow={registerRow}
          />
        ))}
        <li aria-hidden="true" style={{ height: windowed.paddingEnd }} />
      </ul>
    </div>
  );
}

function ConfirmAction({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly pending: PendingAction;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const t = useTranslate();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // `aria-modal="true"` is a promise that focus stays inside; honour it with the shared containment
  // primitive instead of a second implementation, and hand focus back to the invoking row action on
  // unmount so a cancelled confirm does not strand the user on <body> (#2617). Same contract as the
  // workspace-trust decision dialog.
  useDialogTabTrap(dialogRef);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);
  useEffect(() => {
    const cancelOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", cancelOnEscape);
    return () => document.removeEventListener("keydown", cancelOnEscape);
  }, [busy, onCancel]);
  const restore = pending.kind === "restore";
  return (
    <div className={styles.confirmBackdrop}>
      <div
        ref={dialogRef}
        className={styles.confirm}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="file-history-confirm-title"
        aria-describedby="file-history-confirm-body"
        tabIndex={-1}
      >
        <h3 id="file-history-confirm-title">
          {t(restore ? "editor.fileHistory.restoreTitle" : "editor.fileHistory.deleteTitle")}
        </h3>
        <p id="file-history-confirm-body">
          {t(restore ? "editor.fileHistory.restoreBody" : "editor.fileHistory.deleteBody")}
        </p>
        <div className={styles.confirmActions}>
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
            {t("editor.fileHistory.cancel")}
          </button>
          <button type="button" disabled={busy} onClick={onConfirm}>
            {t(restore ? "editor.fileHistory.confirmRestore" : "editor.fileHistory.confirmDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryComparisonView({
  comparison,
  onClose,
  onError,
}: {
  readonly comparison: HistoryComparison;
  readonly onClose: () => void;
  readonly onError: () => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.comparison}>
      <div className={styles.comparisonHeader}>
        <span>{t("editor.fileHistory.compareTitle")}</span>
        <span className={styles.comparisonDescription}>{comparison.description}</span>
        <button type="button" onClick={onClose}>
          {t("editor.fileHistory.closeCompare")}
        </button>
      </div>
      <div className={styles.diff}>
        <HistoryDiffSurface
          model={comparison.model}
          loadState={{ status: "ready" }}
          actions={{ canApply: false, canReject: false, canRunVerification: false }}
          onRuntimeError={onError}
        />
      </div>
    </div>
  );
}

// One component owns only ephemeral browser content: checkpoint bodies remain in this mounted panel
// or the read-only diff surface and are never written to localStorage, IndexedDB, telemetry, or logs.
// eslint-disable-next-line max-lines-per-function -- orchestration stays here so content cannot escape into a durable store.
export function EditorFileHistoryPanel(props: EditorFileHistoryPanelProps): ReactNode {
  const t = useTranslate();
  const { snapshot, reload, replaceEntry, removeEntry } = useHistorySnapshot(
    props.root,
    props.file,
  );
  const contentCache = useRef(new Map<string, HistoryContent>());
  const [notice, setNotice] = useState<string | null>(null);
  const [compareBase, setCompareBase] = useState<HistoryContent | null>(null);
  const [comparison, setComparison] = useState<HistoryComparison | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => panelRef.current?.focus(), []);
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && pending === null) props.onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [pending, props]);

  const readEntry = useCallback(
    async (entry: EditorLocalHistoryEntry): Promise<HistoryContent | null> => {
      const cached = contentCache.current.get(entry.entryRef);
      if (cached !== undefined) return cached;
      try {
        const response = await fetchEditorLocalHistoryEntry(props.root, entry.entryRef);
        contentCache.current.set(entry.entryRef, response);
        return response;
      } catch (error: unknown) {
        const message = historyErrorMessage(error, t("editor.fileHistory.loadFailed"));
        if (message === "pruned") removeEntry(entry.entryRef);
        setNotice(message === "pruned" ? t("editor.fileHistory.pruned") : message);
        return null;
      }
    },
    [props.root, removeEntry, t],
  );

  const compareWithCurrent = useCallback(
    async (entry: EditorLocalHistoryEntry): Promise<void> => {
      const checkpoint = await readEntry(entry);
      if (checkpoint === null) return;
      setComparison({
        model: buildEditorHistoryDiffModel(
          props.file,
          checkpoint.content,
          props.currentContent,
          `history-current-${entry.entryRef}`,
        ),
        description: `${originLabel(entry.origin, t)} → ${t("editor.fileHistory.compareCurrent")}`,
      });
    },
    [props.currentContent, props.file, readEntry, t],
  );

  const selectCompareBase = useCallback(
    async (entry: EditorLocalHistoryEntry): Promise<void> => {
      const checkpoint = await readEntry(entry);
      if (checkpoint !== null) setCompareBase(checkpoint);
    },
    [readEntry],
  );

  const compareWithSelected = useCallback(
    async (entry: EditorLocalHistoryEntry): Promise<void> => {
      if (compareBase === null) return;
      const checkpoint = await readEntry(entry);
      if (checkpoint === null) return;
      setComparison({
        model: buildEditorHistoryDiffModel(
          props.file,
          compareBase.content,
          checkpoint.content,
          `history-pair-${compareBase.entry.entryRef}-${entry.entryRef}`,
        ),
        description: `${String(compareBase.entry.sequence)} → ${String(entry.sequence)}`,
      });
    },
    [compareBase, props.file, readEntry],
  );

  const requestRestore = useCallback(
    async (entry: EditorLocalHistoryEntry): Promise<void> => {
      if (props.dirty) {
        setNotice(t("editor.fileHistory.dirtyConflict"));
        return;
      }
      const checkpoint = await readEntry(entry);
      if (checkpoint !== null) setPending({ kind: "restore", checkpoint });
    },
    [props.dirty, readEntry, t],
  );

  const togglePin = useCallback(
    async (entry: EditorLocalHistoryEntry): Promise<void> => {
      try {
        const response = await setEditorLocalHistoryPinned(
          props.root,
          entry.entryRef,
          !entry.pinned,
        );
        replaceEntry(response.entry);
      } catch {
        setNotice(t("editor.fileHistory.pinFailed"));
      }
    },
    [props.root, replaceEntry, t],
  );

  const confirmPending = useCallback(async (): Promise<void> => {
    if (pending === null || busy) return;
    setBusy(true);
    if (pending.kind === "restore") {
      const restored = await props.onRestore(pending.checkpoint.content);
      if (restored) reload();
      else setNotice(t("editor.fileHistory.restoreFailed"));
    } else {
      try {
        await deleteEditorLocalHistory(props.root, pending.entry.entryRef);
        contentCache.current.delete(pending.entry.entryRef);
        removeEntry(pending.entry.entryRef);
        if (compareBase?.entry.entryRef === pending.entry.entryRef) setCompareBase(null);
      } catch {
        setNotice(t("editor.fileHistory.deleteFailed"));
      }
    }
    setBusy(false);
    setPending(null);
  }, [busy, compareBase?.entry.entryRef, pending, props, reload, removeEntry, t]);

  const entriesVisible = snapshot.status === "ready" && snapshot.entries.length > 0;
  const listOrEmpty = entriesVisible ? (
    <HistoryList
      entries={snapshot.entries}
      compareBaseRef={compareBase?.entry.entryRef ?? null}
      onCompareCurrent={(entry) => void compareWithCurrent(entry)}
      onSelectCompare={(entry) => void selectCompareBase(entry)}
      onCompareSelected={(entry) => void compareWithSelected(entry)}
      onRestore={(entry) => void requestRestore(entry)}
      onPin={(entry) => void togglePin(entry)}
      onDelete={(entry) => setPending({ kind: "delete", entry })}
    />
  ) : (
    <HistoryEmptyState snapshot={snapshot} reload={reload} />
  );
  const historyBody =
    comparison === null ? (
      listOrEmpty
    ) : (
      <HistoryComparisonView
        comparison={comparison}
        onClose={() => setComparison(null)}
        onError={() => setNotice(t("editor.fileHistory.loadFailed"))}
      />
    );
  return (
    <aside
      ref={panelRef}
      className={styles.panel}
      aria-label={t("editor.fileHistory.title")}
      tabIndex={-1}
    >
      <HistoryHeader file={props.file} onClose={props.onClose} />
      {notice !== null ? (
        <div className={styles.notice} role="alert">
          <span>{notice}</span>
          <button type="button" aria-label={t("common.dismiss")} onClick={() => setNotice(null)}>
            <CloseIcon size={13} />
          </button>
        </div>
      ) : null}
      {historyBody}
      {pending !== null ? (
        <ConfirmAction
          pending={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        />
      ) : null}
    </aside>
  );
}
