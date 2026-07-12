"use client";

// Operator-facing task-workspace switcher (Issue #446, Epic #443, ADR-0090).
//
// The single context control that makes the active task workspace TRUSTWORTHY (AC5): it shows the
// active task identity, branch, base branch, managed worktree path, health, dirty state, and lock
// state, the legal lifecycle actions (switch / pause / resume / handoff), and a create form. It reads
// the shared ActiveWorkspace context, so the badges and the bound-surface roots are always derived
// from ONE source of truth. a11y: state changes announce through a role=status aria-live region,
// busy controls use aria-disabled (focus stays put), errors use role=alert, recovery hints sit in a
// <details> disclosure.

import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  nextLegalTaskWorkspaceStates,
  type TaskWorkspaceHealth,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { useActiveWorkspace, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { Icons } from "./Icons";

type Tone = "success" | "warning" | "danger" | "info" | "muted";

const TONE_VAR: Readonly<Record<Tone, string>> = {
  success: "var(--feedback-success, #2e7d32)",
  warning: "var(--feedback-warning, #b8860b)",
  danger: "var(--feedback-danger, #c0392b)",
  info: "var(--feedback-info, #2b6cb0)",
  muted: "var(--text-tertiary, #888)",
};

const HEALTH_TONE: Readonly<Record<TaskWorkspaceHealth, Tone>> = {
  healthy: "success",
  degraded: "warning",
  drifted: "warning",
  "locked-out": "danger",
  missing: "danger",
  unknown: "muted",
};

function pathBasename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/u, "");
  const parts = trimmed.split(/[/\\]/u);
  return parts[parts.length - 1] ?? path;
}

export function isWorkspaceDirty(instance: WorkspaceInstance): boolean {
  return instance.driftMarkers.includes("uncommitted-changes");
}

function canSwitchTo(instance: WorkspaceInstance): boolean {
  // setActive delegates to the #445 activation, which walks active/paused/handoff-ready → active.
  return (
    instance.lifecycleState === "active" ||
    instance.lifecycleState === "paused" ||
    instance.lifecycleState === "handoff-ready"
  );
}

function badge(label: string, tone: Tone, title?: string): ReactNode {
  const toneVar = TONE_VAR[tone];
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.05rem 0.4rem",
    borderRadius: "var(--radius-sm, 4px)",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "var(--text-primary, #111)",
    background: `color-mix(in oklch, ${toneVar} 18%, var(--surface-raised, var(--surface, transparent)))`,
    border: `1px solid color-mix(in oklch, ${toneVar} 48%, var(--border-subtle, transparent))`,
  };
  return (
    <span className="tw-switcher-badge" style={style} title={title}>
      {label}
    </span>
  );
}

function ActiveDetails({
  instance,
  t,
}: {
  readonly instance: WorkspaceInstance;
  readonly t: I18nTranslate;
}): ReactNode {
  const dirty = isWorkspaceDirty(instance);
  return (
    <div className="tw-switcher-active">
      <div className="tw-switcher-identity">
        <strong className="tw-switcher-task" title={instance.taskId}>
          {instance.taskId}
        </strong>
        <span className="tw-switcher-branch" title={instance.taskBranch}>
          {instance.taskBranch}
          <span className="tw-switcher-base"> ← {instance.baseBranch}</span>
        </span>
      </div>
      <div
        className="tw-switcher-badges"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}
      >
        {badge(instance.lifecycleState, "info", t("taskWorkspace.lifecycleState"))}
        {badge(instance.health, HEALTH_TONE[instance.health], t("taskWorkspace.health"))}
        {dirty
          ? badge(
              t("taskWorkspace.dirty.uncommitted"),
              "warning",
              t("taskWorkspace.dirty.uncommittedTitle"),
            )
          : badge(t("taskWorkspace.dirty.clean"), "success", t("taskWorkspace.dirty.cleanTitle"))}
        {instance.lock !== null
          ? badge(
              t("taskWorkspace.locked", { reason: instance.lock.reason }),
              "danger",
              t("taskWorkspace.lockedTitle", { owner: instance.lock.owner }),
            )
          : null}
      </div>
      <p className="tw-switcher-path" style={{ fontSize: "0.72rem", color: TONE_VAR.muted }}>
        <span title={instance.managedWorktreePath}>
          {pathBasename(instance.managedWorktreePath)}
        </span>
      </p>
      <p className="tw-switcher-activity" style={{ fontSize: "0.7rem", color: TONE_VAR.muted }}>
        {t("taskWorkspace.updatedAt", { value: instance.updatedAt })}
      </p>
      {instance.recoveryHints.length > 0 ? (
        <details className="tw-switcher-recovery">
          <summary>
            {t("taskWorkspace.recoveryHints", { count: instance.recoveryHints.length })}
          </summary>
          <ul>
            {instance.recoveryHints.map((hint, index) => (
              <li key={`${hint.marker}-${String(index)}`}>
                {hint.marker}: {hint.strategy}
                {hint.operatorActionRequired ? t("taskWorkspace.operatorActionRequired") : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function actionButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly enabled: boolean;
  readonly busy: boolean;
}): ReactNode {
  const disabled = !props.enabled || props.busy;
  return (
    <button
      type="button"
      className="tw-switcher-action"
      // aria-disabled (not native disabled) keeps focus stable while an action is in flight.
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) props.onClick();
      }}
    >
      {props.label}
    </button>
  );
}

// While the panel is open, Escape closes it and returns focus to the trigger (keyboard operability +
// focus restoration). A document listener keeps the non-interactive panel free of event handlers.
function useCloseOnEscape(
  open: boolean,
  setOpen: (value: boolean) => void,
  triggerRef: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, triggerRef]);
}

