import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type {
  UpdatePreflightReport,
  UpdateRemediationStatusReport,
  UpdateSession,
  UpdateSessionStatus,
} from "@/lib/types";
import { UpdateWindow, type UpdateWindowApi } from "./UpdateWindow";

function preflight(overrides: Partial<UpdatePreflightReport> = {}): UpdatePreflightReport {
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
    patchNotes: {
      collapsed: true,
      summary: "Plain-language patch notes.",
      bullets: ["Improves update readiness.", "Keeps technical logs secondary."],
      details: ["Internal packaging detail."],
    },
    warnings: [],
    ...overrides,
  };
}

function session(overrides: Partial<UpdateSession> = {}): UpdateSession {
  return {
    schemaVersion: "1",
    sessionId: "update-session-1",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.10",
    phase: "running",
    failureReason: "none",
    startedAt: "2026-06-30T12:00:00.000Z",
    updatedAt: "2026-06-30T12:00:01.000Z",
    cancelable: true,
    retryable: false,
    restartRequired: false,
    message: "Installing update.",
    ...overrides,
  };
}

function sessionStatus(overrides: Partial<UpdateSessionStatus> = {}): UpdateSessionStatus {
  return {
    schemaVersion: "1",
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      packageManager: "npm",
      commandPreview: {
        executable: "npm",
        args: ["install", "-g", "@oscharko-dev/keiko@0.2.10"],
        label: "npm install -g @oscharko-dev/keiko@0.2.10",
      },
    },
    policy: { enabled: true, source: "default" },
    ...overrides,
  };
}

function remediation(
  overrides: Partial<UpdateRemediationStatusReport> = {},
): UpdateRemediationStatusReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T12:00:00.000Z",
    targetVersion: "0.2.10",
    overallStatus: "not-required",
    updateCanComplete: true,
    actions: [],
    affectedFeatures: [],
    warnings: [],
    ...overrides,
  };
}

function apiFor(
  args: {
    readonly report?: UpdatePreflightReport;
    readonly status?: UpdateSessionStatus;
    readonly remediation?: UpdateRemediationStatusReport;
  } = {},
): UpdateWindowApi {
  const report = args.report ?? preflight();
  const status = args.status ?? sessionStatus();
  const rem = args.remediation ?? remediation();
  return {
    fetchPreflight: vi.fn(async () => report),
    checkPreflight: vi.fn(async () => report),
    fetchSessionStatus: vi.fn(async () => status),
    startSession: vi.fn(async () => session({ phase: "preparing", message: "Preparing update." })),
    retrySession: vi.fn(async () => session({ phase: "preparing", message: "Retrying update." })),
    cancelSession: vi.fn(async () => session({ phase: "cancelled", message: "Update cancelled." })),
    verifyRestart: vi.fn(async () => session({ phase: "succeeded", message: "Update verified." })),
    fetchRemediationStatus: vi.fn(async () => rem),
    prepareRemediationStatus: vi.fn(async () => rem),
    runRemediationAction: vi.fn(async () => rem),
  };
}

