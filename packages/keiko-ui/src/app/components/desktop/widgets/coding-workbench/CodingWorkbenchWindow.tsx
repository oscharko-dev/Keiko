"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  CODING_WORKBENCH_MODES,
  isCodingWorkbenchMode,
  isCodingWorkbenchModeWidening,
  isCodingWorkbenchModel,
  type CodingWorkbenchMode,
  type CodingWorkbenchRuntimeApprovalDecision,
  type CodingWorkbenchRuntimePendingPermission,
  type CodingWorkbenchRuntimeSseEvent,
  type CodingWorkbenchRuntimeStateName,
} from "@oscharko-dev/keiko-contracts";
import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import { useTranslate } from "@/lib/i18n";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import {
  useCodingWorkbenchRuntime,
  type CodingWorkbenchRuntimeActions,
  type UseCodingWorkbenchRuntimeInput,
} from "@/lib/useCodingWorkbenchRuntime";
import { useAutonomyModePolicy } from "../../hooks/useAutonomyModePolicy";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import { useCodingWorkbenchQuestions } from "@/lib/useCodingWorkbenchQuestions";
import { useCodingWorkbenchSafeActivity } from "@/lib/useCodingWorkbenchSafeActivity";
import { useFollowNewest } from "@/lib/useFollowNewest";
import {
  useCodingWorkbenchResearch,
  type CodingWorkbenchResearchState,
} from "@/lib/useCodingWorkbenchResearch";
import {
  useCodingWorkbenchApprovalReview,
  type CodingWorkbenchApprovalReviewState,
} from "@/lib/useCodingWorkbenchApprovalReview";
import {
  useCodingWorkbenchEditorBridge,
  type CodingWorkbenchChangesetReview,
} from "@/lib/useCodingWorkbenchEditorBridge";
import { useOptionalActiveWorkspace } from "../../context/ActiveWorkspaceContext";
import { useOptionalChatSessionCatalog } from "../../context/ChatSessionContext";
import { DiffFileSection } from "../cards/shared/diffView";
import {
  PanelTitle,
  TaskStartSection,
  Timeline,
  WorkbenchWelcome,
} from "./CodingWorkbenchSections";
import {
  CodingWorkbenchSetup,
  type CodingWorkbenchSetupRuntimePosture,
} from "./CodingWorkbenchSetup";
import { CodingWorkbenchChanges, diffLabels } from "./CodingWorkbenchChanges";
import { ResearchGrantChip } from "./CodingWorkbenchResearchGrant";
import { requestGatewayModelCatalogRefresh } from "../shared/gatewaySetupBus";
import {
  activeRunState,
  changesetDeliveryAlert,
  cx,
  lifecycleAnnouncement,
  modeLabel,
  visibleAlert,
} from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

const EMPTY_WORKSPACE = {
  activeBinding: null,
  activeInstance: null,
  loading: false,
  switching: false,
  error: null,
  refresh: (): Promise<void> => Promise.resolve(),
} as const;

/**
 * The bootstrap setup section's honest posture. Readiness that has not RESOLVED yields "verified"
 * so neither note flashes during load; a resolved-but-unverified runtime yields "evaluation"
 * (ADR-0163 D9), which is what keeps the first screen of a fresh evaluation install honest.
 */
function setupRuntimePosture(
  state: CodingWorkbenchRuntimeState,
): CodingWorkbenchSetupRuntimePosture {
  if (state.runtime.status !== "ready") return "verified";
  if (state.runtime.value?.runtimeAvailable === false) return "unavailable";
  return state.runtime.value?.runtimeEvidenceClass === "functional-not-platform-qualified"
    ? "evaluation"
    : "verified";
}

function latestChangesSignal(events: readonly CodingWorkbenchRuntimeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "status" || event?.eventKind === "diff-summarized") return event.cursor;
  }
  return null;
}

interface ResumeModeSelection {
  readonly runId: string;
  readonly currentMode: CodingWorkbenchMode;
  readonly value: CodingWorkbenchMode;
}

interface WorkbenchAuthoritySelection {
  readonly pending: boolean;
  readonly errorMessage: string | null;
  readonly onChange: (mode: CodingWorkbenchMode) => void;
}

