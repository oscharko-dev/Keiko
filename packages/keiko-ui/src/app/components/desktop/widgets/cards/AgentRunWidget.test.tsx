import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRun, fetchModels, fetchRunReport } from "../../../../../lib/api";
import { useSSE } from "../../../../../lib/useSSE";
import { AgentRunWidget } from "./AgentRunWidget";

vi.mock("../../../../../lib/useSSE", () => ({
  useSSE: vi.fn(),
}));

vi.mock("../../../../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
  applyRun: vi.fn(),
  cancelRun: vi.fn(),
  fetchEvidenceManifest: vi.fn(),
  fetchModels: vi.fn(),
  fetchRunReport: vi.fn(),
}));

describe("AgentRunWidget", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders real report data and applies an appliable dry-run once", async () => {
    vi.mocked(useSSE).mockReturnValue({
      status: "terminal",
      error: null,
      events: [
        {
          schemaVersion: "1",
          runId: "run-123456",
          fingerprint: "fp",
          seq: 1,
          ts: 1,
          type: "workflow:model:call:completed",
          attempt: 1,
          finishReason: "stop",
          promptTokens: 40,
          completionTokens: 10,
          latencyMs: 25,
        },
      ],
    });
    vi.mocked(fetchModels).mockResolvedValue({
      models: [
        {
          id: "example-chat-model",
          kind: "chat",
          contextWindow: 1,
          maxOutputTokens: 1,
          toolCalling: false,
          structuredOutput: false,
          streaming: false,
          supportsImageInput: false,
          supportsDocumentInput: false,
          workflowEligible: false,
          costClass: "medium",
          latencyClass: "standard",
          throughputHint: "test",
          preferredUseCases: [],
          knownLimitations: [],
        },
      ],
    });
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: {
        status: "dry-run",
        durationMs: 100,
        dryRunPreview: "validated",
        proposedDiff: "diff --git a/test.ts b/test.ts",
      },
    });
    vi.mocked(applyRun).mockResolvedValue({
      report: {
        status: "dry-run",
        durationMs: 100,
        dryRunPreview: "validated",
        proposedDiff: "diff --git a/test.ts b/test.ts",
        appliedAt: 123,
        applyReport: { status: "completed" },
      },
    });

    render(
      <AgentRunWidget
        cfg={{
          workflow: "unit-test-generation",
          model: "example-chat-model",
          runId: "run-123456",
          workspaceRoot: "/repo",
          inputJson: '{"workspaceRoot":"/repo"}',
        }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    expect(await screen.findByText("Proposed diff")).toBeInTheDocument();
    expect(screen.getByText("validated")).toBeInTheDocument();
    expect(screen.getAllByText(/50 tok/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\$/u)).not.toBeInTheDocument();

    // uiux-fix F018 C258: Apply is two-stage — the first click arms an explicit
    // confirm step that names the blast radius, the second click writes.
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(applyRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /confirm apply \(1 file\)/i }));

    await waitFor(() => expect(applyRun).toHaveBeenCalledWith("run-123456"));
    expect((await screen.findAllByText("Applied")).length).toBeGreaterThan(0);
  });

  // uiux-fix F018 C026/C109: SSE disconnects must be visible and the log must be a live region
  it("renders the SSE disconnect notice inside the run-events log", async () => {
    vi.mocked(useSSE).mockReturnValue({
      status: "error",
      error: "Stream disconnected. Attempting to reconnect…",
      events: [],
    });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({ report: { status: "running" } });

    render(
      <AgentRunWidget
        cfg={{ workflow: "verify", model: "example-chat-model", runId: "run-sse-err" }}
        linkedRoot={null}
        linkedFilePath={undefined}
      />,
    );

    const log = screen.getByRole("log", { name: "Run events" });
    expect(log).toHaveTextContent("Stream disconnected. Attempting to reconnect…");
    expect(screen.queryByText(/waiting for run events/i)).not.toBeInTheDocument();
  });

  // uiux-fix F018 C259/C265: header shows a human-readable status, not the raw enum
  it("maps raw report status enums to readable labels in the header", async () => {
    vi.mocked(useSSE).mockReturnValue({ status: "terminal", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: { status: "fix-proposed", durationMs: 5, proposedDiff: "diff --git a/x b/x" },
    });

    render(
      <AgentRunWidget
        cfg={{ workflow: "bug-investigation", model: "example-chat-model", runId: "run-label" }}
        linkedRoot={null}
        linkedFilePath={undefined}
      />,
    );

    expect(await screen.findByText("Fix proposed")).toBeInTheDocument();
    expect(screen.queryByText("fix-proposed")).not.toBeInTheDocument();
  });

  it("renders explain reports and terminal failure details without a diff", async () => {
    vi.mocked(useSSE).mockReturnValue({ status: "terminal", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: {
        status: "failed",
        durationMs: 10,
        report: "Grounded explanation body",
        failureReason: "provider rate limited model",
        nextActions: ["Retry after the provider recovers"],
      },
    });

    render(
      <AgentRunWidget
        cfg={{ workflow: "explain-plan", model: "example-chat-model", runId: "run-abcdef" }}
        linkedRoot={null}
        linkedFilePath={undefined}
      />,
    );

    expect(await screen.findByText("Report")).toBeInTheDocument();
    expect(screen.getByText("Grounded explanation body")).toBeInTheDocument();
    expect(screen.getByText("Failure")).toBeInTheDocument();
    expect(screen.getByText("provider rate limited model")).toBeInTheDocument();
    expect(screen.getByText("Retry after the provider recovers")).toBeInTheDocument();
  });

  // GAP-C2 (#146): "permissions coming soon" must never render
  it("does not render the 'permissions coming soon' fake affordance (#146 GAP-C2)", () => {
    vi.mocked(useSSE).mockReturnValue({ status: "connecting", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({ report: { status: "running" } });

    render(
      <AgentRunWidget
        cfg={{ workflow: "verify", model: "example-chat-model", runId: "run-test" }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    expect(screen.queryByText(/permissions coming soon/i)).toBeNull();
  });
});
