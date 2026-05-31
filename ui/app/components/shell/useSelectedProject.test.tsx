// Tests for the useSelectedProject hook.
// Covers: idle / loading / found / notfound, ApiError path, unknown error path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import type { ProjectWithAvailability } from "@/lib/types";
import { clearSelectedProjectCacheForTests, useSelectedProject } from "./useSelectedProject";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockProject: ProjectWithAvailability = {
  path: "/workspace/foo",
  name: "Foo Project",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

// ---------------------------------------------------------------------------
// Test wrapper — renders the hook state to the DOM
// ---------------------------------------------------------------------------

function Probe(): ReactNode {
  const state = useSelectedProject();
  return (
    <div>
      <div
        data-testid="state"
        data-kind={state.kind}
        data-path={state.kind === "found" ? state.project.path : undefined}
      />
      {state.kind === "error" && (
        <>
          <p>{state.message}</p>
          <button type="button" onClick={state.retry}>Retry</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSelectedProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.delete("project");
    clearSelectedProjectCacheForTests();
  });

  it("returns idle when no ?project= param", () => {
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
    render(<Probe />);
    expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "idle");
  });

  it("transitions through loading then found when project exists", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    let resolve: (v: { projects: readonly ProjectWithAvailability[] }) => void;
    vi.mocked(api.fetchProjects).mockReturnValue(
      new Promise((res) => { resolve = res; }),
    );

    render(<Probe />);

    // Immediately shows loading
    expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "loading");

    // Resolve the fetch
    resolve!({ projects: [mockProject] });

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "found");
    });
  });

  it("returns notfound when project path is absent from list", async () => {
    mockSearchParams.set("project", "/workspace/missing");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [mockProject] });

    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "notfound");
    });
  });

  it("returns error when fetchProjects throws ApiError", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.fetchProjects).mockRejectedValue(
      new ApiError("INTERNAL", "server error", 500),
    );

    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "error");
    });
    expect(screen.getByText("server error")).toBeInTheDocument();
  });

  it("returns error when fetchProjects throws unknown error", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.fetchProjects).mockRejectedValue(new Error("network failure"));

    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "error");
    });
    expect(screen.getByText(/could not load the selected project/i)).toBeInTheDocument();
  });

  it("resets to idle when ?project= param is removed", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [mockProject] });

    const { rerender } = render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "found");
    });

    // Remove the project param and force a re-render
    mockSearchParams.delete("project");
    rerender(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "idle");
    });
  });

  it("dedupes shared project-list fetches across multiple hook consumers", async () => {
    mockSearchParams.set("project", "/workspace/foo");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [mockProject] });

    render(
      <>
        <Probe />
        <Probe />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("state")).toHaveLength(2);
      expect(screen.getAllByTestId("state")[0]).toHaveAttribute("data-kind", "found");
      expect(screen.getAllByTestId("state")[1]).toHaveAttribute("data-kind", "found");
    });

    expect(api.fetchProjects).toHaveBeenCalledTimes(1);
  });

  it("refreshes the project list when the selected project path changes after a resolved lookup", async () => {
    const otherProject: ProjectWithAvailability = {
      ...mockProject,
      path: "/workspace/bar",
      name: "Bar Project",
    };
    mockSearchParams.set("project", mockProject.path);
    vi.mocked(api.fetchProjects)
      .mockResolvedValueOnce({ projects: [mockProject] })
      .mockResolvedValueOnce({ projects: [mockProject, otherProject] });

    const { rerender } = render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "found");
    });

    mockSearchParams.set("project", otherProject.path);
    rerender(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("state")).toHaveAttribute("data-kind", "found");
      expect(screen.getByTestId("state")).toHaveAttribute("data-path", otherProject.path);
      expect(api.fetchProjects).toHaveBeenCalledTimes(2);
    });
  });
});