function useWorkbenchAuthoritySelection(
  state: CodingWorkbenchRuntimeState,
  actions: CodingWorkbenchRuntimeActions,
  t: CodingWorkbenchTranslate,
): WorkbenchAuthoritySelection {
  const policy = useAutonomyModePolicy();
  const runState = state.run.value?.state;
  useEffect(() => {
    if (
      activeRunState(runState) ||
      state.mutation.status === "pending" ||
      policy.pending ||
      state.requestedMode === policy.requestedMode
    ) {
      return;
    }
    actions.setRequestedMode(policy.requestedMode);
  }, [
    actions,
    policy.pending,
    policy.requestedMode,
    runState,
    state.mutation.status,
    state.requestedMode,
  ]);
  return {
    pending: policy.pending,
    errorMessage:
      policy.error === null ? null : t(`codingWorkbench.composer.authority.error.${policy.error}`),
    onChange: (mode): void => {
      actions.setRequestedMode(mode);
      policy.change(mode);
    },
  };
}

function resumableModes(currentMode: CodingWorkbenchMode): readonly CodingWorkbenchMode[] {
  return CODING_WORKBENCH_MODES.filter((mode) => !isCodingWorkbenchModeWidening(currentMode, mode));
}

function selectedResumeMode(
  selection: ResumeModeSelection | null,
  runId: string | undefined,
  currentMode: CodingWorkbenchMode | undefined,
): CodingWorkbenchMode | null {
  if (runId === undefined || currentMode === undefined) return null;
  return selection?.runId === runId && selection.currentMode === currentMode
    ? selection.value
    : currentMode;
}

export interface CodingWorkbenchGitTarget {
  readonly root: string | null;
  readonly binding: "repository" | "task-workspace";
}

function noopOpenGit(_target: CodingWorkbenchGitTarget): void {}

export function CodingWorkbenchWindow({
  selectedRoot,
  onOpenGit = noopOpenGit,
}: {
  readonly selectedRoot?: string | undefined;
  readonly onOpenGit?: ((target: CodingWorkbenchGitTarget) => void) | undefined;
}): ReactNode {
  const activeWorkspace = useOptionalActiveWorkspace() ?? EMPTY_WORKSPACE;
  const chatCatalog = useOptionalChatSessionCatalog();
  const { state, actions } = useCodingWorkbenchRuntime({ workspace: activeWorkspace });
  const codingModels = useMemo(
    () => chatCatalog?.models.filter(isCodingWorkbenchModel) ?? [],
    [chatCatalog?.models],
  );
  useEffect(() => requestGatewayModelCatalogRefresh(), []);
  useCodingModelSelection(state, actions, codingModels);
  const research = useCodingWorkbenchResearch({
    runId: state.run.value?.runId,
    revision: state.run.value?.revision,
    permissionRequestId: state.run.value?.pendingPermission?.requestId,
  });
  const [taskIntent, setTaskIntent] = useState("");
  const focusRef = useRef<HTMLHeadingElement>(null);
  const approvalAction = useRef(false);
  const t = useCodingWorkbenchTranslate();
  const authority = useWorkbenchAuthoritySelection(state, actions, t);
  const workbenchLabel = useTranslate()("rail.coding");
  const pendingPermission = state.run.value?.pendingPermission;
  const alert =
    visibleAlert(state, t, bootstrapSetupVisible(state, activeWorkspace)) ?? authority.errorMessage;

  useEffect(() => {
    if (!approvalAction.current || pendingPermission !== undefined) return;
    approvalAction.current = false;
    focusRef.current?.focus();
  }, [pendingPermission]);

  const decideApproval = (decision: "approved" | "denied"): void => {
    approvalAction.current = true;
    void actions.decideApproval(decision);
  };
  return (
    <WorkbenchContent
      state={state}
      actions={actions}
      activeWorkspace={activeWorkspace}
      selectedRoot={selectedRoot}
      taskIntent={taskIntent}
      onTaskIntentChange={setTaskIntent}
      focusRef={focusRef}
      alert={alert}
      t={t}
      workbenchLabel={workbenchLabel}
      onDecision={decideApproval}
      research={research}
      codingModels={codingModels}
      authority={authority}
      onOpenGit={onOpenGit}
    />
  );
}

