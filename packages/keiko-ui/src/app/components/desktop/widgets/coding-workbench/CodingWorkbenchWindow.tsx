"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimePendingPermission,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
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
import {
  useCodingWorkbenchResearch,
  type CodingWorkbenchResearchState,
} from "@/lib/useCodingWorkbenchResearch";
import {
  useCodingWorkbenchEditorBridge,
  type CodingWorkbenchChangesetReview,
} from "@/lib/useCodingWorkbenchEditorBridge";
import { useOptionalActiveWorkspace } from "../../context/ActiveWorkspaceContext";
import { DiffFileSection } from "../cards/shared/diffView";
import { PanelTitle, TaskStartSection, Timeline, WorkbenchHeader } from "./CodingWorkbenchSections";
import { CodingWorkbenchSetup } from "./CodingWorkbenchSetup";
import { CodingWorkbenchChanges, diffLabels } from "./CodingWorkbenchChanges";
import { ResearchGrantChip } from "./CodingWorkbenchResearchGrant";
import {
  activeRunState,
  cx,
  lifecycleAnnouncement,
  modeLabel,
  modelSourceLabel,
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

function latestChangesSignal(events: readonly CodingWorkbenchRuntimeSseEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "status" || event?.eventKind === "diff-summarized") return event.cursor;
  }
  return null;
}

export function CodingWorkbenchWindow(): ReactNode {
  const activeWorkspace = useOptionalActiveWorkspace() ?? EMPTY_WORKSPACE;
  const { state, actions } = useCodingWorkbenchRuntime({ workspace: activeWorkspace });
  const autonomyPolicy = useAutonomyModePolicy();
  const research = useCodingWorkbenchResearch({
    runId: state.run.value?.runId,
    revision: state.run.value?.revision,
    permissionRequestId: state.run.value?.pendingPermission?.requestId,
  });
  const [taskIntent, setTaskIntent] = useState("");
  const focusRef = useRef<HTMLHeadingElement>(null);
  const approvalAction = useRef(false);
  const t = useCodingWorkbenchTranslate();
  const workbenchLabel = useTranslate()("rail.coding");
  const pendingPermission = state.run.value?.pendingPermission;
  const runState = state.run.value?.state;
  const alert = visibleAlert(state, t, bootstrapSetupVisible(state, activeWorkspace));

  useEffect(() => {
    if (
      activeRunState(runState) ||
      state.mutation.status === "pending" ||
      state.requestedMode === autonomyPolicy.requestedMode
    ) {
      return;
    }
    actions.setRequestedMode(autonomyPolicy.requestedMode);
  }, [actions, autonomyPolicy.requestedMode, runState, state.mutation.status, state.requestedMode]);

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
      taskIntent={taskIntent}
      onTaskIntentChange={setTaskIntent}
      focusRef={focusRef}
      alert={alert}
      t={t}
      workbenchLabel={workbenchLabel}
      onDecision={decideApproval}
      research={research}
    />
  );
}

interface WorkbenchContentProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
  readonly activeWorkspace: UseCodingWorkbenchRuntimeInput["workspace"];
  readonly taskIntent: string;
  readonly onTaskIntentChange: (taskIntent: string) => void;
  readonly focusRef: RefObject<HTMLHeadingElement | null>;
  readonly alert: string | null;
  readonly t: CodingWorkbenchTranslate;
  readonly workbenchLabel: string;
  readonly onDecision: (decision: "approved" | "denied") => void;
  readonly research: CodingWorkbenchResearchState;
}

function WorkbenchContent({
  state,
  actions,
  activeWorkspace,
  taskIntent,
  onTaskIntentChange,
  focusRef,
  alert,
  t,
  workbenchLabel,
  onDecision,
  research,
}: WorkbenchContentProps): ReactNode {
  const runState = state.run.value?.state;
  return (
    <section
      className={styles.shell}
      aria-label={workbenchLabel}
      aria-busy={state.mutation.status === "pending"}
      data-state={runState ?? "idle"}
    >
      <WorkbenchHeader state={state} focusRef={focusRef} />
      <SessionContextBar state={state} activeWorkspace={activeWorkspace} />
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {lifecycleAnnouncement(state, t, research.grant)}
      </p>
      {alert ? (
        <p className={styles.alert} role="alert">
          <span aria-hidden="true">!</span> {alert}
        </p>
      ) : null}
      <WorkbenchColumns
        state={state}
        actions={actions}
        activeWorkspace={activeWorkspace}
        taskIntent={taskIntent}
        onTaskIntentChange={onTaskIntentChange}
        onDecision={onDecision}
        research={research}
      />
    </section>
  );
}

