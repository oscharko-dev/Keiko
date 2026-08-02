"use client";

import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { createProject, projectResponseWarningMessage } from "../../../../../lib/api";
import { useTranslate } from "../../../../../lib/i18n";
import { pickWithNativeDialog } from "../../../../../lib/native-file-dialog";
import { useNativeFileDialogCapability } from "../../hooks/useNativeFileDialogCapability";
import { Icons } from "../../Icons";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
import styles from "./EditorEmptyState.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const EditorIcon = Icons.editor;
const FolderIcon = Icons.folder;

// Shown when the editor window is open without a bound project root (e.g. toggled from the left
// rail). Lets the user pick a project folder through the native OS picker (ADR-0118) — or type a
// path where the native picker is unavailable — and binds it via the parent's `onOpenRoot`.
export function EditorEmptyState({
  onOpenRoot,
}: {
  readonly onOpenRoot: (root: string) => void;
}): ReactNode {
  const t = useTranslate();
  const nativeSupported = useNativeFileDialogCapability();
  const [path, setPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connectProject = useCallback(
    async (selectedPath: string): Promise<void> => {
      setNotice(null);
      setConnecting(true);
      try {
        const response = await createProject({ path: selectedPath });
        const warning = projectResponseWarningMessage(response);
        if (warning !== undefined) {
          setNotice(warning);
          return;
        }
        if (response.project.workspaceAvailable !== true) {
          setNotice(t("editor.empty.workspaceUnavailable"));
          return;
        }
        onOpenRoot(response.project.path);
      } catch {
        setNotice(t("editor.empty.connectionFailed"));
      } finally {
        setConnecting(false);
      }
    },
    [onOpenRoot, t],
  );

  const browse = useCallback(async (): Promise<void> => {
    setNotice(null);
    const outcome = await pickWithNativeDialog({
      mode: "open-directory",
      title: t("editor.empty.pickerTitle"),
    });
    if (outcome.kind === "picked") {
      const picked = outcome.paths[0];
      if (picked !== undefined) await connectProject(picked);
      return;
    }
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "busy") setNotice(t("editor.empty.dialogBusy"));
    else if (outcome.kind === "unsupported") setNotice(t("editor.empty.pickerUnsupported"));
    else setNotice(outcome.message);
  }, [connectProject, t]);

  const openManual = useCallback((): void => {
    const trimmed = path.trim();
    if (trimmed.length > 0) void connectProject(trimmed);
  }, [connectProject, path]);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter") openManual();
    },
    [openManual],
  );

  return (
    <div className={styles.empty} role="note" data-testid="editor-empty-state">
      <span className={styles.icon} aria-hidden="true">
        <EditorIcon size={40} />
      </span>
      <h2 className={styles.title}>{t("editor.empty.title")}</h2>
      <p className={styles.desc}>{t("editor.empty.description")}</p>
      <button
        type="button"
        className={styles.primary}
        onClick={() => void browse()}
        disabled={!nativeSupported || connecting}
        data-testid="editor-empty-browse"
      >
        <FolderIcon size={16} />
        {connecting ? t("editor.empty.opening") : t("editor.empty.selectFolder")}
      </button>
      <div className={styles.manual}>
        <input
          className={styles.input}
          type="text"
          placeholder="/absolute/folder/path"
          aria-label={t("editor.empty.pathLabel")}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={onInputKeyDown}
          disabled={connecting}
        />
        <button
          type="button"
          className={styles.open}
          onClick={openManual}
          disabled={path.trim().length === 0 || connecting}
        >
          {connecting ? t("editor.empty.opening") : t("editor.empty.open")}
        </button>
      </div>
      {notice !== null ? (
        <output className={styles.notice} style={NATIVE_BLOCK_STYLE}>
          {notice}
        </output>
      ) : null}
    </div>
  );
}
