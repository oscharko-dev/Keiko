import { act, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_CI_READINESS_REASON_STATES,
  type GitCiReadinessReason,
} from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { translateCodingWorkbench } from "./coding-workbench-i18n";
import { CodingWorkbenchCiReadiness } from "./CodingWorkbenchCiReadiness";
import { ciReadinessSnapshot, CI_OBSERVED_AT } from "./_ciReadinessTestSupport";

const NOW = new Date("2026-09-05T00:00:05.000Z");
describe("exact-head Workbench CI observation", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("separates technical success, advisory failures, draft and outstanding human review", async () => {
    render(<CodingWorkbenchCiReadiness snapshot={ciReadinessSnapshot()} />);
    const region = screen.getByRole("region", { name: "CI readiness" });
    expect(within(region).getByText("Technical checks ready")).toBeInTheDocument();
    expect(within(region).getByRole("region", { name: "Required checks" })).toHaveTextContent("2");
    expect(within(region).getByRole("region", { name: "Advisory checks" })).toHaveTextContent(
      "Failed1",
    );
    expect(within(region).getByText("Draft pull request")).toBeInTheDocument();
    expect(
      within(region).getByText("0 approved · 1 required · 1 changes requested"),
    ).toBeInTheDocument();
    expect(within(region).getByText("3".repeat(40))).toBeInTheDocument();
    expect(region.querySelector(`time[datetime="${CI_OBSERVED_AT}"]`)).not.toBeNull();
    expect(within(region).queryByRole("button")).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalledWith(
      "[keiko] CI readiness displayed: technical-ready head 333333333333",
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });
  it("expires locally without a provider call or additional snapshot", () => {
    vi.mocked(Date.now).mockRestore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<CodingWorkbenchCiReadiness snapshot={ciReadinessSnapshot()} />);
    act(() => {
      vi.advanceTimersByTime(55_001);
    });
    expect(screen.getByText("CI observation is stale")).toBeInTheDocument();
    expect(screen.queryByText("Technical checks ready")).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenLastCalledWith(
      "[keiko] CI readiness displayed: stale head 333333333333",
    );
  });
  it.each([
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "taken-over",
    "recovery-required",
  ] as const)("never shows current technical success after %s", (state) => {
    render(<CodingWorkbenchCiReadiness snapshot={{ ...ciReadinessSnapshot(), state }} />);
    expect(screen.getByText("CI observation is stale")).toBeInTheDocument();
    expect(screen.queryByText("Technical checks ready")).not.toBeInTheDocument();
  });
  it.each(Object.entries(GIT_CI_READINESS_REASON_STATES))(
    "renders closed reason %s separately from review",
    (reason, state) => {
      const snapshot = ciReadinessSnapshot({ reason: reason as GitCiReadinessReason, state });
      render(<CodingWorkbenchCiReadiness snapshot={snapshot} />);
      expect(
        screen.getByText(translateCodingWorkbench("en", `codingWorkbench.ci.state.${state}`)),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          translateCodingWorkbench(
            "en",
            `codingWorkbench.ci.reason.${reason as GitCiReadinessReason}`,
          ),
        ),
      ).toBeInTheDocument();
      expect(
        translateCodingWorkbench(
          "de",
          `codingWorkbench.ci.reason.${reason as GitCiReadinessReason}`,
        ),
      ).not.toContain("codingWorkbench.");
    },
  );
  it("updates stale state when a suspended page becomes visible", () => {
    render(<CodingWorkbenchCiReadiness snapshot={ciReadinessSnapshot()} />);
    vi.mocked(Date.now).mockReturnValue(NOW.getTime() + 60_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText("CI observation is stale")).toBeInTheDocument();
  });
  it("refreshes its clock for a newly observed revision and removes stale data on run switch", async () => {
    const { rerender } = render(<CodingWorkbenchCiReadiness snapshot={ciReadinessSnapshot()} />);
    vi.mocked(Date.now).mockReturnValue(NOW.getTime() + 120_000);
    rerender(
      <CodingWorkbenchCiReadiness
        snapshot={ciReadinessSnapshot({
          observedAt: "2026-09-05T00:02:00.000Z",
          expiresAt: "2026-09-05T00:03:00.000Z",
        })}
      />,
    );
    expect(await screen.findByText("Technical checks ready")).toBeInTheDocument();
    rerender(
      <CodingWorkbenchCiReadiness snapshot={{ ...ciReadinessSnapshot(), runId: "run-2" }} />,
    );
    expect(screen.queryByRole("region", { name: "CI readiness" })).not.toBeInTheDocument();
  });
  it("retains unknown review visibility instead of inferring zero required approvals", () => {
    render(
      <CodingWorkbenchCiReadiness
        snapshot={ciReadinessSnapshot({
          humanReview: {
            visibility: "unknown",
            requiredCount: null,
            approvedCount: null,
            changesRequestedCount: null,
          },
        })}
      />,
    );
    expect(screen.getByText("Review visibility is unknown")).toBeInTheDocument();
    expect(screen.queryByText(/0 approved/)).not.toBeInTheDocument();
  });
  it("shows an honest empty observation without manufacturing checks", () => {
    const snapshot = ciReadinessSnapshot();
    Reflect.deleteProperty(snapshot, "ciReadiness");
    render(<CodingWorkbenchCiReadiness snapshot={snapshot} />);
    expect(screen.getByText("No CI observation yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Required checks" })).not.toBeInTheDocument();
  });
  it.each([
    { runId: "foreign-run" },
    { prNumber: 9 },
    { headSha: "4".repeat(40) },
    { remoteDigest: "d".repeat(64) },
    { repository: "owner/foreign" },
    { rawLog: "private-customer-token" },
    { state: "merged" },
  ])("rejects malformed or foreign observation %j without display or logging", (patch) => {
    const snapshot = ciReadinessSnapshot();
    Object.assign(snapshot.ciReadiness ?? {}, patch);
    const { container } = render(<CodingWorkbenchCiReadiness snapshot={snapshot} />);
    expect(container).toBeEmptyDOMElement();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
