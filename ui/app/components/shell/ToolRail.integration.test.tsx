// Integration tests for the ToolRail + panel flows (issue #67).
// Mocks fetchProjects + fetchWorkspaceSummary; exercises real ToolRail, FilesPanel, PlannedToolPanel.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import type { ProjectWithAvailability, WorkspaceSummary } from "@/lib/types";
import { ToolRail } from "./ToolRail";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
let mockParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  // Each render call picks up the current mockParams instance.
  useSearchParams: () => mockParams,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchWorkspaceSummary: vi.fn(),
    ApiError: class ApiError extends Error {
      code: string;
      status: number;
      constructor(code: string, msg: string, status: number) {
        super(msg);
        this.code = code;
        this.status = status;
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const availableProject: ProjectWithAvailability = {
  path: "/workspace/foo",
  name: "Foo Project",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

const workspaceSummary: WorkspaceSummary = {
  root: "/workspace/foo",
  name: "foo",
  version: "1.2.3",
  testFramework: "vitest",
  sourceDirs: ["src"],
  testDirs: ["tests"],
  languages: ["typescript"],
  counts: { discovered: 55, denied: 0, ignored: 3 },
  context: undefined,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRail integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReplace.mockClear();
    mockParams = new URLSearchParams();
  });

  // ── Available project → click Files → FilesPanel renders with summary ────

  it("clicking Files with an available project opens FilesPanel with workspace summary", async () => {
    const user = userEvent.setup();

    // Start with available project selected, no tool active
    mockParams.set("project", availableProject.path);
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [availableProject] });
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: workspaceSummary });

    render(<ToolRail />);

    // Wait for project to resolve and buttons to be enabled
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Files" })).not.toBeDisabled();
    });

    // Click Files — this calls router.replace with ?tool=files
    await user.click(screen.getByRole("button", { name: "Files" }));

    expect(mockReplace).toHaveBeenCalledOnce();
    const replaceArg = mockReplace.mock.calls[0]?.[0] as string;
    expect(replaceArg).toMatch(/tool=files/);

    // Simulate the URL update by re-rendering with the new params
    mockParams = new URLSearchParams(replaceArg.replace(/^\?/, ""));
    mockParams.set("project", availableProject.path);
    render(<ToolRail />);

    // Wait for FilesPanel to appear with loaded data
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    });

    await waitFor(() => {
      // workspace summary data
      expect(screen.getByText("vitest")).toBeInTheDocument();
    });
  });

  // ── Click X on FilesPanel → URL clears ?tool= ───────────────────────────

  it("closing FilesPanel via close button calls router.replace without tool param", async () => {
    const user = userEvent.setup();

    mockParams.set("project", availableProject.path);
    mockParams.set("tool", "files");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [availableProject] });
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: workspaceSummary });

    render(<ToolRail />);

    // Wait for the panel to render
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    });

    // Click the close button inside FilesPanel
    await user.click(screen.getByRole("button", { name: /close files panel/i }));

    expect(mockReplace).toHaveBeenCalledOnce();
    const replaceArg = mockReplace.mock.calls[0]?.[0] as string;
    expect(replaceArg).not.toMatch(/tool=/);
  });

  // ── Click Browser → PlannedToolPanel renders ─────────────────────────────

  it("clicking Browser with an available project opens PlannedToolPanel", async () => {
    const user = userEvent.setup();

    mockParams.set("project", availableProject.path);
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [availableProject] });
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: workspaceSummary });

    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Browser" })).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: "Browser" }));

    expect(mockReplace).toHaveBeenCalledOnce();
    const replaceArg = mockReplace.mock.calls[0]?.[0] as string;
    expect(replaceArg).toMatch(/tool=browser/);

    // Simulate URL update
    mockParams = new URLSearchParams(replaceArg.replace(/^\?/, ""));
    mockParams.set("project", availableProject.path);
    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Browser" })).toBeInTheDocument();
    });

    // Planned panel contains capability description, no execute button
    expect(screen.queryByRole("button", { name: /start browser/i })).not.toBeInTheDocument();
  });

  // ── No project → all buttons disabled → no panel ─────────────────────────

  it("with no project selected, all buttons are disabled and no panel renders", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });

    render(<ToolRail />);

    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }

    // No panel headings should appear
    expect(screen.queryByRole("heading", { name: "Files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Browser" })).not.toBeInTheDocument();
  });

  // ── Available project + ?tool=review → PlannedToolPanel for review ───────

  it("?tool=review with available project renders Review PlannedToolPanel", async () => {
    mockParams.set("project", availableProject.path);
    mockParams.set("tool", "review");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [availableProject] });
    vi.mocked(api.fetchWorkspaceSummary).mockResolvedValue({ summary: workspaceSummary });

    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Review" })).toBeInTheDocument();
    });
  });

  // ── fetchWorkspaceSummary error → FilesPanel shows error alert ───────────

  it("workspace fetch error renders role=alert inside FilesPanel", async () => {
    mockParams.set("project", availableProject.path);
    mockParams.set("tool", "files");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [availableProject] });
    vi.mocked(api.fetchWorkspaceSummary).mockRejectedValue(
      new ApiError("WORKSPACE_NOT_FOUND", "not found", 404),
    );

    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert").textContent).toMatch(/project directory could not be found/i);
  });
});
