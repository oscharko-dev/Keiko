import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import EvidenceDetailPage from "./page";
import * as api from "@/lib/api";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: (key: string) => key === "id" ? "run-detail-789" : null }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  fetchEvidenceManifest: vi.fn(),
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

const mockManifest = {
  manifest: {
    evidenceSchemaVersion: "1" as const,
    run: {
      runId: "run-detail-789",
      fingerprint: "fp-abc123",
      harnessVersion: "1.0.0",
      taskType: "generate-unit-tests",
      outcome: "completed" as const,
      startedAt: 1780048800000, // 2026-05-29T10:00:00Z epoch-ms (FIX F)
      finishedAt: 1780048920000, // 2026-05-29T10:02:00Z epoch-ms (FIX F)
      durationMs: 120000,
    },
    model: { modelId: "claude-3-5-sonnet", costClass: "medium" as const },
    usageTotals: {
      promptTokens: 5000,
      completionTokens: 1200,
      requestCount: 3,
      totalLatencyMs: 4500,
    },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EvidenceDetailPage (/evidence/detail?id=)", () => {
  beforeEach(() => {
    vi.mocked(api.fetchEvidenceManifest).mockResolvedValue(mockManifest);
  });

  it("renders the evidence detail heading", async () => {
    render(<EvidenceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /evidence detail/i }),
      ).toBeInTheDocument();
    });
  });

  it("displays model ID and usage totals", async () => {
    render(<EvidenceDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("claude-3-5-sonnet")).toBeInTheDocument();
      expect(screen.getByText("5.0k")).toBeInTheDocument();
      expect(screen.getByText("1.2k")).toBeInTheDocument();
    });
  });

  it("Back button is present and reachable by keyboard", async () => {
    render(<EvidenceDetailPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /back to evidence browser/i }),
      ).toBeInTheDocument();
    });
    const btn = screen.getByRole("button", { name: /back to evidence browser/i });
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });

  it("shows 404-safe message on NOT_FOUND error", async () => {
    const { ApiError } = await import("@/lib/api");
    vi.mocked(api.fetchEvidenceManifest).mockRejectedValueOnce(
      new ApiError("NOT_FOUND", "Not found", 404),
    );
    render(<EvidenceDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/no evidence manifest found/i)).toBeInTheDocument();
    });
  });

  it("shows schema-safe message on EVIDENCE_SCHEMA error", async () => {
    const { ApiError } = await import("@/lib/api");
    vi.mocked(api.fetchEvidenceManifest).mockRejectedValueOnce(
      new ApiError("EVIDENCE_SCHEMA", "Schema mismatch", 422),
    );
    render(<EvidenceDetailPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/unsupported schema version/i)).toBeInTheDocument();
    });
  });

  it("has no axe-detectable accessibility violations", async () => {
    const { container } = render(<EvidenceDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("claude-3-5-sonnet")).toBeInTheDocument();
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
