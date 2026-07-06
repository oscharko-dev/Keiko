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
    restartCommandPreview: {
      executable: "keiko",
      args: [
        "restart",
        "--port",
        "1990",
        "--host",
        "127.0.0.1",
        "--state-dir",
        "/tmp/keiko update state",
      ],
      label: "keiko restart --port 1990 --host 127.0.0.1 --state-dir '/tmp/keiko update state'",
    },
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

function portableManagedStatus(overrides: Partial<UpdateSessionStatus> = {}): UpdateSessionStatus {
  return sessionStatus({
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      installKind: "portable-managed",
      installRoot: "/Users/private/Keiko",
      recommendedAction: "portable-managed-update",
      portable: {
        status: "managed",
        target: "macos-arm64",
        updateEligible: true,
        packageVersion: "0.2.9",
        stable: true,
        managedRootKind: "home-relative",
      },
      asset: {
        target: "macos-arm64",
        fileName: "keiko-macos-arm64.zip",
        packageVersion: "0.2.10",
        verificationStatus: "verified",
      },
    },
    ...overrides,
  });
}

function portableReleaseReport(
  overrides: Partial<UpdatePreflightReport> = {},
): UpdatePreflightReport {
  return preflight({
    installabilitySource: "github-release-asset",
    portableAsset: {
      source: "github-release-asset",
      target: "macos-arm64",
      requiredAssetName: "keiko-macos-arm64.zip",
      status: "eligible",
      asset: {
        target: "macos-arm64",
        assetName: "keiko-macos-arm64.zip",
        assetId: 120,
        releaseId: 12,
        sizeBytes: 48_000_000,
        sha256: "0".repeat(64),
        manifestAssetName: "macos-arm64-portable-manifest.json",
        manifestSha256: "1".repeat(64),
        checksumAssetName: "macos-arm64-SHA256SUMS.txt",
        checksumVerified: true,
      },
    },
    release: {
      source: "github-release",
      tag: "v0.2.10",
      title: "Keiko 0.2.10",
      summary: "Portable update.",
      notes: ["Portable update."],
      url: "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.10",
    },
    ...overrides,
  });
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

function setClipboard(writeText: (text: string) => Promise<void>): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return descriptor;
}

