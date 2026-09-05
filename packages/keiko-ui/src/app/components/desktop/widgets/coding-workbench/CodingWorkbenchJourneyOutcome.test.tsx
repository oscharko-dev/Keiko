import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import { CodingWorkbenchJourneyOutcome } from "./CodingWorkbenchJourneyOutcome";
import { completedJourneyFixture, journeyFixture } from "./_journeyOutcomeTestSupport";

import { axe } from "jest-axe";
import {
  GIT_JOURNEY_REASON_STATES,
  type GitJourneyReason,
} from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

const NOW = new Date("2026-09-05T00:00:05.000Z");
describe("observed issue journey handoff", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("shows exact bound links, revision and separate description, CI and human requirements", () => {
    const fixture = journeyFixture();
    expect(isJourneyOutcome(fixture.outcome)).toBe(true);
    render(<CodingWorkbenchJourneyOutcome {...fixture} />);
    expect(screen.getByRole("region", { name: "Issue handoff" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Issue #42" })).toHaveAttribute(
      "href",
      "https://github.com/owner/repository/issues/42",
    );
    expect(screen.getByRole("link", { name: "Pull request #7" })).toHaveAttribute(
      "href",
      "https://github.com/owner/repository/pull/7",
    );
    expect(screen.getByText("3333333333333333333333333333333333333333")).toBeInTheDocument();
    expect(screen.getByText("Description applied to the observed PR")).toBeInTheDocument();
    expect(screen.getByText("Technical checks ready")).toBeInTheDocument();
    expect(screen.getByText("Human review required")).toBeInTheDocument();
    expect(screen.queryByText("Issue journey completed")).not.toBeInTheDocument();
  });
  it("renders ready-for-review as a closed, non-clickable approval-path-pending control by default (#3389 AC3)", async () => {
    const onProposeReady = vi.fn();
    render(<CodingWorkbenchJourneyOutcome {...journeyFixture()} onProposeReady={onProposeReady} />);
    const button = screen.getByRole("button", { name: "Review ready-for-review request" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText("The ready-for-review approval path is not available yet."),
    ).toBeInTheDocument();
    fireEvent.click(button);
    await act(async () => {});
    expect(onProposeReady).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /merge|close issue/i })).not.toBeInTheDocument();
  });
  it("proposes a one-use approval without performing the ready transition once the mark-ready path is available", async () => {
    const onProposeReady = vi.fn();
    render(
      <CodingWorkbenchJourneyOutcome
        {...journeyFixture()}
        onProposeReady={onProposeReady}
        markReadyAvailable
      />,
    );
    const button = screen.getByRole("button", { name: "Review ready-for-review request" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await act(async () => {});
    expect(onProposeReady).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /merge|close issue/i })).not.toBeInTheDocument();
  });
  it("replaces expired readiness with observed history and offers an explicit refresh", () => {
    const fixture = journeyFixture();
    vi.mocked(Date.now).mockReturnValue(new Date("2026-09-05T00:02:00.000Z").getTime());
    render(
      <CodingWorkbenchJourneyOutcome {...fixture} onRefresh={vi.fn()} onProposeReady={vi.fn()} />,
    );
    expect(screen.getByText("Handoff observation is stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh observed status" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Review ready-for-review request" }),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "distinguishes observed merge from actual issue closure (%s)",
    (closed) => {
      const fixture = completedJourneyFixture(closed);
      expect(isJourneyOutcome(fixture.outcome)).toBe(true);
      render(<CodingWorkbenchJourneyOutcome {...fixture} onProposeReady={vi.fn()} />);
      expect(
        screen.getByText(closed ? "Issue journey completed" : "Merged; issue closure pending"),
      ).toBeInTheDocument();
      expect(screen.getByText(closed ? "Issue closed" : "Issue open")).toBeInTheDocument();
      expect(screen.getByText("Description confirmation is stale")).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );
  it("does not call a dated completed observation current, while keeping observed closure visible", () => {
    vi.mocked(Date.now).mockReturnValue(NOW.getTime() + 90_000);
    render(<CodingWorkbenchJourneyOutcome {...completedJourneyFixture(true)} />);
    expect(screen.getByText("Handoff observation is stale")).toBeInTheDocument();
    expect(screen.getByText("Issue closed")).toBeInTheDocument();
    expect(screen.queryByText("Issue journey completed")).not.toBeInTheDocument();
  });
  it.each(
    Object.entries(GIT_JOURNEY_REASON_STATES).filter(
      ([, state]) => !["completed", "merged-awaiting-issue-closure"].includes(state),
    ),
  )("renders the closed %s reason", (reason, state) => {
    const fixture = journeyFixture();
    fixture.outcome = { ...fixture.outcome, reason: reason as GitJourneyReason, state };
    expect(isJourneyOutcome(fixture.outcome)).toBe(true);
    render(<CodingWorkbenchJourneyOutcome {...fixture} />);
    expect(
      screen.getByText(
        translateCodingWorkbench(
          "en",
          `codingWorkbench.journey.reason.${reason as GitJourneyReason}`,
        ),
      ),
    ).toBeInTheDocument();
  });
  it.each(["partial", "fallback"] as const)(
    "permits a visibly limited applied %s description",
    (state) => {
      const fixture = journeyFixture();
      const description = fixture.outcome.description;
      if (description === null) throw new Error("Expected description");
      fixture.outcome = {
        ...fixture.outcome,
        description: {
          ...description,
          state,
          reason: state === "partial" ? "partial-applied" : "fallback-applied",
          completeness: state,
        },
      };
      expect(isJourneyOutcome(fixture.outcome)).toBe(true);
      render(
        <CodingWorkbenchJourneyOutcome {...fixture} onProposeReady={vi.fn()} markReadyAvailable />,
      );
      expect(
        screen.getByText(
          translateCodingWorkbench("en", `codingWorkbench.journey.completeness.${state}`),
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Review ready-for-review request" })).toBeEnabled();
    },
  );
  it.each([
    "succeeded",
    "cancelled",
    "failed",
    "recovery-required",
    "taken-over",
    "stopping",
  ] as const)("does not restore mutation authority from %s runtime", (state) => {
    const fixture = journeyFixture();
    render(
      <CodingWorkbenchJourneyOutcome
        {...fixture}
        snapshot={{ ...fixture.snapshot, state }}
        onProposeReady={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Review ready-for-review request" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh observed status" })).toBeEnabled();
  });
  it("serializes double clicks and disables both actions until the request settles", async () => {
    let settle: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    if (settle === undefined) throw new Error("Expected fixture resolver");
    const pending = { promise, resolve: settle };
    const callback = vi.fn(() => pending.promise);
    render(
      <CodingWorkbenchJourneyOutcome
        {...journeyFixture()}
        onRefresh={callback}
        onProposeReady={vi.fn()}
      />,
    );
    const refresh = screen.getByRole("button", { name: "Refresh observed status" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(refresh).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review ready-for-review request" })).toBeDisabled();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(refresh).toBeEnabled();
  });
  it.each(["refresh", "propose-ready"] as const)(
    "shows a body-free %s failure and allows explicit retry",
    async (action) => {
      const callback = vi.fn().mockRejectedValue(new Error("private/customer-content token-value"));
      render(
        <CodingWorkbenchJourneyOutcome
          {...journeyFixture()}
          onRefresh={callback}
          onProposeReady={callback}
          markReadyAvailable
        />,
      );
      fireEvent.click(
        screen.getByRole("button", {
          name:
            action === "refresh" ? "Refresh observed status" : "Review ready-for-review request",
        }),
      );
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
      expect(document.body).not.toHaveTextContent("customer-content");
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(
        /customer-content|token-value/,
      );
      expect(console.warn).toHaveBeenCalledWith(`[keiko] journey action: ${action} failed`);
    },
  );

  it.each([
    ["blocked", "policy-blocked"],
    ["failed", "provider-failed"],
    ["stale", "stale-pr"],
  ] as const)("discloses the %s description without offering readiness", (state, reason) => {
    const fixture = journeyFixture();
    const description = fixture.outcome.description;
    if (description === null) throw new Error("Expected description");
    fixture.outcome = {
      ...fixture.outcome,
      state: "blocked",
      reason: "description-not-applied",
      keikoDescriptionApplied: false,
      description: { ...description, state, reason, effect: "none" },
    };
    expect(isJourneyOutcome(fixture.outcome)).toBe(true);
    render(<CodingWorkbenchJourneyOutcome {...fixture} onProposeReady={vi.fn()} />);
    expect(
      screen.getByText(
        translateCodingWorkbench("en", `codingWorkbench.journey.description.${state}`),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("keeps unavailable description and CI facts explicit", () => {
    const fixture = journeyFixture();
    fixture.outcome = {
      ...fixture.outcome,
      state: "blocked",
      reason: "description-unavailable",
      description: null,
      readiness: null,
      keikoDescriptionApplied: false,
    };
    expect(isJourneyOutcome(fixture.outcome)).toBe(true);
    render(<CodingWorkbenchJourneyOutcome {...fixture} />);
    expect(screen.getByText("Description status unavailable")).toBeInTheDocument();
    expect(screen.getByText("No CI observation yet")).toBeInTheDocument();
  });
  it("disables supplied actions while the parent is performing an operation", () => {
    render(
      <CodingWorkbenchJourneyOutcome
        {...journeyFixture()}
        busy
        onRefresh={vi.fn()}
        onProposeReady={vi.fn()}
      />,
    );
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(screen.getByText("Updating handoff status…")).toBeInTheDocument();
  });
  it("supports keyboard-visible status controls and has no serious accessibility violations", async () => {
    render(
      <CodingWorkbenchJourneyOutcome
        {...journeyFixture()}
        onRefresh={vi.fn()}
        onProposeReady={vi.fn()}
      />,
    );
    screen.getByRole("button", { name: "Refresh observed status" }).focus();
    expect(screen.getByRole("button", { name: "Refresh observed status" })).toHaveFocus();
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
