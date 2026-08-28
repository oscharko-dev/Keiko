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
import type { TaskWorkspaceLifecycleState, WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { nextLegalTaskWorkspaceStates } from "@oscharko-dev/keiko-contracts/runtime/task-workspace";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { useOptionalAnnouncer } from "./context/AnnouncerContext";
import { useActiveWorkspace, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { Icons } from "./Icons";
import styles from "./TaskWorkspaceManager.module.css";

const ChevronIcon = Icons.chevron;
const GitIcon = Icons.git;

type LifecycleAction = "pause" | "resume" | "handoff" | "switch";

const ACTION_TARGET_STATES: Readonly<Record<LifecycleAction, TaskWorkspaceLifecycleState>> = {
  pause: "paused",
  resume: "active",
  handoff: "handoff-ready",
  switch: "active",
};

function isDirty(instance: WorkspaceInstance): boolean {
  return instance.driftMarkers.includes("uncommitted-changes");
}

function actionLabel(action: LifecycleAction, t: I18nTranslate): string {
  const labels: Readonly<Record<LifecycleAction, string>> = {
    pause: t("taskWorkspace.action.pause"),
    resume: t("taskWorkspace.action.resume"),
    handoff: t("taskWorkspace.action.prepareHandoff"),
    switch: t("taskWorkspace.action.switch"),
  };
  return labels[action];
}

function unavailableStateReason(action: LifecycleAction, t: I18nTranslate): string {
  const reasons: Readonly<Record<LifecycleAction, string>> = {
    pause: t("taskWorkspace.reason.pauseUnavailable"),
    resume: t("taskWorkspace.reason.resumeUnavailable"),
    handoff: t("taskWorkspace.reason.handoffUnavailable"),
    switch: t("taskWorkspace.reason.switchUnavailable"),
  };
  return reasons[action];
}

function actionUnavailableReason(
  action: LifecycleAction,
  instance: WorkspaceInstance,
  t: I18nTranslate,
): string | null {
  if (
    !nextLegalTaskWorkspaceStates(instance.lifecycleState).includes(ACTION_TARGET_STATES[action])
  ) {
    return unavailableStateReason(action, t);
  }
  return action === "handoff" && isDirty(instance) ? t("taskWorkspace.reason.handoffDirty") : null;
}

function actionFor(
  api: ActiveWorkspaceApi,
  action: LifecycleAction,
  workspaceId: string,
): () => void {
  const actions: Readonly<Record<LifecycleAction, () => void>> = {
    pause: () => void api.pause(workspaceId),
    resume: () => void api.resume(workspaceId),
    handoff: () => void api.prepareHandoff(workspaceId),
    switch: () => void api.switchTo(workspaceId),
  };
  return actions[action];
}

function workspaceActions(
  instance: WorkspaceInstance,
  active: boolean,
): readonly LifecycleAction[] {
  if (active) return ["pause", "handoff"];
  if (instance.lifecycleState === "paused") return ["resume", "handoff", "switch"];
  return ["switch"];
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
        if (!disabled) actionFor(props.api, props.action, props.instance.workspaceId)();
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
  return (
    <li className={styles["cmp-i"]} data-active={active ? "true" : "false"}>
      <div className={styles["cmp-id"]}>
        <strong title={props.instance.taskId}>{props.instance.taskId}</strong>
        <span title={props.instance.taskBranch}>{props.instance.taskBranch}</span>
        <span className={styles["cmp-meta"]}>{props.instance.lifecycleState}</span>
        <span className={styles["cmp-meta"]}>{props.instance.health}</span>
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
    void props.api.refresh().then(() => {
      if (props.api.error === null) announcer.announce(props.t("taskWorkspace.status.reconciled"));
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
      <div className={styles["cmp-ph"]}>
        <h2 ref={headingRef} tabIndex={-1}>
          {props.t("taskWorkspace.title")}
        </h2>
        <button
          type="button"
          className={styles["cmp-rf"]}
          disabled={props.api.loading || props.api.switching}
          onClick={refresh}
        >
          {props.t("taskWorkspace.action.refresh")}
        </button>
      </div>
      {props.api.error === null ? null : (
        <p role="alert" className={styles["cmp-e"]}>
          {props.api.error}
        </p>
      )}
      <WorkspaceInventory api={props.api} t={props.t} />
      <button
        type="button"
        className={styles["cmp-clear"]}
        disabled={props.api.activeInstance === null || props.api.switching}
        onClick={() => void props.api.clearActive()}
      >
        {props.t("taskWorkspace.action.clearActive")}
      </button>
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
