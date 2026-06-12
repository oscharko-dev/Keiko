// Epic #270 — QiHubPanel tests. The hub lists past runs and opens a run as a result card via the
// injected `openRun` callback; finishing a run from the launcher also opens its card.

import { render, screen, within } from "@testing-library/react";
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

// fetchQiRuns returns the full wire envelope (issue #646) so the hub can render the
// "more available" indicator when the route truncated the list (uiux-fix F030 C277).
const fakeFetch = (
  runs: readonly QualityIntelligenceUiRunSummary[],
): typeof import("@/lib/quality-intelligence-api").fetchQiRuns =>
  vi.fn().mockResolvedValue({
    runs,
    limit: 50,
    totalRunIds: runs.length,
    truncated: false,
  }) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRuns;

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

  it("names each run row with status, date and case count for assistive tech (F030 C270)", async () => {
    render(
      <QiHubPanel
        openRun={vi.fn()}
        fetchRunsImpl={fakeFetch([makeRun("qi-run-aaaa1111", "failed")])}
      />,
    );
    // aria-label replaces the computed name — it must carry status + date + case count, not
    // just the id, so failed and succeeded runs are distinguishable while list-navigating.
    // "test cases" is the suite-wide object name (uiux-fix F047 C388).
    expect(
      await screen.findByRole("button", {
        name: /open run qi-run-aaaa1111 — Failed, .*3 test cases/i,
      }),
    ).toBeInTheDocument();
  });

  it("leads with the run date and truncates the opaque id with an ellipsis (F038 C145)", async () => {
    render(
      <QiHubPanel
        openRun={vi.fn()}
        fetchRunsImpl={fakeFetch([makeRun("qi-run-cccc3333-very-long-id", "succeeded")])}
      />,
    );
    // The wire summary carries no source label, so the date is the only human-recognizable
    // signal — it renders as the primary line; the id is secondary meta and must visibly
    // signal its truncation (slice(0, 16) + "…"), never pose as a complete id.
    expect(await screen.findByText("qi-run-cccc3333-…")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /open run qi-run-cccc3333-very-long-id/i });
    const title = row.querySelector(".qi-run-title");
    expect(title).not.toBeNull();
    expect(title?.textContent).toBe(
      new Date("2026-06-01T10:00:00.000Z").toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    );
  });

  it("shows a 'more available' note and the total count when the list is truncated (F030 C277)", async () => {
    const truncatedFetch = vi.fn().mockResolvedValue({
      runs: [makeRun("qi-run-aaaa1111", "succeeded"), makeRun("qi-run-bbbb2222", "failed")],
      limit: 2,
      totalRunIds: 5,
      truncated: true,
    }) as unknown as typeof import("@/lib/quality-intelligence-api").fetchQiRuns;
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={truncatedFetch} />);
    expect(await screen.findByTestId("qi-runs-truncated")).toHaveTextContent(
      "Showing 2 of 5 runs.",
    );
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

  it("paginates the run list and reveals the rest on Show more (#280)", async () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      makeRun(`qi-run-${i.toString().padStart(4, "0")}`, "succeeded"),
    );
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={fakeFetch(runs)} />);

    const list = await screen.findByRole("list", { name: /run list/i });
    // First page only: 25 of 30 rendered into the DOM.
    expect(within(list).getAllByRole("listitem")).toHaveLength(25);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /show more runs \(5 remaining\)/i }));

    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    expect(screen.queryByRole("button", { name: /show more runs/i })).not.toBeInTheDocument();
  });
});