function restoreClipboard(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
    return;
  }
  Object.defineProperty(navigator, "clipboard", descriptor);
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

  it("uses one explicit Update action for eligible portable-managed updates", async () => {
    const api = apiFor({
      report: portableReleaseReport(),
      status: portableManagedStatus(),
    });

    const { container } = render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Click Update. Keiko will download, verify, apply, relaunch, and verify the new version.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update Keiko" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();
    expect(screen.queryByText("Manual update path")).toBeNull();
    expect(screen.queryByText("npm")).toBeNull();
    expect(screen.queryByText("Yarn")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole("button", { name: "Update Keiko" }));
    await waitFor(() => {
      expect(api.startSession).toHaveBeenCalledWith({ targetVersion: "0.2.10" });
    });
  });

  it("limits blocked portable-managed updates to retry, current, details, and manual download", async () => {
    const api = apiFor({
      report: portableReleaseReport({
        manualUpdateRequired: true,
        oneClickEligible: false,
        userActionRequired: true,
        portableAsset: {
          source: "github-release-asset",
          target: "macos-arm64",
          requiredAssetName: "keiko-macos-arm64.zip",
          status: "malformed",
        },
        blockers: [
          {
            code: "portable-checksum-mismatch",
            severity: "high",
            message: "The release asset checksum did not match the manifest.",
            userActionRequired: true,
          },
        ],
      }),
      status: portableManagedStatus(),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    expect(screen.getByText("Portable update needs attention")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Keiko cannot complete this portable update automatically right now. The current version remains usable.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Keep using the current Keiko version; this update has not replaced it."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Open technical details below for the redacted reason Keiko blocked the update.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Manual update instructions")).toBeNull();
    expect(screen.queryByLabelText("Package-manager commands")).toBeNull();
    expect(screen.queryByText("npm")).toBeNull();
    expect(screen.queryByText("Yarn")).toBeNull();

    const download = screen.getByRole("link", { name: "Open manual download" });
    expect(download).toHaveAttribute(
      "href",
      "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.10",
    );
    fireEvent.click(screen.getByText("Technical details and logs"));
    expect(
      screen.getByText("The release asset checksum did not match the manifest."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(api.checkPreflight).toHaveBeenCalledTimes(1);
    });
  });

  it("blocks automatic install while preserving manual-review remediation copy", async () => {
    const api = apiFor({
      report: preflight({
        userActionRequired: true,
        impact: {
          entries: [],
          releaseNoteBullets: ["Local Knowledge needs review."],
          affectedStateStores: ["local-knowledge"],
          stateImpact: [
            {
              store: "local-knowledge",
              description: "Local Knowledge vectors need reindexing after this update.",
              remediation: "manual-review-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediations: ["manual-review-required"],
        },
      }),
      remediation: remediation({
        overallStatus: "manual-review-required",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge Reindex",
            state: "manual-review-required",
            reason: "Manual review is required before this update can be installed.",
            actionIds: [],
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    expect(screen.getByText("Check the local-state risk before installing.")).toBeInTheDocument();
    expect(
      screen.queryByText("Review the state impact, then install when you are ready."),
    ).toBeNull();
    expect(
      screen.getByText("Manual review is required before this update can be installed."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();
    expect(screen.getByText("Local-state risk before install")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This update could affect local state. Continue only if you accept the risk below.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Local Knowledge Reindex")).toBeInTheDocument();
    expect(screen.queryByText("Review required")).toBeNull();
    expect(screen.queryByText("Follow-up action")).toBeNull();
    expect(screen.queryByText("Run or defer this action before finishing.")).toBeNull();
    expect(
      screen.queryByText(
        "Local Knowledge Reindex could stop working or require recovery after this update.",
      ),
    ).toBeNull();
    expect(api.startSession).not.toHaveBeenCalled();
  });

  it("hides manual-review risk after the update is installed", async () => {
    const api = apiFor({
      report: preflight({
        currentVersion: "0.2.10",
        targetVersion: "0.2.10",
        updateAvailable: false,
        status: "current",
        availabilityState: "current",
        severity: "none",
        userActionRequired: false,
      }),
      status: sessionStatus({
        lastSession: session({
          phase: "succeeded",
          restartRequired: false,
          cancelable: false,
          retryable: false,
          message: "Update verified. Keiko 0.2.10 is running.",
        }),
      }),
      remediation: remediation({
        overallStatus: "manual-review-required",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge Reindex",
            state: "manual-review-required",
            reason: "Manual review is required before this update can be installed.",
            actionIds: [],
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update installed" })).toBeInTheDocument();
    expect(screen.queryByText("Local-state risk before install")).toBeNull();
    expect(
      screen.queryByText(
        "This update could affect local state. Continue only if you accept the risk below.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Local Knowledge Reindex could stop working or require recovery after this update.",
      ),
    ).toBeNull();
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
    const patchNotes = screen.getByText("Patch notes").closest("details");
    expect(patchNotes).not.toHaveAttribute("open");

    fireEvent.click(screen.getByText("Patch notes"));

    expect(screen.getByText("Plain-language patch notes.")).toBeInTheDocument();
    expect(screen.getByText("Improves update readiness.")).toBeInTheDocument();
  });

  it("renders grouped current-release patch notes without repeating the summary", async () => {
    const summary = "Repository intelligence headline.";
    const api = apiFor({
      report: preflight({
        targetVersion: "0.2.9",
        updateAvailable: false,
        status: "current",
        availabilityState: "current",
        severity: "none",
        patchNotes: {
          collapsed: true,
          summary,
          bullets: ["Security hardening.", "Stability fixes."],
          sections: [
            { title: "High · Improvements", bullets: [summary] },
            { title: "Normal · Improvements", bullets: ["Security hardening."] },
            { title: "Normal · Fixes", bullets: ["Stability fixes."] },
          ],
          details: [],
        },
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Keiko is up to date" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Patch notes"));

    expect(screen.getByRole("heading", { name: "High · Improvements" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Normal · Improvements" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Normal · Fixes" })).toBeInTheDocument();
    expect(screen.getAllByText(summary)).toHaveLength(1);
    expect(screen.getByText("Security hardening.")).toBeInTheDocument();
    expect(screen.getByText("Stability fixes.")).toBeInTheDocument();
  });

  it("renders a targetless degraded check as unavailable instead of target unknown", async () => {
    const {
      targetVersion: omittedTargetVersion,
      patchNotes: omittedPatchNotes,
      release: omittedRelease,
      ...degradedReport
    } = preflight({
      currentVersion: "0.2.12",
      updateAvailable: false,
      status: "degraded",
      availabilityState: "degraded",
      severity: "low",
      registryStatus: "unavailable",
      releaseMetadataStatus: "not-needed",
      userActionRequired: false,
      blockers: [
        {
          code: "registry-unavailable",
          message: "The update registry could not be reached.",
          severity: "low",
          userActionRequired: false,
        },
      ],
      manualUpdateRequired: false,
      oneClickEligible: false,
      warnings: ["The update registry could not be reached."],
    });
    expect(omittedTargetVersion).toBe("0.2.10");
    expect(omittedPatchNotes).toBeDefined();
    expect(omittedRelease).toBeUndefined();
    const api = apiFor({ report: degradedReport });

    render(<UpdateWindow api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Update status unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Current 0.2.12; latest version could not be verified."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Update availability could not be verified. Check again when the registry is reachable.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Current 0.2.12 -> target unknown")).toBeNull();
    expect(screen.queryByText("Keiko is up to date")).toBeNull();
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

  it("keeps technical details focused on installer output instead of command previews", async () => {
    const installLog = "updated @oscharko-dev/keiko to 0.2.10";

    render(
      <UpdateWindow
        api={apiFor({
          status: sessionStatus({
            activeSession: session({
              phase: "restart-required",
              restartRequired: true,
              cancelable: false,
              message: "Restart Keiko to complete the update.",
              logs: {
                collapsed: true,
                stdoutPreview: installLog,
                stderrPreview: "",
                stdoutBytes: installLog.length,
                stderrBytes: 0,
                truncated: false,
              },
            }),
          }),
        })}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Restart required" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Technical details and logs"));

    expect(screen.queryByText("Command preview")).toBeNull();
    expect(screen.queryByText("npm install -g @oscharko-dev/keiko@0.2.10")).toBeNull();
    expect(screen.getByText("Installer output")).toBeInTheDocument();
    expect(screen.getByText(installLog).closest(".upd-log-preview")).toBeInTheDocument();
  });

  it("does not report a degraded manual check as no newer update available", async () => {
    const {
      targetVersion: omittedTargetVersion,
      patchNotes: omittedPatchNotes,
      release: omittedRelease,
      ...degradedReport
    } = preflight({
      currentVersion: "0.2.12",
      updateAvailable: false,
      status: "degraded",
      availabilityState: "degraded",
      severity: "low",
      registryStatus: "unavailable",
      releaseMetadataStatus: "not-needed",
      blockers: [
        {
          code: "registry-unavailable",
          message: "The update registry could not be reached.",
          severity: "low",
          userActionRequired: false,
        },
      ],
      oneClickEligible: false,
      warnings: ["The update registry could not be reached."],
    });
    expect(omittedTargetVersion).toBe("0.2.10");
    expect(omittedPatchNotes).toBeDefined();
    expect(omittedRelease).toBeUndefined();
    const api = {
      ...apiFor({
        report: preflight({
          targetVersion: "0.2.12",
          currentVersion: "0.2.12",
          updateAvailable: false,
          status: "current",
          availabilityState: "current",
          severity: "none",
        }),
      }),
      checkPreflight: vi.fn(async () => degradedReport),
    };

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Keiko is up to date" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(
      await screen.findByText("Checked just now. Update status could not be verified."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checked just now. No newer update is available.")).toBeNull();
  });

  it("shows pre-install remediation as a notice instead of a runnable action", async () => {
    const api = apiFor({
      report: preflight({
        severity: "critical",
        manualUpdateRequired: true,
        oneClickEligible: false,
        userActionRequired: true,
        release: {
          source: "github-release",
          tag: "v0.2.10",
          title: "Keiko 0.2.10",
          summary: "Critical packaging update.",
          notes: ["Critical packaging update."],
          url: "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.10",
        },
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
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    const clipboardDescriptor = setClipboard(writeText);

    render(<UpdateWindow api={api} />);

    expect(
      await screen.findByRole("heading", { name: "Critical update available" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Automatic install is unavailable. Follow the approved manual instructions, restart Keiko, then check again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show instructions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide instructions" })).toBeNull();
    const releaseNotes = screen.getByRole("link", { name: "Open release notes" });
    expect(releaseNotes).toHaveAttribute(
      "href",
      "https://github.com/oscharko-dev/Keiko/releases/tag/v0.2.10",
    );
    expect(releaseNotes).toHaveAttribute("target", "_blank");
    expect(releaseNotes).toHaveAttribute("rel", "noopener noreferrer");
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

    fireEvent.click(screen.getByText("Manual update instructions"));
    await waitFor(() => {
      expect(commands).toHaveAttribute("open");
    });
    expect(screen.getByText("Run the approved package update outside Keiko.")).toBeInTheDocument();
    expect(screen.getByLabelText("Package-manager commands")).toBeInTheDocument();
    expect(
      screen
        .getByText("Run the approved package update outside Keiko.")
        .closest(".upd-manual-commands-body"),
    ).toBeInTheDocument();
    const npmTargetCommand = "npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.10";
    const yarnTargetCommand = "yarn global add --ignore-scripts @oscharko-dev/keiko@0.2.10";
    expect(screen.getByText("npm")).toBeInTheDocument();
    expect(screen.getByText("Yarn")).toBeInTheDocument();
    expect(
      screen.queryByText("npm install --global --ignore-scripts @oscharko-dev/keiko@latest"),
    ).toBeNull();
    expect(screen.getByText(npmTargetCommand)).toBeInTheDocument();
    expect(
      screen.queryByText("yarn global add --ignore-scripts @oscharko-dev/keiko@latest"),
    ).toBeNull();
    expect(screen.getByText(yarnTargetCommand)).toBeInTheDocument();

    const npmCopyButton = screen.getByRole("button", { name: "Copy npm command" });
    fireEvent.click(npmCopyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(npmTargetCommand);
    });
    expect(npmCopyButton).toHaveAttribute("data-copied", "true");
    expect(npmCopyButton).toHaveAttribute("title", "Copied");

    const yarnCopyButton = screen.getByRole("button", { name: "Copy Yarn command" });
    fireEvent.click(yarnCopyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(yarnTargetCommand);
    });
    expect(yarnCopyButton).toHaveAttribute("data-copied", "true");
    for (const copiedFeedback of screen.getAllByText("Copied")) {
      expect(copiedFeedback).toHaveClass("sr-only");
      expect(copiedFeedback).toHaveAttribute("role", "status");
    }

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
    restoreClipboard(clipboardDescriptor);
  });

  it("narrows manual package commands to the detected package manager", async () => {
    const api = apiFor({
      report: preflight({
        manualUpdateRequired: true,
        oneClickEligible: false,
        userActionRequired: true,
      }),
      status: sessionStatus({
        installMode: {
          schemaVersion: "1",
          status: "supported",
          packageName: "@oscharko-dev/keiko",
          packageManager: "npm",
          installRoot: "/usr/local/lib/node_modules/@oscharko-dev/keiko",
          commandPreview: {
            executable: "npm",
            args: [
              "install",
              "--global",
              "--ignore-scripts",
              "@oscharko-dev/keiko@<target-version>",
            ],
            label: "npm install --global --ignore-scripts @oscharko-dev/keiko@<target-version>",
          },
        },
        policy: {
          enabled: false,
          source: "environment",
          reason: "Update mutation is disabled in this environment.",
        },
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Manual update instructions"));

    expect(screen.getByText("npm")).toBeInTheDocument();
    expect(
      screen.getByText("npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.10"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("yarn global add --ignore-scripts @oscharko-dev/keiko@latest"),
    ).toBeNull();
    expect(screen.queryByText("Yarn")).toBeNull();
  });

  it("shows immediate command-copy feedback while clipboard completion is pending", async () => {
    const api = apiFor({
      report: preflight({
        manualUpdateRequired: true,
        oneClickEligible: false,
        userActionRequired: true,
      }),
    });
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValue(new Promise(() => {}));
    const clipboardDescriptor = setClipboard(writeText);

    try {
      render(<UpdateWindow api={api} />);

      expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
      fireEvent.click(screen.getByText("Manual update instructions"));

      const npmCopyButton = screen.getByRole("button", { name: "Copy npm command" });
      fireEvent.click(npmCopyButton);

      expect(writeText).toHaveBeenCalledWith(
        "npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.10",
      );
      expect(npmCopyButton).toHaveAttribute("data-pressed", "true");
      expect(npmCopyButton).toHaveAttribute("data-copied", "false");
      expect(npmCopyButton).toHaveAttribute("title", "Copy npm command");
      expect(screen.queryAllByText("Copied")).toHaveLength(0);
    } finally {
      restoreClipboard(clipboardDescriptor);
    }
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

  it("uses the completed session target for post-install remediation when the report is current", async () => {
    const { targetVersion: omittedTargetVersion, ...currentReport } = preflight({
      currentVersion: "0.2.10",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
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
    });
    expect(omittedTargetVersion).toBe("0.2.10");
    const api = apiFor({
      report: currentReport,
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
    expect(screen.getByRole("heading", { name: "Update installed" })).toBeInTheDocument();
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

  it("hides persisted manual-review risk after relaunch when the update is current", async () => {
    const { targetVersion: omittedTargetVersion, ...currentReport } = preflight({
      currentVersion: "0.2.10",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
      userActionRequired: false,
    });
    const api = apiFor({
      report: currentReport,
      remediation: remediation({
        overallStatus: "manual-review-required",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "manual-review-required",
            reason: "Local Knowledge requires manual review before the update can complete.",
            actionIds: [],
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Keiko is up to date" })).toBeInTheDocument();
    expect(screen.queryByText("Local-state risk before install")).toBeNull();
    expect(
      screen.queryByText("Local Knowledge requires manual review before the update can complete."),
    ).toBeNull();
    expect(screen.queryByText("This update could affect local state.")).toBeNull();
  });

  it("shows failed remediation metadata as planned follow-up before install", async () => {
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
              description: "Local Knowledge vectors must be rebuilt after the package update.",
              remediation: "local-knowledge-reindex-required",
              userActionRequired: true,
            },
          ],
          userActionRequired: true,
          remediations: ["local-knowledge-reindex-required"],
        },
      }),
      remediation: remediation({
        overallStatus: "failed",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "degraded",
            reason: "Refresh Local Knowledge vectors before affected workflows are ready.",
            actionIds: ["local-knowledge:reindex"],
          },
        ],
        actions: [
          {
            actionId: "local-knowledge:reindex",
            kind: "local-knowledge-reindex",
            store: "local-knowledge",
            remediation: "local-knowledge-reindex-required",
            status: "failed",
            required: true,
            canRun: true,
            canDefer: false,
            userApprovalRequired: true,
            featureIds: ["local-knowledge"],
            scopeCounts: { stores: 1, artifacts: 0, retainedEntries: 0 },
            message: "Refresh Local Knowledge vectors.",
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    const heading = await screen.findByRole("heading", { name: "Update available" });
    expect(heading.closest(".upd-summary")).toHaveAttribute("data-tone", "info");
    expect(screen.getByText("Follow-up after install")).toBeInTheDocument();
    expect(
      screen.getByText("This update will require this after the package is installed."),
    ).toBeInTheDocument();
    expect(screen.getByText("Local Knowledge Reindex")).toBeInTheDocument();
    expect(
      screen.getByText("Refresh Local Knowledge vectors before affected workflows are ready."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Follow-up failed")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run action" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Defer" })).toBeNull();
  });

  it("keeps post-install remediation failure scoped to the follow-up panel", async () => {
    const { targetVersion: omittedTargetVersion, ...currentReport } = preflight({
      currentVersion: "0.2.10",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
      userActionRequired: true,
      impact: {
        entries: [],
        releaseNoteBullets: ["Local Knowledge needs a follow-up."],
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
    });
    expect(omittedTargetVersion).toBe("0.2.10");
    const api = apiFor({
      report: currentReport,
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
        overallStatus: "failed",
        updateCanComplete: false,
        affectedFeatures: [
          {
            featureId: "local-knowledge",
            label: "Local Knowledge",
            state: "degraded",
            reason: "Refresh Local Knowledge vectors before affected workflows are ready.",
            actionIds: ["local-knowledge:reindex"],
          },
        ],
        actions: [
          {
            actionId: "local-knowledge:reindex",
            kind: "local-knowledge-reindex",
            store: "local-knowledge",
            remediation: "local-knowledge-reindex-required",
            status: "failed",
            required: true,
            canRun: true,
            canDefer: false,
            userApprovalRequired: true,
            featureIds: ["local-knowledge"],
            scopeCounts: { stores: 1, artifacts: 0, retainedEntries: 0 },
            message: "Refresh Local Knowledge vectors.",
          },
        ],
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update installed" })).toBeInTheDocument();
    expect(screen.getByText("Follow-up failed")).toBeInTheDocument();
    expect(
      screen.getByText("The follow-up action did not complete. Run it again before continuing."),
    ).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
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
    expect(
      screen.getByText(
        phase === "restart-required"
          ? "Keiko 0.2.10 is installed. Finish with one restart."
          : message,
      ),
    ).toBeInTheDocument();
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
    const help = screen.getByText("When Keiko opens again, click Verify restart.");
    const restartDetails = screen
      .getAllByText("Restart instructions")
      .map((entry) => entry.closest("details"))
      .find((entry): entry is HTMLDetailsElement => entry !== null);
    if (restartDetails === undefined) throw new Error("restart details panel not found");
    expect(
      screen.getByText("Restart and verification are needed to finish the update."),
    ).toBeInTheDocument();
    expect(restartDetails).toHaveAttribute("open");
    expect(screen.getByText("Restart instructions")).toBeInTheDocument();
    expect(screen.queryByText("Open for instructions.")).not.toBeInTheDocument();
    expect(
      screen.getByText("Keiko 0.2.10 is installed. Finish with one restart."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Copy the command below, paste it into your terminal, and press Enter."),
    ).toBeInTheDocument();
    expect(screen.getByText("Restart Keiko")).toBeInTheDocument();
    expect(
      screen.getByText(
        "keiko restart --port 1990 --host 127.0.0.1 --state-dir '/tmp/keiko update state'",
      ),
    ).toBeInTheDocument();
    expect(restartDetails).not.toContainElement(button);
    expect(screen.queryByText("Foreground terminal")).not.toBeInTheDocument();
    expect(screen.queryByText("keiko ui")).not.toBeInTheDocument();
    expect(button).toHaveAttribute("aria-describedby", help.id);
  });

  it("falls back to generic restart guidance when no targeted restart command is available", async () => {
    const api = apiFor({
      status: sessionStatus({
        activeSession: session({
          phase: "restart-required",
          restartCommandPreview: undefined,
          restartRequired: true,
          cancelable: false,
          message: "Restart Keiko to complete the update.",
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Restart required" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Restart Keiko from the same launcher you used before, then return here and verify.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Restart Keiko")).not.toBeInTheDocument();
    expect(screen.queryByText(/keiko restart/u)).not.toBeInTheDocument();
  });

  it("keeps restart mismatch in the restart instructions flow", async () => {
    const api = apiFor({
      status: sessionStatus({
        activeSession: session({
          phase: "restart-required",
          failureReason: "restart-version-mismatch",
          restartRequired: true,
          cancelable: false,
          message:
            "Restart not detected yet. Run the restart command, then try Verify restart again.",
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Restart required" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify restart" })).toBeInTheDocument();
    const restartDetails = screen.getByText("Restart instructions").closest("details");
    const mismatchNotice = screen.getByText(
      "Restart not detected yet. Run the restart command, then try Verify restart again.",
    );
    expect(restartDetails).toBeInTheDocument();
    expect(mismatchNotice.closest(".upd-restart-verification-feedback")).toBeInTheDocument();
    expect(restartDetails).not.toContainElement(mismatchNotice);
    expect(
      screen.getByText("Keiko 0.2.10 is installed. Finish with one restart."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "keiko restart --port 1990 --host 127.0.0.1 --state-dir '/tmp/keiko update state'",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Update failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Install update")).not.toBeInTheDocument();
  });

  it("keeps restart verification mismatches out of the install flow after clicking verify", async () => {
    const pending = session({
      phase: "restart-required",
      restartRequired: true,
      cancelable: false,
      message: "Restart Keiko to complete the update.",
    });
    const mismatch = session({
      phase: "restart-required",
      failureReason: "restart-version-mismatch",
      restartRequired: true,
      cancelable: false,
      message: "Restart not detected yet. Run the restart command, then try Verify restart again.",
    });
    const pendingStatus = sessionStatus({ activeSession: pending });
    const mismatchStatus = sessionStatus({ activeSession: mismatch });
    const api = {
      ...apiFor({ status: pendingStatus }),
      fetchSessionStatus: vi.fn(async () => pendingStatus),
      verifyRestart: vi.fn(async () => mismatch),
    };
    api.fetchSessionStatus.mockResolvedValueOnce(pendingStatus).mockResolvedValue(mismatchStatus);

    render(<UpdateWindow api={api} />);

    const button = await screen.findByRole("button", { name: "Verify restart" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(api.verifyRestart).toHaveBeenCalledWith({ targetVersion: "0.2.10" });
    });
    expect(
      await screen.findByText(
        "Restart not detected yet. Run the restart command, then try Verify restart again.",
      ),
    ).toBeInTheDocument();
    const restartDetails = screen.getByText("Restart instructions").closest("details");
    const mismatchNotice = screen.getByText(
      "Restart not detected yet. Run the restart command, then try Verify restart again.",
    );
    expect(restartDetails).toBeInTheDocument();
    expect(mismatchNotice.closest(".upd-restart-verification-feedback")).toBeInTheDocument();
    expect(restartDetails).not.toContainElement(mismatchNotice);
    expect(screen.getByRole("button", { name: "Verify restart" })).toBeEnabled();
    expect(screen.queryByText("Update failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Install update")).not.toBeInTheDocument();
  });

  it("uses installed-state copy and preserves patch notes after a targetless current check", async () => {
    const installedStatus = sessionStatus({
      lastSession: session({
        phase: "succeeded",
        restartRequired: false,
        cancelable: false,
        retryable: false,
        message: "Update complete.",
      }),
    });
    const {
      targetVersion: omittedTargetVersion,
      patchNotes: omittedPatchNotes,
      release: omittedRelease,
      ...currentReport
    } = preflight({
      currentVersion: "0.2.10",
      updateAvailable: false,
      status: "current",
      availabilityState: "current",
      severity: "none",
    });
    expect(omittedTargetVersion).toBe("0.2.10");
    expect(omittedPatchNotes).toBeDefined();
    expect(omittedRelease).toBeUndefined();
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

  it("checks again after a cancelled update session", async () => {
    const api = apiFor({
      status: sessionStatus({
        lastSession: session({
          phase: "cancelled",
          retryable: false,
          message: "Update cancelled.",
        }),
      }),
    });

    render(<UpdateWindow api={api} />);

    expect(await screen.findByRole("heading", { name: "Update available" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => {
      expect(api.checkPreflight).toHaveBeenCalledTimes(1);
    });
    expect(api.retrySession).not.toHaveBeenCalled();
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

  it("uses the displayed session target for restart verification when the report target is missing", async () => {
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
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => {
      expect(api.verifyRestart).toHaveBeenCalledWith({ targetVersion: "0.2.10" });
    });
  });
});
