/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The virtualized file list and diff are named keyboard-scrollable regions. */
"use client";

import { useMemo, useState, type ReactNode, type UIEvent } from "react";
import type { GitChangedFile } from "@oscharko-dev/keiko-contracts";

import {
  useCodingWorkbenchChanges,
  type CodingWorkbenchChangesClient,
  type UseCodingWorkbenchChangesResult,
} from "@/lib/useCodingWorkbenchChanges";
import { DiffFileSection, type DiffViewLabels } from "../cards/shared/diffView";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import styles from "./CodingWorkbenchWindow.module.css";

const VIRTUAL_THRESHOLD = 80;
const VISIBLE_ROWS = 24;
const OVERSCAN_ROWS = 6;
const ROW_HEIGHT = 54;

export interface CodingWorkbenchChangesProps {
  readonly root: string | null;
  readonly runId: string | undefined;
  readonly changeSignal: string | null;
  readonly bindingPending: boolean;
  readonly client?: CodingWorkbenchChangesClient | undefined;
}

export function CodingWorkbenchChanges(props: CodingWorkbenchChangesProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const changes = useCodingWorkbenchChanges(props);
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-changes-title">
      <PanelTitle
        eyebrow={t("codingWorkbench.changes.eyebrow")}
        id="coding-workbench-changes-title"
      >
        {t("codingWorkbench.changes.title")}
      </PanelTitle>
      <p className={styles.helpText}>{t("codingWorkbench.changes.help")}</p>
      <ChangesContent changes={changes} t={t} />
    </section>
  );
}

function ChangesContent({
  changes,
  t,
}: {
  readonly changes: UseCodingWorkbenchChangesResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (changes.status === "idle") return <ChangesMessage text={t("codingWorkbench.changes.idle")} />;
  if (changes.status === "loading") {
    return <ChangesMessage role="status" text={t("codingWorkbench.changes.loading")} />;
  }
  if (changes.status === "binding-lost") {
    return <ChangesMessage role="alert" text={t("codingWorkbench.changes.bindingLost")} />;
  }
  if (changes.status === "unavailable") {
    return (
      <RetryMessage text={t("codingWorkbench.changes.unavailable")} retry={changes.retry} t={t} />
    );
  }
  if (changes.status === "error") {
    return <RetryMessage text={t("codingWorkbench.changes.error")} retry={changes.retry} t={t} />;
  }
  return <ReadyChanges changes={changes} t={t} />;
}

function ChangesMessage({
  text,
  role,
}: {
  readonly text: string;
  readonly role?: "status" | "alert" | undefined;
}): ReactNode {
  return (
    <p className={styles.changesMessage} role={role}>
      {text}
    </p>
  );
}

function RetryMessage({
  text,
  retry,
  t,
}: {
  readonly text: string;
  readonly retry: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles.changesMessage} role="alert">
      <p>{text}</p>
      <button className={styles.button} type="button" onClick={retry}>
        {t("codingWorkbench.changes.retry")}
      </button>
    </div>
  );
}

function ReadyChanges({
  changes,
  t,
}: {
  readonly changes: UseCodingWorkbenchChangesResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <>
      <p className={styles.changesRevision} role="status" aria-live="polite">
        {t("codingWorkbench.changes.asOf", { head: changes.head ?? "HEAD" })}
      </p>
      {changes.files.length === 0 ? (
        <ChangesMessage text={t("codingWorkbench.changes.empty")} />
      ) : (
        <div className={styles.changesLayout}>
          <ChangedFileList changes={changes} t={t} />
          <SelectedDiff changes={changes} t={t} />
        </div>
      )}
      {changes.truncated ? (
        <output className={styles.changesNotice}>
          {t("codingWorkbench.changes.filesTruncated")}
        </output>
      ) : null}
    </>
  );
}

interface FileWindow {
  readonly virtual: boolean;
  readonly start: number;
  readonly visible: readonly GitChangedFile[];
  readonly end: number;
  readonly onScroll: (event: UIEvent<HTMLUListElement>) => void;
}

function useFileWindow(files: readonly GitChangedFile[]): FileWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const virtual = files.length > VIRTUAL_THRESHOLD;
  const maxStart = Math.max(0, files.length - VISIBLE_ROWS);
  const start = virtual
    ? Math.min(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS), maxStart)
    : 0;
  const visible = virtual ? files.slice(start, start + VISIBLE_ROWS) : files;
  const onScroll = (event: UIEvent<HTMLUListElement>): void =>
    setScrollTop(event.currentTarget.scrollTop);
  return { virtual, start, visible, end: start + visible.length, onScroll };
}

