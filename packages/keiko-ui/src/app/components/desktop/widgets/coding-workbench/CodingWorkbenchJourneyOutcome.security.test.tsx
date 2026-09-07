import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_DELIVERY_OBSERVATION_FAILURE_STATES,
  gitDeliveryObservationFailure,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { JourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-outcome";
import { isJourneyOutcome } from "@oscharko-dev/keiko-contracts/runtime/git-journey-validation";
import { CodingWorkbenchJourneyOutcome } from "./CodingWorkbenchJourneyOutcome";
import { journeyFixture } from "./_journeyOutcomeTestSupport";
import { translateCodingWorkbench } from "./coding-workbench-i18n";

describe("handoff identity and negative projections", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-05T00:00:05.000Z"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([
    ["runId", "run-foreign"],
    ["remoteDigest", "b".repeat(64)],
    ["issueBindingDigest", "b".repeat(64)],
    ["issueIdDigest", "b".repeat(64)],
    ["issueNumber", 43],
    ["prNumber", 8],
    ["prExternalId", "PR_foreign"],
    ["headRef", "feature/foreign"],
    ["baseRef", "dev"],
    ["headSha", "f".repeat(40)],
    ["repository", "hostile/foreign"],
    ["repository", "javascript:alert(1)"],
  ])("rejects foreign or unsafe %s", (field, value) => {
    const fixture = journeyFixture();
    fixture.outcome = {
      ...fixture.outcome,
      binding: { ...fixture.outcome.binding, [field]: value },
    };
    render(<CodingWorkbenchJourneyOutcome {...fixture} onProposeReady={vi.fn()} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith("[keiko] journey unavailable: binding-mismatch");
  });
  it.each([null, {}, [], { state: "completed" }, { __proto__: null, state: "completed" }])(
    "rejects malformed outcome %j",
    (outcome) => {
      render(
        <CodingWorkbenchJourneyOutcome {...journeyFixture()} outcome={outcome as JourneyOutcome} />,
      );
      expect(screen.queryByRole("region")).not.toBeInTheDocument();
    },
  );
  it.each(Object.keys(GIT_DELIVERY_OBSERVATION_FAILURE_STATES))(
    "preserves the typed %s provider failure",
    (reason) => {
      const fixture = journeyFixture();
      const failure = gitDeliveryObservationFailure(
        reason as Parameters<typeof gitDeliveryObservationFailure>[0],
      );
      fixture.outcome = {
        ...fixture.outcome,
        state: "blocked",
        reason: "provider-unavailable",
        remote: null,
        observationFailure: failure,
        keikoDescriptionApplied: false,
      };
      expect(isJourneyOutcome(fixture.outcome)).toBe(true);
      render(<CodingWorkbenchJourneyOutcome {...fixture} />);
      expect(
        screen.getByText(
          translateCodingWorkbench("en", `codingWorkbench.ci.reason.${failure.reason}`),
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Issue journey completed")).not.toBeInTheDocument();
    },
  );
  it("rejects forged completion without merge and issue closure", () => {
    const fixture = journeyFixture();
    fixture.outcome = {
      ...fixture.outcome,
      state: "completed",
      reason: "merge-and-closure-observed",
    };
    render(<CodingWorkbenchJourneyOutcome {...fixture} />);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
  it("rejects extra body fields without rendering or logging them", () => {
    const fixture = journeyFixture();
    const outcome = { ...fixture.outcome, body: "private-customer-body" };
    render(<CodingWorkbenchJourneyOutcome {...fixture} outcome={outcome} />);
    expect(document.body).not.toHaveTextContent("private-customer-body");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(
      "private-customer-body",
    );
  });
});
