import { useRef, type ReactNode, type RefObject } from "react";
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
import { Icons } from "../../Icons";
import {
  ComposerShell,
  composerEnterSubmits,
  useComposerAutoGrow,
} from "../../composer/ComposerShell";
import styles from "./CodingWorkbenchWindow.module.css";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const CodeIcon = Icons.code;
const MinimizeIcon = Icons.minimize;
const FwdIcon = Icons.fwd;
const ArrowUpIcon = Icons.arrowUp;

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
  // Release-audit F-01: the idle pill's "Ready to start" is a READINESS claim, not a run state.
  // It consumes the one aggregated, server-confirmed readiness the start action itself gates on
  // (`canStart` — model source incl. the sidecar gateway profile, workspace, runtime, run), so
  // the header can never claim ready while any of those resources is unavailable or unconfirmed.
  const blockedIdle = snapshotState === "idle" && !state.canStart;
  // ADR-0163 D9: an unverified evaluation runtime is a READINESS fact this pill already claims to
  // carry, so the idle label must not read as the plain "Ready to start", and the run states must
  // not paint the success colour over it.
  const evaluation =
    state.runtime.value?.runtimeEvidenceClass === "functional-not-platform-qualified";
  return (
    <header className={styles.header}>
      <h2 className={styles.title} ref={focusRef} tabIndex={-1}>
        {sharedT("rail.coding")}
      </h2>
      <span
        className={styles.statePill}
        data-state={blockedIdle ? "not-ready" : snapshotState}
        {...(evaluation ? { "data-assurance": "evaluation" } : {})}
      >
        <span className={styles.statusSymbol} aria-hidden="true">
          {activeRunState(snapshotState) ? "●" : "○"}
        </span>
        {headerStateLabel(blockedIdle, evaluation, snapshotState, t)}
      </span>
    </header>
  );
}

function headerStateLabel(
  blockedIdle: boolean,
  evaluation: boolean,
  snapshotState: CodingWorkbenchRuntimeStateName,
  t: CodingWorkbenchTranslate,
): string {
  if (blockedIdle) return t("codingWorkbench.header.notReady");
  if (evaluation && snapshotState === "idle") return t("codingWorkbench.header.readyEvaluation");
  return runStateLabel(snapshotState, t);
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
  canResume,
  runState,
  mutationPending,
  startBusy,
}: {
  readonly taskIntent: string;
  readonly onTaskIntentChange: (value: string) => void;
  readonly actions: TaskComposerActions;
  readonly canStart: boolean;
  readonly canResume: boolean;
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
  useComposerAutoGrow(textareaRef, taskIntent);
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
        <ComposerShell
          id="coding-workbench-task-intent"
          value={taskIntent}
          placeholder={t("codingWorkbench.task.placeholder")}
          textareaRef={textareaRef}
          maxLength={65_536}
          disabled={mutationPending}
          onChange={(event): void => onTaskIntentChange(event.target.value)}
          onKeyDown={(event): void => {
            if (composerEnterSubmits(event)) submit();
          }}
          footer={
            <div className="cmp-bar cmp-bar-compact">
              <div className="cmp-bar-model">
                <span className="cmp-model mono">
                  <CodeIcon size={15} />
                  {t("codingWorkbench.header.eyebrow")}
                </span>
              </div>
              <ComposerControls
                actions={actions}
                runState={runState}
                submitBlocked={submitBlocked}
                busy={mutationPending}
                startBusy={startBusy}
                canResume={canResume}
                t={t}
              />
            </div>
          }
        />
      </div>
    </form>
  );
}

function ComposerControls({
  actions,
  runState,
  submitBlocked,
  busy,
  startBusy,
  canResume,
  t,
}: {
  readonly actions: TaskComposerActions;
  readonly runState: CodingWorkbenchRuntimeStateName | undefined;
  readonly submitBlocked: boolean;
  readonly busy: boolean;
  readonly startBusy: boolean;
  readonly canResume: boolean;
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
          <MinimizeIcon size={16} />
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
          disabled={busy || !canResume}
          onClick={actions.onResume}
        >
          <FwdIcon size={16} />
        </button>
        <button
          className="cmp-send cmp-tip-end"
          type={submitBlocked ? "button" : "submit"}
          data-on={!submitBlocked}
          data-tip={t("codingWorkbench.composer.send")}
          aria-label={t("codingWorkbench.composer.send")}
          aria-disabled={submitBlocked}
        >
          <ArrowUpIcon size={16} />
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
      <ArrowUpIcon size={16} />
    </button>
  );
}
