"use client";

import type { ReactNode } from "react";
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import type { EditorOutlineNode } from "./editorOutlineModel";
import styles from "./EditorOutline.module.css";

export interface EditorBreadcrumbBarProps {
  readonly filePath: string | undefined;
  readonly path: readonly EditorOutlineNode[];
  readonly onReveal: (symbol: EditorDocumentSymbol) => void;
}

function basename(path: string | undefined): string {
  if (path === undefined || path.length === 0) return "Editor";
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function EditorBreadcrumbBar(props: EditorBreadcrumbBarProps): ReactNode {
  return (
    <nav className={styles.breadcrumbs} aria-label="Editor breadcrumbs">
      <span className={styles.breadcrumbFile}>{basename(props.filePath)}</span>
      {props.path.map((node) => (
        <span key={node.id} className={styles.breadcrumbSegment}>
          <span className={styles.breadcrumbSeparator} aria-hidden="true">
            /
          </span>
          <button
            type="button"
            className={styles.breadcrumbButton}
            onClick={() => props.onReveal(node.symbol)}
          >
            {node.symbol.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
