"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClientCodingWorkbenchDiffSurface } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import type { GitEditorDiffFile } from "@oscharko-dev/keiko-contracts";

import { reportCodingWorkbenchDiffWindowed } from "@/lib/coding-workbench-interaction";
import { useLocale } from "@/lib/i18n";
import { DiffFileSection, type DiffViewLabels } from "../cards/shared/diffView";
import {
  DIFF_WINDOW_PAGE_ROWS,
  diffFileMetrics,
  diffTotals,
  formatDiffBytes,
  isWindowedDiff,
  sliceDiffPage,
  type DiffPage,
} from "../cards/shared/diffWindow";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

// #4108 — the one place the Coding Workbench renders a parsed diff's files. A diff within the
// window threshold renders every file exactly as before. A larger one (a governed changeset may be
// 8 MiB) shows a file list with sizes, one file at a time, and one page of that file's lines at a
// time. Nothing is dropped: the totals and the position are always visible, and every file and page
// is one activation away. The pages are buttons and the position is a polite status, so keyboard
// and screen-reader users move through the diff without any scroll-position bookkeeping.

function ignoreSectionRef(): void {
  // The windowed view shows one file at a time, so there is no file list to scroll to.
}

export function CodingWorkbenchDiffFiles({
  surface,
  files,
  idPrefix,
  labels,
}: {
  /** Which Workbench surface shows the diff, for the one-time windowing report. */
  readonly surface: ClientCodingWorkbenchDiffSurface;
  readonly files: readonly GitEditorDiffFile[];
  readonly idPrefix: string;
  readonly labels: DiffViewLabels;
}): ReactNode {
  const windowed = useMemo(() => isWindowedDiff(files), [files]);
  if (windowed) {
    return <WindowedDiff surface={surface} files={files} idPrefix={idPrefix} labels={labels} />;
  }
  return (
    <>
      {files.map((file, index) => (
        <DiffFileSection
          key={`${file.path}:${String(index)}`}
          file={file}
          index={index}
          idPrefix={idPrefix}
          sectionRef={ignoreSectionRef}
          labels={labels}
        />
      ))}
    </>
  );
}

interface WindowPosition {
  readonly file: number;
  readonly page: number;
}

interface DiffWindowState {
  readonly fileIndex: number;
  readonly file: GitEditorDiffFile | undefined;
  readonly view: DiffPage | null;
  readonly selectFile: (index: number) => void;
  readonly selectPage: (page: number) => void;
}

function useNumberFormat(): (value: number) => string {
  const locale = useLocale();
  return useMemo(() => new Intl.NumberFormat(locale).format, [locale]);
}

function useDiffWindowState(
  surface: ClientCodingWorkbenchDiffSurface,
  files: readonly GitEditorDiffFile[],
): DiffWindowState {
  useReportWindowed(surface, files);
  const [position, setPosition] = useState<WindowPosition>({ file: 0, page: 0 });
  const fileIndex = Math.min(position.file, files.length - 1);
  const file = files[fileIndex];
  const selectFile = useCallback((index: number) => setPosition({ file: index, page: 0 }), []);
  const selectPage = useCallback(
    (page: number) => setPosition((current) => ({ ...current, page })),
    [],
  );
  const view = useMemo(
    () => (file === undefined ? null : sliceDiffPage(file, position.page)),
    [file, position.page],
  );
  return { fileIndex, file, view, selectFile, selectPage };
}

// One body-free report when a diff switches to the windowed view, not one per page turn: the
// counts of the diff identify it, so an equal re-render of the same diff reports nothing again.
function useReportWindowed(
  surface: ClientCodingWorkbenchDiffSurface,
  files: readonly GitEditorDiffFile[],
): void {
  const reported = useRef<string | null>(null);
  useEffect(() => {
    const totals = diffTotals(files);
    const signature = `${surface}:${String(totals.fileCount)}:${String(totals.rows)}:${String(totals.bytes)}`;
    if (reported.current === signature) return;
    reported.current = signature;
    reportCodingWorkbenchDiffWindowed(surface, {
      fileCount: totals.fileCount,
      totalLineCount: totals.rows,
      totalByteCount: totals.bytes,
    });
  }, [surface, files]);
}

