// Route-resolution test for / (issue #68, AC#1).
// Proves the root route mounts the workspace shell central area. Kept lightweight:
// with no ?project= in the URL, CentralArea renders the shared shell entry surface.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Page from "./page";
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

describe("/ route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.delete("project");
    mockSearchParams.delete("chat");
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects: [] });
    vi.mocked(api.fetchChats).mockResolvedValue({ chats: [] });
  });

  it("mounts the workspace shell entry surface when no project is selected", () => {
    render(<Page />);
    expect(
      screen.getByRole("heading", { name: /welcome to keiko/i }),
    ).toBeInTheDocument();
  });
});
