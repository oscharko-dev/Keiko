import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

// FIX F: timestamps are epoch-ms numbers, matching src/audit/index-api.ts startedAt/finishedAt.
const mockEntries = [
  {
    runId: "run-aaa",
    taskType: "generate-unit-tests",
    outcome: "completed" as const,
    startedAt: 1780048800000, // 2026-05-29T10:00:00Z
    finishedAt: 1780048920000, // 2026-05-29T10:02:00Z
  },
  {
    runId: "run-bbb",
    taskType: "investigate-bug",
    outcome: "failed" as const,
    startedAt: 1779958800000, // 2026-05-28T09:00:00Z
    finishedAt: 1779959100000, // 2026-05-28T09:05:00Z
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

  // FIX F: date filter must handle numeric epoch-ms timestamps without throwing.
  // The filter derives a YYYY-MM-DD string from the number and compares — no .startsWith.
  // We use fireEvent.change rather than userEvent.type because <input type="date"> in jsdom
  // requires the full YYYY-MM-DD value to be set atomically for the onChange handler to fire
  // with the complete date string.
  it("date filter works with numeric epoch-ms timestamps (FIX F)", async () => {
    render(<EvidencePage />);

    // Wait for entries to load
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "run-aaa" })).toBeInTheDocument();
    });

    // Both entries visible initially
    expect(screen.getByRole("link", { name: "run-aaa" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "run-bbb" })).toBeInTheDocument();

    // Filter to the date of run-aaa only. The filter MUST NOT throw even though
    // startedAt is a number — toDateString(epochMs) produces YYYY-MM-DD for comparison.
    const dateInput = screen.getByLabelText(/date/i);
    fireEvent.change(dateInput, { target: { value: "2026-05-29" } });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "run-aaa" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "run-bbb" })).not.toBeInTheDocument();
    });
  });

  it("date filter for second date shows only matching entry (FIX F)", async () => {
    render(<EvidencePage />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "run-bbb" })).toBeInTheDocument();
    });

    const dateInput = screen.getByLabelText(/date/i);
    fireEvent.change(dateInput, { target: { value: "2026-05-28" } });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "run-bbb" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "run-aaa" })).not.toBeInTheDocument();
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
