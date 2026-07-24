import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { type CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import { activeRunState, runStateLabel } from "./codingWorkbenchLabels";
export { PanelTitle } from "./CodingWorkbenchPanelTitle";
export { Timeline } from "./CodingWorkbenchTimeline";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import { Icons } from "../../Icons";
import styles from "./CodingWorkbenchWindow.module.css";

export function WorkbenchHeader({
  state,
  focusRef,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly focusRef: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const sharedT = useTranslate();
  const snapshotState = state.run.value?.state ?? "idle";
  return (
    <header className={styles.header}>
      <h2 className={styles.title} ref={focusRef} tabIndex={-1}>
        {sharedT("rail.coding")}
      </h2>
      <span className={styles.statePill} data-state={snapshotState}>
        <span className={styles.statusSymbol} aria-hidden="true">
          {activeRunState(snapshotState) ? "●" : "○"}
        </span>
        {runStateLabel(snapshotState, t)}
      </span>
    </header>
  );
}

export interface TaskComposerActions {
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onSend: () => void;
}

export function TaskStartSection({
  taskIntent,
  onTaskIntentChange,
  actions,
  canStart,
  runState,
  mutationPending,
  startBusy,
}: {
  readonly taskIntent: string;
  readonly onTaskIntentChange: (value: string) => void;
  readonly actions: TaskComposerActions;
  readonly canStart: boolean;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly mutationPending: boolean;
  readonly startBusy: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const submitBlocked =
    mutationPending ||
    (runState !== "running" && taskIntent.trim().length === 0) ||
    (runState !== "running" && runState !== "paused" && (!canStart || startBusy));
  const submit = (): void => {
    if (submitBlocked) return;
    if (runState === "running") actions.onPause();
    else if (runState === "paused") actions.onSend();
    else actions.onStart();
  };
  useEffect((): void => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${String(Math.min(textarea.scrollHeight, 220))}px`;
  }, [taskIntent]);
  return (
    <form
      className="composer"
      aria-labelledby="coding-workbench-task-title"
      onSubmit={(event): void => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="sr-only" id="coding-workbench-task-title">
        {t("codingWorkbench.task.title")}
      </h3>
      <label className="sr-only" htmlFor="coding-workbench-task-intent">
        {t("codingWorkbench.task.instructions")}
      </label>
      <div className="cmp-box">
        <div className="cmp-input-stack">
          <div className="cmp-input-combobox">
            <textarea
              id="coding-workbench-task-intent"
              className="cmp-input"
              ref={textareaRef}
              rows={2}
              value={taskIntent}
              maxLength={65_536}
              disabled={mutationPending}
              placeholder={t("codingWorkbench.task.placeholder")}
              onChange={(event): void => onTaskIntentChange(event.target.value)}
              onKeyDown={(event): void => handleComposerKeyDown(event, submit, submitBlocked)}
            />
          </div>
        </div>
        <div className="cmp-footer-row">
          <div className="cmp-bar cmp-bar-compact">
            <div className="cmp-bar-model">
              <span className="cmp-model mono">
                <Icons.code size={15} />
                {t("codingWorkbench.header.eyebrow")}
              </span>
            </div>
            <ComposerControls
              actions={actions}
              runState={runState}
              submitBlocked={submitBlocked}
              busy={mutationPending}
              startBusy={startBusy}
              t={t}
            />
          </div>
        </div>
      </div>
    </form>
  );
}

function handleComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  submit: () => void,
  blocked: boolean,
): void {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
  event.preventDefault();
  if (!blocked) submit();
}

function ComposerControls({
  actions,
  runState,
  submitBlocked,
  busy,
  startBusy,
  t,
}: {
  readonly actions: TaskComposerActions;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly submitBlocked: boolean;
  readonly busy: boolean;
  readonly startBusy: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (runState === "running") {
    return (
      <div className="cmp-bar-main">
        <button
          className="cmp-send cmp-send-cancel cmp-tip-end"
          type={submitBlocked ? "button" : "submit"}
          data-on={!submitBlocked}
          data-tip={t("codingWorkbench.composer.pause")}
          aria-label={t("codingWorkbench.composer.pause")}
          aria-disabled={submitBlocked}
        >
          <Icons.minimize size={16} />
        </button>
      </div>
    );
  }
  if (runState === "paused") {
    return (
      <div className="cmp-bar-main">
        <button
          className="cmp-icon ui-tip"
          type="button"
          data-tip={t("codingWorkbench.composer.resume")}
          aria-label={t("codingWorkbench.composer.resume")}
          disabled={busy}
          onClick={actions.onResume}
        >
          <Icons.fwd size={16} />
        </button>
        <button
          className="cmp-send cmp-tip-end"
          type={submitBlocked ? "button" : "submit"}
          data-on={!submitBlocked}
          data-tip={t("codingWorkbench.composer.send")}
          aria-label={t("codingWorkbench.composer.send")}
          aria-disabled={submitBlocked}
        >
          <Icons.arrowUp size={16} />
        </button>
      </div>
    );
  }
  return (
    <button
      className="cmp-send cmp-tip-end"
      type={submitBlocked ? "button" : "submit"}
      data-on={!submitBlocked}
      data-tip={startBusy ? t("codingWorkbench.task.starting") : t("codingWorkbench.task.start")}
      aria-label={startBusy ? t("codingWorkbench.task.starting") : t("codingWorkbench.task.start")}
      aria-disabled={submitBlocked}
    >
      <Icons.arrowUp size={16} />
    </button>
  );
}
