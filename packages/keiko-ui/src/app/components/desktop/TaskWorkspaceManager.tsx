"use client";

// Discoverable, server-truth management surface for the repository-scoped Task Workspace
// inventory (Issue #2946). It deliberately owns no persisted lifecycle state: the shared
// ActiveWorkspaceContext reloads the authoritative BFF view after every mutation.

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  TaskWorkspaceDriftMarker,
  TaskWorkspaceLifecycleState,
  WorkspaceInstance,
  WorkspaceRecoveryHint,
} from "@oscharko-dev/keiko-contracts";
import {
  isAutomaticWorkspaceRepairStrategy,
  nextLegalTaskWorkspaceStates,
} from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { TASK_WORKSPACE_MARKER_MESSAGE_KEYS } from "@/lib/task-workspace-marker-labels";
import { useOptionalAnnouncer } from "./context/AnnouncerContext";
import { useActiveWorkspace, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { Icons } from "./Icons";
import styles from "./TaskWorkspaceManager.module.css";

const ChevronIcon = Icons.chevron;
const GitIcon = Icons.git;

type LifecycleAction = "pause" | "resume" | "handoff" | "switch" | "repair";
// The four actions above carry a fixed lifecycle target state (checked against
// `nextLegalTaskWorkspaceStates`). `repair` does not: its applicability comes from the instance's
// own recovery hints (see `firstAutomaticRepairHint`), never from a lifecycle transition.
type StateBoundAction = Exclude<LifecycleAction, "repair">;

const ACTION_TARGET_STATES: Readonly<Record<StateBoundAction, TaskWorkspaceLifecycleState>> = {
  pause: "paused",
  resume: "active",
  handoff: "handoff-ready",
  switch: "active",
};

// The inventory spans every repository, so each row names the one it belongs to — by its last path
// segment, the way the folder switcher names a selection; the full path rides on the title.
function repositoryLabel(repositoryRoot: string): string {
  const segments = repositoryRoot.split(/[\\/]/u).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? repositoryRoot;
}

function isDirty(instance: WorkspaceInstance): boolean {
  return instance.driftMarkers.includes("uncommitted-changes");
}

// The first recovery hint a Repair click can apply automatically: no operator action needed, and
// the strategy is one the #447 repair service actually runs without further gating
// (reconcile-pointer, recreate-worktree, release-stale-lock). Null when every hint needs a human
// first (operator-repair, reattach-branch, commit-or-stash-required) or there is no hint at all.
function firstAutomaticRepairHint(instance: WorkspaceInstance): WorkspaceRecoveryHint | null {
  return (
    instance.recoveryHints.find(
      (hint) => !hint.operatorActionRequired && isAutomaticWorkspaceRepairStrategy(hint.strategy),
    ) ?? null
  );
}

function actionLabel(action: LifecycleAction, t: I18nTranslate): string {
  const labels: Readonly<Record<LifecycleAction, string>> = {
    pause: t("taskWorkspace.action.pause"),
    resume: t("taskWorkspace.action.resume"),
    handoff: t("taskWorkspace.action.prepareHandoff"),
    switch: t("taskWorkspace.action.switch"),
    repair: t("taskWorkspace.action.repair"),
  };
  return labels[action];
}

function unavailableStateReason(action: StateBoundAction, t: I18nTranslate): string {
  const reasons: Readonly<Record<StateBoundAction, string>> = {
    pause: t("taskWorkspace.reason.pauseUnavailable"),
    resume: t("taskWorkspace.reason.resumeUnavailable"),
    handoff: t("taskWorkspace.reason.handoffUnavailable"),
    switch: t("taskWorkspace.reason.switchUnavailable"),
  };
  return reasons[action];
}

// Switching binds the active pointer to a workspace the server can activate: one that is already
// `active` (activation is idempotent there — the contract's transition table has no self-edge,
// so a table lookup alone reported every other active workspace as unswitchable, which is exactly
// the "bind two workspaces, then switch between them" flow; observed live, 2026-09-03) or one the
// table lets reach `active` (paused, handoff-ready, recovery-required).
function isSwitchable(lifecycleState: TaskWorkspaceLifecycleState): boolean {
  return (
    lifecycleState === "active" || nextLegalTaskWorkspaceStates(lifecycleState).includes("active")
  );
}

function stateBoundActionAllowed(
  action: StateBoundAction,
  lifecycleState: TaskWorkspaceLifecycleState,
): boolean {
  if (action === "switch") return isSwitchable(lifecycleState);
  return nextLegalTaskWorkspaceStates(lifecycleState).includes(ACTION_TARGET_STATES[action]);
}

// `repair` is only ever rendered once `workspaceActions` has already found an applicable
// automatic hint, so it has nothing left to refuse here beyond the shared busy state
// `LifecycleButton` applies to every action.
function actionUnavailableReason(
  action: LifecycleAction,
  instance: WorkspaceInstance,
  t: I18nTranslate,
): string | null {
  if (action === "repair") return null;
  if (!stateBoundActionAllowed(action, instance.lifecycleState)) {
    return unavailableStateReason(action, t);
  }
  return action === "handoff" && isDirty(instance) ? t("taskWorkspace.reason.handoffDirty") : null;
}

function actionFor(
  api: ActiveWorkspaceApi,
  action: LifecycleAction,
  instance: WorkspaceInstance,
): () => void {
  if (action === "repair") {
    const hint = firstAutomaticRepairHint(instance);
    return () => {
      if (hint !== null) void api.repair(instance.workspaceId, hint.strategy);
    };
  }
  const actions: Readonly<Record<StateBoundAction, () => void>> = {
    pause: () => void api.pause(instance.workspaceId),
    resume: () => void api.resume(instance.workspaceId),
    handoff: () => void api.prepareHandoff(instance.workspaceId),
    switch: () => void api.switchTo(instance.workspaceId),
  };
  return actions[action];
}

function workspaceActions(
  instance: WorkspaceInstance,
  active: boolean,
): readonly LifecycleAction[] {
  if (active) return ["pause", "handoff"];
  if (instance.lifecycleState === "paused") return ["resume", "handoff"];
  return firstAutomaticRepairHint(instance) !== null ? ["repair", "switch"] : ["switch"];
}

// Every drift marker except `uncommitted-changes`, labelled next to the health text.
// `uncommitted-changes` keeps its existing dedicated "dirty" badge (below) instead of being
// repeated here as a second, differently-styled label for the same fact.
function driftMarkerLabels(
  instance: WorkspaceInstance,
  t: I18nTranslate,
): readonly { readonly marker: TaskWorkspaceDriftMarker; readonly label: string }[] {
  return instance.driftMarkers
    .filter((marker) => marker !== "uncommitted-changes")
    .map((marker) => ({ marker, label: t(TASK_WORKSPACE_MARKER_MESSAGE_KEYS[marker]) }));
}

function useWorkspacePanelState(): {
  readonly open: boolean;
  readonly panelId: string;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const toggle = useCallback((): void => setOpen((value) => !value), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      close();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return (): void => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, open]);

  return { open, panelId, triggerRef, rootRef, toggle };
}

