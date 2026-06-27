"use client";

// Operator-facing task-workspace switcher (Issue #446, Epic #443, ADR-0090).
//
// The single context control that makes the active task workspace TRUSTWORTHY (AC5): it shows the
// active task identity, branch, base branch, managed worktree path, health, dirty state, and lock
// state, the legal lifecycle actions (switch / pause / resume / handoff), and a create form. It reads
// the shared ActiveWorkspace context, so the badges and the bound-surface roots are always derived
// from ONE source of truth. a11y: state changes announce through a role=status aria-live region,
// busy controls use aria-disabled (focus stays put), errors use role=alert, recovery hints sit in a
// <details> disclosure. No globals.css edits — visual tone comes from inline design tokens.

import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  nextLegalTaskWorkspaceStates,
  type TaskWorkspaceHealth,
  type WorkspaceInstance,
} from "@oscharko-dev/keiko-contracts";
import { useActiveWorkspace } from "./context/ActiveWorkspaceContext";

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

function ActiveDetails({ instance }: { readonly instance: WorkspaceInstance }): ReactNode {
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
        {badge(instance.lifecycleState, "info", "Lifecycle state")}
        {badge(instance.health, HEALTH_TONE[instance.health], "Workspace health")}
        {dirty
          ? badge("uncommitted", "warning", "The worktree has uncommitted changes")
          : badge("clean", "success", "The worktree is clean")}
        {instance.lock !== null
          ? badge(`locked: ${instance.lock.reason}`, "danger", `Held by ${instance.lock.owner}`)
          : null}
      </div>
      <p className="tw-switcher-path" style={{ fontSize: "0.72rem", color: TONE_VAR.muted }}>
        <span title={instance.managedWorktreePath}>
          {pathBasename(instance.managedWorktreePath)}
        </span>
      </p>
      <p className="tw-switcher-activity" style={{ fontSize: "0.7rem", color: TONE_VAR.muted }}>
        Updated {instance.updatedAt}
      </p>
      {instance.recoveryHints.length > 0 ? (
        <details className="tw-switcher-recovery">
          <summary>Recovery hints ({instance.recoveryHints.length})</summary>
          <ul>
            {instance.recoveryHints.map((hint, index) => (
              <li key={`${hint.marker}-${String(index)}`}>
                {hint.marker}: {hint.strategy}
                {hint.operatorActionRequired ? " (operator action required)" : ""}
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
      style={{
        padding: "0.2rem 0.55rem",
        borderRadius: "var(--radius-sm, 4px)",
        border: "1px solid var(--border-subtle, #ccc)",
        background: "transparent",
        // Disabled cue via a tertiary text token (keeps ≥4.5:1 contrast, WCAG 1.4.3) rather than an
        // opacity fade, which would drop the label below the minimum contrast ratio.
        color: disabled ? "var(--text-tertiary, #6b6b6b)" : "var(--text-primary, inherit)",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {props.label}
    </button>
  );
}

function TaskWorkspaceSwitcherImpl(): ReactNode {
  const api = useActiveWorkspace();
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const panelId = useId();
  const statusId = useId();

  const triggerRef = useRef<HTMLButtonElement>(null);
  // While the panel is open, Escape closes it and returns focus to the trigger (keyboard operability +
  // focus restoration). A document listener keeps the non-interactive panel free of event handlers.
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
  }, [open]);

  const active = api.activeInstance;
  const legalNext = active === null ? [] : nextLegalTaskWorkspaceStates(active.lifecycleState);
  const canPause = active !== null && legalNext.includes("paused");
  const canHandoff = active !== null && legalNext.includes("handoff-ready");
  const statusText =
    active === null
      ? "No active task workspace"
      : `Active: ${active.taskId} on ${active.taskBranch} (${active.lifecycleState}, ${active.health})`;
  const triggerLabel =
    active === null
      ? "Task workspace context: no active workspace"
      : `Task workspace context: ${active.taskId}`;

  const repositoryRoot =
    api.activeInstance?.repositoryRoot ?? api.instances[0]?.repositoryRoot ?? null;
  const createDisabled =
    api.switching || repositoryRoot === null || taskId.trim() === "" || baseBranch.trim() === "";

  return (
    <div className="tw-switcher" style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className="tw-switcher-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={statusId}
        aria-label={triggerLabel}
        aria-busy={api.switching}
        onClick={() => {
          setOpen((value) => !value);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4rem",
          padding: "0.2rem 0.6rem",
          borderRadius: "var(--radius-sm, 4px)",
          border: "1px solid var(--border-subtle, #ccc)",
          background: active !== null ? "var(--accent, #2b6cb0)" : "transparent",
          color: active !== null ? "var(--text-on-accent, #fff)" : "var(--text-primary, inherit)",
        }}
      >
        <span aria-hidden="true">⌥</span>
        <span className="tw-switcher-trigger-label">
          {active === null ? "Task workspace" : active.taskId}
        </span>
        {api.switching ? <span aria-hidden="true">…</span> : null}
      </button>

      {/* Polite live region: a switch / pause / resume announces the new active context to AT. */}
      <div id={statusId} role="status" aria-live="polite" className="tw-switcher-status-sr">
        {statusText}
      </div>

      {open ? (
        <div
          id={panelId}
          className="tw-switcher-panel"
          role="group"
          aria-label="Task workspace context"
          style={{
            position: "absolute",
            zIndex: 50,
            marginTop: "0.3rem",
            minWidth: "20rem",
            padding: "0.6rem",
            borderRadius: "var(--radius-md, 6px)",
            border: "1px solid var(--border-subtle, #ccc)",
            background: "var(--surface-raised, var(--surface, #fff))",
            boxShadow: "0 6px 20px rgba(0,0,0,0.2)",
          }}
        >
          {api.error !== null ? (
            <p role="alert" className="tw-switcher-error" style={{ color: TONE_VAR.danger }}>
              {api.error}
            </p>
          ) : null}

          {active !== null ? (
            <>
              <ActiveDetails instance={active} />
              <div
                className="tw-switcher-actions"
                style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.4rem" }}
              >
                {actionButton({
                  label: "Pause",
                  onClick: () => void api.pause(active.workspaceId),
                  enabled: canPause,
                  busy: api.switching,
                })}
                {actionButton({
                  label: "Prepare handoff",
                  onClick: () => void api.prepareHandoff(active.workspaceId),
                  enabled: canHandoff && !isWorkspaceDirty(active),
                  busy: api.switching,
                })}
                {actionButton({
                  label: "Clear active",
                  onClick: () => void api.clearActive(),
                  enabled: true,
                  busy: api.switching,
                })}
              </div>
            </>
          ) : (
            <p className="tw-switcher-empty" style={{ color: TONE_VAR.muted }}>
              No active task workspace. Switch to one below or create a new one.
            </p>
          )}

          <hr style={{ margin: "0.6rem 0", borderColor: "var(--border-subtle, #ddd)" }} />

          {api.instances.length === 0 ? (
            <p
              className="tw-switcher-list-empty"
              style={{ color: TONE_VAR.muted, fontSize: "0.78rem" }}
            >
              {api.loading ? "Loading…" : "No task workspaces yet."}
            </p>
          ) : (
            <div className="tw-switcher-list" role="list" aria-label="Task workspaces">
              {api.instances.map((instance) => {
                const isActive = active?.workspaceId === instance.workspaceId;
                return (
                  <div
                    key={instance.workspaceId}
                    role="listitem"
                    className="tw-switcher-list-item"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.4rem",
                      padding: "0.2rem 0",
                    }}
                  >
                    <span className="tw-switcher-list-label" title={instance.managedWorktreePath}>
                      {instance.taskId} · {instance.lifecycleState}
                      {isWorkspaceDirty(instance) ? " ·" : ""}
                      {isWorkspaceDirty(instance) ? badge("dirty", "warning") : null}
                    </span>
                    {actionButton({
                      label: isActive ? "Active" : "Switch",
                      onClick: () => void api.switchTo(instance.workspaceId),
                      enabled: !isActive && canSwitchTo(instance),
                      busy: api.switching,
                    })}
                  </div>
                );
              })}
            </div>
          )}

          <hr style={{ margin: "0.6rem 0", borderColor: "var(--border-subtle, #ddd)" }} />

          <form
            className="tw-switcher-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (createDisabled || repositoryRoot === null) {
                return;
              }
              void api
                .provision({
                  root: repositoryRoot,
                  taskId: taskId.trim(),
                  baseBranch: baseBranch.trim(),
                })
                .then(() => {
                  setTaskId("");
                  setBaseBranch("");
                });
            }}
          >
            <label className="tw-switcher-field">
              <span>Task id</span>
              <input
                type="text"
                value={taskId}
                onChange={(event) => {
                  setTaskId(event.target.value);
                }}
                placeholder="e.g. 446-binding"
              />
            </label>
            <label className="tw-switcher-field">
              <span>Base branch</span>
              <input
                type="text"
                value={baseBranch}
                onChange={(event) => {
                  setBaseBranch(event.target.value);
                }}
                placeholder="e.g. dev"
              />
            </label>
            <button
              type="submit"
              className="tw-switcher-create-submit"
              disabled={createDisabled}
              aria-disabled={createDisabled}
            >
              Create task workspace
            </button>
            {repositoryRoot === null ? (
              <p style={{ color: TONE_VAR.muted, fontSize: "0.72rem" }}>
                Open a project to create a task workspace.
              </p>
            ) : null}
          </form>
        </div>
      ) : null}
    </div>
  );
}

export const TaskWorkspaceSwitcher = memo(TaskWorkspaceSwitcherImpl);
