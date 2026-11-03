import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchRuntimeVersion,
  UpdatePreflightReport,
} from "@oscharko-dev/keiko-contracts";
import { ApiError, fetchStartupUpdatePreflight } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { CodingWorkbenchInfoPanel } from "./CodingWorkbenchInfoPanel";
import {
  latestKeikoReleaseOf,
  useCodingWorkbenchVersionFacts,
} from "./useCodingWorkbenchVersionFacts";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchStartupUpdatePreflight: vi.fn(),
}));
vi.mock("@/lib/client-diagnostics", () => ({ reportClientDiagnostic: vi.fn() }));
vi.mock("../../TaskWorkspaceManager", () => ({ TaskWorkspaceManager: (): null => null }));

function report(overrides: Partial<UpdatePreflightReport> = {}): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-10-26T08:00:00.000Z",
    currentVersion: "1.2.7",
    updateAvailable: false,
    status: "current",
    availabilityState: "current",
    severity: "none",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: false,
    affectedStateStores: [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: false,
    warnings: [],
    ...overrides,
  };
}

const current: CodingWorkbenchRuntimeVersion = {
  opencode: "2.1.4",
  pinned: "2.1.4",
  origin: "npm-runtime-package",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchStartupUpdatePreflight).mockResolvedValue(report());
});

// #3904 AC4: the Workbench states what runs and what is newest, and says so when it cannot tell.
describe("Coding Workbench version facts", () => {
  it("names the runtime that runs and where it came from", async () => {
    const { result } = renderHook(() => useCodingWorkbenchVersionFacts(current));
    expect(result.current[0]).toEqual({
      label: "OpenCode runtime",
      value: "2.1.4 · npm runtime package",
    });
    await waitFor(() =>
      expect(result.current[1]).toEqual({
        label: "Latest Keiko release",
        value: "1.2.7 is installed and current",
      }),
    );
  });

  it("warns when the installed runtime is not the one this version expects", () => {
    const { result } = renderHook(() =>
      useCodingWorkbenchVersionFacts({
        opencode: "2.0.10",
        pinned: "2.1.4",
        origin: "dev-checkout",
      }),
    );
    expect(result.current[0]).toEqual({
      label: "OpenCode runtime",
      tone: "warning",
      value: "2.0.10 · development checkout · this Keiko version expects 2.1.4",
    });
  });

  it("does not claim a runtime version the server did not report", () => {
    const { result } = renderHook(() => useCodingWorkbenchVersionFacts(undefined));
    expect(result.current[0]).toEqual({
      label: "OpenCode runtime",
      value: "Not reported by runtime",
    });
  });

  it("names an available release and where to install it", async () => {
    vi.mocked(fetchStartupUpdatePreflight).mockResolvedValue(
      report({ updateAvailable: true, targetVersion: "1.2.8", status: "update-available" }),
    );
    const { result } = renderHook(() => useCodingWorkbenchVersionFacts(current));
    expect(result.current[1]?.value).toBe("Checking…");
    await waitFor(() =>
      expect(result.current[1]).toEqual({
        label: "Latest Keiko release",
        tone: "warning",
        value: "1.2.8 is available. Install it from Updates; it brings its own OpenCode runtime.",
      }),
    );
  });

  it.each([
    ["an unreachable registry", report({ status: "degraded", registryStatus: "unavailable" })],
    ["an update without a target", report({ updateAvailable: true, status: "update-available" })],
  ])("says the newest release is unknown after %s", (_name, value) => {
    expect(latestKeikoReleaseOf(value)).toEqual({ kind: "unknown" });
  });

  it("reports a failed read and says the newest release is unknown", async () => {
    const failure = new ApiError("INTERNAL", "failed", 500);
    failure.correlationId = "release-correlation";
    vi.mocked(fetchStartupUpdatePreflight).mockRejectedValue(failure);
    const { result } = renderHook(() => useCodingWorkbenchVersionFacts(current));
    await waitFor(() =>
      expect(result.current[1]?.value).toBe(
        "Unknown: the update check could not reach the release source",
      ),
    );
    expect(reportClientDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("coding workbench release facts failed"),
      { correlationId: "release-correlation" },
    );
  });

  it("reads the release only when the information opens", async () => {
    render(<CodingWorkbenchInfoPanel facts={[]} runtimeVersion={current} />);
    expect(fetchStartupUpdatePreflight).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open Coding Workbench information" }));
    expect(await screen.findByText("2.1.4 · npm runtime package")).toBeInTheDocument();
    expect(await screen.findByText("1.2.7 is installed and current")).toBeInTheDocument();
    expect(fetchStartupUpdatePreflight).toHaveBeenCalledOnce();
  });
});
