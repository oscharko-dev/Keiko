import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import {
  type CodingWorkbenchRuntimeResearchGrant,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import type {
  CodingWorkbenchResourceStatus,
  CodingWorkbenchRuntimeState,
} from "@/lib/coding-workbench-live-state";
import {
  activeRunState,
  cx,
  resourceStatusLabel,
  resourceStatusSymbol,
  resourceTone,
  runStateLabel,
} from "./codingWorkbenchLabels";
export { PanelTitle } from "./CodingWorkbenchPanelTitle";
export { Timeline } from "./CodingWorkbenchTimeline";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import { ResearchGrantChip } from "./CodingWorkbenchResearchGrant";
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
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${String(Math.min(textarea.scrollHeight, 220))}px`;
  }, [taskIntent]);
  return (
    <form
      className="composer"
      aria-labelledby="coding-workbench-task-title"
      onSubmit={(event) => {
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
              onChange={(event) => onTaskIntentChange(event.target.value)}
              onKeyDown={(event) => handleComposerKeyDown(event, submit, submitBlocked)}
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

export function ReadinessGrid({
  state,
  actions,
  refreshWorkspace,
  researchGrant,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: Pick<
    CodingWorkbenchRuntimeActions,
    "refreshRuntime" | "refreshRun" | "refreshSource" | "revokeResearchGrant"
  >;
  readonly refreshWorkspace: () => Promise<void>;
  readonly researchGrant: CodingWorkbenchRuntimeResearchGrant | null;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-readiness-title">
      <PanelTitle
        eyebrow={t("codingWorkbench.readiness.eyebrow")}
        id="coding-workbench-readiness-title"
      >
        {t("codingWorkbench.readiness.title")}
      </PanelTitle>
      <ReadinessResourceCards
        state={state}
        actions={actions}
        refreshWorkspace={refreshWorkspace}
        t={t}
      />
      <ResearchGrantChip
        grant={researchGrant ?? undefined}
        busy={state.mutation.status === "pending"}
        onRevoke={() => {
          if (researchGrant !== null) void actions.revokeResearchGrant(researchGrant);
        }}
      />
    </section>
  );
}

interface ReadinessResourceCardsProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: Pick<
    CodingWorkbenchRuntimeActions,
    "refreshRuntime" | "refreshRun" | "refreshSource"
  >;
  readonly refreshWorkspace: () => Promise<void>;
  readonly t: CodingWorkbenchTranslate;
}

function ReadinessResourceCards({
  state,
  actions,
  refreshWorkspace,
  t,
}: ReadinessResourceCardsProps): ReactNode {
  return (
    <div className={styles.resourceGrid}>
      <SourceResourceCard state={state} onRetry={actions.refreshSource} t={t} />
      <WorkspaceResourceCard state={state} onRetry={refreshWorkspace} t={t} />
      <RuntimeResourceCard state={state} onRetry={actions.refreshRuntime} t={t} />
      <RunResourceCard state={state} onRetry={actions.refreshRun} t={t} />
      <StreamResourceCard state={state} onRetry={actions.refreshRun} t={t} />
    </div>
  );
}

function unavailableResourceStatus(
  status: CodingWorkbenchResourceStatus,
  unavailable: boolean,
): CodingWorkbenchResourceStatus {
  return status === "ready" && unavailable ? "unavailable" : status;
}

interface ReadinessResourceCardProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly onRetry: () => Promise<void>;
  readonly t: CodingWorkbenchTranslate;
}

function SourceResourceCard({ state, onRetry, t }: ReadinessResourceCardProps): ReactNode {
  return (
    <ResourceCard
      label={t("codingWorkbench.readiness.modelSource.label")}
      detail={
        state.source.value?.available
          ? t("codingWorkbench.readiness.modelSource.confirmed")
          : t("codingWorkbench.readiness.modelSource.select")
      }
      status={unavailableResourceStatus(
        state.source.status,
        state.source.value?.available !== true,
      )}
      onRetry={onRetry}
    />
  );
}

function WorkspaceResourceCard({ state, onRetry, t }: ReadinessResourceCardProps): ReactNode {
  const workspace = state.workspace.value;
  return (
    <ResourceCard
      label={t("codingWorkbench.readiness.workspace.label")}
      detail={
        workspace
          ? `${workspace.taskId} · ${workspace.taskBranch} · ${workspace.health}`
          : t("codingWorkbench.readiness.workspace.none")
      }
      status={unavailableResourceStatus(state.workspace.status, workspace?.health !== "healthy")}
      onRetry={onRetry}
    />
  );
}

function RuntimeResourceCard({ state, onRetry, t }: ReadinessResourceCardProps): ReactNode {
  return (
    <ResourceCard
      label={t("codingWorkbench.readiness.runtime.label")}
      detail={
        state.runtime.value?.runtimeAvailable
          ? t("codingWorkbench.readiness.runtime.available")
          : t("codingWorkbench.readiness.runtime.notConfirmed")
      }
      status={unavailableResourceStatus(
        state.runtime.status,
        state.runtime.value?.runtimeAvailable !== true,
      )}
      onRetry={onRetry}
    />
  );
}

function RunResourceCard({ state, onRetry, t }: ReadinessResourceCardProps): ReactNode {
  return (
    <ResourceCard
      label={t("codingWorkbench.readiness.run.label")}
      detail={
        state.run.value
          ? runStateLabel(state.run.value.state, t)
          : t("codingWorkbench.readiness.run.none")
      }
      status={state.run.status}
      onRetry={onRetry}
    />
  );
}

function StreamResourceCard({ state, onRetry, t }: ReadinessResourceCardProps): ReactNode {
  return (
    <ResourceCard
      label={t("codingWorkbench.readiness.eventStream.label")}
      detail={
        state.run.value?.runId
          ? t("codingWorkbench.readiness.eventStream.resumable")
          : t("codingWorkbench.readiness.eventStream.waiting")
      }
      status={state.stream.status}
      onRetry={onRetry}
      retryLabel={t("codingWorkbench.readiness.eventStream.resnapshot")}
    />
  );
}

function ResourceCard({
  label,
  detail,
  status,
  onRetry,
  retryLabel,
}: {
  readonly label: string;
  readonly detail: string;
  readonly status: CodingWorkbenchResourceStatus;
  readonly onRetry: () => Promise<void>;
  readonly retryLabel?: string;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const sharedT = useTranslate();
  const retryable = status === "error" || status === "unavailable";
  return (
    <article className={styles.resourceCard} data-status={status}>
      <div className={styles.resourceHeading}>
        <span className={styles.statusSymbol} aria-hidden="true">
          {resourceStatusSymbol(status)}
        </span>
        <p className={styles.resourceName}>{label}</p>
      </div>
      <p className={styles.resourceState} data-tone={resourceTone(status)}>
        {resourceStatusLabel(status, t)}
      </p>
      <p className={styles.resourceDetail}>{detail}</p>
      {retryable ? (
        <button className={styles.button} type="button" onClick={() => void onRetry()}>
          {retryLabel ?? sharedT("common.retry")}
        </button>
      ) : null}
    </article>
  );
}
