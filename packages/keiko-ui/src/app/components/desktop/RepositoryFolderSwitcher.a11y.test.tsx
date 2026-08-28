// WCAG 2.2 AA smoke for the focused folder/repository selector.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectWithAvailability } from "@/lib/types";
import { ATTACHMENT_CLEANUP_DEFERRED_ERROR } from "@/lib/chat-session-error";
import { ActiveWorkspaceProvider, type ActiveWorkspaceApi } from "./context/ActiveWorkspaceContext";
import { RepositoryFolderSwitcher } from "./RepositoryFolderSwitcher";

const catalogState = vi.hoisted(() => ({
  activeProject: undefined as ProjectWithAvailability | undefined,
  projects: [] as ProjectWithAvailability[],
  error: undefined as string | undefined,
}));
const chatActions = vi.hoisted(() => ({
  addProject: vi.fn<(path: string) => Promise<ProjectWithAvailability | undefined>>(() =>
    Promise.resolve(undefined),
  ),
  openProject: vi.fn(() => Promise.resolve()),
}));

vi.mock("./context/ChatSessionContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./context/ChatSessionContext")>();
  return {
    ...actual,
    useOptionalChatSessionActions: (): typeof chatActions => chatActions,
    useOptionalChatSessionCatalog: (): {
      activeProject: ProjectWithAvailability | undefined;
      projects: ProjectWithAvailability[];
      error: string | undefined;
    } => ({
      activeProject: catalogState.activeProject,
      projects: catalogState.projects,
      error: catalogState.error,
    }),
  };
});

vi.mock("./hooks/useNativeFileDialogCapability", () => ({
  useNativeFileDialogCapability: (): boolean => true,
}));

vi.mock("@/lib/native-file-dialog", () => ({
  pickWithNativeDialog: vi.fn(() => Promise.resolve({ kind: "cancelled" as const })),
}));

function project(path: string): ProjectWithAvailability {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    favorite: false,
    createdAt: 1,
    lastOpenedAt: 1,
    available: true,
    workspaceAvailable: true,
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

function renderSwitcher(value: ActiveWorkspaceApi): HTMLElement {
  const { container } = render(
    <ActiveWorkspaceProvider value={value}>
      <RepositoryFolderSwitcher />
    </ActiveWorkspaceProvider>,
  );
  return container;
}

describe("RepositoryFolderSwitcher a11y", () => {
  beforeEach(() => {
    catalogState.activeProject = undefined;
    catalogState.projects = [];
    catalogState.error = undefined;
    chatActions.addProject.mockClear();
    chatActions.openProject.mockClear();
  });

  it("collapsed (unbound) has no violations", async () => {
    const container = renderSwitcher(api());
    const trigger = screen.getByRole("button", {
      name: "Workspace context: choose a folder",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("expanded with a selected repository has no violations", async () => {
    catalogState.activeProject = project("/work/client-portal");
    catalogState.projects = [catalogState.activeProject];
    const container = renderSwitcher(api());

    fireEvent.click(screen.getByRole("button", { name: "Workspace context: client-portal" }));

    expect(screen.getByRole("dialog", { name: "Folder or repository" })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("expanded with a localized cleanup warning has no violations", async () => {
    catalogState.error = ATTACHMENT_CLEANUP_DEFERRED_ERROR;
    const container = renderSwitcher(api());

    fireEvent.click(screen.getByRole("button", { name: "Workspace context: choose a folder" }));

    expect(screen.getByRole("alert")).not.toHaveTextContent(ATTACHMENT_CLEANUP_DEFERRED_ERROR);
    expect(await axe(container)).toHaveNoViolations();
  });
});
