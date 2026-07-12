import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  applyRun,
  fetchEvidenceManifest,
  fetchModels,
  fetchRunReport,
} from "../../../../../lib/api";
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

  it("exposes the dry-run, diff, and run-input <pre> blocks as keyboard-focusable named regions", async () => {
    // GEN-UI-KEYBOARD-005 (test-plan #31) — every overflow:auto output <pre> must be a
    // focusable region with an accessible name so keyboard-only users can scroll it.
    vi.mocked(useSSE).mockReturnValue({ status: "terminal", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: {
        status: "dry-run",
        durationMs: 100,
        dryRunPreview: "d".repeat(4000),
        proposedDiff: "diff --git a/test.ts b/test.ts",
      },
    });

    render(
      <AgentRunWidget
        cfg={{
          workflow: "unit-test-generation",
          model: "example-chat-model",
          runId: "run-regions",
          workspaceRoot: "/repo",
          inputJson: '{"workspaceRoot":"/repo"}',
        }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    const diff = await screen.findByRole("region", { name: /proposed diff/i });
    expect(diff.tagName).toBe("PRE");
    expect(diff).toHaveAttribute("tabindex", "0");

    const dryRun = screen.getByRole("region", { name: /dry-run preview/i });
    expect(dryRun.tagName).toBe("PRE");
    expect(dryRun).toHaveAttribute("tabindex", "0");

    const runInput = screen.getByRole("region", { name: /run input/i });
    expect(runInput.tagName).toBe("PRE");
    expect(runInput).toHaveAttribute("tabindex", "0");
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

  it("renders translated labels for the full agent event stream", async () => {
    vi.mocked(useSSE).mockReturnValue({
      status: "terminal",
      error: null,
      events: [
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 1,
          ts: 1,
          type: "ready",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 2,
          ts: 2,
          type: "run:started",
          taskType: "verify",
          modelId: "example-chat-model",
          limits: {},
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 3,
          ts: 3,
          type: "state:transition",
          from: "queued",
          to: "running",
          reason: "worker available",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 4,
          ts: 4,
          type: "model:call:started",
          modelId: "example-chat-model",
          messageCount: 2,
          contextBytes: 1024,
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 5,
          ts: 5,
          type: "model:call:failed",
          modelId: "example-chat-model",
          errorCode: "RATE_LIMITED",
          message: "rate limited",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 6,
          ts: 6,
          type: "patch:proposed",
          targetFile: "redacted",
          patchBytes: 2048,
          diff: "redacted",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 7,
          ts: 7,
          type: "verification:result",
          passed: false,
          detail: "lint failed",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 8,
          ts: 8,
          type: "bug:rootcause:proposed",
          hasPatch: false,
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 9,
          ts: 9,
          type: "bug:failed",
          errorCode: "NOT_REPRODUCED",
          message: "could not reproduce",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 10,
          ts: 10,
          type: "run:completed",
          report: "completed",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 11,
          ts: 11,
          type: "run:failed",
          failure: { message: "policy denied" },
          atState: "running",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 12,
          ts: 12,
          type: "run:cancelled",
          atState: "running",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 13,
          ts: 13,
          type: "model:call:completed",
          usage: {
            promptTokens: 12,
            completionTokens: 8,
            latencyMs: 40,
          },
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 14,
          ts: 14,
          type: "workflow:started",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 15,
          ts: 15,
          type: "workflow:verification:result",
          overallStatus: "passed",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 16,
          ts: 16,
          type: "workflow:completed",
          status: "completed",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 17,
          ts: 17,
          type: "workflow:failed",
          message: "assertion missing",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 18,
          ts: 18,
          type: "bug:started",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 19,
          ts: 19,
          type: "bug:model:call:completed",
          promptTokens: 21,
          completionTokens: 4,
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 20,
          ts: 20,
          type: "bug:rootcause:proposed",
          hasPatch: true,
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 21,
          ts: 21,
          type: "bug:verification:result",
          overallStatus: "passed",
        },
        {
          schemaVersion: "1",
          runId: "run-events",
          fingerprint: "fp",
          seq: 22,
          ts: 22,
          type: "bug:completed",
          status: "fix-applied",
        },
      ] as never,
    });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({ report: { status: "completed" } });

    render(
      <AgentRunWidget
        cfg={{ workflow: "verify", model: "example-chat-model", runId: "run-events" }}
        linkedRoot={null}
        linkedFilePath={undefined}
      />,
    );

    const log = await screen.findByRole("log", { name: "Run events" });
    expect(log).toHaveTextContent("SSE stream ready");
    expect(log).toHaveTextContent("Started verify");
    expect(log).toHaveTextContent("queued -> running: worker available");
    expect(log).toHaveTextContent("Model call started (1.0 KB)");
    expect(log).toHaveTextContent("Model call failed: rate limited");
    expect(log).toHaveTextContent("Patch proposed (2.0 KB)");
    expect(log).toHaveTextContent("Verification failed: lint failed");
    expect(log).toHaveTextContent("Root cause proposed");
    expect(log).toHaveTextContent("Bug investigation failed: could not reproduce");
    expect(log).toHaveTextContent("Run completed");
    expect(log).toHaveTextContent("Run failed: policy denied");
    expect(log).toHaveTextContent("Run cancelled");
    expect(log).toHaveTextContent("Model call completed (20 tokens)");
    expect(log).toHaveTextContent("Unit-test workflow started");
    expect(log).toHaveTextContent("Unit-test verification passed");
    expect(log).toHaveTextContent("Unit-test workflow completed");
    expect(log).toHaveTextContent("Unit-test workflow failed: assertion missing");
    expect(log).toHaveTextContent("Bug investigation started");
    expect(log).toHaveTextContent("Bug model call completed (25 tokens)");
    expect(log).toHaveTextContent("Root cause proposed with patch");
    expect(log).toHaveTextContent("Bug verification passed");
    expect(log).toHaveTextContent("Bug investigation fix-applied");
  });

  it("marks active run surfaces busy for assistive technology", () => {
    vi.mocked(useSSE).mockReturnValue({
      status: "connecting",
      error: null,
      events: [],
    });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({ report: { status: "running" } });

    const { container } = render(
      <AgentRunWidget
        cfg={{ workflow: "verify", model: "example-chat-model", runId: "run-busy" }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    expect(container.querySelector(".arun-real")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("log", { name: "Run events" })).toHaveAttribute("aria-busy", "true");
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

  it("renders the proposed diff from evidence when the live run report is unavailable", async () => {
    vi.mocked(useSSE).mockReturnValue({ status: "terminal", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockRejectedValue(new ApiError("NOT_FOUND", "Unknown run.", 404));
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({
      manifest: {
        evidenceSchemaVersion: "1",
        run: {
          runId: "run-evidence",
          fingerprint: "fp",
          harnessVersion: "test",
          taskType: "generate-unit-tests",
          outcome: "completed",
          startedAt: 0,
          finishedAt: 50,
          durationMs: 50,
        },
        model: { modelId: "example-chat-model", costClass: "unknown" },
        usageTotals: {
          promptTokens: 0,
          completionTokens: 0,
          requestCount: 0,
          totalLatencyMs: 0,
        },
        stateTransitions: [],
        toolCalls: [],
        commandExecutions: [],
        patch: {
          proposed: true,
          applied: false,
          targetFileCount: 1,
          patchBytes: 35,
          changedFiles: 1,
          created: 1,
          deleted: 0,
          redactedDiff: "diff --git a/tests/add.test.ts b/tests/add.test.ts",
        },
      },
    });

    render(
      <AgentRunWidget
        cfg={{
          workflow: "unit-test-generation",
          model: "example-chat-model",
          runId: "run-evidence",
          workspaceRoot: "/repo",
        }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    expect(await screen.findByText("Proposed diff")).toBeInTheDocument();
    expect(
      screen.getByText("diff --git a/tests/add.test.ts b/tests/add.test.ts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Generate unit tests evidence loaded with a reviewable diff."),
    ).toBeInTheDocument();
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

  // Issue #1296 — a low/medium/high agent confidence renders as the DS 0.4.0 confidence
  // signal (3-segment track + uppercase word), never colour alone, and stays axe-clean.
  it("renders a level confidence as the non-colour .ai-conf signal", async () => {
    vi.mocked(useSSE).mockReturnValue({ status: "terminal", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: {
        status: "completed",
        durationMs: 100,
        hypothesis: {
          rootCause: "off-by-one in the cursor",
          confidence: "high",
        },
      },
    });

    const { container } = render(
      <AgentRunWidget
        cfg={{ workflow: "bug-investigation", model: "example-chat-model", runId: "run-conf" }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    expect(await screen.findByText("Hypothesis")).toBeInTheDocument();
    // the word carries the meaning (not colour); the track is decorative/aria-hidden.
    const signal = container.querySelector('.ai-conf[data-level="high"]');
    expect(signal).not.toBeNull();
    expect(signal).toHaveTextContent("High");
    expect(signal?.querySelector(".track")?.getAttribute("aria-hidden")).toBe("true");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("keeps a non-level confidence string as the plain key/value row (behaviour-preserving)", async () => {
    vi.mocked(useSSE).mockReturnValue({ status: "terminal", error: null, events: [] });
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: {
        status: "completed",
        durationMs: 100,
        hypothesis: { rootCause: "race condition", confidence: "0.82" },
      },
    });

    const { container } = render(
      <AgentRunWidget
        cfg={{ workflow: "bug-investigation", model: "example-chat-model", runId: "run-conf2" }}
        linkedRoot="/repo"
        linkedFilePath={undefined}
      />,
    );

    expect(await screen.findByText("Hypothesis")).toBeInTheDocument();
    expect(screen.getByText("0.82")).toBeInTheDocument();
    expect(container.querySelector(".ai-conf")).toBeNull();
  });
});