function useCodingModelSelection(
  state: CodingWorkbenchRuntimeState,
  actions: CodingWorkbenchRuntimeActions,
  models: readonly ModelCapability[],
): void {
  const selected = models.find((model) => model.id === state.selectedModelId);
  useEffect(() => {
    if (state.runtimePreference !== "managed-gateway") return;
    const next = selected?.id ?? models[0]?.id ?? null;
    if (next !== state.selectedModelId) actions.setSelectedModel(next);
  }, [actions, models, selected?.id, state.runtimePreference, state.selectedModelId]);
  useEffect(() => {
    const efforts = selected?.reasoningEfforts ?? [];
    const currentAllowed =
      state.reasoningEffort !== null && efforts.includes(state.reasoningEffort);
    const next = currentAllowed
      ? state.reasoningEffort
      : (efforts.find((effort) => effort === "medium") ?? efforts[0] ?? null);
    if (next !== state.reasoningEffort) actions.setReasoningEffort(next);
  }, [actions, selected, state.reasoningEffort]);
}

interface WorkbenchContentProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
  readonly activeWorkspace: UseCodingWorkbenchRuntimeInput["workspace"];
  readonly selectedRoot: string | undefined;
  readonly taskIntent: string;
  readonly onTaskIntentChange: (taskIntent: string) => void;
  readonly focusRef: RefObject<HTMLHeadingElement | null>;
  readonly alert: string | null;
  readonly t: CodingWorkbenchTranslate;
  readonly workbenchLabel: string;
  readonly onDecision: (decision: "approved" | "denied") => void;
  readonly research: CodingWorkbenchResearchState;
  readonly codingModels: readonly ModelCapability[];
  readonly authority: WorkbenchAuthoritySelection;
  readonly onOpenGit: (target: CodingWorkbenchGitTarget) => void;
}

function WorkbenchAlert({ message }: { readonly message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <p className={styles.alert} role="alert">
      <span aria-hidden="true">!</span> {message}
    </p>
  );
}

function WorkbenchContent({
  state,
  actions,
  activeWorkspace,
  selectedRoot,
  taskIntent,
  onTaskIntentChange,
  focusRef,
  alert,
  t,
  workbenchLabel,
  onDecision,
  research,
  codingModels,
  authority,
  onOpenGit,
}: WorkbenchContentProps): ReactNode {
  return (
    <section
      className={styles.shell}
      aria-label={workbenchLabel}
      aria-busy={state.mutation.status === "pending"}
      data-state={state.run.value?.state ?? "idle"}
    >
      <h2 className="sr-only">{workbenchLabel}</h2>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {lifecycleAnnouncement(state, t, research.grant)}
      </p>
      <div className={styles.body}>
        <WorkbenchAlert message={alert} />
        <WorkbenchColumns
          state={state}
          actions={actions}
          activeWorkspace={activeWorkspace}
          selectedRoot={selectedRoot}
          taskIntent={taskIntent}
          onTaskIntentChange={onTaskIntentChange}
          focusRef={focusRef}
          onDecision={onDecision}
          research={research}
          codingModels={codingModels}
          authority={authority}
          onOpenGit={onOpenGit}
        />
      </div>
    </section>
  );
}

