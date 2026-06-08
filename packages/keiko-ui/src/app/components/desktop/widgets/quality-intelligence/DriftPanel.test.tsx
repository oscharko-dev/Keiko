// Epic #735 / Issue #744 — DriftPanel tests. Re-check surfaces a stale/fresh drift indicator
// (icon + text, never colour-only); regenerate calls the API and reports the new run.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DriftPanel } from "./DriftPanel";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiStalenessReport,
  QualityIntelligenceUiRegenerateResult,
} from "@oscharko-dev/keiko-contracts";

const SOURCE: QualityIntelligenceInlineSource = {
  kind: "file",
  label: "Fachkonzept.md",
  path: "/abs/Fachkonzept.md",
};

const staleReport = (staleCount: number): QualityIntelligenceUiStalenessReport => ({
  runId: "run-1",
  staleCount,
  fresh: staleCount === 0 ? ["tc-1", "tc-2"] : ["tc-1"],
  changedStale:
    staleCount > 0 ? [{ candidateId: "tc-2", reason: "source-changed", envelopeId: "env-1" }] : [],
  orphanedStale: [],
});

const reCheckOk = (
  report: QualityIntelligenceUiStalenessReport,
): typeof import("@/lib/quality-intelligence-api").reCheckQiRun =>
  vi
    .fn()
    .mockResolvedValue(
      report,
    ) as unknown as typeof import("@/lib/quality-intelligence-api").reCheckQiRun;

const regenOk = (
  result: QualityIntelligenceUiRegenerateResult,
): typeof import("@/lib/quality-intelligence-api").regenerateStaleQiRun =>
  vi
    .fn()
    .mockResolvedValue(
      result,
    ) as unknown as typeof import("@/lib/quality-intelligence-api").regenerateStaleQiRun;

describe("DriftPanel", () => {
  it("re-checks and shows a stale indicator with icon + text when tests drifted", async () => {
    const user = userEvent.setup();
    render(
      <DriftPanel runId="run-1" connectedSource={SOURCE} reCheckImpl={reCheckOk(staleReport(1))} />,
    );
    await user.click(screen.getByTestId("qi-drift-recheck"));
    const stale = await screen.findByTestId("qi-drift-stale");
    // Not colour-only: the visible text carries the meaning.
    expect(stale).toHaveTextContent(/1 test is stale/i);
  });

  it("shows a fresh indicator when nothing drifted", async () => {
    const user = userEvent.setup();
    render(
      <DriftPanel runId="run-1" connectedSource={SOURCE} reCheckImpl={reCheckOk(staleReport(0))} />,
    );
    await user.click(screen.getByTestId("qi-drift-recheck"));
    expect(await screen.findByTestId("qi-drift-fresh")).toHaveTextContent(/no drift/i);
  });

  it("offers a Regenerate action only when there are stale tests", async () => {
    const user = userEvent.setup();
    render(
      <DriftPanel runId="run-1" connectedSource={SOURCE} reCheckImpl={reCheckOk(staleReport(1))} />,
    );
    await user.click(screen.getByTestId("qi-drift-recheck"));
    expect(await screen.findByTestId("qi-drift-regenerate")).toBeInTheDocument();
  });

  it("does not offer Regenerate when there is no drift", async () => {
    const user = userEvent.setup();
    render(
      <DriftPanel runId="run-1" connectedSource={SOURCE} reCheckImpl={reCheckOk(staleReport(0))} />,
    );
    await user.click(screen.getByTestId("qi-drift-recheck"));
    await screen.findByTestId("qi-drift-fresh");
    expect(screen.queryByTestId("qi-drift-regenerate")).not.toBeInTheDocument();
  });

  it("regenerates stale tests and reports the new run", async () => {
    const user = userEvent.setup();
    const regen = regenOk({ runId: "run-2", regeneratedCount: 1, preservedCount: 1 });
    const onRegenerated = vi.fn();
    render(
      <DriftPanel
        runId="run-1"
        connectedSource={SOURCE}
        reCheckImpl={reCheckOk(staleReport(1))}
        regenerateImpl={regen}
        onRegenerated={onRegenerated}
      />,
    );
    await user.click(screen.getByTestId("qi-drift-recheck"));
    await user.click(await screen.findByTestId("qi-drift-regenerate"));
    await waitFor(() => {
      expect(regen).toHaveBeenCalledWith("run-1", [SOURCE]);
    });
    expect(await screen.findByTestId("qi-drift-regenerated")).toHaveTextContent(/regenerated 1/i);
    expect(onRegenerated).toHaveBeenCalledWith({
      runId: "run-2",
      regeneratedCount: 1,
      preservedCount: 1,
    });
  });

  it("surfaces an error when re-check fails", async () => {
    const user = userEvent.setup();
    const failing = vi
      .fn()
      .mockRejectedValue(
        new Error("boom"),
      ) as unknown as typeof import("@/lib/quality-intelligence-api").reCheckQiRun;
    render(<DriftPanel runId="run-1" connectedSource={SOURCE} reCheckImpl={failing} />);
    await user.click(screen.getByTestId("qi-drift-recheck"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
  });
});