// GEN-UI-INTERACTION-006 — while the panel is open, a pointerdown outside the `.tw-switcher` root
// dismisses it (mirrors the Footer window-palette outside-click). Focus is intentionally NOT forced
// back to the trigger here: an outside click already moves focus to whatever was clicked, and the
// Escape path above owns focus restoration for keyboard dismissal.
function useCloseOnOutsideClick(
  open: boolean,
  setOpen: (value: boolean) => void,
  rootRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current !== null && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, setOpen, rootRef]);
}

function computeStatusText(active: WorkspaceInstance | null, t: I18nTranslate): string {
  return active === null
    ? t("taskWorkspace.status.none")
    : t("taskWorkspace.status.active", {
        taskId: active.taskId,
        branch: active.taskBranch,
        lifecycle: active.lifecycleState,
        health: active.health,
      });
}

function computeTriggerLabel(active: WorkspaceInstance | null, t: I18nTranslate): string {
  return active === null
    ? t("taskWorkspace.trigger.noActive")
    : t("taskWorkspace.trigger.active", { taskId: active.taskId });
}

function TriggerButton(props: {
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly panelId: string;
  readonly statusId: string;
  readonly open: boolean;
  readonly switching: boolean;
  readonly active: WorkspaceInstance | null;
  readonly label: string;
  readonly onToggle: () => void;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <button
      ref={props.triggerRef}
      type="button"
      className="tw-switcher-trigger"
      aria-expanded={props.open}
      aria-controls={props.panelId}
      aria-describedby={props.statusId}
      aria-label={props.label}
      aria-busy={props.switching}
      onClick={props.onToggle}
      data-active={props.active !== null ? "true" : "false"}
    >
      <Icons.branch size={14} />
      <span className="tw-switcher-trigger-label">
        {props.active === null ? props.t("taskWorkspace.title") : props.active.taskId}
      </span>
      {props.switching ? <span aria-hidden="true">…</span> : null}
    </button>
  );
}

function PanelError({ error }: { readonly error: string | null }): ReactNode {
  if (error === null) return null;
  return (
    <p role="alert" className="tw-switcher-error" style={{ color: TONE_VAR.danger }}>
      {error}
    </p>
  );
}

