import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import { ActiveWorkspaceProvider, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { AnnouncerProvider } from "./context/AnnouncerContext";
import { TaskWorkspaceManager } from "./TaskWorkspaceManager";

function instance(overrides: Partial<WorkspaceInstance> = {}): WorkspaceInstance {
  return {
    schemaVersion: "1",
    workspaceId: "ws-alpha",
    taskId: "alpha-446",
    repositoryId: "repo-446",
    repositoryRoot: "/repo-446",
    baseBranch: "dev",
    taskBranch: "keiko/alpha-446",
    managedWorktreePath: "/managed/alpha",
    gitdirIdentity: "gitdir-identity",
    lifecycleState: "active",
    health: "healthy",
    lock: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    driftMarkers: [],
    recoveryHints: [],
    auditCorrelationId: "ws-alpha",
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
    refresh: vi.fn(() => Promise.resolve(true)),
    switchTo: vi.fn(() => Promise.resolve()),
    clearActive: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    prepareHandoff: vi.fn(() => Promise.resolve()),
    provision: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function renderManager(value: ActiveWorkspaceApi): HTMLElement {
  const { container } = render(
    <AnnouncerProvider>
      <ActiveWorkspaceProvider value={value}>
        <TaskWorkspaceManager />
      </ActiveWorkspaceProvider>
    </AnnouncerProvider>,
  );
  return container;
}

function openManager(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /task workspaces/i }));
  return screen.getByRole("dialog", { name: "Task workspace context" });
}

describe("TaskWorkspaceManager", () => {
  it("lists the server-provided inventory and routes each supported lifecycle action", () => {
    const active = instance();
    const paused = instance({
      workspaceId: "ws-beta",
      taskId: "beta-446",
      lifecycleState: "paused",
      managedWorktreePath: "/managed/beta",
    });
    const value = api({ activeInstance: active, instances: [active, paused] });
    renderManager(value);

    const panel = openManager();
    const list = within(panel).getByRole("list", { name: "Task workspaces" });
    expect(within(list).getByText("alpha-446")).toBeVisible();
    expect(within(list).getByText("beta-446")).toBeVisible();
    const activeItem = within(list).getByText("alpha-446").closest("li");
    const pausedItem = within(list).getByText("beta-446").closest("li");
    if (activeItem === null || pausedItem === null) throw new Error("Workspace list item missing");

    fireEvent.click(within(activeItem).getByRole("button", { name: "Pause" }));
    expect(within(pausedItem).queryByRole("button", { name: "Switch" })).not.toBeInTheDocument();
    fireEvent.click(within(pausedItem).getByRole("button", { name: "Resume" }));
    fireEvent.click(within(activeItem).getByRole("button", { name: "Prepare handoff" }));

    expect(value.pause).toHaveBeenCalledWith("ws-alpha");
    expect(value.resume).toHaveBeenCalledWith("ws-beta");
    expect(value.prepareHandoff).toHaveBeenCalledWith("ws-alpha");
    expect(value.switchTo).not.toHaveBeenCalled();
  });

  it("keeps unsupported and dirty transitions focusable with their actionable reason", () => {
    const dirty = instance({ driftMarkers: ["uncommitted-changes"] });
    const failed = instance({
      workspaceId: "ws-failed",
      taskId: "failed-446",
      lifecycleState: "failed",
    });
    renderManager(api({ activeInstance: dirty, instances: [dirty, failed] }));

    const panel = openManager();
    const dirtyHandoff = within(panel).getByRole("button", {
      name: /Prepare handoff: Commit or stash/i,
    });
    const failedSwitch = within(panel).getByRole("button", {
      name: /Switch: Only active, paused/i,
    });
    expect(dirtyHandoff).toHaveAttribute("aria-disabled", "true");
    expect(failedSwitch).toHaveAttribute("aria-disabled", "true");
  });

  it("announces a successful refresh from the resolved operation outcome", async () => {
    const value = api({ error: "The workspace changed on another client." });
    renderManager(value);

    const panel = openManager();
    expect(within(panel).getByRole("alert")).toHaveTextContent("changed on another client");
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh" }));
    expect(value.refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId("app-announcer-polite")).toHaveTextContent(
        "Task workspaces refreshed.",
      );
    });
  });

  it("does not announce success when refresh resolves as failed", async () => {
    const refresh = vi.fn(() => Promise.resolve(false));
    renderManager(api({ error: "The workspace changed on another client.", refresh }));

    const panel = openManager();
    fireEvent.click(within(panel).getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId("app-announcer-polite")).toBeEmptyDOMElement();
  });

  it("restores trigger focus when Escape closes the non-modal panel", () => {
    renderManager(api());
    const trigger = screen.getByRole("button", {
      name: "Task workspaces: no active workspace",
    });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Task workspace context" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("moves focus into the panel and restores it after an outside dismissal", () => {
    renderManager(api());
    const trigger = screen.getByRole("button", {
      name: "Task workspaces: no active workspace",
    });
    const panel = openManager();

    expect(within(panel).getByRole("heading", { name: "Task workspace" })).toHaveFocus();
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "Task workspace context" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("has no accessibility violations in a dirty active and paused inventory", async () => {
    const active = instance({ driftMarkers: ["uncommitted-changes"] });
    const paused = instance({
      workspaceId: "ws-beta",
      taskId: "beta-446",
      lifecycleState: "paused",
      managedWorktreePath: "/managed/beta",
    });
    const container = renderManager(api({ activeInstance: active, instances: [active, paused] }));
    openManager();
    expect(await axe(container)).toHaveNoViolations();
  });
});
