// Retention disclosure in the QI hub run list (0.3.0 release audit).
//
// QI runs are hard-deleted automatically at server start — by age and by count. The hub used to
// render the run list with no hint of that, so a user watching runs disappear between sessions had
// no way to know the product had destroyed them. These tests pin the disclosure: whenever the run
// list route reports a retention policy, the hub states it in words the user can act on, with the
// numbers the server actually enforces.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  QualityIntelligenceUiRetentionNotice,
  QualityIntelligenceUiRunSummary,
} from "@oscharko-dev/keiko-contracts";
import { QiHubPanel } from "./QiHubPanel";

type FetchRunsImpl = typeof import("@/lib/quality-intelligence-api").fetchQiRuns;

function makeRun(id: string): QualityIntelligenceUiRunSummary {
  return {
    id,
    status: "succeeded",
    requestedAt: "2026-07-01T10:00:00.000Z",
    completedAt: "2026-07-01T10:01:00.000Z",
    totals: { candidates: 3, findings: 0, exports: 0 },
    reviewState: "open",
  };
}

const fakeFetch = (
  runs: readonly QualityIntelligenceUiRunSummary[],
  retention?: QualityIntelligenceUiRetentionNotice,
): FetchRunsImpl =>
  vi.fn().mockResolvedValue({
    runs,
    limit: 50,
    totalRunIds: runs.length,
    truncated: false,
    ...(retention !== undefined ? { retention } : {}),
  }) as unknown as FetchRunsImpl;

const NOTICE: QualityIntelligenceUiRetentionNotice = {
  policyId: "qi:short-30d",
  retainedDays: 30,
  maxRunArtifacts: 100,
};

describe("QiHubPanel — automatic-deletion disclosure", () => {
  it("states that runs are deleted automatically, with the enforced limits", async () => {
    render(
      <QiHubPanel
        openRun={vi.fn()}
        fetchRunsImpl={fakeFetch([makeRun("qi-run-aaaa1111")], NOTICE)}
      />,
    );
    const notice = await screen.findByTestId("qi-runs-retention");
    expect(notice).toHaveTextContent(/30/);
    expect(notice).toHaveTextContent(/100/);
    expect(notice.textContent ?? "").toMatch(/delete/i);
  });

  it("discloses retention on the empty list too, before any run exists to lose", async () => {
    render(<QiHubPanel openRun={vi.fn()} fetchRunsImpl={fakeFetch([], NOTICE)} />);
    expect(await screen.findByTestId("qi-runs-retention")).toBeInTheDocument();
  });

  it("makes no retention claim when the server reports none", async () => {
    render(
      <QiHubPanel openRun={vi.fn()} fetchRunsImpl={fakeFetch([makeRun("qi-run-aaaa1111")])} />,
    );
    expect(await screen.findByText(/qi-run-aaaa1111/)).toBeInTheDocument();
    expect(screen.queryByTestId("qi-runs-retention")).not.toBeInTheDocument();
  });
});
