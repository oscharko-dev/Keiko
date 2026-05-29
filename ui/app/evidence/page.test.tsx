import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import EvidencePage from "./page";
import * as api from "@/lib/api";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  fetchEvidenceList: vi.fn(),
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

const mockEntries = [
  {
    runId: "run-aaa",
    taskType: "generate-unit-tests",
    outcome: "completed" as const,
    startedAt: "2026-05-29T10:00:00Z",
    finishedAt: "2026-05-29T10:02:00Z",
  },
  {
    runId: "run-bbb",
    taskType: "investigate-bug",
    outcome: "failed" as const,
    startedAt: "2026-05-28T09:00:00Z",
    finishedAt: "2026-05-28T09:05:00Z",
  },
];

describe("EvidencePage", () => {
  beforeEach(() => {
    vi.mocked(api.fetchEvidenceList).mockResolvedValue({ entries: mockEntries });
  });

  it("renders the evidence browser heading", async () => {
    render(<EvidencePage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /evidence browser/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders run IDs as links to detail pages", async () => {
    render(<EvidencePage />);
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "run-aaa" })).toHaveAttribute(
        "href",
        "/evidence/detail?id=run-aaa",
      );
    });
  });

  it("filter controls are reachable by keyboard", async () => {
    render(<EvidencePage />);
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: /workflow/i })).toBeInTheDocument();
    });
    const workflowSelect = screen.getByRole("combobox", { name: /workflow/i });
    workflowSelect.focus();
    expect(document.activeElement).toBe(workflowSelect);
  });

  it("shows error message when API fails", async () => {
    vi.mocked(api.fetchEvidenceList).mockRejectedValueOnce(new Error("Network error"));
    render(<EvidencePage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<EvidencePage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
      expect(screen.getByText("run-aaa")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
