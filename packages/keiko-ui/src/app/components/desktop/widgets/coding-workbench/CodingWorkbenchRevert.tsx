"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  CodingWorkbenchRuntimeRevertAction,
  CodingWorkbenchRuntimeRevertState,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import windowStyles from "./CodingWorkbenchWindow.module.css";
import styles from "./CodingWorkbenchRevert.module.css";

export interface CodingWorkbenchRevertBarProps {
  /** Counts of the newest turn or of the staged undo; `null` when the run offers no undo. */
  readonly revert: CodingWorkbenchRuntimeRevertState | null;
  /** A runtime mutation is in flight: the control waits instead of racing it. */
  readonly busy: boolean;
  readonly onRevert: (action: CodingWorkbenchRuntimeRevertAction) => void;
}

function summaryText(
  revert: CodingWorkbenchRuntimeRevertState,
  t: CodingWorkbenchTranslate,
): string {
  const values = {
    count: revert.fileCount,
    additions: revert.additions,
    deletions: revert.deletions,
  };
  if (revert.staged) {
    return t(
      revert.fileCount === 1
        ? "codingWorkbench.revert.staged.one"
        : "codingWorkbench.revert.staged",
      values,
    );
  }
  if (revert.fileCount === 0) return t("codingWorkbench.revert.none");
  return t(
    revert.fileCount === 1
      ? "codingWorkbench.revert.summary.one"
      : "codingWorkbench.revert.summary",
    values,
  );
}

interface RevertConfirmationState {
  /** The action whose confirmation is open, or `null`. */
  readonly open: CodingWorkbenchRuntimeRevertAction | null;
  readonly ask: () => void;
  readonly close: () => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}

// A confirmation belongs to the action it was opened for: when the server flips between undo and
// restore, it is dropped rather than confirming something else. Closing returns focus to the
// control once nothing is in flight, so a keyboard user is never left on a removed element.
function useRevertConfirmation(
  action: CodingWorkbenchRuntimeRevertAction,
  busy: boolean,
): RevertConfirmationState {
  const [confirming, setConfirming] = useState<CodingWorkbenchRuntimeRevertAction | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const open = confirming === action ? confirming : null;
  useEffect(() => {
    if (!returnFocus.current || open !== null || busy) return;
    returnFocus.current = false;
    triggerRef.current?.focus();
  }, [open, busy]);
  return {
    open,
    ask: (): void => setConfirming(action),
    close: (): void => {
      returnFocus.current = true;
      setConfirming(null);
    },
    triggerRef,
  };
}

/**
 * Undo last turn / Restore changes (B3, S04). One action is offered at a time: Restore while an
 * undo is staged, Undo otherwise. Each asks for a confirmation first, because both rewrite
 * workspace files; the confirmation is keyboard-operable (focus lands on Cancel, Escape cancels and
 * returns to the control). The outcome arrives as the run's next revision, which re-reads the
 * counts; a refused request is reported by the Workbench's standing action alert.
 */
export function CodingWorkbenchRevertBar({
  revert,
  busy,
  onRevert,
}: CodingWorkbenchRevertBarProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const action: CodingWorkbenchRuntimeRevertAction = revert?.staged === true ? "restore" : "undo";
  const confirmation = useRevertConfirmation(action, busy);
  if (revert === null) return null;
  const { open } = confirmation;
  return (
    <section className={styles.cmpRevert} aria-label={t("codingWorkbench.revert.region")}>
      <p className={styles.cmpRevertSummary} role="status">
        {busy ? t("codingWorkbench.revert.busy") : summaryText(revert, t)}
      </p>
      {open === null ? (
        <button
          ref={confirmation.triggerRef}
          className={windowStyles.button}
          type="button"
          disabled={busy || !(revert.staged || revert.fileCount > 0)}
          onClick={confirmation.ask}
        >
          {t(action === "undo" ? "codingWorkbench.revert.undo" : "codingWorkbench.revert.restore")}
        </button>
      ) : (
        <RevertConfirmation
          action={open}
          busy={busy}
          onConfirm={() => {
            confirmation.close();
            onRevert(open);
          }}
          onCancel={confirmation.close}
          t={t}
        />
      )}
    </section>
  );
}

const CONFIRMATION_KEYS = {
  undo: {
    text: "codingWorkbench.revert.undo.confirm",
    action: "codingWorkbench.revert.undo.confirmAction",
  },
  restore: {
    text: "codingWorkbench.revert.restore.confirm",
    action: "codingWorkbench.revert.restore.confirmAction",
  },
} as const satisfies Record<
  CodingWorkbenchRuntimeRevertAction,
  Record<"text" | "action", CodingWorkbenchMessageKey>
>;

interface RevertConfirmationProps {
  readonly action: CodingWorkbenchRuntimeRevertAction;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly t: CodingWorkbenchTranslate;
}

function RevertConfirmation({
  action,
  busy,
  onConfirm,
  onCancel,
  t,
}: RevertConfirmationProps): ReactNode {
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The safe choice takes focus, so a stray Enter or Space never rewrites the workspace.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape cancels from any control inside the group; the buttons are the interactive elements.
    <div
      className={styles.cmpRevertConfirm}
      role="group"
      aria-labelledby={textId}
      onKeyDown={onKeyDown}
    >
      <p id={textId} className={styles.cmpRevertConfirmText}>
        {t(CONFIRMATION_KEYS[action].text)}
      </p>
      <div className={styles.cmpRevertActions}>
        <button ref={cancelRef} className={windowStyles.button} type="button" onClick={onCancel}>
          {t("codingWorkbench.revert.cancel")}
        </button>
        <button
          className={`${windowStyles.button} ${windowStyles.buttonPrimary}`}
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {t(CONFIRMATION_KEYS[action].action)}
        </button>
      </div>
    </div>
  );
}
