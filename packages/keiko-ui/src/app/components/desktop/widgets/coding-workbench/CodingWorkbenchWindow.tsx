"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  CodingWorkbenchRuntimeApprovalDecision,
  CodingWorkbenchRuntimePendingPermission,
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
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import { useOptionalActiveWorkspace } from "../../context/ActiveWorkspaceContext";
import {
  ModeAuthority,
  PanelTitle,
  ReadinessGrid,
  TaskStartSection,
  Timeline,
  WorkbenchHeader,
} from "./CodingWorkbenchSections";
import { ModelRuntimeStatus } from "./CodingWorkbenchModelCards";
import { activeRunState, cx, lifecycleAnnouncement, visibleAlert } from "./codingWorkbenchLabels";
import styles from "./CodingWorkbenchWindow.module.css";

const EMPTY_WORKSPACE = {
  activeBinding: null,
  activeInstance: null,
  loading: false,
  switching: false,
  error: null,
  refresh: (): Promise<void> => Promise.resolve(),
} as const;

export function CodingWorkbenchWindow(): ReactNode {
  const activeWorkspace = useOptionalActiveWorkspace() ?? EMPTY_WORKSPACE;
  const { state, actions } = useCodingWorkbenchRuntime({ workspace: activeWorkspace });
  const [taskIntent, setTaskIntent] = useState("");
  const focusRef = useRef<HTMLHeadingElement>(null);
  const approvalAction = useRef(false);
  const t = useCodingWorkbenchTranslate();
  const workbenchLabel = useTranslate()("rail.coding");
  const pendingPermission = state.run.value?.pendingPermission;
  const runState = state.run.value?.state;
  const locked = activeRunState(runState) || state.mutation.status === "pending";
  const alert = visibleAlert(state, t);

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
      locked={locked}
      alert={alert}
      t={t}
      workbenchLabel={workbenchLabel}
      onDecision={decideApproval}
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
  readonly locked: boolean;
  readonly alert: string | null;
  readonly t: CodingWorkbenchTranslate;
  readonly workbenchLabel: string;
  readonly onDecision: (decision: "approved" | "denied") => void;
}

function WorkbenchContent({
  state,
  actions,
  activeWorkspace,
  taskIntent,
  onTaskIntentChange,
  focusRef,
  locked,
  alert,
  t,
  workbenchLabel,
  onDecision,
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
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {lifecycleAnnouncement(state, t)}
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
        locked={locked}
        onDecision={onDecision}
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
  locked,
  onDecision,
}: Omit<WorkbenchContentProps, "alert" | "focusRef" | "t" | "workbenchLabel">): ReactNode {
  return (
    <div className={styles.grid}>
      <div className={styles.stack}>
        <TaskStartSection
          taskIntent={taskIntent}
          onTaskIntentChange={onTaskIntentChange}
          onStart={() => void actions.start(taskIntent.trim())}
          canStart={state.canStart}
          busy={state.mutation.kind === "start" && state.mutation.status === "pending"}
        />
        <ModeAuthority state={state} onModeChange={actions.setRequestedMode} locked={locked} />
        <ModelRuntimeStatus state={state} actions={actions} locked={locked} />
        <ReadinessGrid
          state={state}
          actions={actions}
          refreshWorkspace={() => activeWorkspace.refresh()}
        />
      </div>
      <div className={styles.stack}>
        <PermissionPrompt state={state} onDecision={onDecision} />
        <RecoveryPanel state={state} taskIntent={taskIntent} actions={actions} />
        <RuntimeControls state={state} actions={actions} />
        <Timeline events={state.events} />
      </div>
    </div>
  );
}

export default CodingWorkbenchWindow;

interface LiveSectionProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: CodingWorkbenchRuntimeActions;
}

function RuntimeControls({ state, actions }: LiveSectionProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const running = activeRunState(state.run.value?.state);
  const busy = state.mutation.status === "pending";
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-controls-title">
      <PanelTitle
        eyebrow={t("codingWorkbench.controls.eyebrow")}
        id="coding-workbench-controls-title"
      >
        {t("codingWorkbench.controls.title")}
      </PanelTitle>
      <div className={styles.controls}>
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
      <p className={styles.helpText}>{t("codingWorkbench.controls.help")}</p>
    </section>
  );
}

function PermissionPrompt({
  state,
  onDecision,
}: {
  readonly state: CodingWorkbenchRuntimeState;
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
