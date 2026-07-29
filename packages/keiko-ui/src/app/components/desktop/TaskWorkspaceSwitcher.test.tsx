// Regression coverage for the global folder/repository selector. The dialog intentionally owns
// only base-context selection; task-workspace lifecycle belongs to its own surface.

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInstance } from "@oscharko-dev/keiko-contracts";
import type { NativeDialogPickOutcome } from "@/lib/native-file-dialog";
import type { ProjectWithAvailability } from "@/lib/types";
import { ActiveWorkspaceProvider, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { TaskWorkspaceSwitcher } from "./TaskWorkspaceSwitcher";

const SELECTED_ROOT = "/Users/oscharko-dev/Projects/Keiko";

const catalogState = vi.hoisted(() => ({
  activeProject: undefined as ProjectWithAvailability | undefined,
  projects: [] as ProjectWithAvailability[],
  actionsAvailable: true,
}));
const chatActions = vi.hoisted(() => ({
  addProject: vi.fn<(path: string) => Promise<ProjectWithAvailability | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  openProject: vi.fn<(project: ProjectWithAvailability) => Promise<void>>(() => Promise.resolve()),
}));
const nativeDialogState = vi.hoisted(() => ({
  supported: true,
  pick: vi.fn<() => Promise<NativeDialogPickOutcome>>(() => Promise.resolve({ kind: "cancelled" })),
}));

vi.mock("./context/ChatSessionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context/ChatSessionContext")>();
  return {
    ...actual,
    useOptionalChatSessionActions: () => (catalogState.actionsAvailable ? chatActions : null),
    useOptionalChatSessionCatalog: () => ({
      activeProject: catalogState.activeProject,
      projects: catalogState.projects,
    }),
  };
});

vi.mock("./hooks/useNativeFileDialogCapability", () => ({
  useNativeFileDialogCapability: (): boolean => nativeDialogState.supported,
}));

vi.mock("@/lib/native-file-dialog", () => ({
  pickWithNativeDialog: nativeDialogState.pick,
}));

function project(
  path: string,
  overrides: Partial<ProjectWithAvailability> = {},
): ProjectWithAvailability {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 1,
    available: true,
    workspaceAvailable: true,
    ...overrides,
  };
}

function instance(): WorkspaceInstance {
  return {
    schemaVersion: "1",
    workspaceId: "ws-1",
    taskId: "task-446",
    repositoryId: "repo",
    repositoryRoot: "/old/repository",
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

function switcher(value: ActiveWorkspaceApi): ReactNode {
  return (
    <ActiveWorkspaceProvider value={value}>
      <TaskWorkspaceSwitcher />
    </ActiveWorkspaceProvider>
  );
}

function renderSwitcher(value: ActiveWorkspaceApi): RenderResult {
  return render(switcher(value));
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /workspace context/i }));
  return screen.getByRole("dialog", { name: "Folder or repository" });
}

function registerSelectedProject(path: string): void {
  const selected = project(path);
  catalogState.activeProject = selected;
  catalogState.projects = [selected];
}