function WorkbenchColumns({
  state,
  actions,
  activeWorkspace,
  selectedRoot,
  taskIntent,
  onTaskIntentChange,
  focusRef,
  onDecision,
  research,
  codingModels,
  authority,
  onOpenGit,
}: Omit<WorkbenchContentProps, "alert" | "t" | "workbenchLabel">): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [resumeSelection, setResumeSelection] = useState<ResumeModeSelection | null>(null);
  // The bootstrap Code setup (#2385) renders whenever no active task-workspace binding exists, so a
  // hand-bound repository can be bound → verified → started entirely from the UI (#2476). It no longer
  // hides behind runtime availability: on an unactivated install it stays reachable and honestly
  // explains why a run cannot start yet (#2476 AC4). Once a binding lands it yields to the task-start
  // flow. The honest note shows only once readiness has RESOLVED as unavailable, never during load.
  const showSetup = bootstrapSetupVisible(state, activeWorkspace);
  const runtimePosture = setupRuntimePosture(state);
  // Monotonic, not a count: the event buffer is capped (CODING_WORKBENCH_EVENT_RETENTION_LIMIT), so
  // its length plateaus on a long run and every change-driven resync — questions and the activity
  // feed's automatic reconnect — would silently stop firing exactly when a run is busiest. The
  // highest observed runtime-event sequence keeps advancing for as long as the run produces events.
  const runtimeEventSignal = state.events.reduce(
    (highest, event) =>
      event.kind === "runtime-event" && event.sequence > highest ? event.sequence : highest,
    0,
  );
  const questions = useCodingWorkbenchQuestions({
    runId: state.run.value?.runId,
    revision: state.run.value?.revision,
    runState: state.run.value?.state,
    runtimeEventSignal,
    refreshSnapshot: actions.refreshRun,
  });
  const activity = useCodingWorkbenchSafeActivity({
    runId: state.run.value?.runId,
    runState: state.run.value?.state,
    runtimeEventSignal,
  });
  const editorBridge = useCodingWorkbenchEditorBridge({
    root:
      activeWorkspace.error === null ? (activeWorkspace.activeBinding?.activeRoot ?? null) : null,
    runId: state.run.value?.runId,
    active: activeRunState(state.run.value?.state),
  });
  // The session stream is a bounded scroll region below the header; a run's newest activity lands
  // at its end. Follow that growth while the operator is at the bottom, never yank a reader who
  // scrolled up into the history, and start following again for every new run (#3257 Wave 0).
  const sessionStreamRef = useRef<HTMLDivElement>(null);
  const { onScroll: onStreamScroll, resume: followNewest } = useFollowNewest(
    sessionStreamRef,
    `${String(runtimeEventSignal)}:${activity.feed?.updatedAt ?? ""}:${String(questions.questions.length)}`,
  );
  const runId = state.run.value?.runId;
  useEffect(() => {
    if (runId !== undefined) followNewest();
  }, [followNewest, runId]);
  const pausedRun = state.run.value?.state === "paused" ? state.run.value : undefined;
  const resumeMode = selectedResumeMode(
    resumeSelection,
    pausedRun?.runId,
    pausedRun?.effectiveMode,
  );
  const resumeModes = pausedRun?.effectiveMode ? resumableModes(pausedRun.effectiveMode) : [];
  const runIsActive = activeRunState(state.run.value?.state);
  const repositoryRoot = runIsActive
    ? (activeWorkspace.activeBinding?.activeRoot ?? selectedRoot ?? null)
    : (selectedRoot ?? null);
  const taskComposer = (
    <TaskStartSection
      taskIntent={taskIntent}
      onTaskIntentChange={onTaskIntentChange}
      actions={{
        onStart: () => void actions.start(taskIntent.trim()),
        onPause: () => void actions.pause(),
        onResume: () => {
          if (resumeMode !== null) void actions.resume(resumeMode);
        },
        onSend: () => void actions.submitFollowUp(taskIntent.trim()),
      }}
      canStart={state.canStart}
      runState={state.run.value?.state}
      canResume={resumeMode !== null}
      mutationPending={state.mutation.status === "pending"}
      startBusy={state.mutation.kind === "start" && state.mutation.status === "pending"}
      repositoryLabel={repositoryLabel(repositoryRoot)}
      branchLabel={activeWorkspace.activeInstance?.baseBranch ?? null}
      onOpenGit={() =>
        onOpenGit({
          root: repositoryRoot,
          binding: runIsActive ? "task-workspace" : "repository",
        })
      }
      autonomyMode={confirmedMode(state)}
      autonomyLabel={confirmedModeLabel(state, t)}
      requestedMode={state.requestedMode}
      runtimePreference={state.runtimePreference}
      configurationLocked={
        activeRunState(state.run.value?.state) ||
        state.mutation.status === "pending" ||
        authority.pending
      }
      onRequestedModeChange={authority.onChange}
      onRuntimePreferenceChange={actions.setRuntimePreference}
      models={codingModels}
      selectedModelId={state.selectedModelId}
      reasoningEffort={state.reasoningEffort}
      onSelectedModelChange={actions.setSelectedModel}
      onReasoningEffortChange={actions.setReasoningEffort}
    />
  );
  if (showSetup) {
    return (
      <div className={styles.emptySession}>
        <CodingWorkbenchSetup
          selectedRoot={selectedRoot}
          refreshWorkspace={(root) => activeWorkspace.refresh(root)}
          runtimePosture={runtimePosture}
        />
      </div>
    );
  }
  const showWelcome =
    welcomeEligibleState(state.run.value?.state) &&
    state.events.length === 0 &&
    activity.feed === null &&
    questions.questions.length === 0 &&
    editorBridge.pendingReview === null &&
    research.grant === null;
  return (
    <div className={styles.session}>
      {showWelcome ? (
        <WorkbenchWelcome />
      ) : (
        <div
          ref={sessionStreamRef}
          className={styles.sessionStream}
          role="log"
          aria-label={t("codingWorkbench.readiness.eventStream.label")}
          onScroll={onStreamScroll}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable log region must be keyboard-focusable (axe scrollable-region-focusable)
          tabIndex={0}
        >
          <PermissionPrompt state={state} research={research} onDecision={onDecision} />
          <ChangesetReviewPanel
            review={editorBridge.pendingReview}
            onApprove={editorBridge.approve}
            onDeny={editorBridge.deny}
            onRetry={editorBridge.retry}
          />
          <RecoveryPanel state={state} taskIntent={taskIntent} actions={actions} />
          <ResearchGrantChip
            grant={research.grant ?? undefined}
            busy={state.mutation.status === "pending"}
            onRevoke={() => {
              if (research.grant !== null) void actions.revokeResearchGrant(research.grant);
            }}
          />
          <Timeline
            events={state.events}
            activity={activity}
            questions={questions}
            focusRef={focusRef}
          />
          <CodingWorkbenchChanges
            root={
              activeWorkspace.error === null
                ? (activeWorkspace.activeBinding?.activeRoot ?? null)
                : null
            }
            runId={state.run.value?.runId}
            changeSignal={latestChangesSignal(state.events)}
            bindingPending={activeWorkspace.loading || activeWorkspace.switching}
            pairing={state.pairing}
          />
        </div>
      )}
      <div className={styles.composerDock}>
        <RuntimeControls
          state={state}
          actions={actions}
          resumeMode={resumeMode}
          resumeModes={resumeModes}
          onResumeModeChange={(mode): void => {
            if (pausedRun?.runId === undefined || pausedRun.effectiveMode === undefined) return;
            setResumeSelection({
              runId: pausedRun.runId,
              currentMode: pausedRun.effectiveMode,
              value: mode,
            });
          }}
        />
        {taskComposer}
      </div>
    </div>
  );
}

