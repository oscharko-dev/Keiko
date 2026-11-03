import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "@/lib/client-diagnostics";
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
  beforeEach(() => {
    window.localStorage.clear();
    resetClientDiagnosticWriter();
  });

  it("reports a bounded startup diagnostic without exposing the fetch error", async () => {
    const diagnostics: string[] = [];
    const privateError = "request failed for https://private.example/token";
    setClientDiagnosticWriter((message) => diagnostics.push(message));

    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () => Promise.reject(new Error(privateError)))}
      />,
    );

    await waitFor(() => {
      expect(diagnostics).toEqual(["update-startup-notice: preflight-fetch-failed"]);
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(diagnostics.join("\n")).not.toContain(privateError);
  });

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

  it("does not render a startup banner for a degraded checker result without an available update", async () => {
    const fetchReport = vi.fn(async () =>
      report({
        updateAvailable: false,
        status: "degraded",
        availabilityState: "degraded",
        severity: "low",
        registryStatus: "unavailable",
        releaseMetadataStatus: "unavailable",
        warnings: ["The update registry could not be reached."],
      }),
    );

    render(<UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={fetchReport} />);

    await waitFor(() => {
      expect(fetchReport).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("supports Not now dismissal for the launched session", async () => {
    render(
      <UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={vi.fn(async () => report())} />,
    );

    expect(await screen.findByText("Update available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("keeps a dismissed startup notice hidden across browser reloads for the same startup report", async () => {
    const startupReport = report();
    const firstFetch = vi.fn(async () => startupReport);
    const secondFetch = vi.fn(async () => startupReport);
    const first = render(
      <UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={firstFetch} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    first.unmount();

    render(<UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={secondFetch} />);

    await waitFor(() => {
      expect(secondFetch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("keeps a dismissed startup notice hidden when only the startup check timestamp changes", async () => {
    const firstFetch = vi.fn(async () => report());
    const secondFetch = vi.fn(async () => report({ checkedAt: "2026-06-30T12:05:00.000Z" }));
    const first = render(
      <UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={firstFetch} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    first.unmount();

    render(<UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={secondFetch} />);

    await waitFor(() => {
      expect(secondFetch).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("shows again when the target version changes", async () => {
    const first = render(
      <UpdateStartupNotice ready openUpdates={vi.fn()} fetchReport={vi.fn(async () => report())} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));
    first.unmount();

    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () => report({ targetVersion: "0.2.11" }))}
      />,
    );

    expect(await screen.findByText("Update available")).toBeInTheDocument();
  });

  it("opens the update window and dismisses itself from the Review action", async () => {
    const openUpdates = vi.fn();
    render(
      <UpdateStartupNotice
        ready
        openUpdates={openUpdates}
        fetchReport={vi.fn(async () => report())}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review update" }));

    expect(openUpdates).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("uses portable update wording for eligible release assets", async () => {
    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () =>
          report({
            installabilitySource: "github-release-asset",
            portableAsset: {
              source: "github-release-asset",
              target: "macos-x64",
              requiredAssetName: "keiko-macos-x64.zip",
              status: "eligible",
            },
          }),
        )}
      />,
    );

    expect(await screen.findByText("Update available")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Version 0.2.10 is ready. Open updates, then click Update when you are ready.",
      ),
    ).toBeInTheDocument();
  });

  it("uses setup-required wording for unmanaged portable bootstrap installs", async () => {
    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () =>
          report({
            updateAvailable: false,
            status: "degraded",
            availabilityState: "degraded",
            manualUpdateRequired: true,
            oneClickEligible: false,
            portableAsset: {
              source: "github-release-asset",
              target: "macos-arm64",
              requiredAssetName: "keiko-macos-arm64.zip",
              status: "install-mode-ineligible",
            },
            blockers: [
              {
                code: "portable-install-mode-ineligible",
                severity: "normal",
                message:
                  "Run the portable setup flow from the Keiko launcher before using in-app updates.",
                userActionRequired: true,
              },
            ],
          }),
        )}
      />,
    );

    expect(await screen.findByText("Portable setup required")).toBeInTheDocument();
    expect(screen.queryByText("Update available")).toBeNull();
    expect(screen.getByRole("button", { name: "Review details" })).toBeInTheDocument();
    expect(
      screen.getByText("Portable setup is required before Keiko can use in-app updates."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Version unknown/u)).toBeNull();
  });

  it("uses externally-managed wording for organization-managed portable installs", async () => {
    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () =>
          report({
            updateAvailable: false,
            status: "degraded",
            availabilityState: "degraded",
            manualUpdateRequired: true,
            oneClickEligible: false,
            portableAsset: {
              source: "github-release-asset",
              target: "macos-arm64",
              requiredAssetName: "keiko-macos-arm64.zip",
              status: "install-mode-ineligible",
            },
            blockers: [
              {
                code: "portable-install-managed-externally",
                severity: "normal",
                message:
                  "This Keiko install is managed outside the app and is not eligible for self-update.",
                userActionRequired: true,
              },
            ],
          }),
        )}
      />,
    );

    expect(await screen.findByText("Updates managed by your organization")).toBeInTheDocument();
    expect(screen.queryByText("Update available")).toBeNull();
    expect(screen.getByRole("button", { name: "Review details" })).toBeInTheDocument();
    expect(
      screen.getByText("This Keiko install is managed outside the app. Open updates for details."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Portable setup is required before Keiko can use in-app updates."),
    ).toBeNull();
    expect(screen.queryByText(/Version unknown/u)).toBeNull();
  });

  it("uses release-unavailable wording for portable metadata network failures", async () => {
    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () =>
          report({
            updateAvailable: false,
            status: "degraded",
            availabilityState: "degraded",
            releaseMetadataStatus: "unavailable",
            registryStatus: "not-used",
            manualUpdateRequired: true,
            oneClickEligible: false,
            portableAsset: {
              source: "github-release-asset",
              target: "macos-arm64",
              requiredAssetName: "keiko-macos-arm64.zip",
              status: "unavailable",
            },
            blockers: [
              {
                code: "portable-release-unavailable",
                severity: "normal",
                message: "GitHub release asset metadata is unavailable for portable updates.",
                userActionRequired: true,
              },
            ],
          }),
        )}
      />,
    );

    expect(await screen.findByText("Update check unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Keiko could not verify update download information right now. It will not install anything.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Update available")).toBeNull();
    expect(screen.queryByText(/Version unknown/u)).toBeNull();
  });

  it("uses alert treatment and visible critical wording for critical updates", async () => {
    render(
      <UpdateStartupNotice
        ready
        openUpdates={vi.fn()}
        fetchReport={vi.fn(async () => report({ severity: "critical" }))}
      />,
    );

    expect(
      await screen.findByRole("alert", { name: "Keiko update notification" }),
    ).toHaveTextContent("Critical update available");
  });
  it.each(["normal", "critical"] as const)(
    "does not claim an available update for an action-only %s result",
    async (severity) => {
      const diagnostics = vi.fn();
      setClientDiagnosticWriter(diagnostics);
      render(
        <UpdateStartupNotice
          ready
          openUpdates={vi.fn()}
          fetchReport={vi.fn(async () =>
            report({
              currentVersion: "1.2.4",
              targetVersion: "1.2.4",
              updateAvailable: false,
              userActionRequired: true,
              severity,
              status: "current",
              availabilityState: "current",
              warnings: ["private customer content must never enter presentation evidence"],
            }),
          )}
        />,
      );
      expect(await screen.findByText("Update settings need attention")).toBeInTheDocument();
      expect(screen.queryByText(/(?:Critical update available|Update available)/u)).toBeNull();
      expect(screen.getByRole("button", { name: "Review details" })).toBeInTheDocument();
      expect(diagnostics).toHaveBeenCalledWith("Keiko startup update notice classified.", {
        correlationId: expect.any(String),
        updateNotice: {
          blockerCount: 0,
          noticeKind: "action-required",
          presentation: "shown",
          updateAvailable: false,
        },
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private customer content");
    },
  );
  it.each([
    { button: "Not now", available: true, noticeKind: "update-available" },
    { button: "Review update", available: true, noticeKind: "update-available" },
    { button: "Review details", available: false, noticeKind: "action-required" },
  ] as const)(
    "records immediate body-free dismissal from $button",
    async ({ button, available, noticeKind }) => {
      const diagnostics = vi.fn<Parameters<typeof setClientDiagnosticWriter>[0]>();
      setClientDiagnosticWriter(diagnostics);
      render(
        <UpdateStartupNotice
          ready
          openUpdates={vi.fn()}
          fetchReport={async () =>
            report({
              updateAvailable: available,
              userActionRequired: true,
              warnings: ["private dismissal canary"],
            })
          }
        />,
      );
      fireEvent.click(await screen.findByRole("button", { name: button }));
      const presentations = diagnostics.mock.calls.flatMap(([, meta]) =>
        meta?.updateNotice === undefined ? [] : [meta.updateNotice],
      );
      expect(presentations.map((event) => event.presentation)).toEqual(["shown", "dismissed"]);
      expect(presentations.at(-1)).toMatchObject({
        noticeKind,
        updateAvailable: available,
        blockerCount: 0,
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private dismissal canary");
    },
  );
});
