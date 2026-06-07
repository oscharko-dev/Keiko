// Issue #643 — regression coverage for the stale-response guard on QI detail loading.
//
// Rapid run-switching (user clicks run A, then run B before A's detail resolves) must not let
// the older promise overwrite the active detail state. We exercise the seam by injecting fake
// `fetchRunDetailImpl` that returns hand-controlled promises so the test can settle them in
// out-of-order arrival order.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QualityIntelligencePanel } from "./QualityIntelligencePanel";
import type {
  QualityIntelligenceUiRunDetail,
  QualityIntelligenceUiRunSummary,
} from "@oscharko-dev/keiko-contracts";

function summary(id: string): QualityIntelligenceUiRunSummary {
  return {
    id,
    status: "succeeded",
    requestedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:01:00.000Z",
    totals: { candidates: 1, findings: 1, exports: 0 },
  };
}

function detail(id: string, findingSummary: string): QualityIntelligenceUiRunDetail {
  return {
    id,
    status: "succeeded",
    requestedAt: "2026-06-01T00:00:00.000Z",
    completedAt: "2026-06-01T00:01:00.000Z",
    totals: { candidates: 1, findings: 1, exports: 0 },
    findingRefs: [
      { id: `f-${id}`, kind: "logic-defect", severity: "medium", summaryRedacted: findingSummary },
    ],
    candidateIds: [],
    evidenceRefs: [],
    manifestSchemaVersion: 1,
  };
}

describe("QualityIntelligencePanel — stale detail response guard (issue #643)", () => {
  it("ignores a stale detail response for a run the user has already navigated away from", async () => {
    const runs: readonly QualityIntelligenceUiRunSummary[] = [summary("run-a"), summary("run-b")];

    const aResolvers: { resolve: (value: QualityIntelligenceUiRunDetail) => void } = {
      resolve: () => undefined,
    };
    const bResolvers: { resolve: (value: QualityIntelligenceUiRunDetail) => void } = {
      resolve: () => undefined,
    };
    const aPromise = new Promise<QualityIntelligenceUiRunDetail>((resolve) => {
      aResolvers.resolve = resolve;
    });
    const bPromise = new Promise<QualityIntelligenceUiRunDetail>((resolve) => {
      bResolvers.resolve = resolve;
    });

    const fetchRunDetailImpl = (id: string): Promise<QualityIntelligenceUiRunDetail> => {
      if (id === "run-a") return aPromise;
      if (id === "run-b") return bPromise;
      throw new Error(`unexpected id ${id}`);
    };

    const fetchRunsImpl = (): Promise<readonly QualityIntelligenceUiRunSummary[]> =>
      Promise.resolve(runs);

    render(
      <QualityIntelligencePanel
        fetchRunsImpl={fetchRunsImpl}
        fetchRunDetailImpl={fetchRunDetailImpl}
      />,
    );

    // Wait until both run buttons render.
    const runAButton = await screen.findByRole("button", { name: /run-a/ });
    const runBButton = await screen.findByRole("button", { name: /run-b/ });

    // Select A (starts A's detail fetch), then immediately select B (starts B's detail fetch).
    runAButton.click();
    runBButton.click();

    // Resolve A LAST — the stale arrival must not surface in the UI.
    bResolvers.resolve(detail("run-b", "B finding summary"));
    await waitFor(() => {
      expect(screen.getByText("B finding summary")).toBeInTheDocument();
    });

    aResolvers.resolve(detail("run-a", "A finding summary"));
    // Give microtasks a chance to flush in case the stale promise tries to set state.
    await new Promise<void>((res) => {
      setTimeout(res, 10);
    });

    // The stale A response must NOT have replaced B's detail in the UI.
    expect(screen.queryByText("A finding summary")).not.toBeInTheDocument();
    expect(screen.getByText("B finding summary")).toBeInTheDocument();
  });

  it("surfaces the latest detail when responses arrive in the expected order", async () => {
    const runs: readonly QualityIntelligenceUiRunSummary[] = [summary("run-a")];
    const fetchRunsImpl = (): Promise<readonly QualityIntelligenceUiRunSummary[]> =>
      Promise.resolve(runs);
    const fetchRunDetailImpl = (id: string): Promise<QualityIntelligenceUiRunDetail> =>
      Promise.resolve(detail(id, "A only"));

    render(
      <QualityIntelligencePanel
        fetchRunsImpl={fetchRunsImpl}
        fetchRunDetailImpl={fetchRunDetailImpl}
      />,
    );
    const runAButton = await screen.findByRole("button", { name: /run-a/ });
    runAButton.click();
    await waitFor(() => {
      expect(screen.getByText("A only")).toBeInTheDocument();
    });
  });
});