describe("UpdateWindow", () => {
  it("renders a normal available update with collapsed patch notes and details", async () => {
    const api = apiFor();
    const { container } = render(<UpdateWindow api={api} />);

    const heading = await screen.findByRole("heading", { name: "Update available" });
    await waitFor(() => {
      expect(heading).toHaveFocus();
    });
    expect(screen.getByText("Current 0.2.9 -> target 0.2.10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install update" })).toBeEnabled();
    expect(screen.getByText("Patch notes").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("Technical details and logs").closest("details")).not.toHaveAttribute(
      "open",
    );
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole("button", { name: "Install update" }));
    await waitFor(() => {
      expect(api.startSession).toHaveBeenCalledWith({ targetVersion: "0.2.10" });
    });
  });

  it("renders the no-update state as no-action messaging", async () => {
    const api = apiFor({
      report: preflight({
        targetVersion: "0.2.9",
        updateAvailable: false,
        status: "current",
        availabilityState: "current",
        severity: "none",
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Keiko is up to date" })).toBeInTheDocument();
    expect(
      screen.getByText("No update is available. You can check again at any time."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("surfaces load errors and recovers through a manual check", async () => {
    const api = {
      ...apiFor(),
      fetchPreflight: vi.fn(async () => {
        throw new Error("Gateway unavailable");
      }),
    };

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Gateway unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    expect(api.checkPreflight).toHaveBeenCalledTimes(1);
  });

  it("shows pre-install remediation as a notice instead of a runnable action", async () => {
    const api = apiFor({
      report: preflight({
        severity: "critical",
        manualUpdateRequired: true,
        oneClickEligible: false,
        userActionRequired: true,
        impact: {
          entries: [],
          releaseNoteBullets: ["Critical packaging update."],
          affectedStateStores: ["local-knowledge"],
          stateImpact: [
            {
              store: "local-knowledge",
              description: "Local knowledge must be reindexed after this update.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediations: ["local-knowledge-reindex-required"],
        },
      }),
      status: sessionStatus({
        installMode: {
          schemaVersion: "1",
          status: "unsupported",
          packageName: "@oscharko-dev/keiko",
          reason: "local-checkout",
          manualInstructions: "Run the approved package update outside Keiko.",
        },
      }),
      remediation: remediation({
        overallStatus: "pending",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "degraded",
            reason: "Vectors need reindexing.",
            actionIds: ["local-knowledge:reindex"],
          },
        ],
        actions: [
          {
            actionId: "local-knowledge:reindex",
            kind: "local-knowledge-reindex",
            store: "local-knowledge",
            remediation: "local-knowledge-reindex-required",
            status: "pending",
            required: true,
            canRun: true,
            canDefer: true,
            userApprovalRequired: true,
            featureIds: ["local-knowledge"],
            scopeCounts: { stores: 1, artifacts: 2, retainedEntries: 2 },
            message: "Reindex Local Knowledge",
            instructions: "This keeps search results consistent.",
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Critical update available" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Automatic install is unavailable. Follow the approved manual instructions, restart Keiko, then check again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show instructions" })).toBeEnabled();
    expect(screen.getByText("Manual update path")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Keiko cannot safely update itself from this installation. Follow the approved manual instructions, restart Keiko, then verify the version here.",
      ),
    ).toBeInTheDocument();
    const commands = screen.getByText("Manual update instructions").closest("details");
    if (commands === null) throw new Error("Expected manual commands details");
    expect(commands).toBeInTheDocument();
    expect(commands).not.toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "Show instructions" }));
    await waitFor(() => {
      expect(commands).toHaveAttribute("open");
    });
    expect(screen.getByText("Run the approved package update outside Keiko.")).toBeInTheDocument();
    expect(
      screen.queryByText("npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.10"),
    ).toBeNull();
    expect(
      screen.queryByText("yarn global add --ignore-scripts @oscharko-dev/keiko@0.2.10"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy .* command/u })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(api.checkPreflight).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(
        "Manual install is still pending. Follow the approved manual instructions, restart Keiko, then check again.",
      ),
    ).toBeInTheDocument();

    expect(screen.queryByText("Workflow and state impact")).toBeNull();
    expect(screen.getByText("Follow-up after install")).toBeInTheDocument();
    expect(
      screen.getByText("This update will require this after the package is installed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Local Knowledge Reindex")).toBeInTheDocument();
    expect(screen.getByText("Vectors need reindexing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run action" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Defer" })).toBeNull();
  });

  it("shows update installed when manual check verifies the target version is running", async () => {
    const manualStatus = sessionStatus({
      installMode: {
        schemaVersion: "1",
        status: "unsupported",
        packageName: "@oscharko-dev/keiko",
        reason: "local-checkout",
        manualInstructions: "Run the approved package update outside Keiko.",
      },
    });
    const currentReport = preflight({
      currentVersion: "0.2.10",
      targetVersion: "0.2.10",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
      manualUpdateRequired: false,
      oneClickEligible: true,
    });
    const api = {
      ...apiFor({ status: manualStatus }),
      checkPreflight: vi.fn(async () => currentReport),
    };

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    expect(screen.getByText("Manual update path")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("heading", { name: "Update installed" })).toBeInTheDocument();
    expect(screen.getByText("Keiko is now running 0.2.10.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The update is installed. No further action is required unless you want to check for a newer release.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Update installed. Keiko is now running 0.2.10.")).toBeInTheDocument();
    expect(screen.queryByText("Manual update path")).toBeNull();
    expect(screen.queryByText("Keiko is up to date")).toBeNull();
  });

  it("enables remediation after the package update has been installed", async () => {
    const api = apiFor({
      report: preflight({
        userActionRequired: true,
        impact: {
          entries: [],
          releaseNoteBullets: ["Local Knowledge needs a follow-up."],
          affectedStateStores: ["local-knowledge"],
          stateImpact: [
            {
              store: "local-knowledge",
              description: "Local knowledge must be reindexed after this update.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediations: ["local-knowledge-reindex-required"],
        },
      }),
      status: sessionStatus({
        activeSession: session({
          phase: "restart-required",
          restartRequired: true,
          cancelable: false,
          message: "Restart Keiko to complete the update.",
        }),
      }),
      remediation: remediation({
        overallStatus: "pending",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "degraded",
            reason: "Vectors need reindexing.",
            actionIds: ["local-knowledge:reindex"],
          },
        ],
        actions: [
          {
            actionId: "local-knowledge:reindex",
            kind: "local-knowledge-reindex",
            store: "local-knowledge",
            remediation: "local-knowledge-reindex-required",
            status: "pending",
            required: true,
            canRun: true,
            canDefer: true,
            userApprovalRequired: true,
            featureIds: ["local-knowledge"],
            scopeCounts: { stores: 1, artifacts: 2, retainedEntries: 2 },
            message: "Reindex Local Knowledge",
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByText("Follow-up action")).toBeInTheDocument();
    expect(screen.queryByText("Follow-up after install")).toBeNull();
    expect(screen.getByText("Local Knowledge Reindex")).toBeInTheDocument();
    expect(screen.getByText("Vectors need reindexing.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run action" }));
    await waitFor(() => {
      expect(api.runRemediationAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "local-knowledge:reindex",
          decision: "run",
          targetVersion: "0.2.10",
        }),
      );
    });
  });

  it("hides completed remediation after the follow-up action is done", async () => {
    const api = apiFor({
      report: preflight({
        userActionRequired: true,
        impact: {
          entries: [],
          releaseNoteBullets: ["Local Knowledge was refreshed."],
          affectedStateStores: ["local-knowledge"],
          stateImpact: [
            {
              store: "local-knowledge",
              description: "Local Knowledge vectors must be rebuilt after the package update.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediations: ["local-knowledge-reindex-required"],
        },
      }),
      status: sessionStatus({
        lastSession: session({
          phase: "succeeded",
          restartRequired: false,
          cancelable: false,
          retryable: false,
          message: "Update complete.",
        }),
      }),
      remediation: remediation({
        overallStatus: "completed",
        updateCanComplete: true,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "ready",
            reason: "Refresh Local Knowledge vectors before affected grounded workflows are ready.",
            actionIds: ["local-knowledge:reindex"],
          },
        ],
        actions: [
          {
            actionId: "local-knowledge:reindex",
            kind: "local-knowledge-reindex",
            store: "local-knowledge",
            remediation: "local-knowledge-reindex-required",
            status: "completed",
            required: true,
            canRun: true,
            canDefer: true,
            userApprovalRequired: true,
            featureIds: ["local-knowledge"],
            scopeCounts: { stores: 1, artifacts: 0, retainedEntries: 0 },
            message:
              "Refresh Local Knowledge vectors before affected grounded workflows are ready.",
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update installed" })).toBeInTheDocument();
    expect(screen.queryByText("Follow-up action")).toBeNull();
    expect(screen.queryByText("All required follow-up work is complete.")).toBeNull();
    expect(screen.queryByText("Local Knowledge Reindex")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run action" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Defer" })).toBeNull();
    expect(
      screen.queryByText("Choose how to handle this before completing the update."),
    ).toBeNull();
    expect(screen.queryByText("Impact")).toBeNull();
  });

  it("lets deferred remediation be run later without repeating the defer action", async () => {
    const api = apiFor({
      report: preflight({
        userActionRequired: true,
        impact: {
          entries: [],
          releaseNoteBullets: ["Local Knowledge can be refreshed later."],
          affectedStateStores: ["local-knowledge"],
          stateImpact: [
            {
              store: "local-knowledge",
              description: "Local Knowledge vectors must be rebuilt after the package update.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediations: ["local-knowledge-reindex-required"],
        },
      }),
      status: sessionStatus({
        lastSession: session({
          phase: "succeeded",
          restartRequired: false,
          cancelable: false,
          retryable: false,
          message: "Update complete.",
        }),
      }),
      remediation: remediation({
        overallStatus: "completed",
        updateCanComplete: true,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "degraded",
            reason: "Refresh Local Knowledge vectors before affected grounded workflows are ready.",
            actionIds: ["local-knowledge:reindex"],
          },
        ],
        actions: [
          {
            actionId: "local-knowledge:reindex",
            kind: "local-knowledge-reindex",
            store: "local-knowledge",
            remediation: "local-knowledge-reindex-required",
            status: "deferred",
            required: true,
            canRun: true,
            canDefer: true,
            userApprovalRequired: true,
            featureIds: ["local-knowledge"],
            scopeCounts: { stores: 1, artifacts: 0, retainedEntries: 0 },
            message:
              "Refresh Local Knowledge vectors before affected grounded workflows are ready.",
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByText("Deferred follow-up")).toBeInTheDocument();
    expect(
      screen.getByText("Skipped for now. Run it later if you want affected workflows fully ready."),
    ).toBeInTheDocument();
    expect(screen.getByText("Local Knowledge Reindex")).toBeInTheDocument();
    expect(screen.getByText("Deferred")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Defer" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => {
      expect(api.runRemediationAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "local-knowledge:reindex",
          decision: "run",
          targetVersion: "0.2.10",
        }),
      );
    });
  });

  it.each([
    ["preparing", "Preparing update", "Preparing update."],
    ["running", "Installing update", "Installing update."],
    ["restart-required", "Restart required", "Restart Keiko to complete the update."],
    ["failed", "Update failed", "Update command failed."],
    ["succeeded", "Update installed", "Update complete."],
  ] as const)("renders %s session state", async (phase, label, message) => {
    const api = apiFor({
      status: sessionStatus({
        activeSession:
          phase === "preparing" || phase === "running" || phase === "restart-required"
            ? session({
                phase,
                message,
                restartRequired: phase === "restart-required",
                retryable: false,
              })
            : undefined,
        lastSession:
          phase === "failed" || phase === "succeeded"
            ? session({ phase, message, retryable: phase === "failed" })
            : undefined,
      }),
    });

    render(<UpdateWindow api={api} />);

    await waitFor(() => {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    });
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("clarifies restart verification does not restart Keiko", async () => {
    const api = apiFor({
      status: sessionStatus({
        activeSession: session({
          phase: "restart-required",
          restartRequired: true,
          cancelable: false,
          message: "Restart Keiko to complete the update.",
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    const button = await screen.findByRole("button", { name: "Verify restart" });
    const help = screen.getByText(
      "This does not restart Keiko. Use your normal restart command first, then verify here.",
    );
    expect(
      screen.getByText(
        "Restart Keiko outside this window, then verify that the new version is running.",
      ),
    ).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-describedby", help.id);
  });

  it("uses installed-state copy and reports no newer update after a manual check", async () => {
    const installedStatus = sessionStatus({
      lastSession: session({
        phase: "succeeded",
        restartRequired: false,
        cancelable: false,
        retryable: false,
        message: "Update complete.",
      }),
    });
    const currentReport = preflight({
      currentVersion: "0.2.10",
      targetVersion: "0.2.10",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
    });
    const api = {
      ...apiFor({ status: installedStatus }),
      checkPreflight: vi.fn(async () => currentReport),
    };

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update installed" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "The update is installed. No further action is required unless you want to check for a newer release.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Review the state impact, then install when you are ready."),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(api.checkPreflight).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText("Checked just now. No newer update is available."),
    ).toBeInTheDocument();
    const outcomeDetails = screen.getByText("Patch notes").closest("details");
    const installedLabels = screen.getAllByText("Update installed");
    expect(outcomeDetails).toBeInTheDocument();
    expect(screen.getByText("Patch notes")).toHaveClass("upd-secondary-btn");
    expect(outcomeDetails).toContainElement(screen.getByText("Patch notes"));
    expect(installedLabels).toHaveLength(2);
    expect(outcomeDetails).toContainElement(installedLabels[1] as HTMLElement);
    expect(screen.getByText("Plain-language patch notes.")).toBeInTheDocument();
  });

  it("retries a failed terminal update session", async () => {
    const api = apiFor({
      status: sessionStatus({
        lastSession: session({
          phase: "failed",
          retryable: true,
          message: "Update command failed.",
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry update" }));
    await waitFor(() => {
      expect(api.retrySession).toHaveBeenCalledTimes(1);
    });
  });

  it("renders in-flight update progress as indeterminate", async () => {
    const api = apiFor({
      status: sessionStatus({
        activeSession: session({
          phase: "running",
          message: "Installing update.",
          cancelable: true,
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    const progress = await screen.findByRole("progressbar", { name: "Update progress" });
    expect(progress).not.toHaveAttribute("value");
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });

  it("disables restart verification when no report target is available", async () => {
    const { targetVersion: omittedTargetVersion, ...reportWithoutTarget } = preflight();
    expect(omittedTargetVersion).toBe("0.2.10");
    const api = apiFor({
      report: reportWithoutTarget,
      status: sessionStatus({
        activeSession: session({
          phase: "restart-required",
          restartRequired: true,
          cancelable: false,
          message: "Restart Keiko to complete the update.",
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    const button = await screen.findByRole("button", { name: "Verify restart" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.verifyRestart).not.toHaveBeenCalled();
  });
});
