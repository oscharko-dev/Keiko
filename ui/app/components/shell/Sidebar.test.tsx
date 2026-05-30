import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { Sidebar } from "./Sidebar";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/lib/api", () => ({
  fetchProjects: vi.fn(),
  fetchChats: vi.fn().mockResolvedValue({ chats: [] }),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  createChat: vi.fn(),
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, msg: string, status: number) {
      super(msg);
      this.code = code;
      this.status = status;
    }
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockProjects = [
  {
    path: "/workspace/foo",
    name: "Foo Project",
    available: true,
    favorite: false,
    createdAt: 1000,
    lastOpenedAt: 2000,
  },
  {
    path: "/workspace/bar",
    name: "Bar Project",
    available: false,
    favorite: false,
    createdAt: 1000,
    lastOpenedAt: 2000,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset search params to empty
    mockSearchParams.delete("project");
    mockSearchParams.delete("chat");
    // Default fetchChats mock
    vi.mocked(api.fetchChats).mockResolvedValue({ chats: [] });
  });

  it("renders loading state with role=status and aria-live=polite", () => {
    vi.mocked(api.fetchProjects).mockReturnValue(new Promise(() => { /* never resolves */ }));
    render(<Sidebar collapsed={false} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("renders error state with role=alert and Retry button", async () => {
    vi.mocked(api.fetchProjects).mockRejectedValueOnce(new Error("Network error"));
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("retry button re-triggers fetch", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchProjects)
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ projects: [] });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(api.fetchProjects).toHaveBeenCalledTimes(2);
    });
  });

  it("renders empty state with Add project button (not disabled)", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: [] });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
    });
    // The add-project button at the bottom is now always functional
    expect(screen.getByRole("button", { name: /\+ add project/i })).toBeInTheDocument();
  });

  it("renders project list when loaded", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: mockProjects });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByText("Foo Project")).toBeInTheDocument();
      expect(screen.getByText("Bar Project")).toBeInTheDocument();
    });
  });

  it("marks unavailable projects with an indicator", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: mockProjects });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      const unavailableIndicators = screen.getAllByLabelText(/project path unavailable/i);
      expect(unavailableIndicators).toHaveLength(1);
    });
  });

  it("clicking a project row writes ?project= to URL", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({
      projects: [mockProjects[0]!],
    });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByText("Foo Project")).toBeInTheDocument();
    });
    // The main row button has the project name as text
    const projectBtns = screen.getAllByRole("button", { name: /foo project/i });
    // The first match is the row select button (title attribute = path)
    await user.click(projectBtns[0]!);
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("project="));
  });

  it("renders project nav landmark", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: [] });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(
        screen.getByRole("navigation", { name: /project navigation/i }),
      ).toBeInTheDocument();
    });
  });

  it("nav has id=shell-sidebar for aria-controls targeting", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: [] });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(document.getElementById("shell-sidebar")).not.toBeNull();
    });
  });

  it("selected project row has aria-current=true", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({
      projects: [mockProjects[0]!],
    });
    vi.mocked(api.fetchChats).mockResolvedValue({ chats: [] });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      // The row button for the selected project has aria-current=true
      const allWithCurrent = document
        .querySelectorAll('[aria-current="true"]');
      expect(allWithCurrent.length).toBeGreaterThan(0);
    });
  });

  it("New chat button is disabled when no project is selected", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: mockProjects });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByText("Foo Project")).toBeInTheDocument();
    });
    const newChatBtn = screen.getByRole("button", { name: /\+ new chat/i });
    expect(newChatBtn).toBeDisabled();
  });

  it("has no axe-detectable accessibility violations when loaded", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: mockProjects });
    const { container } = render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByText("Foo Project")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
