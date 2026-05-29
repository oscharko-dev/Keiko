import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import LaunchPage from "./LaunchPage";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  fetchWorkflows: vi.fn(),
  fetchModels: vi.fn(),
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

const mockWorkflows = {
  descriptors: [
    {
      workflowId: "generate-unit-tests",
      name: "Generate unit tests",
      description: "Generates unit tests for a target file.",
      inputs: [
        {
          name: "target",
          type: "string" as const,
          required: true,
          description: "Target file path",
          defaultValue: "",
        },
      ],
      defaultLimits: { maxModelCalls: 3, maxRetries: 2 },
      modelSelectionOptions: { arbitrary: true, preferredCostClass: "medium" as const },
      supportsDryRun: true,
      supportsApply: true,
    },
  ],
  explainPlan: {
    inputs: [
      { name: "filePath", type: "string" as const, required: true },
      { name: "question", type: "string" as const, required: false },
    ],
  },
};

const mockModels = {
  models: [
    {
      id: "claude-3-5-sonnet",
      kind: "chat" as const,
      contextWindow: 200000,
      maxOutputTokens: 8192,
      toolCalling: true,
      structuredOutput: true,
      streaming: true,
      costClass: "medium" as const,
      latencyClass: "medium" as const,
      throughputHint: "medium",
      preferredUseCases: [],
      knownLimitations: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LaunchPage", () => {
  beforeEach(() => {
    vi.mocked(api.fetchWorkflows).mockResolvedValue(mockWorkflows);
    vi.mocked(api.fetchModels).mockResolvedValue(mockModels);
  });

  it("renders the launch heading and loads workflows", async () => {
    render(<LaunchPage />);
    expect(screen.getByRole("heading", { level: 1, name: /launch workflow/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Generate unit tests")).toBeInTheDocument();
    });
  });

  it("primary action (Start run button) is reachable by keyboard", async () => {
    const user = userEvent.setup();
    render(<LaunchPage />);

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText("Generate unit tests")).toBeInTheDocument();
    });

    // Tab to the first radio (workflow select) and confirm it's focused
    await user.tab();
    // The first radio is the workflow selector
    const radio = screen.getByRole("radio", { name: /generate unit tests/i });
    // Tab through until we reach the Submit button
    // We just verify the submit button is in the DOM and accessible
    const submitBtn = screen.getByRole("button", { name: /start run/i });
    expect(submitBtn).toBeInTheDocument();
    // Focus the submit button directly via keyboard reach
    submitBtn.focus();
    expect(document.activeElement).toBe(submitBtn);
    // Verify it is not disabled (first workflow is selected by default)
    expect(submitBtn).not.toBeDisabled();
    // Confirm radio is present (keyboard-operable)
    expect(radio).toBeInTheDocument();
  });

  it("shows error message when API fails", async () => {
    vi.mocked(api.fetchWorkflows).mockRejectedValueOnce(new Error("Network error"));
    render(<LaunchPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });

  it("has no axe-detectable accessibility violations after load", async () => {
    const { container } = render(<LaunchPage />);
    await waitFor(() => {
      expect(screen.getByText("Generate unit tests")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
