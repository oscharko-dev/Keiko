// Epic #270 — QiHubPanel tests. The hub lists past runs and opens a run as a result card via the
// injected `openRun` callback; finishing a run from the launcher also opens its card.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QiHubPanel } from "./QiHubPanel";
import type { QualityIntelligenceUiRunSummary } from "@oscharko-dev/keiko-contracts";

function makeRun(
  id: string,
  status: QualityIntelligenceUiRunSummary["status"],
): QualityIntelligenceUiRunSummary {
  return {
    id,
    status,
    requestedAt: "2026-06-01T10:00:00.000Z",
    completedAt: status === "running" ? null : "2026-06-01T10:01:00.000Z",
    totals: { candidates: 3, findings: 0, exports: 0 },
  };
}

const fakeFetch = (
  runs: readonly QualityIntelligenceUiRunSummary[],
): typeof import("@/lib/quality-intelligence-api").fetchQiRuns =>
  vi
    .fn()
    .mockResolvedValue(
      runs,
    ) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRuns;

describe("QiHubPanel", () => {
  it("renders the run launcher form", async () => {
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={fakeFetch([])} />);
    expect(await screen.findByRole("button", { name: /generate test cases/i })).toBeInTheDocument();
  });

  it("lists fetched runs", async () => {
    const runs = [makeRun("qi-run-aaaa1111", "succeeded"), makeRun("qi-run-bbbb2222", "failed")];
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={fakeFetch(runs)} />);
    expect(await screen.findByText(/qi-run-aaaa1111/)).toBeInTheDocument();
    expect(screen.getByText(/qi-run-bbbb2222/)).toBeInTheDocument();
  });

  it("calls openRun with the run id when a run row is clicked", async () => {
    const user = userEvent.setup();
    const openRun = vi.fn();
    render(
      <QiHubPanel
        openRun={openRun}
        fetchRunsImpl={fakeFetch([makeRun("qi-run-aaaa1111", "succeeded")])}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /open run qi-run-aaaa1111/i }));
    expect(openRun).toHaveBeenCalledWith("qi-run-aaaa1111");
  });

  it("shows an empty state when there are no runs", async () => {
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={fakeFetch([])} />);
    expect(await screen.findByText(/no runs yet/i)).toBeInTheDocument();
  });

  it("surfaces a retryable error when the run list fails to load", async () => {
    const failing = vi
      .fn()
      .mockRejectedValue(
        new Error("boom"),
      ) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRuns;
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={failing} />);
    expect(await screen.findByTestId("qi-error-state")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
