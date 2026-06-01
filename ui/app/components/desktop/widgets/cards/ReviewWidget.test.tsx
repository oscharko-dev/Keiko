import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, applyRun, fetchEvidenceManifest, fetchRunReport } from "../../../../../lib/api";
import type { EvidenceManifest } from "../../../../../lib/types";
import { ReviewWidget } from "./ReviewWidget";

vi.mock("../../../../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    public readonly code: string;
    public readonly status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  applyRun: vi.fn(),
  fetchEvidenceManifest: vi.fn(),
  fetchRunReport: vi.fn(),
}));

const MINIMAL_REPORT = {
  status: "dry-run" as const,
  proposedDiff: [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "-del",
    "+add1",
    "+add2",
    "",
  ].join("\n"),
  changedFiles: [
    { path: "src/foo.ts", kind: "modified", addedLines: 2, removedLines: 1, elevatedReview: false },
  ],
};

const MULTI_FILE_REPORT = {
  status: "dry-run" as const,
  proposedDiff: [
    "diff --git a/src/alpha.ts b/src/alpha.ts",
    "--- a/src/alpha.ts",
    "+++ b/src/alpha.ts",
    "@@ -1 +1 @@",
    "-alphaOld",
    "+alphaNew",
    "diff --git a/src/beta.ts b/src/beta.ts",
    "--- a/src/beta.ts",
    "+++ b/src/beta.ts",
    "@@ -1 +1 @@",
    "-betaOld",
    "+betaNew",
    "",
  ].join("\n"),
  changedFiles: [
    { path: "src/alpha.ts", kind: "modified", addedLines: 1, removedLines: 1, elevatedReview: false },
    { path: "src/beta.ts", kind: "modified", addedLines: 1, removedLines: 1, elevatedReview: false },
  ],
};

function evidenceManifest(runId: string): EvidenceManifest {
  return {
    evidenceSchemaVersion: "1",
    run: {
      runId,
      fingerprint: "fp",
      harnessVersion: "1",
      taskType: "unit-test-generation",
      startedAt: 0,
      finishedAt: 100,
      outcome: "completed",
      durationMs: 100,
    },
    model: { modelId: "m1", costClass: "medium" },
    usageTotals: { promptTokens: 1, completionTokens: 1, requestCount: 1, totalLatencyMs: 1 },
    stateTransitions: [],
    toolCalls: [],
    commandExecutions: [],
  };
}

