"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ComposerEditorController } from "./composer-editor-controller";
import type { MarkdownComposerProps } from "./composer-editor-types";
import styles from "./MarkdownComposer.module.css";

export function MarkdownComposer(props: MarkdownComposerProps): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ComposerEditorController | null>(null);
  const current = useRef(props);
  const [notice, setNotice] = useState("");
  useLayoutEffect(() => {
    current.current = props;
  });
  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new ComposerEditorController(host.current, current.current, setNotice);
    controller.current = editor;
    const inputRef = current.current.inputRef;
    inputRef.current = editor;
    return (): void => {
      editor.destroy();
      controller.current = null;
      inputRef.current = null;
    };
  }, [props.documentKey]);
  useLayoutEffect(() => {
    controller.current?.update(props);
  });
  return (
    <div className={styles.cmpRoot} data-markdown-composer-scope="">
      <div ref={host} />
      {notice && <output className={styles.cmpNotice}>{notice}</output>}
    </div>
  );
}
