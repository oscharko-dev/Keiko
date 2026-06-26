"use client";

// Issue #1389 — Runtime, Git, and command UX hub. This card composes the existing governed surfaces
// without adding execution authority: read-only Git lives in Files, command/container runs keep their
// server-frozen catalogs, and all Git mutations stay in Epic #470 Git Delivery windows.

import { useEffect, useState, type ReactNode } from "react";
import { Icons } from "../../Icons";

interface RuntimeHubWidgetProps {
  readonly projectPath?: string | undefined;
  readonly onProjectPathChange?: ((projectPath: string) => void) | undefined;
  readonly onOpenFiles: (projectPath?: string) => void;
  readonly onOpenCommands: (projectPath: string) => void;
  readonly onOpenContainers: (projectPath?: string) => void;
  readonly onOpenGovernedGit: (projectPath: string) => void;
  readonly onOpenPullRequest: (projectPath: string) => void;
  readonly onOpenMerge: (projectPath: string) => void;
}

interface RuntimeAction {
  readonly id: string;
  readonly label: string;
  readonly icon: keyof typeof Icons;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

function RuntimeActionButton({ action }: { readonly action: RuntimeAction }): ReactNode {
  const Icon = Icons[action.icon];
  return (
    <button
      type="button"
      className="tm-action"
      disabled={action.disabled === true}
      onClick={action.onClick}
      style={{ justifyContent: "flex-start", minHeight: 34 }}
    >
      <Icon size={14} />
      <span>{action.label}</span>
    </button>
  );
}

export function RuntimeHubWidget(props: RuntimeHubWidgetProps): ReactNode {
  const [projectInput, setProjectInput] = useState<string>(props.projectPath ?? "");
  useEffect(() => {
    setProjectInput(props.projectPath ?? "");
  }, [props.projectPath]);

  const projectPath = projectInput.trim();
  const hasProject = projectPath.length > 0;

  const actions: readonly RuntimeAction[] = [
    {
      id: "files",
      label: "Files & Git diff",
      icon: "files",
      onClick: () => props.onOpenFiles(hasProject ? projectPath : undefined),
    },
    {
      id: "commands",
      label: "Tasks",
      icon: "terminal",
      disabled: !hasProject,
      onClick: () => props.onOpenCommands(projectPath),
    },
    {
      id: "containers",
      label: "Containers",
      icon: "cube",
      onClick: () => props.onOpenContainers(hasProject ? projectPath : undefined),
    },
    {
      id: "governed-git",
      label: "Governed Git",
      icon: "git",
      disabled: !hasProject,
      onClick: () => props.onOpenGovernedGit(projectPath),
    },
    {
      id: "pull-request",
      label: "Pull Request",
      icon: "branch",
      disabled: !hasProject,
      onClick: () => props.onOpenPullRequest(projectPath),
    },
    {
      id: "merge",
      label: "Merge",
      icon: "check",
      disabled: !hasProject,
      onClick: () => props.onOpenMerge(projectPath),
    },
  ];

  return (
    <div className="terminal commands">
      <form
        className="tm-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasProject) props.onProjectPathChange?.(projectPath);
        }}
      >
        <label className="tm-field">
          <span>Project path</span>
          <input
            type="text"
            value={projectInput}
            onChange={(event) => setProjectInput(event.target.value)}
            onBlur={() => {
              if (hasProject) props.onProjectPathChange?.(projectPath);
            }}
            placeholder="/absolute/path/to/project"
          />
        </label>
        <div
          role="group"
          aria-label="Runtime actions"
          style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}
        >
          {actions.map((action) => (
            <RuntimeActionButton key={action.id} action={action} />
          ))}
        </div>
        {!hasProject ? (
          <p className="tm-limits" role="status">
            Add a project path to enable task and governed Git workflows.
          </p>
        ) : null}
      </form>

      <div role="region" aria-label="Runtime audit metadata">
        <ul className="tm-events">
          <li className="tm-event">
            <span className="tm-event-kind">Commands</span>
            <span className="tm-event-detail">runId / taskId / exit status</span>
          </li>
          <li className="tm-event">
            <span className="tm-event-kind">Containers</span>
            <span className="tm-event-detail">runId / taskId / engine / exit status</span>
          </li>
          <li className="tm-event">
            <span className="tm-event-kind">Git Delivery</span>
            <span className="tm-event-detail">policy / approval / evidence ledger</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