function WindowedDiff({
  surface,
  files,
  idPrefix,
  labels,
}: {
  readonly surface: ClientCodingWorkbenchDiffSurface;
  readonly files: readonly GitEditorDiffFile[];
  readonly idPrefix: string;
  readonly labels: DiffViewLabels;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const formatNumber = useNumberFormat();
  const { fileIndex, file, view, selectFile, selectPage } = useDiffWindowState(surface, files);
  if (file === undefined || view === null) return null;
  const pages = (
    <WindowPages page={view.page} pageCount={view.pageCount} onSelect={selectPage} t={t} />
  );
  return (
    <>
      <WindowNotice files={files} formatNumber={formatNumber} t={t} />
      <WindowFileIndex
        files={files}
        active={fileIndex}
        formatNumber={formatNumber}
        onSelect={selectFile}
        t={t}
      />
      <WindowStatus
        file={file}
        fileIndex={fileIndex}
        fileCount={files.length}
        view={view}
        formatNumber={formatNumber}
        t={t}
      />
      {pages}
      <WindowedFileSection
        file={file}
        fileIndex={fileIndex}
        view={view}
        idPrefix={idPrefix}
        labels={labels}
      />
      {pages}
    </>
  );
}

function WindowedFileSection({
  file,
  fileIndex,
  view,
  idPrefix,
  labels,
}: {
  readonly file: GitEditorDiffFile;
  readonly fileIndex: number;
  readonly view: DiffPage;
  readonly idPrefix: string;
  readonly labels: DiffViewLabels;
}): ReactNode {
  return (
    <DiffFileSection
      key={`${file.path}:${String(fileIndex)}`}
      file={file}
      index={fileIndex}
      idPrefix={idPrefix}
      sectionRef={ignoreSectionRef}
      labels={labels}
      windowHunks={view.hunks}
      showFileTruncated={view.page === view.pageCount - 1}
    />
  );
}

function WindowStatus({
  file,
  fileIndex,
  fileCount,
  view,
  formatNumber,
  t,
}: {
  readonly file: GitEditorDiffFile;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly view: DiffPage;
  readonly formatNumber: (value: number) => string;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const place = { file: fileIndex + 1, files: fileCount };
  return (
    <p className={styles.changesRevision} role="status" aria-live="polite">
      {view.toRow === 0
        ? t("codingWorkbench.diffWindow.positionEmpty", place)
        : t("codingWorkbench.diffWindow.position", {
            ...place,
            from: formatNumber(view.fromRow),
            to: formatNumber(view.toRow),
            rows: formatNumber(diffFileMetrics(file).rows),
          })}
    </p>
  );
}

function WindowNotice({
  files,
  formatNumber,
  t,
}: {
  readonly files: readonly GitEditorDiffFile[];
  readonly formatNumber: (value: number) => string;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const totals = diffTotals(files);
  return (
    <p className={styles.changesNotice}>
      {t("codingWorkbench.diffWindow.notice", {
        rows: formatNumber(totals.rows),
        files: totals.fileCount,
        size: formatDiffBytes(totals.bytes, formatNumber),
        page: formatNumber(DIFF_WINDOW_PAGE_ROWS),
      })}
    </p>
  );
}

function WindowFileIndex({
  files,
  active,
  formatNumber,
  onSelect,
  t,
}: {
  readonly files: readonly GitEditorDiffFile[];
  readonly active: number;
  readonly formatNumber: (value: number) => string;
  readonly onSelect: (index: number) => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <ul className={styles.changesFileList} aria-label={t("codingWorkbench.diffWindow.files")}>
      {files.map((file, index) => (
        <li key={`${file.path}:${String(index)}`} className={styles.changesFileItem}>
          <button
            className={styles.changesFileButton}
            type="button"
            aria-pressed={index === active}
            onClick={() => onSelect(index)}
          >
            <span className={styles.changesPath} title={file.path}>
              {file.path}
            </span>
            <span className={styles.changesFileState}>{fileMeta(file, formatNumber, t)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function fileMeta(
  file: GitEditorDiffFile,
  formatNumber: (value: number) => string,
  t: CodingWorkbenchTranslate,
): string {
  const metrics = diffFileMetrics(file);
  const size = formatDiffBytes(metrics.bytes, formatNumber);
  if (file.binary) return t("codingWorkbench.diffWindow.fileMetaBinary");
  return t("codingWorkbench.diffWindow.fileMeta", {
    added: formatNumber(file.addedLines),
    removed: formatNumber(file.removedLines),
    size,
    rows: formatNumber(metrics.rows),
  });
}

function WindowPages({
  page,
  pageCount,
  onSelect,
  t,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly onSelect: (page: number) => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (pageCount <= 1) return null;
  const first = page <= 0;
  const last = page >= pageCount - 1;
  // aria-disabled, not disabled: activating the last page must not drop focus out of the control.
  return (
    <div
      className={styles.controls}
      role="group"
      aria-label={t("codingWorkbench.diffWindow.pages")}
    >
      <button
        className={styles.button}
        type="button"
        aria-disabled={first}
        onClick={() => {
          if (!first) onSelect(page - 1);
        }}
      >
        {t("codingWorkbench.diffWindow.previous")}
      </button>
      <span>{t("codingWorkbench.diffWindow.pageOf", { page: page + 1, pages: pageCount })}</span>
      <button
        className={styles.button}
        type="button"
        aria-disabled={last}
        onClick={() => {
          if (!last) onSelect(page + 1);
        }}
      >
        {t("codingWorkbench.diffWindow.next")}
      </button>
    </div>
  );
}
