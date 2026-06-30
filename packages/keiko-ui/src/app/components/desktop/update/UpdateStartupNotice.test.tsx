import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UpdatePreflightReport } from "@/lib/types";
import { UpdateStartupNotice } from "./UpdateStartupNotice";

function report(overrides: Partial<UpdatePreflightReport> = {}): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    currentVersion: "0.2.9",
    targetVersion: "0.2.10",
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: "normal",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: false,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    warnings: [],
    ...overrides,
  };
}

describe("UpdateStartupNotice", () => {
  it("waits for shell readiness before fetching the startup report", async () => {
    const fetchReport = vi.fn(async () => report());
    const { rerender } = render(
      <UpdateStartupNotice ready={false} openUpdates={vi.fn()} fetchReport={fetchReport} />,
    );

    expect(fetchReport).not.toHaveBeenCalled();

    rerender(<UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={fetchReport} />);

    expect(await screen.findByText("Update available")).toBeInTheDocument();
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });

  it("does not render when Keiko is current", async () => {
    const fetchReport = vi.fn(async () =>
      report({
        targetVersion: "0.2.9",
        updateAvailable: false,
        status: "current",
        availabilityState: "current",
        severity: "none",
      }),
    );

    render(<UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={fetchReport} />);

    await waitFor(() => {
      expect(fetchReport).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("supports Not now dismissal for the launched session", async () => {
    render(<UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={vi.fn(async () => report())} />);

    expect(await screen.findByText("Update available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("opens the update window and dismisses itself from the Review action", async () => {
    const openUpdates = vi.fn();
    render(
      <UpdateStartupNotice ready openUpdates={openUpdates} fetchReport={vi.fn(async () => report())} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));

    expect(openUpdates).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("uses alert treatment and visible critical wording for critical updates", async () => {
    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () => report({ severity: "critical" }))}
      />,
    );

    expect(await screen.findByRole("alert", { name: "Keiko update notification" })).toHaveTextContent(
      "Critical update available",
    );
  });
});
