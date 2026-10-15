"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { ComposerEditorController } from "./composer-editor-controller";
import type { ComposerKeyEvent, MarkdownComposerProps } from "./composer-editor-types";
import styles from "./MarkdownComposer.module.css";

interface PendingChange {
  readonly owner: ComposerEditorController | null;
  readonly value: string;
  readonly cursor: number;
}

const DRAFT_PUBLICATION_DELAY_MS = 16;

function useComposerUnloadFlush(flush: () => boolean): void {
  useLayoutEffect(() => {
    const publish = (): void => {
      if (!flush()) return;
      reportClientDiagnostic("Keiko composer departure flushed the current draft.", {
        composerActivity: "literal-input-preserved",
      });
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === "hidden") publish();
    };
    // Publish the editor's final frame before the Chat draft persistence listener runs.
    window.addEventListener("beforeunload", publish, true);
    window.addEventListener("pagehide", publish, true);
    document.addEventListener("visibilitychange", visibilityChanged, true);
    return (): void => {
      window.removeEventListener("beforeunload", publish, true);
      window.removeEventListener("pagehide", publish, true);
      document.removeEventListener("visibilitychange", visibilityChanged, true);
    };
  }, [flush]);
}

function useDeferredComposerChange(
  controller: RefObject<ComposerEditorController | null>,
  current: RefObject<MarkdownComposerProps>,
  publishedValues: RefObject<string[]>,
): { publishChange: (value: string, cursor: number) => void; cancel: () => void } {
  const pending = useRef<PendingChange | null>(null);
  const pendingTimer = useRef<number | null>(null);
  const cancel = useCallback((): void => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    pending.current = null;
  }, []);
  const flush = useCallback((): boolean => {
    const change = pending.current;
    cancel();
    if (!change?.owner || controller.current !== change.owner) return false;
    publishedValues.current.push(change.value);
    current.current.onChange(change.value, change.cursor);
    return true;
  }, [cancel, controller, current, publishedValues]);
  useComposerUnloadFlush(flush);
  const publishChange = useCallback(
    (value: string, cursor: number): void => {
      const owner = controller.current;
      pending.current = { owner, value, cursor };
      if (pendingTimer.current !== null) return;
      pendingTimer.current = window.setTimeout(flush, DRAFT_PUBLICATION_DELAY_MS);
    },
    [controller, flush],
  );
  return { publishChange, cancel };
}

function shouldApplyDraft(
  value: string,
  previousValue: RefObject<string>,
  publishedValues: RefObject<string[]>,
): boolean {
  const acknowledged = publishedValues.current.indexOf(value);
  const isPreviousValue = value === previousValue.current;
  previousValue.current = value;
  if (acknowledged >= 0) publishedValues.current.splice(0, acknowledged + 1);
  else if (!isPreviousValue) publishedValues.current = [];
  return !isPreviousValue && acknowledged < 0;
}

function useComposerKeyDown(
  controller: RefObject<ComposerEditorController | null>,
  current: RefObject<MarkdownComposerProps>,
  publishedValues: RefObject<string[]>,
  cancel: () => void,
): (event: ComposerKeyEvent, value: string) => void {
  return useCallback(
    (event: ComposerKeyEvent, value: string): void => {
      const isEnter =
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.nativeEvent?.isComposing;
      if (isEnter && value !== current.current.value) {
        cancel();
        publishedValues.current.push(value);
        flushSync(() => current.current.onChange(value, controller.current?.selectionStart ?? -1));
        reportClientDiagnostic("Keiko composer Enter flushed the current draft.", {
          composerActivity: "literal-input-preserved",
        });
      }
      current.current.onKeyDown(event, value);
    },
    [cancel, controller, current, publishedValues],
  );
}

export function MarkdownComposer(props: MarkdownComposerProps): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ComposerEditorController | null>(null);
  const current = useRef(props);
  const publishedValues = useRef<string[]>([]);
  const previousValue = useRef(props.value);
  const [notice, setNotice] = useState("");
  const { publishChange, cancel } = useDeferredComposerChange(controller, current, publishedValues);
  const onKeyDown = useComposerKeyDown(controller, current, publishedValues, cancel);
  useLayoutEffect(() => {
    current.current = props;
  });
  useLayoutEffect(() => {
    if (!host.current) return;
    const editor = new ComposerEditorController(
      host.current,
      { ...current.current, onChange: publishChange, onKeyDown },
      setNotice,
    );
    controller.current = editor;
    previousValue.current = current.current.value;
    publishedValues.current = [];
    const inputRef = current.current.inputRef;
    inputRef.current = editor;
    return (): void => {
      editor.destroy();
      cancel();
      publishedValues.current = [];
      controller.current = null;
      inputRef.current = null;
    };
  }, [props.documentKey, publishChange, onKeyDown, cancel]);
  useLayoutEffect(() => {
    const applyValue = shouldApplyDraft(props.value, previousValue, publishedValues);
    if (applyValue) cancel();
    controller.current?.update({ ...props, onChange: publishChange, onKeyDown }, applyValue);
  });
  return (
    <div className={styles.cmpRoot} data-markdown-composer-scope="">
      <div ref={host} />
      {notice && <output className={styles.cmpNotice}>{notice}</output>}
    </div>
  );
}
