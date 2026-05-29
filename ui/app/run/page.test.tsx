import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import RunPage from "./page";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => key === "id" ? "run-test-123" : null }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/useSSE", () => ({
  useSSE: vi.fn().mockReturnValue({
    events: [],
    status: "connecting" as const,
    error: null,
  }),
}));

vi.mock("@/lib/api", () => ({
  cancelRun: vi.fn(),
  fetchRunReport: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
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

const { useSSE } = await import("@/lib/useSSE");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RunPage (/run?id=)", () => {
  beforeEach(() => {
    vi.mocked(useSSE).mockReturnValue({ events: [], status: "connecting", error: null });
    vi.mocked(api.cancelRun).mockResolvedValue({ ok: true });
    vi.mocked(api.fetchRunReport).mockResolvedValue({ report: { status: "dry-run" } });
  });

  it("renders the run heading with the runId", () => {
    render(<RunPage />);
    expect(screen.getByRole("heading", { level: 1, name: /run/i })).toBeInTheDocument();
    expect(screen.getByText("run-test-123")).toBeInTheDocument();
  });

  it("Cancel button is present and reachable by keyboard", () => {
    render(<RunPage />);
    const cancelBtn = screen.getByRole("button", { name: /cancel this run/i });
    expect(cancelBtn).toBeInTheDocument();
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);
    expect(cancelBtn).not.toBeDisabled();
  });

  it("Cancel button is disabled when run is terminal", () => {
    vi.mocked(useSSE).mockReturnValue({ events: [], status: "terminal", error: null });
    render(<RunPage />);
    expect(screen.getByRole("button", { name: /cancel this run/i })).toBeDisabled();
  });

  it("calls cancelRun API when Cancel is clicked", async () => {
    const user = userEvent.setup();
    render(<RunPage />);
    await user.click(screen.getByRole("button", { name: /cancel this run/i }));
    await waitFor(() => {
      expect(api.cancelRun).toHaveBeenCalledWith("run-test-123");
    });
  });

  it("shows event timeline heading", () => {
    render(<RunPage />);
    expect(screen.getByRole("heading", { name: /event timeline/i })).toBeInTheDocument();
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<RunPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
