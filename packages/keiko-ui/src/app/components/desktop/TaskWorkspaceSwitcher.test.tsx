// Component tests for the TaskWorkspaceSwitcher (Issue #446, AC5). Renders inside a stubbed
// ActiveWorkspace context and proves it exposes the active task identity/branch/path/health/dirty/
// lock, gates the lifecycle actions to the legal transitions, and wires the action callbacks.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { ActiveWorkspaceProvider, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { TaskWorkspaceSwitcher } from "./TaskWorkspaceSwitcher";

function instance(overrides: Partial<WorkspaceInstance> = {}): WorkspaceInstance {
  return {
    schemaVersion: "1",
    workspaceId: "ws-1",
    taskId: "task-446",
    repositoryId: "repo",
    repositoryRoot: "/repo",
    baseBranch: "dev",
    taskBranch: "keiko/task-446",
    managedWorktreePath: "/managed/repo/ws-1",
    gitdirIdentity: "g",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "t",
    updatedAt: "2026-06-26T10:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "ws-1",
    ...overrides,
  };
}

function api(overrides: Partial<ActiveWorkspaceApi> = {}): ActiveWorkspaceApi {
  const active = overrides.activeInstance ?? null;
  return {
    instances: [],
    activeBinding: null,
    activeInstance: active,
    activeRoot: active?.managedWorktreePath ?? null,
    loading: false,
    switching: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
    switchTo: vi.fn(() => Promise.resolve()),
    clearActive: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    prepareHandoff: vi.fn(() => Promise.resolve()),
    provision: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function renderSwitcher(value: ActiveWorkspaceApi): void {
  render(
    <ActiveWorkspaceProvider value={value}>
      <TaskWorkspaceSwitcher />
    </ActiveWorkspaceProvider>,
  );
}

function openPanel(): void {
  fireEvent.click(screen.getByRole("button", { name: /task workspace|task-446/i }));
}

describe("TaskWorkspaceSwitcher", () => {
  it("shows an unbound label and announces no active workspace", () => {
    renderSwitcher(api());
    expect(screen.getByRole("button", { name: /task workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No active task workspace");
  });

  it("renders the active identity, branch, base branch and a clean badge", () => {
    renderSwitcher(api({ activeInstance: instance() }));
    openPanel();
    // Branch text nests the base inside the branch span, so it matches multiple elements; assert
    // against the panel's full text instead of a single-element query.
    const text = document.body.textContent ?? "";
    expect(text).toContain("keiko/task-446");
    expect(text).toContain("← dev");
    expect(screen.getByText("clean")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("shows a dirty badge and a lock badge from the instance state", () => {
    renderSwitcher(
      api({
        activeInstance: instance({
          driftMarkers: ["uncommitted-changes"],
          lock: { lockId: "l", owner: "op", reason: "mutation", acquiredAt: "t" },
        }),
      }),
    );
    openPanel();
    expect(screen.getByText("uncommitted")).toBeInTheDocument();
    expect(screen.getByText(/locked: mutation/)).toBeInTheDocument();
  });

  it("invokes pause for an active workspace (a legal active→paused transition)", () => {
    const value = api({ activeInstance: instance() });
    renderSwitcher(value);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(value.pause).toHaveBeenCalledWith("ws-1");
  });

  it("disables handoff while the worktree is dirty", () => {
    const value = api({ activeInstance: instance({ driftMarkers: ["uncommitted-changes"] }) });
    renderSwitcher(value);
    openPanel();
    const handoff = screen.getByRole("button", { name: /prepare handoff/i });
    expect(handoff).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(handoff);
    expect(value.prepareHandoff).not.toHaveBeenCalled();
  });

  it("switches to a listed inactive workspace", () => {
    const value = api({
      instances: [
        instance(),
        instance({ workspaceId: "ws-2", taskId: "task-2", lifecycleState: "paused" }),
      ],
      activeInstance: instance(),
    });
    renderSwitcher(value);
    openPanel();
    const list = screen.getByRole("list", { name: /task workspaces/i });
    fireEvent.click(within(list).getByRole("button", { name: "Switch" }));
    expect(value.switchTo).toHaveBeenCalledWith("ws-2");
  });

  it("renders an error in an alert region", () => {
    renderSwitcher(api({ error: "Workspace is locked by another actor" }));
    openPanel();
    expect(screen.getByRole("alert")).toHaveTextContent("locked by another actor");
  });

  it("creates a task workspace from the form when a repository root is known", () => {
    const value = api({ instances: [instance()], activeInstance: instance() });
    renderSwitcher(value);
    openPanel();
    fireEvent.change(screen.getByPlaceholderText(/446-binding/), { target: { value: "new-task" } });
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. dev/), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: /create task workspace/i }));
    expect(value.provision).toHaveBeenCalledWith({
      root: "/repo",
      taskId: "new-task",
      baseBranch: "dev",
    });
  });
});
