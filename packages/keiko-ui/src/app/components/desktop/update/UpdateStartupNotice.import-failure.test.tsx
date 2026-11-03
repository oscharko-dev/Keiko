import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppShellBoundary } from "../AppShellBoundary";
import { UpdateStartupNotice } from "./UpdateStartupNotice";
import { setClientDiagnosticWriter, resetClientDiagnosticWriter } from "@/lib/client-diagnostics";
import type { UpdatePreflightReport } from "@/lib/types";
vi.mock("next/dynamic", async () => {
  const actual = await vi.importActual<typeof import("next/dynamic")>(
    "next/dist/shared/lib/app-dynamic.js",
  );
  return { default: actual.default };
});
const state = vi.hoisted(() => ({ attempted: vi.fn() }));
vi.mock("./UpdateStartupNoticeContent", () => {
  state.attempted();
  throw new Error("Synthetic notice module unavailable");
});
afterEach(() => {
  vi.restoreAllMocks();
  resetClientDiagnosticWriter();
});
function report(available: boolean): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-10-18T00:00:00.000Z",
    currentVersion: "1.2.4",
    targetVersion: available ? "1.2.5" : "1.2.4",
    updateAvailable: available,
    status: available ? "update-available" : "current",
    availabilityState: available ? "update-available" : "current",
    severity: available ? "normal" : "none",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: false,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    warnings: [],
  };
}
it("optional notice module failure preserves the working desktop", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const diagnostic = vi.fn<Parameters<typeof setClientDiagnosticWriter>[0]>();
  setClientDiagnosticWriter(diagnostic);
  const openUpdates = vi.fn();
  const onError = (event: ErrorEvent): void => {
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  try {
    render(
      <AppShellBoundary>
        <p>Independent workspace remains usable</p>
        <UpdateStartupNotice
          ready
          openUpdates={openUpdates}
          fetchReport={async () => report(true)}
        />
      </AppShellBoundary>,
    );
    await waitFor(() => expect(state.attempted).toHaveBeenCalled());
    await waitFor(() =>
      expect(diagnostic.mock.calls.some(([, meta]) => meta?.errorEvidence !== undefined)).toBe(
        true,
      ),
    );
    expect(screen.getByText("Independent workspace remains usable")).toBeInTheDocument();
    expect(document.querySelector("[data-app-shell-crashed]")).toBeNull();
    const loadFailure = diagnostic.mock.calls.find(([, meta]) => meta?.errorEvidence !== undefined);
    expect(loadFailure?.[0]).toBe("update-startup-notice: presentation-load-failed");
    expect(loadFailure?.[1]).toMatchObject({ kind: "other", errorKind: "unavailable" });
    fireEvent.click(await screen.findByRole("button", { name: "Updates" }));
    expect(openUpdates).toHaveBeenCalledOnce();
    const presentations = diagnostic.mock.calls.flatMap(([, meta]) =>
      meta?.updateNotice === undefined ? [] : [meta.updateNotice],
    );
    expect(presentations.map((event) => event.presentation)).toEqual(["shown", "dismissed"]);

    expect(screen.getByText("Independent workspace remains usable")).toBeInTheDocument();
  } finally {
    window.removeEventListener("error", onError);
  }
});
it("suppressed current notice never requests the optional view module", async () => {
  const fetchReport = vi.fn(async () => report(false));
  render(
    <AppShellBoundary>
      <p>Independent workspace remains usable</p>
      <UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={fetchReport} />
    </AppShellBoundary>,
  );
  await waitFor(() => expect(fetchReport).toHaveResolved());
  await act(async () => {
    await Promise.resolve();
  });
  expect(state.attempted).not.toHaveBeenCalled();
  expect(screen.getByText("Independent workspace remains usable")).toBeInTheDocument();
});
