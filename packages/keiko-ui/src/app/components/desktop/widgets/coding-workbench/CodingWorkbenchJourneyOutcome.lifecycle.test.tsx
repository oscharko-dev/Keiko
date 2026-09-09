import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodingWorkbenchJourneyOutcome } from "./CodingWorkbenchJourneyOutcome";
import { journeyFixture } from "./_journeyOutcomeTestSupport";

const NOW = Date.parse("2026-09-05T00:00:05.000Z");
describe("independent handoff freshness and action boundaries", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each(["description", "readiness"] as const)(
    "expires %s before the overall outcome and removes the ready claim",
    (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const fixture = journeyFixture();
      const evidence = fixture.outcome[kind];
      if (evidence === null) throw new Error("Expected fixture evidence");
      fixture.outcome = {
        ...fixture.outcome,
        [kind]: { ...evidence, expiresAt: "2026-09-05T00:00:10.000Z" },
      };
      render(
        <CodingWorkbenchJourneyOutcome {...fixture} onProposeReady={vi.fn()} markReadyAvailable />,
      );
      expect(screen.getByRole("button", { name: "Review ready-for-review request" })).toBeEnabled();
      act(() => {
        vi.advanceTimersByTime(5_001);
      });
      expect(screen.getByText("Handoff observation is stale")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Review ready-for-review request" }),
      ).not.toBeInTheDocument();
    },
  );
  it("checks wall-clock freshness again on any render before an expired timer can execute", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const fixture = journeyFixture();
    const { rerender } = render(<CodingWorkbenchJourneyOutcome {...fixture} />);
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    rerender(<CodingWorkbenchJourneyOutcome {...fixture} busy />);
    expect(screen.getByText("Handoff observation is stale")).toBeInTheDocument();
  });
  it("checks freshness at click time even when the browser timer has not rendered yet", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const callback = vi.fn();
    render(
      <CodingWorkbenchJourneyOutcome
        {...journeyFixture()}
        onProposeReady={callback}
        markReadyAvailable
      />,
    );
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    fireEvent.click(screen.getByRole("button", { name: "Review ready-for-review request" }));
    expect(callback).not.toHaveBeenCalled();
  });
  it.each(["visibilitychange", "pageshow"])(
    "revalidates after %s and cleans up listeners",
    (event) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const { unmount } = render(<CodingWorkbenchJourneyOutcome {...journeyFixture()} />);
      vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
      act(() => {
        (event === "pageshow" ? globalThis : document).dispatchEvent(new Event(event));
      });
      expect(screen.getByText("Handoff observation is stale")).toBeInTheDocument();
      const remove = vi.spyOn(event === "pageshow" ? globalThis : document, "removeEventListener");
      unmount();
      expect(remove).toHaveBeenCalledWith(event, expect.any(Function));
    },
  );
});
