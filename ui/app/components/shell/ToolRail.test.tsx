// Tests for the project-aware ToolRail (issue #67).
// Covers: disabled states, tooltip text, URL toggle, axe-clean.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ToolRail } from "./ToolRail";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
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

const unavailableProject: ProjectWithAvailability = {
  ...availableProject,
  available: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockNoProject(): void {
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
  mockSearchParams.delete("project");
}

function mockAvailableProject(): void {
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [availableProject] });
  mockSearchParams.set("project", availableProject.path);
}

function mockUnavailableProject(): void {
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [unavailableProject] });
  mockSearchParams.set("project", unavailableProject.path);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReplace.mockClear();
    mockSearchParams.delete("project");
    mockSearchParams.delete("tool");
  });

  // ── DOM structure ────────────────────────────────────────────────────────

  it("renders aside with accessible name 'Workspace tools'", () => {
    mockNoProject();
    render(<ToolRail />);
    expect(screen.getByRole("complementary", { name: /workspace tools/i })).toBeInTheDocument();
  });

  it("renders 4 buttons in DOM order: Files, Browser, Review, Terminal", () => {
    mockNoProject();
    render(<ToolRail />);
    // Buttons have aria-label matching the tool name
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(4);
  });

  // ── No project: all disabled ─────────────────────────────────────────────

  it("disables all 4 buttons when no project is selected", () => {
    mockNoProject();
    render(<ToolRail />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).toBeDisabled();
    }
  });

  it("shows 'Select a project' tooltip when no project is selected", () => {
    mockNoProject();
    render(<ToolRail />);
    const tooltips = screen.getAllByRole("tooltip");
    for (const tip of tooltips) {
      expect(tip.textContent).toMatch(/select a project/i);
    }
  });

  it("does not fire router.replace when a disabled button is clicked (no project)", async () => {
    const user = userEvent.setup();
    mockNoProject();
    render(<ToolRail />);
    const [filesBtn] = screen.getAllByRole("button");
    await user.click(filesBtn!);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // ── Project unavailable: all disabled ────────────────────────────────────

  it("disables all 4 buttons when project is unavailable", async () => {
    mockUnavailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      for (const btn of buttons) {
        expect(btn).toBeDisabled();
      }
    });
  });

  it("shows 'Project path is unavailable' tooltip when project is unavailable", async () => {
    mockUnavailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      const tooltips = screen.getAllByRole("tooltip");
      for (const tip of tooltips) {
        expect(tip.textContent).toMatch(/project path is unavailable/i);
      }
    });
  });

  it("does not fire router.replace when a disabled button is clicked (unavailable project)", async () => {
    const user = userEvent.setup();
    mockUnavailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).toBeDisabled();
    });
    const [filesBtn] = screen.getAllByRole("button");
    await user.click(filesBtn!);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // ── Available project: all enabled ───────────────────────────────────────

  it("enables all 4 buttons when project is available", async () => {
    mockAvailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      for (const btn of buttons) {
        expect(btn).not.toBeDisabled();
      }
    });
  });

  it("shows no tooltips when project is available", async () => {
    mockAvailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).not.toBeDisabled();
    });
    const tooltips = screen.queryAllByRole("tooltip");
    expect(tooltips).toHaveLength(0);
  });

  // ── URL toggle behaviour ─────────────────────────────────────────────────

  it("clicking Files sets ?tool=files in the URL", async () => {
    const user = userEvent.setup();
    mockAvailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).not.toBeDisabled();
    });

    const [filesBtn] = screen.getAllByRole("button");
    await user.click(filesBtn!);

    expect(mockReplace).toHaveBeenCalledOnce();
    const callArg: string = mockReplace.mock.calls[0]?.[0] as string;
    expect(callArg).toMatch(/tool=files/);
  });

  it("clicking Files again when ?tool=files clears the tool param", async () => {
    const user = userEvent.setup();
    mockAvailableProject();
    mockSearchParams.set("tool", "files");
    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).not.toBeDisabled();
    });

    const [filesBtn] = screen.getAllByRole("button");
    await user.click(filesBtn!);

    expect(mockReplace).toHaveBeenCalledOnce();
    const callArg: string = mockReplace.mock.calls[0]?.[0] as string;
    expect(callArg).not.toMatch(/tool=/);
  });

  it("clicking Browser sets ?tool=browser in the URL", async () => {
    const user = userEvent.setup();
    mockAvailableProject();
    render(<ToolRail />);
    await waitFor(() => {
      expect(screen.getAllByRole("button")[1]).not.toBeDisabled();
    });

    const buttons = screen.getAllByRole("button");
    await user.click(buttons[1]!);

    expect(mockReplace).toHaveBeenCalledOnce();
    const callArg: string = mockReplace.mock.calls[0]?.[0] as string;
    expect(callArg).toMatch(/tool=browser/);
  });

  // ── aria-pressed ─────────────────────────────────────────────────────────

  it("active tool button has aria-pressed=true", async () => {
    mockAvailableProject();
    mockSearchParams.set("tool", "files");
    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).not.toBeDisabled();
    });

    const [filesBtn] = screen.getAllByRole("button");
    expect(filesBtn).toHaveAttribute("aria-pressed", "true");
  });

  it("inactive enabled buttons have aria-pressed=false", async () => {
    mockAvailableProject();
    mockSearchParams.set("tool", "files");
    render(<ToolRail />);

    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).not.toBeDisabled();
    });

    const buttons = screen.getAllByRole("button");
    // Browser, Review, Terminal should be aria-pressed=false
    for (const btn of buttons.slice(1)) {
      expect(btn).toHaveAttribute("aria-pressed", "false");
    }
  });

  // ── Axe accessibility ────────────────────────────────────────────────────

  it("has no axe violations with no project (all disabled)", async () => {
    mockNoProject();
    const { container } = render(<ToolRail />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations with unavailable project", async () => {
    mockUnavailableProject();
    const { container } = render(<ToolRail />);
    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).toBeDisabled();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations with available project", async () => {
    mockAvailableProject();
    const { container } = render(<ToolRail />);
    await waitFor(() => {
      expect(screen.getAllByRole("button")[0]).not.toBeDisabled();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // ── ApiError path ─────────────────────────────────────────────────────────

  it("disables all buttons when fetchProjects throws ApiError", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.fetchProjects).mockRejectedValue(
      new ApiError("INTERNAL", "server error", 500),
    );
    render(<ToolRail />);
    // Initially loading (disabled) - remains disabled after notfound
    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      for (const btn of buttons) {
        expect(btn).toBeDisabled();
      }
    });
  });
});