function welcomeEligibleState(state: CodingWorkbenchRuntimeStateName | undefined): boolean {
  return (
    state === undefined ||
    state === "idle" ||
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "taken-over"
  );
}

function repositoryLabel(root: string | null): string | null {
  if (root === null) return null;
  return root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root;
}

function confirmedModeLabel(
  state: CodingWorkbenchRuntimeState,
  t: CodingWorkbenchTranslate,
): string {
  const mode = confirmedMode(state);
  return mode === null ? t("codingWorkbench.mode.unconfirmed") : modeLabel(mode, t);
}

function confirmedMode(state: CodingWorkbenchRuntimeState): CodingWorkbenchMode | null {
  const snapshot = state.run.value;
  return (
    (activeRunState(snapshot?.state)
      ? snapshot?.effectiveMode
      : state.runtime.value?.effectiveMode) ?? null
  );
}

// Single source for "the bootstrap Code setup section is on screen". Two copies of this predicate
// would let the live alert and the setup section disagree about who states a condition.
function bootstrapSetupVisible(
  state: CodingWorkbenchRuntimeState,
  activeWorkspace: UseCodingWorkbenchRuntimeInput["workspace"],
): boolean {
  return activeWorkspace.activeBinding === null && state.workspace.value === null;
}

interface LiveSectionProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
}