function mockEvidenceNotFound(): void {
  vi.mocked(fetchEvidenceManifest).mockRejectedValue(
    new ApiError("NOT_FOUND", "No evidence for that run id.", 404),
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ReviewWidget", () => {
  it("renders empty state when no runId is provided and makes no fetch", () => {
    render(<ReviewWidget />);
    expect(screen.getByRole("heading", { name: /review/i })).toBeInTheDocument();
    expect(screen.getByText(/enter a run id/i)).toBeInTheDocument();
    expect(vi.mocked(fetchRunReport)).not.toHaveBeenCalled();
  });

  it("renders empty state when runId is empty string", () => {
    render(<ReviewWidget runId="" />);
    expect(screen.getByText(/enter a run id/i)).toBeInTheDocument();
    expect(vi.mocked(fetchRunReport)).not.toHaveBeenCalled();
  });

  it("shows aria-busy skeleton while loading", async () => {
    // fetchRunReport never resolves in this test
    vi.mocked(fetchRunReport).mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchEvidenceManifest).mockReturnValue(new Promise(() => {}));

    render(<ReviewWidget runId="r-123" />);
    // The loading div has aria-label "Loading diff" and aria-busy="true"
    const loading = await screen.findByLabelText(/loading diff/i);
    expect(loading).toHaveAttribute("aria-busy", "true");
  });

  it("renders file headers, line counts, +N/−M badges; Apply enabled when status:dry-run", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-123" />);

    await waitFor(() => {
      // path appears in file-list and diff section — both are expected
      expect(screen.getAllByText("src/foo.ts").length).toBeGreaterThan(0);
    });

    // stat badges are rendered in both file list and section header
    const addBadges = screen.getAllByText("+2");
    expect(addBadges.length).toBeGreaterThan(0);
    const delBadges = screen.getAllByText("−1");
    expect(delBadges.length).toBeGreaterThan(0);

    const applyBtn = screen.getByRole("button", { name: /apply/i });
    expect(applyBtn).toBeEnabled();
    expect(screen.getAllByText("Added line").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Deleted line").length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/hunk header/i)).toBeInTheDocument();
  });

  it("Apply button is disabled and replaced with Applied text once appliedAt is set", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: { ...MINIMAL_REPORT, appliedAt: Date.now() },
    });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-123" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
    });
    // rv-final "Applied" span is in the document; the role=status live region also says "Applied"
    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0);
  });

  it("shows error message on 409 NOT_APPLIABLE and re-enables the Apply button", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    mockEvidenceNotFound();
    vi.mocked(applyRun).mockRejectedValue(
      new ApiError("NOT_APPLIABLE", "Run is not in an appliable state.", 409),
    );

    render(<ReviewWidget runId="r-123" />);
    await screen.findByRole("button", { name: /apply/i });

    await userEvent.click(screen.getByRole("button", { name: /apply/i }));

    await waitFor(() => {
      expect(screen.getByText(/not in an appliable state/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/not in an appliable state/i);
    expect(screen.getByRole("button", { name: /apply/i })).toBeEnabled();
  });

  it("calls the existing apply route helper and transitions to Applied on success", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    mockEvidenceNotFound();
    vi.mocked(applyRun).mockResolvedValue({
      report: { ...MINIMAL_REPORT, appliedAt: Date.now() },
    });

    render(<ReviewWidget runId="r-123" />);
    await screen.findByRole("button", { name: /apply/i });

    await userEvent.click(screen.getByRole("button", { name: /apply/i }));

    await waitFor(() => {
      expect(applyRun).toHaveBeenCalledWith("r-123");
      expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
    });
    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0);
  });

  it("shows 404 message when report fetch returns NOT_FOUND", async () => {
    vi.mocked(fetchRunReport).mockRejectedValue(
      new ApiError("NOT_FOUND", "Run not found.", 404),
    );
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-missing" />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "No run with that ID was found.",
      );
    });
  });

  it("keeps evidence navigation when the live run record has expired", async () => {
    vi.mocked(fetchRunReport).mockRejectedValue(
      new ApiError("NOT_FOUND", "Run not found.", 404),
    );
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({
      manifest: evidenceManifest("r-expired"),
    });

    render(<ReviewWidget runId="r-expired" />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("No run with that ID was found.");
      expect(screen.getByRole("link", { name: /evidence/i })).toHaveAttribute(
        "href",
        "/api/evidence/r-expired",
      );
    });
  });

  it("shows a running state instead of claiming there is no diff yet", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: { status: "running" as const },
    });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-running" />);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/run is still running/i);
      expect(screen.queryByText(/this run has no proposed diff to review/i)).not.toBeInTheDocument();
    });
  });

  it("shows no-diff message when report has no proposedDiff", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: { status: "completed" as const },
    });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-nodiff" />);

    await waitFor(() => {
      expect(
        screen.getByText(/this run has no proposed diff to review/i),
      ).toBeInTheDocument();
    });
  });

  it("shows no-diff message when report has only changedFiles but no proposedDiff", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: {
        status: "completed" as const,
        changedFiles: [
          { path: "src/foo.ts", kind: "modified", addedLines: 1, removedLines: 0, elevatedReview: false },
        ],
      },
    });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-cfonly" />);

    await waitFor(() => {
      expect(
        screen.getByText(/this run has no proposed diff to review/i),
      ).toBeInTheDocument();
    });
  });

  it("renders only the selected file body and switches files from the file list", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MULTI_FILE_REPORT });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-123" />);

    await screen.findByText("alphaNew");
    expect(screen.queryByText("betaNew")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /src\/beta\.ts/i }));

    await waitFor(() => {
      expect(screen.getByText("betaNew")).toBeInTheDocument();
      expect(screen.queryByText("alphaNew")).not.toBeInTheDocument();
    });
  });

  it("Evidence link is present when manifest fetch succeeds", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({
      manifest: evidenceManifest("r-123"),
    });

    render(<ReviewWidget runId="r-123" />);

    await waitFor(() => {
      const link = screen.getByRole("link", { name: /evidence/i });
      expect(link).toHaveAttribute("href", "/api/evidence/r-123");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });
  });

  it("Evidence is aria-disabled when manifest 404s", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    mockEvidenceNotFound();

    render(<ReviewWidget runId="r-123" />);

    await waitFor(() => {
      const span = screen.getByText("Evidence");
      expect(span).toHaveAttribute("role", "link");
      expect(span).toHaveAttribute("aria-disabled", "true");
    });
  });

  it("surfaces non-404 evidence read failures instead of treating them as absence", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(
      new ApiError("EVIDENCE_READ", "manifest could not be read", 422),
    );

    render(<ReviewWidget runId="r-corrupt" />);

    await waitFor(() => {
      const status = screen.getByRole("status", { name: /evidence unavailable/i });
      expect(status).toHaveTextContent("Evidence error");
      expect(status).toHaveAttribute("title", "manifest could not be read");
    });
  });

  it("jest-axe: empty state has no violations", async () => {
    const { container } = render(<ReviewWidget />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: loaded state has no violations", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    mockEvidenceNotFound();

    const { container } = render(<ReviewWidget runId="r-axe" />);

    await waitFor(() => {
      expect(screen.getAllByText("src/foo.ts").length).toBeGreaterThan(0);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
