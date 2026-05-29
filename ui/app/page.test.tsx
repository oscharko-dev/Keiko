/**
 * page.tsx re-exports LaunchPage — tests are co-located in LaunchPage.test.tsx.
 * This file retains the smoke-level export test so the original test file stays valid.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import HomePage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  fetchWorkflows: vi.fn().mockResolvedValue({
    descriptors: [],
    explainPlan: { inputs: [] },
  }),
  fetchModels: vi.fn().mockResolvedValue({ models: [] }),
  startRun: vi.fn(),
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

describe("HomePage (LaunchPage re-export)", () => {
  it("renders the launch workflow heading", async () => {
    render(<HomePage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /launch workflow/i }),
      ).toBeInTheDocument();
    });
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<HomePage />);
    await waitFor(() => {
      // Wait for async loading state to settle
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