interface RuntimeControlsProps extends LiveSectionProps {
  readonly resumeMode: CodingWorkbenchMode | null;
  readonly resumeModes: readonly CodingWorkbenchMode[];
  readonly onResumeModeChange: (mode: CodingWorkbenchMode) => void;
}

function RuntimeControls({
  state,
  actions,
  resumeMode,
  resumeModes,
  onResumeModeChange,
}: RuntimeControlsProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const running = activeRunState(state.run.value?.state);
  const busy = state.mutation.status === "pending";
  if (!running) return null;
  return (
    <div className={styles.runtimeControls} aria-label={t("codingWorkbench.controls.title")}>
      <span>{t("codingWorkbench.controls.help")}</span>
      {state.run.value?.state === "paused" && resumeMode !== null ? (
        <div className={styles.resumeModeControl}>
          <label className={styles.resumeModeLabel} htmlFor="coding-workbench-resume-mode">
            {t("codingWorkbench.controls.resumeMode.label")}
          </label>
          <select
            className={styles.resumeModeSelect}
            id="coding-workbench-resume-mode"
            value={resumeMode}
            disabled={busy}
            aria-describedby="coding-workbench-resume-mode-help"
            onChange={(event): void => {
              if (isCodingWorkbenchMode(event.target.value)) {
                onResumeModeChange(event.target.value);
              }
            }}
          >
            {resumeModes.map((mode) => (
              <option key={mode} value={mode}>
                {modeLabel(mode, t)}
              </option>
            ))}
          </select>
          <span className="sr-only" id="coding-workbench-resume-mode-help">
            {t("codingWorkbench.controls.resumeMode.help")}
          </span>
        </div>
      ) : null}
      <div className={styles.inlineActions}>
        <button
          className={cx(styles.button, styles.buttonDanger)}
          type="button"
          disabled={!running || busy}
          onClick={() => void actions.stop()}
        >
          {t("codingWorkbench.controls.stop")}
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={!running || busy}
          onClick={() => void actions.takeover()}
        >
          {t("codingWorkbench.controls.takeover")}
        </button>
      </div>
    </div>
  );
}

