import { type ReactNode, type RefObject } from "react";
import { CODING_WORKBENCH_MODES, type CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
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
  modeDescription,
  modeLabel,
  resourceStatusLabel,
  resourceStatusSymbol,
  resourceTone,
  runStateLabel,
} from "./codingWorkbenchLabels";
export { PanelTitle } from "./CodingWorkbenchPanelTitle";
export { Timeline } from "./CodingWorkbenchTimeline";
import { PanelTitle } from "./CodingWorkbenchPanelTitle";
import styles from "./CodingWorkbenchWindow.module.css";

const MODE_ORDER: Readonly<Record<CodingWorkbenchMode, number>> = {
  "governed-assist": 0,
  "supervised-coding": 1,
  "autonomous-delivery": 2,
};

export function WorkbenchHeader({
  state,
  focusRef,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly focusRef: RefObject<HTMLHeadingElement>;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const sharedT = useTranslate();
  const snapshotState = state.run.value?.state ?? "idle";
  return (
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>{t("codingWorkbench.header.eyebrow")}</p>
        <h2 className={styles.title} ref={focusRef} tabIndex={-1}>
          {sharedT("rail.coding")}
        </h2>
        <p className={styles.summary}>{t("codingWorkbench.header.summary")}</p>
      </div>
      <span className={styles.statePill} data-state={snapshotState}>
        <span aria-hidden="true">{activeRunState(snapshotState) ? "●" : "○"}</span>
        {runStateLabel(snapshotState, t)}
      </span>
    </header>
  );
}

export function ModeAuthority({
  state,
  onModeChange,
  locked,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly onModeChange: (mode: CodingWorkbenchMode) => void;
  readonly locked: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const ceiling = state.runtime.value?.deploymentCeiling;
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-mode-title">
      <PanelTitle eyebrow={t("codingWorkbench.mode.eyebrow")} id="coding-workbench-mode-title">
        {t("codingWorkbench.mode.title")}
      </PanelTitle>
      <div
        className={styles.modeGrid}
        role="radiogroup"
        aria-label={t("codingWorkbench.mode.group")}
      >
        {CODING_WORKBENCH_MODES.map((mode) => {
          const aboveCeiling = ceiling !== undefined && MODE_ORDER[mode] > MODE_ORDER[ceiling];
          return (
            <ModeOption
              key={mode}
              mode={mode}
              selected={state.requestedMode === mode}
              disabled={locked}
              capped={aboveCeiling}
              onModeChange={onModeChange}
              t={t}
            />
          );
        })}
      </div>
      {state.runtime.value ? (
        <p className={styles.boundaryNote}>
          {t("codingWorkbench.mode.boundary", {
            effectiveMode: modeLabel(state.runtime.value.effectiveMode, t),
            deploymentCeiling: modeLabel(state.runtime.value.deploymentCeiling, t),
          })}
        </p>
      ) : null}
    </section>
  );
}

function ModeOption({
  mode,
  selected,
  disabled,
  capped,
  onModeChange,
  t,
}: {
  readonly mode: CodingWorkbenchMode;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly capped: boolean;
  readonly onModeChange: (mode: CodingWorkbenchMode) => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const id = `coding-workbench-mode-${mode}`;
  return (
    <div className={styles.modeOption} data-selected={selected} data-capped={capped}>
      <input
        id={id}
        type="radio"
        name="coding-workbench-mode"
        checked={selected}
        disabled={disabled}
        onChange={() => onModeChange(mode)}
      />
      <label className={styles.modeText} htmlFor={id}>
        <span className={styles.modeName}>{modeLabel(mode, t)}</span>
        <span className={styles.modeDetail}>{modeDescription(mode, t)}</span>
        {capped ? (
          <span className={styles.cappedText}>{t("codingWorkbench.mode.capped")}</span>
        ) : null}
      </label>
    </div>
  );
}

export function TaskStartSection({
  taskIntent,
  onTaskIntentChange,
  onStart,
  canStart,
  busy,
}: {
  readonly taskIntent: string;
  readonly onTaskIntentChange: (value: string) => void;
  readonly onStart: () => void;
  readonly canStart: boolean;
  readonly busy: boolean;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const startDisabled = busy || !canStart || taskIntent.trim().length === 0;
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-task-title">
      <PanelTitle eyebrow={t("codingWorkbench.task.eyebrow")} id="coding-workbench-task-title">
        {t("codingWorkbench.task.title")}
      </PanelTitle>
      <label className={styles.fieldLabel} htmlFor="coding-workbench-task-intent">
        {t("codingWorkbench.task.instructions")}
      </label>
      <textarea
        id="coding-workbench-task-intent"
        className={styles.taskInput}
        value={taskIntent}
        maxLength={65_536}
        disabled={busy}
        aria-describedby="coding-workbench-task-help"
        onChange={(event) => onTaskIntentChange(event.target.value)}
      />
      <p id="coding-workbench-task-help" className={styles.helpText}>
        {t("codingWorkbench.task.help")}
      </p>
      <button
        className={cx(styles.button, styles.buttonPrimary)}
        type="button"
        disabled={startDisabled}
        onClick={onStart}
      >
        {busy ? t("codingWorkbench.task.starting") : t("codingWorkbench.task.start")}
      </button>
    </section>
  );
}

export function ReadinessGrid({
  state,
  actions,
  refreshWorkspace,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: Pick<
    CodingWorkbenchRuntimeActions,
    "refreshRuntime" | "refreshRun" | "refreshSource"
  >;
  readonly refreshWorkspace: () => Promise<void>;
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
