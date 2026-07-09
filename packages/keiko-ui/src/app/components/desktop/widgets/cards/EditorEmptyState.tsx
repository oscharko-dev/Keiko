"use client";

import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { pickWithNativeDialog } from "../../../../../lib/native-file-dialog";
import { useNativeFileDialogCapability } from "../../hooks/useNativeFileDialogCapability";
import { Icons } from "../../Icons";
import styles from "./EditorEmptyState.module.css";

// Shown when the editor window is open without a bound project root (e.g. toggled from the left
// rail). Lets the user pick a project folder through the native OS picker (ADR-0118) — or type a
// path where the native picker is unavailable — and binds it via the parent's `onOpenRoot`.
export function EditorEmptyState({
  onOpenRoot,
}: {
  readonly onOpenRoot: (root: string) => void;
}): ReactNode {
  const nativeSupported = useNativeFileDialogCapability();
  const [path, setPath] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const browse = useCallback(async (): Promise<void> => {
    setNotice(null);
    const outcome = await pickWithNativeDialog({
      mode: "open-directory",
      title: "Select project folder",
    });
    if (outcome.kind === "picked") {
      const picked = outcome.paths[0];
      if (picked !== undefined) onOpenRoot(picked);
      return;
    }
    if (outcome.kind === "cancelled") return;
    if (outcome.kind === "busy") setNotice("A native dialog is already open. Close it first.");
    else if (outcome.kind === "unsupported")
      setNotice("The native folder picker is unavailable on this platform. Enter a path below.");
    else setNotice(outcome.message);
  }, [onOpenRoot]);

  const openManual = useCallback((): void => {
    const trimmed = path.trim();
    if (trimmed.length > 0) onOpenRoot(trimmed);
  }, [onOpenRoot, path]);

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter") openManual();
    },
    [openManual],
  );

  return (
    <div className={styles.empty} role="note" data-testid="editor-empty-state">
      <span className={styles.icon} aria-hidden="true">
        <Icons.editor size={40} />
      </span>
      <h2 className={styles.title}>Open a project</h2>
      <p className={styles.desc}>
        Choose a project folder to start editing. The editor works inside the selected workspace
        root.
      </p>
      <button
        type="button"
        className={styles.primary}
        onClick={() => void browse()}
        disabled={!nativeSupported}
        data-testid="editor-empty-browse"
      >
        <Icons.folder size={16} />
        Select folder…
      </button>
      <div className={styles.manual}>
        <input
          className={styles.input}
          type="text"
          placeholder="/absolute/folder/path"
          aria-label="Project folder path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <button
          type="button"
          className={styles.open}
          onClick={openManual}
          disabled={path.trim().length === 0}
        >
          Open
        </button>
      </div>
      {notice !== null ? (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
