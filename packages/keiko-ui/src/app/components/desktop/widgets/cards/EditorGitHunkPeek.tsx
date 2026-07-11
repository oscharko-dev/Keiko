"use client";

import { useEffect, useRef, type ReactElement } from "react";
import type { EditorGitGutterPeek } from "@oscharko-dev/keiko-editor";

import { DiffHunkView } from "./shared/diffView";
import styles from "./EditorGitHunkPeek.module.css";

export interface EditorGitHunkPeekLabels {
  readonly close: string;
  readonly staged: string;
  readonly unstaged: string;
  readonly title: string;
  readonly truncated: string;
  readonly hunkHeader: string;
  readonly addedLine: string;
  readonly deletedLine: string;
  readonly contextLine: string;
  readonly metadataLine: string;
}

export interface EditorGitHunkPeekProps {
  readonly path: string;
  readonly peek: EditorGitGutterPeek;
  readonly labels: EditorGitHunkPeekLabels;
  readonly onClose: () => void;
}

export function EditorGitHunkPeek(props: EditorGitHunkPeekProps): ReactElement {
  const { onClose } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [onClose]);
  const extension = props.path.includes(".") ? (props.path.split(".").pop() ?? "code") : "code";
  const layer = props.peek.layer === "staged" ? props.labels.staged : props.labels.unstaged;
  return (
    <section
      className={styles.peek}
      role="dialog"
      aria-modal="false"
      aria-label={`${props.labels.title}: ${props.path}, ${layer}`}
      data-testid="editor-git-hunk-peek"
    >
      <header className={styles.header}>
        <span className={styles.title}>{`${props.labels.title}: ${props.path} · ${layer}`}</span>
        <button
          ref={closeRef}
          type="button"
          className={styles.close}
          aria-label={props.labels.close}
          onClick={props.onClose}
        >
          ×
        </button>
      </header>
      {props.peek.hunk.truncated ? (
        <div className={styles.notice} role="note">
          {props.labels.truncated}
        </div>
      ) : null}
      <DiffHunkView
        hunk={props.peek.hunk}
        lang={extension}
        labels={{
          header: props.labels.hunkHeader,
          add: props.labels.addedLine,
          del: props.labels.deletedLine,
          ctx: props.labels.contextLine,
          meta: props.labels.metadataLine,
        }}
      />
    </section>
  );
}