function ActiveWorkspaceActions(props: {
  readonly active: WorkspaceInstance;
  readonly canPause: boolean;
  readonly canHandoff: boolean;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const { active, api } = props;
  return (
    <div
      className="tw-switcher-actions"
      style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.4rem" }}
    >
      {actionButton({
        label: props.t("taskWorkspace.action.pause"),
        onClick: () => void api.pause(active.workspaceId),
        enabled: props.canPause,
        busy: api.switching,
      })}
      {actionButton({
        label: props.t("taskWorkspace.action.prepareHandoff"),
        onClick: () => void api.prepareHandoff(active.workspaceId),
        enabled: props.canHandoff && !isWorkspaceDirty(active),
        busy: api.switching,
      })}
      {actionButton({
        label: props.t("taskWorkspace.action.clearActive"),
        onClick: () => void api.clearActive(),
        enabled: true,
        busy: api.switching,
      })}
    </div>
  );
}

function EmptyWorkspaceState(props: {
  readonly repositoryRoot: string | null;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <div className="tw-switcher-empty">
      <span className="tw-switcher-empty-icon" aria-hidden="true">
        <Icons.branch size={16} />
      </span>
      <div>
        <strong>{props.t("taskWorkspace.empty.title")}</strong>
        <p>
          {props.repositoryRoot === null
            ? props.t("taskWorkspace.empty.openProject")
            : props.t("taskWorkspace.empty.switchOrCreate")}
        </p>
      </div>
    </div>
  );
}

function ActiveOrEmptySection(props: {
  readonly active: WorkspaceInstance | null;
  readonly repositoryRoot: string | null;
  readonly canPause: boolean;
  readonly canHandoff: boolean;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const { active } = props;
  if (active === null) {
    return <EmptyWorkspaceState repositoryRoot={props.repositoryRoot} t={props.t} />;
  }
  return (
    <>
      <ActiveDetails instance={active} t={props.t} />
      <ActiveWorkspaceActions
        active={active}
        canPause={props.canPause}
        canHandoff={props.canHandoff}
        api={props.api}
        t={props.t}
      />
    </>
  );
}

function instanceListItem(props: {
  readonly instance: WorkspaceInstance;
  readonly isActive: boolean;
  readonly switching: boolean;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const { instance, isActive } = props;
  return (
    <li key={instance.workspaceId} className="tw-switcher-list-item">
      <span className="tw-switcher-list-label" title={instance.managedWorktreePath}>
        <strong>{instance.taskId}</strong>
        <span>{instance.lifecycleState}</span>
        {isWorkspaceDirty(instance) ? badge(props.t("taskWorkspace.dirty.short"), "warning") : null}
      </span>
      {actionButton({
        label: isActive
          ? props.t("taskWorkspace.action.active")
          : props.t("taskWorkspace.action.switch"),
        onClick: () => void props.api.switchTo(instance.workspaceId),
        enabled: !isActive && canSwitchTo(instance),
        busy: props.switching,
      })}
    </li>
  );
}

function AvailableInstancesSection(props: {
  readonly instances: readonly WorkspaceInstance[];
  readonly active: WorkspaceInstance | null;
  readonly loading: boolean;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const { instances, active, t } = props;
  return (
    <div className="tw-switcher-section">
      <div className="tw-switcher-section-title">{t("taskWorkspace.available")}</div>
      {instances.length === 0 ? (
        <p className="tw-switcher-list-empty">
          {props.loading ? t("taskWorkspace.loading") : t("taskWorkspace.noneManaged")}
        </p>
      ) : (
        <ul
          className="tw-switcher-list"
          aria-label={t("taskWorkspace.list")}
          style={{ listStyle: "none", margin: 0, padding: 0 }}
        >
          {instances.map((instance) =>
            instanceListItem({
              instance,
              isActive: active?.workspaceId === instance.workspaceId,
              switching: props.api.switching,
              api: props.api,
              t,
            }),
          )}
        </ul>
      )}
    </div>
  );
}

function createProvisionSubmitHandler(params: {
  readonly api: ActiveWorkspaceApi;
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly createDisabled: boolean;
  readonly setTaskId: (value: string) => void;
  readonly setBaseBranch: (value: string) => void;
}): (event: FormEvent<HTMLFormElement>) => void {
  return (event) => {
    event.preventDefault();
    if (params.createDisabled) {
      return;
    }
    void params.api
      .provision({
        root: params.repositoryRoot,
        taskId: params.taskId.trim(),
        baseBranch: params.baseBranch.trim(),
      })
      .then(() => {
        params.setTaskId("");
        params.setBaseBranch("");
      });
  };
}

function CreateWorkspaceSection(props: {
  readonly repositoryRoot: string | null;
  readonly taskId: string;
  readonly setTaskId: (value: string) => void;
  readonly baseBranch: string;
  readonly setBaseBranch: (value: string) => void;
  readonly createDisabled: boolean;
  readonly api: ActiveWorkspaceApi;
  readonly t: I18nTranslate;
}): ReactNode {
  const { repositoryRoot, t } = props;
  if (repositoryRoot === null) return null;
  const onSubmit = createProvisionSubmitHandler({
    api: props.api,
    repositoryRoot,
    taskId: props.taskId,
    baseBranch: props.baseBranch,
    createDisabled: props.createDisabled,
    setTaskId: props.setTaskId,
    setBaseBranch: props.setBaseBranch,
  });
  return (
    <div className="tw-switcher-section">
      <div className="tw-switcher-section-title">{t("taskWorkspace.create.title")}</div>
      <form className="tw-switcher-create" onSubmit={onSubmit}>
        <label className="tw-switcher-field">
          <span>{t("taskWorkspace.create.taskId")}</span>
          <input
            type="text"
            value={props.taskId}
            onChange={(event) => {
              props.setTaskId(event.target.value);
            }}
            placeholder={t("taskWorkspace.create.taskIdPlaceholder")}
          />
        </label>
        <label className="tw-switcher-field">
          <span>{t("taskWorkspace.create.baseBranch")}</span>
          <input
            type="text"
            value={props.baseBranch}
            onChange={(event) => {
              props.setBaseBranch(event.target.value);
            }}
            placeholder={t("taskWorkspace.create.baseBranchPlaceholder")}
          />
        </label>
        <button
          type="submit"
          className="tw-switcher-create-submit"
          disabled={props.createDisabled}
          aria-disabled={props.createDisabled}
        >
          {t("taskWorkspace.create.submit")}
        </button>
      </form>
    </div>
  );
}

function TaskWorkspacePanel(props: {
  readonly panelId: string;
  readonly active: WorkspaceInstance | null;
  readonly api: ActiveWorkspaceApi;
  readonly canPause: boolean;
  readonly canHandoff: boolean;
  readonly repositoryRoot: string | null;
  readonly taskId: string;
  readonly setTaskId: (value: string) => void;
  readonly baseBranch: string;
  readonly setBaseBranch: (value: string) => void;
  readonly createDisabled: boolean;
  readonly t: I18nTranslate;
}): ReactNode {
  const { active, api, t } = props;
  return (
    <div
      id={props.panelId}
      className="tw-switcher-panel"
      role="group"
      aria-label={t("taskWorkspace.panel.aria")}
    >
      <div className="tw-switcher-panel-head">
        <span className="tw-switcher-kicker">{t("taskWorkspace.title")}</span>
        <strong>{active === null ? t("taskWorkspace.noWorkspaceBound") : active.taskId}</strong>
      </div>
      <PanelError error={api.error} />
      <ActiveOrEmptySection
        active={active}
        repositoryRoot={props.repositoryRoot}
        canPause={props.canPause}
        canHandoff={props.canHandoff}
        api={api}
        t={t}
      />
      <AvailableInstancesSection
        instances={api.instances}
        active={active}
        loading={api.loading}
        api={api}
        t={t}
      />
      <CreateWorkspaceSection
        repositoryRoot={props.repositoryRoot}
        taskId={props.taskId}
        setTaskId={props.setTaskId}
        baseBranch={props.baseBranch}
        setBaseBranch={props.setBaseBranch}
        createDisabled={props.createDisabled}
        api={api}
        t={t}
      />
    </div>
  );
}

function TaskWorkspaceSwitcherImpl(): ReactNode {
  const t = useTranslate();
  const api = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const panelId = useId();
  const statusId = useId();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useCloseOnEscape(open, setOpen, triggerRef);
  useCloseOnOutsideClick(open, setOpen, rootRef);

  const active = api.activeInstance;
  const legalNext = active === null ? [] : nextLegalTaskWorkspaceStates(active.lifecycleState);
  const canPause = active !== null && legalNext.includes("paused");
  const canHandoff = active !== null && legalNext.includes("handoff-ready");
  const statusText = computeStatusText(active, t);
  const triggerLabel = computeTriggerLabel(active, t);

  const repositoryRoot =
    api.activeInstance?.repositoryRoot ?? api.instances[0]?.repositoryRoot ?? null;
  const createDisabled =
    api.switching || repositoryRoot === null || taskId.trim() === "" || baseBranch.trim() === "";

  return (
    <div ref={rootRef} className="tw-switcher" style={{ position: "relative" }}>
      <TriggerButton
        triggerRef={triggerRef}
        panelId={panelId}
        statusId={statusId}
        open={open}
        switching={api.switching}
        active={active}
        label={triggerLabel}
        onToggle={() => {
          setOpen((value) => !value);
        }}
        t={t}
      />

      {/* Polite live region: a switch / pause / resume announces the new active context to AT. */}
      <div id={statusId} role="status" aria-live="polite" className="tw-switcher-status-sr">
        {statusText}
      </div>

      {open ? (
        <TaskWorkspacePanel
          panelId={panelId}
          active={active}
          api={api}
          canPause={canPause}
          canHandoff={canHandoff}
          repositoryRoot={repositoryRoot}
          taskId={taskId}
          setTaskId={setTaskId}
          baseBranch={baseBranch}
          setBaseBranch={setBaseBranch}
          createDisabled={createDisabled}
          t={t}
        />
      ) : null}
    </div>
  );
}

export const TaskWorkspaceSwitcher = memo(TaskWorkspaceSwitcherImpl);
