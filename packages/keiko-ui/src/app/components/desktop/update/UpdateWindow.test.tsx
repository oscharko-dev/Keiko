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

function apiFor(args: {
  readonly report?: UpdatePreflightReport;
  readonly status?: UpdateSessionStatus;
  readonly remediation?: UpdateRemediationStatusReport;
} = {}): UpdateWindowApi {
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

    expect(await screen.findByRole("heading", { name: "Update available" })).toHaveFocus();
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
    expect(screen.getByText("No update is available. You can check again at any time.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("shows critical, manual, remediation, affected-feature, and non-color-only state copy", async () => {
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

    expect(await screen.findByRole("heading", { name: "Critical update available" })).toBeInTheDocument();
    expect(screen.getByText("Manual update path")).toBeInTheDocument();
    expect(screen.getByText("Local knowledge must be reindexed after this update.")).toBeInTheDocument();
    expect(screen.getByText("Local Knowledge")).toBeInTheDocument();
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
});