function ChangedFileList({
  changes,
  t,
}: {
  readonly changes: UseCodingWorkbenchChangesResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const window = useFileWindow(changes.files);
  return (
    <div className={styles.changesFiles}>
      <p className={styles.changesPaneTitle} id="coding-workbench-changed-files-title">
        {t("codingWorkbench.changes.changedFiles", { count: changes.files.length })}
      </p>
      {window.virtual ? (
        <p className={styles.helpText} id="coding-workbench-changes-list-help">
          {t("codingWorkbench.changes.virtualInstructions")}
        </p>
      ) : null}
      <ul
        className={styles.changesFileList}
        aria-labelledby="coding-workbench-changed-files-title"
        aria-describedby={window.virtual ? "coding-workbench-changes-list-help" : undefined}
        tabIndex={window.virtual ? 0 : undefined}
        onScroll={window.onScroll}
      >
        {window.virtual && window.start > 0 ? (
          <FileSpacer size={window.start * ROW_HEIGHT} />
        ) : null}
        {window.visible.map((file) => (
          <ChangedFileButton key={file.path} file={file} changes={changes} t={t} />
        ))}
        {window.virtual && window.end < changes.files.length ? (
          <FileSpacer size={(changes.files.length - window.end) * ROW_HEIGHT} />
        ) : null}
      </ul>
    </div>
  );
}

function FileSpacer({ size }: { readonly size: number }): ReactNode {
  return <li className={styles.changesSpacer} style={{ blockSize: size }} aria-hidden="true" />;
}

function ChangedFileButton({
  file,
  changes,
  t,
}: {
  readonly file: GitChangedFile;
  readonly changes: UseCodingWorkbenchChangesResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const selected = changes.selectedPath === file.path;
  return (
    <li className={styles.changesFileItem}>
      <button
        className={styles.changesFileButton}
        type="button"
        aria-pressed={selected}
        onClick={() => changes.selectPath(file.path)}
      >
        <span className={styles.changesPath} title={file.path}>
          {file.path}
        </span>
        <span className={styles.changesFileState}>{changedFileState(file, t)}</span>
      </button>
    </li>
  );
}

function changedFileState(file: GitChangedFile, t: CodingWorkbenchTranslate): string {
  if (file.conflicted) return t("codingWorkbench.changes.fileState.conflicted");
  if (file.untracked) return t("codingWorkbench.changes.fileState.untracked");
  if (file.staged && file.unstaged) return t("codingWorkbench.changes.fileState.stagedAndUnstaged");
  if (file.staged) return t("codingWorkbench.changes.fileState.staged");
  return t("codingWorkbench.changes.fileState.unstaged");
}

function diffLabels(t: CodingWorkbenchTranslate): DiffViewLabels {
  return {
    addedLine: t("codingWorkbench.changes.diff.addedLine"),
    deletedLine: t("codingWorkbench.changes.diff.deletedLine"),
    contextLine: t("codingWorkbench.changes.diff.contextLine"),
    metadataLine: t("codingWorkbench.changes.diff.metadataLine"),
    hunkHeader: t("codingWorkbench.changes.diff.hunkHeader"),
    hunkTruncated: t("codingWorkbench.changes.diff.hunkTruncated"),
    fileTruncated: t("codingWorkbench.changes.diff.fileTruncated"),
    binaryFile: t("codingWorkbench.changes.diff.binaryFile"),
    previousPath: (path) => t("codingWorkbench.changes.diff.previousPath", { path }),
    elevatedReview: t("codingWorkbench.changes.diff.elevatedReview"),
  };
}

function SelectedDiff({
  changes,
  t,
}: {
  readonly changes: UseCodingWorkbenchChangesResult;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const labels = useMemo(() => diffLabels(t), [t]);
  return (
    <div className={styles.changesDiffPane}>
      <p className={styles.changesPaneTitle}>{t("codingWorkbench.changes.diff.title")}</p>
      <section
        className={`${styles.changesDiff} review`}
        aria-label={t("codingWorkbench.changes.diff.region")}
        tabIndex={0}
      >
        <DiffContent changes={changes} labels={labels} t={t} />
      </section>
    </div>
  );
}

function DiffContent({
  changes,
  labels,
  t,
}: {
  readonly changes: UseCodingWorkbenchChangesResult;
  readonly labels: DiffViewLabels;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (changes.diffStatus === "loading") {
    return <ChangesMessage role="status" text={t("codingWorkbench.changes.diff.loading")} />;
  }
  if (changes.diffStatus === "error") {
    return <ChangesMessage role="alert" text={t("codingWorkbench.changes.diff.error")} />;
  }
  if (changes.diffStatus === "empty" || changes.diff === null) {
    return <ChangesMessage text={t("codingWorkbench.changes.diff.empty")} />;
  }
  return (
    <div className="rv-body">
      {changes.diffTruncated ? (
        <output className="rv-truncated">{t("codingWorkbench.changes.diff.truncated")}</output>
      ) : null}
      {changes.diff.files.map((file, index) => (
        <DiffFileSection
          key={`${file.path}:${String(index)}`}
          file={file}
          index={index}
          idPrefix="coding-workbench-change-file"
          sectionRef={() => undefined}
          labels={labels}
        />
      ))}
    </div>
  );
}