function PermissionPrompt({
  state,
  research,
  onDecision,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly research: CodingWorkbenchResearchState;
  readonly onDecision: (decision: CodingWorkbenchRuntimeApprovalDecision) => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const request = state.run.value?.pendingPermission;
  // Called before the early return so the hook order is stable; an absent request scopes it to idle.
  const approvalReview = useCodingWorkbenchApprovalReview({
    runId: state.run.value?.runId,
    permissionRequestId: request?.actionKind === "file-edit" ? request.requestId : undefined,
  });
  if (request === undefined) return null;
  const busy = state.mutation.status === "pending";
  return (
    <section className={cx(styles.card, styles.permission)} aria-labelledby="permission-title">
      <PanelTitle eyebrow={t("codingWorkbench.approval.eyebrow")} id="permission-title">
        {t("codingWorkbench.approval.title")}
      </PanelTitle>
      <ApprovalFacts request={request} t={t} />
      <ApprovalChangedFiles state={approvalReview} t={t} />
      {request.kind === "network-egress" ? <ResearchDestination state={research} t={t} /> : null}
      <p className={styles.helpText}>{t("codingWorkbench.approval.help")}</p>
      <div className={styles.controls}>
        <button
          className={cx(styles.button, styles.buttonPrimary)}
          type="button"
          disabled={busy}
          onClick={() => onDecision("approved")}
        >
          {t("codingWorkbench.approval.approve")}
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          onClick={() => onDecision("denied")}
        >
          {t("codingWorkbench.approval.deny")}
        </button>
      </div>
    </section>
  );
}

/**
 * The one place a Code task's edit tool surfaces a specific diff for explicit confirmation before
 * it is written (mirrors the Editor's own agent-changeset review, ADR-0125 D1 "workspace-contained"
 * high risk): the headless bridge (`useCodingWorkbenchEditorBridge`) only reaches this state when
 * the run's mode requires review, so it must never auto-resolve on its own.
 */
function ChangesetReviewPanel({
  review,
  onApprove,
  onDeny,
  onRetry,
}: {
  readonly review: CodingWorkbenchChangesetReview | null;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  if (review === null) return null;
  const labels = diffLabels(t);
  const failureCode = review.deliveryFailure?.code;
  return (
    <section
      className={cx(styles.card, styles.permission)}
      aria-labelledby="changeset-review-title"
    >
      <PanelTitle
        eyebrow={t("codingWorkbench.changesetReview.eyebrow")}
        id="changeset-review-title"
      >
        {t("codingWorkbench.changesetReview.title")}
      </PanelTitle>
      <p className={styles.helpText}>{t("codingWorkbench.changesetReview.help")}</p>
      {review.deliveryFailed ? (
        <p className={styles.alert} role="alert" data-decision-failure-code={failureCode}>
          <span aria-hidden="true">!</span> {changesetDeliveryAlert(review.deliveryFailure, t)}
        </p>
      ) : null}
      <div className="rv-body">
        {review.diff.files.length === 0 ? (
          <p className={styles.helpText}>{t("codingWorkbench.changesetReview.empty")}</p>
        ) : (
          review.diff.files.map((file, index) => (
            <DiffFileSection
              key={`${file.path}:${String(index)}`}
              file={file}
              index={index}
              idPrefix="coding-workbench-changeset-review-file"
              sectionRef={() => undefined}
              labels={labels}
            />
          ))
        )}
      </div>
      <div className={styles.controls}>
        {review.deliveryFailed ? (
          <button
            className={cx(styles.button, styles.buttonPrimary)}
            type="button"
            disabled={review.deciding}
            onClick={onRetry}
          >
            {t("codingWorkbench.changesetReview.retry")}
          </button>
        ) : (
          <button
            className={cx(styles.button, styles.buttonPrimary)}
            type="button"
            disabled={review.deciding}
            onClick={onApprove}
          >
            {t("codingWorkbench.changesetReview.approve")}
          </button>
        )}
        <button className={styles.button} type="button" disabled={review.deciding} onClick={onDeny}>
          {t("codingWorkbench.changesetReview.deny")}
        </button>
      </div>
    </section>
  );
}

/**
 * The destination of a pending research fetch (#2387). Both values are model-chosen and therefore
 * untrusted: they are rendered as plain text nodes, never as markup or as a live link, so reviewing
 * an ask can never itself navigate anywhere. While the read is in flight, or when the window is not
 * paired, the panel says so rather than implying there is no destination.
 */
/**
 * The reviewable body of a `file-edit` approval (#2802): the workspace-relative files the change
 * would write and its magnitude. Without this the card carries only vocabulary — kind, class, risk
 * — and a human cannot exercise control over a change they are not shown (ADR-0129 D1).
 *
 * The paths arrive over the authenticated approval-review channel and are model-selected: they are
 * rendered as plain text, never as markup or a link, and no patch byte reaches this component.
 */
function ApprovalChangedFiles({
  state,
  t,
}: {
  readonly state: CodingWorkbenchApprovalReviewState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (state.status === "idle") return null;
  const review = state.review;
  return (
    <fieldset
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.approval.changes.title")}
    >
      <p className={styles.approvalResearchTitle}>{t("codingWorkbench.approval.changes.title")}</p>
      {review === null ? (
        <p className={styles.approvalResearchDetail}>
          {t(
            state.status === "loading"
              ? "codingWorkbench.approval.changes.loading"
              : "codingWorkbench.approval.changes.unavailable",
          )}
        </p>
      ) : (
        <>
          <dl className={styles.approvalFacts}>
            <ApprovalFact
              label={t("codingWorkbench.approval.changes.files")}
              value={String(review.fileCount)}
            />
            <ApprovalFact
              label={t("codingWorkbench.approval.changes.lines")}
              value={t("codingWorkbench.approval.changes.lineCounts", {
                added: review.addedLines,
                deleted: review.deletedLines,
              })}
            />
          </dl>
          <ul className={styles.approvalChangedFiles}>
            {review.paths.map((path) => (
              <li className={styles.approvalChangedFile} key={path}>
                {path}
              </li>
            ))}
          </ul>
          {review.pathsTruncated ? (
            <p className={styles.approvalResearchDetail}>
              {t("codingWorkbench.approval.changes.truncated", {
                shown: review.paths.length,
                total: review.fileCount,
              })}
            </p>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

function ResearchDestination({
  state,
  t,
}: {
  readonly state: CodingWorkbenchResearchState;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (state.status === "idle") return null;
  const ask = state.ask;
  return (
    <fieldset
      className={styles.approvalResearch}
      aria-label={t("codingWorkbench.approval.research.title")}
    >
      <p className={styles.approvalResearchTitle}>{t("codingWorkbench.approval.research.title")}</p>
      {ask === null ? (
        <p className={styles.approvalResearchDetail}>
          {t(
            state.status === "loading"
              ? "codingWorkbench.approval.research.loading"
              : "codingWorkbench.approval.research.unavailable",
          )}
        </p>
      ) : (
        <dl className={styles.approvalFacts}>
          <ApprovalFact label={t("codingWorkbench.approval.research.host")} value={ask.host} />
          <ApprovalFact
            label={t("codingWorkbench.approval.research.requestLine")}
            value={ask.requestLine}
          />
        </dl>
      )}
    </fieldset>
  );
}

function ApprovalFacts({
  request,
  t,
}: {
  readonly request: CodingWorkbenchRuntimePendingPermission;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <dl className={styles.approvalFacts} aria-label={t("codingWorkbench.approval.facts")}>
      {approvalFacts(request, t).map(({ label, value }) => (
        <ApprovalFact key={label} label={label} value={value} />
      ))}
    </dl>
  );
}

function approvalFacts(
  request: CodingWorkbenchRuntimePendingPermission,
  t: CodingWorkbenchTranslate,
): readonly { readonly label: string; readonly value: string }[] {
  const notSpecified = t("codingWorkbench.approval.notSpecified");
  return [
    { label: t("codingWorkbench.approval.permissionKind"), value: request.kind },
    { label: t("codingWorkbench.approval.actionClass"), value: request.actionClass },
    { label: t("codingWorkbench.approval.action"), value: request.actionKind ?? notSpecified },
    { label: t("codingWorkbench.approval.scope"), value: request.scopeLabel ?? notSpecified },
    {
      label: t("codingWorkbench.approval.commandClass"),
      value: request.commandLabel ?? t("codingWorkbench.approval.notApplicable"),
    },
    {
      label: t("codingWorkbench.approval.connectorScopes"),
      value: request.connectorScopes?.join(", ") || t("codingWorkbench.approval.noneRequested"),
    },
    {
      label: t("codingWorkbench.approval.risk"),
      value: request.risk ?? t("codingWorkbench.approval.unspecified"),
    },
    {
      label: t("codingWorkbench.approval.policyReason"),
      value: request.policyReason ?? notSpecified,
    },
    { label: t("codingWorkbench.approval.reasonCode"), value: request.reasonCode },
    { label: t("codingWorkbench.approval.expires"), value: request.expiresAt },
  ];
}

function ApprovalFact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactNode {
  return (
    <div className={styles.approvalFact}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RecoveryPanel({
  state,
  taskIntent,
  actions,
}: LiveSectionProps & { readonly taskIntent: string }): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const snapshot = state.run.value;
  if (snapshot?.state !== "recovery-required") return null;
  const busy = state.mutation.status === "pending";
  return (
    <section className={cx(styles.card, styles.recovery)} aria-labelledby="recovery-title">
      <PanelTitle eyebrow={t("codingWorkbench.recovery.eyebrow")} id="recovery-title">
        {t("codingWorkbench.recovery.title")}
      </PanelTitle>
      <p className={styles.summary}>{t("codingWorkbench.recovery.summary")}</p>
      {snapshot.recoveryAcknowledged === true ? (
        <button
          className={cx(styles.button, styles.buttonPrimary)}
          type="button"
          disabled={busy || !state.canRetry || taskIntent.trim().length === 0}
          onClick={() => void actions.retry(taskIntent)}
        >
          {t("codingWorkbench.recovery.retry")}
        </button>
      ) : (
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          onClick={() => void actions.acknowledgeRecovery()}
        >
          {t("codingWorkbench.recovery.acknowledge")}
        </button>
      )}
    </section>
  );
}