function LifecycleButton(props: {
  readonly action: LifecycleAction;
  readonly instance: WorkspaceInstance;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const reason = actionUnavailableReason(props.action, props.instance, props.t);
  const busy = props.api.switching;
  const disabled = busy || reason !== null;
  const label = actionLabel(props.action, props.t);
  const unavailable = reason ?? (busy ? props.t("taskWorkspace.reason.busy") : null);
  return (
    <button
      type="button"
      className={styles["cmp-a"]}
      aria-disabled={disabled}
      aria-label={unavailable === null ? label : `${label}: ${unavailable}`}
      title={unavailable ?? undefined}
      onClick={() => {
        if (!disabled) actionFor(props.api, props.action, props.instance)();
      }}
    >
      {label}
    </button>
  );
}

function WorkspaceActions(props: {
  readonly instance: WorkspaceInstance;
  readonly active: boolean;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const actions = workspaceActions(props.instance, props.active);
  return (
    <div className={styles["cmp-as"]}>
      {props.active ? (
        <span className={styles["cmp-active"]}>{props.t("taskWorkspace.action.active")}</span>
      ) : null}
      {actions.map((action) => (
        <LifecycleButton
          key={action}
          action={action}
          instance={props.instance}
          api={props.api}
          t={props.t}
        />
      ))}
    </div>
  );
}

function WorkspaceItem(props: {
  readonly instance: WorkspaceInstance;
  readonly activeWorkspaceId: string | undefined;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const active = props.activeWorkspaceId === props.instance.workspaceId;
  const dirty = isDirty(props.instance);
  const markers = driftMarkerLabels(props.instance, props.t);
  return (
    <li className={styles["cmp-i"]} data-active={active ? "true" : "false"}>
      <div className={styles["cmp-id"]}>
        <strong title={props.instance.taskId}>{props.instance.taskId}</strong>
        <span title={props.instance.taskBranch}>{props.instance.taskBranch}</span>
        <span className={styles["cmp-meta"]} title={props.instance.repositoryRoot}>
          {repositoryLabel(props.instance.repositoryRoot)}
        </span>
        <span className={styles["cmp-meta"]}>{props.instance.lifecycleState}</span>
        <span className={styles["cmp-meta"]}>{props.instance.health}</span>
        {markers.map(({ marker, label }) => (
          <span key={marker} className={styles["cmp-meta"]}>
            {label}
          </span>
        ))}
        {dirty ? (
          <span className={styles["cmp-warn"]}>{props.t("taskWorkspace.dirty.short")}</span>
        ) : null}
      </div>
      <WorkspaceActions instance={props.instance} active={active} api={props.api} t={props.t} />
    </li>
  );
}

function WorkspaceInventory(props: {
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  if (props.api.loading)
    return <p className={styles["cmp-empty"]}>{props.t("taskWorkspace.loading")}</p>;
  if (props.api.instances.length === 0)
    return <p className={styles["cmp-empty"]}>{props.t("taskWorkspace.noneManaged")}</p>;
  return (
    <ul className={styles["cmp-list"]} aria-label={props.t("taskWorkspace.list")}>
      {props.api.instances.map((instance) => (
        <WorkspaceItem
          key={instance.workspaceId}
          instance={instance}
          activeWorkspaceId={props.api.activeInstance?.workspaceId}
          api={props.api}
          t={props.t}
        />
      ))}
    </ul>
  );
}

function WorkspacePanelHeader(props: {
  readonly api: ActiveWorkspaceApi;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
  readonly refresh: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div className={styles["cmp-ph"]}>
      <h2 ref={props.headingRef} tabIndex={-1}>
        {props.t("taskWorkspace.title")}
      </h2>
      <button
        type="button"
        className={styles["cmp-rf"]}
        aria-disabled={props.api.loading || props.api.switching}
        onClick={props.refresh}
      >
        {props.t("taskWorkspace.action.refresh")}
      </button>
    </div>
  );
}

function ClearActiveButton(props: {
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const unavailable = props.api.activeInstance === null || props.api.switching;
  return (
    <button
      type="button"
      className={styles["cmp-clear"]}
      aria-disabled={unavailable}
      onClick={() => {
        if (!unavailable) void props.api.clearActive();
      }}
    >
      {props.t("taskWorkspace.action.clearActive")}
    </button>
  );
}

function WorkspacePanel(props: {
  readonly api: ActiveWorkspaceApi;
  readonly panelId: string;
  readonly t: I18nTranslate;
}): ReactNode {
  const announcer = useOptionalAnnouncer();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const refresh = (): void => {
    if (props.api.loading || props.api.switching) return;
    void props.api.refresh().then((succeeded) => {
      if (succeeded) announcer.announce(props.t("taskWorkspace.status.reconciled"));
    });
  };
  return (
    <dialog
      open
      id={props.panelId}
      className={styles["cmp-p"]}
      aria-modal="false"
      aria-label={props.t("taskWorkspace.panel.aria")}
    >
      <WorkspacePanelHeader api={props.api} headingRef={headingRef} refresh={refresh} t={props.t} />
      {props.api.error === null ? null : (
        <p role="alert" className={styles["cmp-e"]}>
          {props.api.error}
        </p>
      )}
      <WorkspaceInventory api={props.api} t={props.t} />
      <ClearActiveButton api={props.api} t={props.t} />
    </dialog>
  );
}

function statusText(api: ActiveWorkspaceApi, t: I18nTranslate): string {
  if (api.switching) return t("taskWorkspace.status.updating");
  if (api.loading) return t("taskWorkspace.loading");
  if (api.activeInstance === null) return t("taskWorkspace.status.none");
  return t("taskWorkspace.status.active", {
    taskId: api.activeInstance.taskId,
    branch: api.activeInstance.taskBranch,
    lifecycle: api.activeInstance.lifecycleState,
    health: api.activeInstance.health,
  });
}

function TaskWorkspaceManagerImpl(): ReactNode {
  const api = useActiveWorkspace();
  const t = useTranslate();
  const panel = useWorkspacePanelState();
  const active = api.activeInstance;
  const label = active === null ? t("taskWorkspace.title") : active.taskId;
  return (
    <div ref={panel.rootRef} className={styles["cmp-r"]}>
      <button
        ref={panel.triggerRef}
        type="button"
        className={styles["cmp-t"]}
        aria-expanded={panel.open}
        aria-controls={panel.panelId}
        aria-haspopup="dialog"
        aria-busy={api.loading || api.switching}
        aria-label={
          active === null
            ? t("taskWorkspace.trigger.noActive")
            : t("taskWorkspace.trigger.active", { taskId: active.taskId })
        }
        onClick={panel.toggle}
      >
        <GitIcon size={16} aria-hidden="true" />
        <span>{label}</span>
        <ChevronIcon className={styles["cmp-c"] ?? ""} size={13} aria-hidden="true" />
      </button>
      <span className={styles["cmp-sr"]} role="status" aria-live="polite">
        {statusText(api, t)}
      </span>
      {panel.open ? <WorkspacePanel api={api} panelId={panel.panelId} t={t} /> : null}
    </div>
  );
}

export const TaskWorkspaceManager = memo(TaskWorkspaceManagerImpl);
