// Issue #2063 — unit tests for the live HTML Manual Knowledge Pod refresh control. Every BFF call is
// an injected seam, so the confirm -> start -> poll -> settle flow runs with no network, and jest-axe
// gates the idle state.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HtmlManualPodJob, KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import { HtmlManualPodRefresh } from "./html-manual-pod-refresh";

const CAP = "cap-1" as KnowledgeCapsuleId;

function job(state: HtmlManualPodJob["state"]): HtmlManualPodJob {
  return {
    schemaVersion: "1",
    jobId: "job-1",
    operation: "refresh",
    state,
    phase: state === "running" ? "crawling" : "ready",
    capsuleId: "cap-1",
    sourceId: "src-1",
    crawl: { discovered: 3, accepted: 2, deniedCount: 1, bytesFetched: 100 },
    indexing:
      state === "running"
        ? null
        : {
            totalDocuments: 2,
            processedDocuments: 2,
            failedDocuments: 0,
            skippedDocuments: 0,
            vectorsPersisted: 5,
          },
    remediations: [],
    startedAt: 0,
    updatedAt: 0,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HtmlManualPodRefresh", () => {
  it("shows the refresh button and has no accessibility violations", async () => {
    const { container } = render(<HtmlManualPodRefresh capsuleId={CAP} sourceId="src-1" />);
    expect(screen.getByRole("button", { name: /refresh manual/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("confirms then starts a refresh and shows live crawl progress", async () => {
    const startRefreshImpl = vi.fn().mockResolvedValue(job("running"));
    render(
      <HtmlManualPodRefresh capsuleId={CAP} sourceId="src-1" startRefreshImpl={startRefreshImpl} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh manual/i }));
    fireEvent.click(screen.getByRole("button", { name: /^refresh manual$/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/Refreshing manual/i);
    });
    expect(startRefreshImpl).toHaveBeenCalledWith(CAP, "src-1");
    // The crawl line counts pages the crawler FETCHED, not pages that reached the index (0.3.0
    // audit): calling accepted pages "indexed" claimed work that had not happened yet.
    expect(screen.getByRole("status")).toHaveTextContent(/2 pages fetched, 1 links skipped/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(/2 pages indexed/i);
  });

  it("reports a refresh that left gaps as partial, not as a plain success", async () => {
    const partial: HtmlManualPodJob = {
      ...job("partial"),
      phase: "degraded",
      indexing: {
        totalDocuments: 4,
        processedDocuments: 3,
        failedDocuments: 1,
        skippedDocuments: 0,
        vectorsPersisted: 9,
      },
      remediations: [{ reason: "fetch-failed", guidance: "Some pages could not be retrieved." }],
    };
    render(
      <HtmlManualPodRefresh
        capsuleId={CAP}
        sourceId="src-1"
        startRefreshImpl={vi.fn().mockResolvedValue(job("running"))}
        getJobImpl={vi.fn().mockResolvedValue(partial)}
        pollIntervalMs={5}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh manual/i }));
    fireEvent.click(screen.getByRole("button", { name: /^refresh manual$/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/refreshed with gaps/i);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/1 pages failed, 0 pages skipped/i);
    expect(screen.getByRole("status")).toHaveTextContent(/Some pages could not be retrieved\./i);
  });

  it("polls the job to completion and reports the terminal state", async () => {
    const startRefreshImpl = vi.fn().mockResolvedValue(job("running"));
    const getJobImpl = vi.fn().mockResolvedValue(job("succeeded"));
    const onRefreshComplete = vi.fn();
    render(
      <HtmlManualPodRefresh
        capsuleId={CAP}
        sourceId="src-1"
        startRefreshImpl={startRefreshImpl}
        getJobImpl={getJobImpl}
        onRefreshComplete={onRefreshComplete}
        pollIntervalMs={5}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh manual/i }));
    fireEvent.click(screen.getByRole("button", { name: /^refresh manual$/i }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(/Manual refreshed/i);
    });
    expect(getJobImpl).toHaveBeenCalledWith("job-1");
    expect(onRefreshComplete).toHaveBeenCalledTimes(1);
  });

  it("surfaces a start failure without crashing", async () => {
    const startRefreshImpl = vi.fn().mockRejectedValue(new Error("boom"));
    render(
      <HtmlManualPodRefresh capsuleId={CAP} sourceId="src-1" startRefreshImpl={startRefreshImpl} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh manual/i }));
    fireEvent.click(screen.getByRole("button", { name: /^refresh manual$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});