describe("TaskWorkspaceSwitcher", () => {
  beforeEach(() => {
    catalogState.activeProject = undefined;
    catalogState.projects = [];
    catalogState.actionsAvailable = true;
    chatActions.addProject.mockReset().mockResolvedValue(undefined);
    chatActions.openProject.mockReset().mockResolvedValue(undefined);
    nativeDialogState.supported = true;
    nativeDialogState.pick.mockReset().mockResolvedValue({ kind: "cancelled" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for a folder when no workspace context is selected", () => {
    renderSwitcher(api());

    expect(
      screen.getByRole("button", { name: "Workspace context: choose a folder" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("shows the selected folder as the primary workbench context", () => {
    registerSelectedProject(SELECTED_ROOT);
    renderSwitcher(api());

    expect(screen.getByRole("button", { name: "Workspace context: Keiko" })).toBeInTheDocument();
    const dialog = openDialog();
    expect(within(dialog).getAllByText(SELECTED_ROOT).length).toBeGreaterThan(0);
  });

  it("does not confuse governed workspace readiness with folder pickability", () => {
    catalogState.activeProject = project(SELECTED_ROOT, { workspaceAvailable: false });
    catalogState.projects = [catalogState.activeProject];

    renderSwitcher(api());

    expect(screen.getByRole("button", { name: "Workspace context: Keiko" })).toBeInTheDocument();
  });

  it("keeps a newly chosen and registered folder active without requiring a chat or model", async () => {
    nativeDialogState.pick.mockResolvedValue({
      kind: "picked",
      paths: [SELECTED_ROOT],
    });
    chatActions.addProject.mockImplementation(async (path) => {
      registerSelectedProject(path);
      return catalogState.activeProject ?? undefined;
    });
    const value = api();
    const view = renderSwitcher(value);
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose a folder" }));

    await waitFor(() => {
      expect(chatActions.addProject).toHaveBeenCalledWith(SELECTED_ROOT);
    });
    view.unmount();
    renderSwitcher(value);
    expect(screen.getByRole("button", { name: "Workspace context: Keiko" })).toBeInTheDocument();
    expect(nativeDialogState.pick).toHaveBeenCalledWith({
      mode: "open-directory",
      title: "Choose a folder or repository",
    });
  });

  it("keeps the selector open and reports a failed folder registration", async () => {
    nativeDialogState.pick.mockResolvedValue({
      kind: "picked",
      paths: [SELECTED_ROOT],
    });
    chatActions.addProject.mockResolvedValue(undefined);
    renderSwitcher(api());
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose a folder" }));

    await waitFor(() => {
      expect(chatActions.addProject).toHaveBeenCalledWith(SELECTED_ROOT);
    });
    expect(screen.getByRole("dialog", { name: "Folder or repository" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("reports a correlated content-free diagnostic when folder registration rejects", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    nativeDialogState.pick.mockResolvedValue({
      kind: "picked",
      paths: [SELECTED_ROOT],
    });
    chatActions.addProject.mockRejectedValue(new TypeError("secret customer folder detail"));
    renderSwitcher(api());
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose a folder" }));

    await waitFor(() => expect(reportError).toHaveBeenCalledOnce());
    const reported = reportError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    const diagnostic = (reported as Error).message;
    expect(diagnostic).toMatch(
      /^Workspace folder selection failed\. Cause category: TypeError\. Correlation ID: .+$/u,
    );
    expect(diagnostic).not.toContain("secret customer folder detail");
    const correlationId = diagnostic.split("Correlation ID: ").at(-1);
    expect(correlationId).toBeDefined();
    expect(screen.getByRole("alert")).toHaveTextContent(`Support ID: ${correlationId}`);
  });

  it("reports a selection failure when chat actions are unavailable", async () => {
    catalogState.actionsAvailable = false;
    nativeDialogState.pick.mockResolvedValue({
      kind: "picked",
      paths: [SELECTED_ROOT],
    });
    renderSwitcher(api());
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose a folder" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The folder could not be selected. Check the path and try again.",
    );
    expect(chatActions.addProject).not.toHaveBeenCalled();
  });

  it("clears a task override before activating a newly chosen base folder", async () => {
    nativeDialogState.pick.mockResolvedValue({
      kind: "picked",
      paths: [SELECTED_ROOT],
    });
    chatActions.addProject.mockImplementation(async (path) => {
      registerSelectedProject(path);
      return catalogState.activeProject ?? undefined;
    });
    const value = api({ activeInstance: instance() });
    renderSwitcher(value);
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole("button", { name: "Choose a folder" }));

    await waitFor(() => {
      expect(value.clearActive).toHaveBeenCalledOnce();
      expect(chatActions.addProject).toHaveBeenCalledWith(SELECTED_ROOT);
    });
    const clearOrder = vi.mocked(value.clearActive).mock.invocationCallOrder.at(0);
    const addOrder = chatActions.addProject.mock.invocationCallOrder.at(0);
    if (clearOrder === undefined || addOrder === undefined) {
      throw new Error("Expected the task override to clear before folder activation");
    }
    expect(clearOrder).toBeLessThan(addOrder);
  });

  it("keeps the dialog focused on folder selection without task or recent-list clutter", () => {
    registerSelectedProject(SELECTED_ROOT);
    catalogState.projects.push(project("/Users/oscharko-dev/Projects/Other"));
    renderSwitcher(api({ activeInstance: instance(), instances: [instance()] }));

    const dialog = openDialog();

    expect(
      within(dialog).getByRole("heading", { name: "Folder or repository" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Choose a folder" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Or enter a local path")).toBeNull();
    expect(within(dialog).queryAllByText(/task workspace/i)).toHaveLength(0);
    expect(within(dialog).queryByText(/recent folders and repositories/i)).toBeNull();
    expect(within(dialog).queryByRole("list", { name: "Folders and repositories" })).toBeNull();
  });

  it("replaces the native picker with the manual-path fallback when it is unavailable", () => {
    nativeDialogState.supported = false;
    renderSwitcher(api());

    const dialog = openDialog();
    const pathInput = within(dialog).getByLabelText("Or enter a local path");

    expect(within(dialog).queryByRole("button", { name: "Choose a folder" })).toBeNull();
    expect(pathInput).toBeEnabled();
    fireEvent.change(pathInput, { target: { value: SELECTED_ROOT } });
    expect(within(dialog).getByRole("button", { name: "Open" })).toBeEnabled();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    registerSelectedProject(SELECTED_ROOT);
    renderSwitcher(api());
    const trigger = screen.getByRole("button", { name: "Workspace context: Keiko" });
    const dialog = openDialog();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when a pointerdown lands outside, but not inside", () => {
    registerSelectedProject(SELECTED_ROOT);
    renderSwitcher(api());
    const trigger = screen.getByRole("button", { name: "Workspace context: Keiko" });
    const dialog = openDialog();

    fireEvent.pointerDown(dialog);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("renders selection failures in an alert region", () => {
    renderSwitcher(api({ error: "Folder selection failed" }));

    openDialog();

    expect(screen.getByRole("alert")).toHaveTextContent("Folder selection failed");
  });
});
