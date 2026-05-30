import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { Sidebar } from "./Sidebar";
import * as api from "@/lib/api";

vi.mock("@/lib/api", () => ({
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
}));

const mockProjects = [
  { path: "/workspace/foo", name: "Foo Project", available: true, favorite: false, createdAt: 1000, lastOpenedAt: 2000 },
  { path: "/workspace/bar", name: "Bar Project", available: false, favorite: false, createdAt: 1000, lastOpenedAt: 2000 },
];

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("renders empty state with disabled Add project CTA", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValueOnce({ projects: [] });
    render(<Sidebar collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add project/i })).toBeDisabled();
    });
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
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