function WorkbenchColumns({
  state,
  actions,
  activeWorkspace,
  taskIntent,
  onTaskIntentChange,
  onDecision,
  research,
}: Omit<WorkbenchContentProps, "alert" | "focusRef" | "t" | "workbenchLabel">): ReactNode {
  const t = useCodingWorkbenchTranslate();
  // The bootstrap Code setup (#2385) renders whenever no active task-workspace binding exists, so a
  // hand-bound repository can be bound → verified → started entirely from the UI (#2476). It no longer
  // hides behind runtime availability: on an unactivated install it stays reachable and honestly
  // explains why a run cannot start yet (#2476 AC4). Once a binding lands it yields to the task-start
  // flow. The honest note shows only once readiness has RESOLVED as unavailable, never during load.
  const showSetup = bootstrapSetupVisible(state, activeWorkspace);
  const runtimeUnavailable =
    state.runtime.status === "ready" && state.runtime.value?.runtimeAvailable === false;
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
  const taskComposer = (
    <TaskStartSection
      taskIntent={taskIntent}
      onTaskIntentChange={onTaskIntentChange}
      actions={{
        onStart: () => void actions.start(taskIntent.trim()),
        onPause: () => void actions.pause(),
        onResume: () => void actions.resume(),
        onSend: () => void actions.submitFollowUp(taskIntent.trim()),
      }}
      canStart={state.canStart}
      runState={state.run.value?.state}
      mutationPending={state.mutation.status === "pending"}
      startBusy={state.mutation.kind === "start" && state.mutation.status === "pending"}
    />
  );
  if (showSetup) {
    return (
      <div className={styles.emptySession}>
        <CodingWorkbenchSetup
          refreshWorkspace={(root) => activeWorkspace.refresh(root)}
          runtimeUnavailable={runtimeUnavailable}
        />
      </div>
    );
  }
  return (
    <div className={styles.session}>
      <div
        className={styles.sessionStream}
        role="log"
        aria-label={t("codingWorkbench.readiness.eventStream.label")}
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
        <Timeline events={state.events} activity={activity} questions={questions} />
        <CodingWorkbenchChanges
          root={
            activeWorkspace.error === null
              ? (activeWorkspace.activeBinding?.activeRoot ?? null)
              : null
          }
          runId={state.run.value?.runId}
          changeSignal={latestChangesSignal(state.events)}
          bindingPending={activeWorkspace.loading || activeWorkspace.switching}
        />
      </div>
      <div className={styles.composerDock}>
        <RuntimeControls state={state} actions={actions} />
        {taskComposer}
      </div>
    </div>
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

// The bound worktree's health belongs next to its identity: a drifted worktree must stay visible in
// the session context bar rather than only in the readiness resources (#1990). The projection always
// carries a health, so there is no unreported case to branch on.
function workspaceContextValue(
  workspace: CodingWorkbenchRuntimeState["workspace"]["value"],
  t: CodingWorkbenchTranslate,
): string {
  if (workspace === null) return t("codingWorkbench.readiness.workspace.none");
  return `${workspace.taskId} · ${workspace.taskBranch} · ${workspace.health}`;
}

function SessionContextBar({
  state,
  activeWorkspace,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly activeWorkspace: UseCodingWorkbenchRuntimeInput["workspace"];
}): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const workspace = state.workspace.value;
  const source = state.source.value;
  // Never present the locally requested mode as the effective one. Until readiness resolves, the
  // request and the server's answer can differ — a deployment ceiling clamps it — and this bar is
  // where an operator reads the authority a run will actually get.
  const confirmedMode = state.runtime.value?.effectiveMode ?? null;
  const repository = activeWorkspace.activeBinding?.activeRoot;
  const workspaceValue = workspaceContextValue(workspace, t);
  const sourceValue =
    source === null
      ? t("codingWorkbench.readiness.modelSource.select")
      : modelSourceLabel(source.modelSource, t);
  return (
    <div className={styles.contextBar} aria-label={t("codingWorkbench.header.summary")}>
      <span className={styles.contextItem} title={repository}>
        <span className={styles.contextLabel}>
          {t("codingWorkbench.readiness.workspace.label")}
        </span>
        <span className={styles.contextValue}>{workspaceValue}</span>
      </span>
      <span className={styles.contextItem}>
        <span className={styles.contextLabel}>
          {t("codingWorkbench.readiness.modelSource.label")}
        </span>
        <span className={styles.contextValue}>{sourceValue}</span>
      </span>
      <span
        className={styles.contextItem}
        {...(confirmedMode === null ? {} : { "data-mode": confirmedMode })}
      >
        <span className={styles.contextLabel}>{t("codingWorkbench.mode.eyebrow")}</span>
        <span className={styles.contextValue}>
          {confirmedMode === null
            ? t("codingWorkbench.mode.unconfirmed")
            : modeLabel(confirmedMode, t)}
        </span>
      </span>
    </div>
  );
}

interface LiveSectionProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
}

function RuntimeControls({ state, actions }: LiveSectionProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const running = activeRunState(state.run.value?.state);
  const busy = state.mutation.status === "pending";
  if (!running) return null;
  return (
    <div className={styles.runtimeControls} aria-label={t("codingWorkbench.controls.title")}>
      <span>{t("codingWorkbench.controls.help")}</span>
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
  if (request === undefined) return null;
  const busy = state.mutation.status === "pending";
  return (
    <section className={cx(styles.card, styles.permission)} aria-labelledby="permission-title">
      <PanelTitle eyebrow={t("codingWorkbench.approval.eyebrow")} id="permission-title">
        {t("codingWorkbench.approval.title")}
      </PanelTitle>
      <ApprovalFacts request={request} t={t} />
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
        <p className={styles.alert} role="alert">
          <span aria-hidden="true">!</span> {t("codingWorkbench.changesetReview.deliveryFailed")}
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
