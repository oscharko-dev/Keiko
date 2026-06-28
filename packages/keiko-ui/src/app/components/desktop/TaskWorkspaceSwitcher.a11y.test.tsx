// a11y smoke for the TaskWorkspaceSwitcher (Issue #446, AC5). jest-axe runs WCAG 2.2 AA against the
// collapsed trigger and the expanded panel in the unbound, active-clean, and dirty+locked+recovery
// states — the disclosure content only enters the accessibility tree when the panel is open.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
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

function renderSwitcher(value: ActiveWorkspaceApi): HTMLElement {
  const { container } = render(
    <ActiveWorkspaceProvider value={value}>
      <TaskWorkspaceSwitcher />
    </ActiveWorkspaceProvider>,
  );
  return container;
}

describe("TaskWorkspaceSwitcher a11y", () => {
  it("collapsed (unbound) has no violations", async () => {
    const container = renderSwitcher(api());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("expanded with an active clean workspace has no violations", async () => {
    const container = renderSwitcher(api({ activeInstance: instance(), instances: [instance()] }));
    fireEvent.click(screen.getByRole("button", { name: /task-446/i }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("expanded with a dirty, locked workspace and recovery hints has no violations", async () => {
    const container = renderSwitcher(
      api({
        activeInstance: instance({
          health: "drifted",
          driftMarkers: ["uncommitted-changes"],
          lock: { lockId: "l", owner: "op", reason: "mutation", acquiredAt: "t" },
          recoveryHints: [
            {
              marker: "uncommitted-changes",
              strategy: "commit-or-stash-required",
              operatorActionRequired: true,
            },
          ],
        }),
        error: "Workspace is locked by another actor",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /task-446/i }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
