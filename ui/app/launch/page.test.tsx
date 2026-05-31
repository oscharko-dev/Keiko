// Route-resolution tests for /launch.
// Proves /launch uses the same URL-aware workspace route as /.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import LaunchPage from "./page";
import * as api from "@/lib/api";

const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof api>("@/lib/api");
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchChats: vi.fn(),
  };
});

const project = {
  path: "/workspace/keiko",
  name: "Keiko",
  available: true,
  favorite: false,
  createdAt: 1000,
  lastOpenedAt: 2000,
};

describe("/launch route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.delete("project");
    mockSearchParams.delete("chat");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [project] });
    vi.mocked(api.fetchChats).mockResolvedValue({ chats: [] });
  });

  it("renders the workspace shell entry surface", () => {
    render(<LaunchPage />);
    expect(
      screen.getByRole("heading", { name: /welcome to keiko/i }),
    ).toBeInTheDocument();
  });

  it("honors selected project search params like the root route", async () => {
    mockSearchParams.set("project", project.path);
    render(<LaunchPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: project.name })).toBeInTheDocument();
    });
    expect(screen.getByText(project.path)).toBeInTheDocument();
  });
});
