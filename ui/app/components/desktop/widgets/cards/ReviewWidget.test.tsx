import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, applyRun, fetchEvidenceManifest, fetchRunReport } from "../../../../../lib/api";
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
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

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
  });

  it("Apply button is disabled and replaced with Applied text once appliedAt is set", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: { ...MINIMAL_REPORT, appliedAt: Date.now() },
    });
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

    render(<ReviewWidget runId="r-123" />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
    });
    // rv-final "Applied" span is in the document; the role=status live region also says "Applied"
    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0);
  });

  it("shows error message on 409 NOT_APPLIABLE and re-enables the Apply button", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));
    vi.mocked(applyRun).mockRejectedValue(
      new ApiError("NOT_APPLIABLE", "Run is not in an appliable state.", 409),
    );

    render(<ReviewWidget runId="r-123" />);
    await screen.findByRole("button", { name: /apply/i });

    await userEvent.click(screen.getByRole("button", { name: /apply/i }));

    await waitFor(() => {
      expect(screen.getByText(/not in an appliable state/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /apply/i })).toBeEnabled();
  });

  it("shows 404 message when report fetch returns NOT_FOUND", async () => {
    vi.mocked(fetchRunReport).mockRejectedValue(
      new ApiError("NOT_FOUND", "Run not found.", 404),
    );
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

    render(<ReviewWidget runId="r-missing" />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "No run with that ID was found.",
      );
    });
  });

  it("shows no-diff message when report has no proposedDiff, dryRunPreview, or changedFiles", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({
      report: { status: "completed" as const },
    });
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

    render(<ReviewWidget runId="r-nodiff" />);

    await waitFor(() => {
      expect(
        screen.getByText(/this run has no proposed diff to review/i),
      ).toBeInTheDocument();
    });
  });

  it("file list click scrolls the matching section into view", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    render(<ReviewWidget runId="r-123" />);
    // Wait for the file-list button to appear (multiple text nodes with the path are expected)
    await screen.findAllByText("src/foo.ts");

    // The file-list button for src/foo.ts (only one file-row button exists)
    const [fileBtn] = screen.getAllByRole("button", { name: /src\/foo\.ts/i });
    await userEvent.click(fileBtn!);

    expect(scrollSpy).toHaveBeenCalledWith({ block: "start" });
    scrollSpy.mockRestore();
  });

  it("Evidence link is present when manifest fetch succeeds", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    vi.mocked(fetchEvidenceManifest).mockResolvedValue({
      manifest: {
        evidenceSchemaVersion: "1",
        run: {
          runId: "r-123",
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
      },
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
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

    render(<ReviewWidget runId="r-123" />);

    await waitFor(() => {
      const span = screen.getByText("Evidence");
      expect(span).toHaveAttribute("aria-disabled", "true");
    });
  });

  it("jest-axe: empty state has no violations", async () => {
    const { container } = render(<ReviewWidget />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("jest-axe: loaded state has no violations", async () => {
    vi.mocked(fetchRunReport).mockResolvedValue({ report: MINIMAL_REPORT });
    vi.mocked(fetchEvidenceManifest).mockRejectedValue(new Error("404"));

    const { container } = render(<ReviewWidget runId="r-axe" />);

    await waitFor(() => {
      expect(screen.getAllByText("src/foo.ts").length).toBeGreaterThan(0);
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
