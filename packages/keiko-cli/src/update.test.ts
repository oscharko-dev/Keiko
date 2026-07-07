import { describe, expect, it } from "vitest";
import {
  type UpdatePreflightReport,
  type UpdateRemediationStatusReport,
  type UpdateSession,
  type UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import type {
  UpdateRemediationManager,
  UpdateSessionManager,
  UpdateSessionStartOutcome,
} from "@oscharko-dev/keiko-server";
import { runCli, type CliIo } from "./runner.js";
import { runUpdateCli, type UpdateCliDeps, type UpdateCliPreflight } from "./update.js";

interface Captured {
  readonly io: CliIo;
  readonly out: () => string;
  readonly err: () => string;
}

function makeIo(): Captured {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      out: (text: string): void => {
        outChunks.push(text);
      },
      err: (text: string): void => {
        errChunks.push(text);
      },
    },
    out: (): string => outChunks.join(""),
    err: (): string => errChunks.join(""),
  };
}

function baseReport(patch: Partial<UpdatePreflightReport> = {}): UpdatePreflightReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T00:00:00.000Z",
    currentVersion: "0.2.10",
    targetVersion: "0.2.11",
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
    ...patch,
  };
}

function impactedReport(): UpdatePreflightReport {
  return baseReport({
    userActionRequired: true,
    affectedStateStores: ["local-knowledge"],
    impact: {
      entries: [],
      releaseNoteBullets: [],
      stateImpact: [
        {
          store: "local-knowledge",
          description: "Local Knowledge index format changed.",
          remediation: "local-knowledge-reindex-required",
          userActionRequired: true,
        },
      ],
      affectedStateStores: ["local-knowledge"],
      userActionRequired: true,
      remediations: ["local-knowledge-reindex-required"],
    },
  });
}

function baseStatus(patch: Partial<UpdateSessionStatus> = {}): UpdateSessionStatus {
  return {
    schemaVersion: "1",
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      packageManager: "npm",
      installRoot: "/Users/private/customer-bank/repo",
      commandPreview: {
        executable: "npm",
        args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.11"],
        label: "npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.11",
      },
    },
    policy: { enabled: true, source: "default" },
    ...patch,
  };
}

function portableStatus(patch: Partial<UpdateSessionStatus> = {}): UpdateSessionStatus {
  return baseStatus({
    installMode: {
      schemaVersion: "1",
      status: "supported",
      packageName: "@oscharko-dev/keiko",
      installKind: "portable-managed",
      installRoot: "/Users/private/Keiko",
      recommendedAction: "portable-managed-update",
      portable: {
        status: "managed",
        target: "windows-x64",
        updateEligible: true,
        packageVersion: "0.2.10",
        stable: true,
        managedRootKind: "home-relative",
      },
    },
    ...patch,
  });
}

function updateSession(patch: Partial<UpdateSession> = {}): UpdateSession {
  return {
    schemaVersion: "1",
    sessionId: "session-1",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.11",
    phase: "restart-required",
    failureReason: "none",
    packageManager: "npm",
    installRoot: "/Users/private/customer-bank/repo",
    commandPreview: {
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.11"],
      label: "npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.11",
    },
    startedAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:01.000Z",
    cancelable: false,
    retryable: false,
    restartRequired: true,
    message: "Update installed. Restart Keiko to load 0.2.11.",
    logs: {
      collapsed: true,
      stdoutPreview: "SECRET_TOKEN /Users/private/customer-bank/repo",
      stderrPreview: "raw package-manager stderr",
      stdoutBytes: 40,
      stderrBytes: 26,
      truncated: false,
    },
    ...patch,
  };
}

function baseRemediation(
  patch: Partial<UpdateRemediationStatusReport> = {},
): UpdateRemediationStatusReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T00:00:00.000Z",
    overallStatus: "not-required",
    updateCanComplete: true,
    actions: [],
    affectedFeatures: [],
    warnings: [],
    ...patch,
  };
}

function reindexRemediation(): UpdateRemediationStatusReport {
  return baseRemediation({
    overallStatus: "pending",
    updateCanComplete: false,
    actions: [
      {
        actionId: "local-knowledge-reindex",
        kind: "local-knowledge-reindex",
        store: "local-knowledge",
        remediation: "local-knowledge-reindex-required",
        status: "pending",
        required: true,
        canRun: true,
        canDefer: true,
        userApprovalRequired: false,
        featureIds: ["local-knowledge"],
        scopeCounts: { stores: 1, artifacts: 0, retainedEntries: 0 },
        message: "Rebuild Local Knowledge indexes.",
        cliFallback: "keiko repair",
      },
    ],
  });
}

function fakePreflight(report: UpdatePreflightReport): {
  readonly preflight: UpdateCliPreflight;
  readonly calls: { startup: number; manual: number };
} {
  const calls = { startup: 0, manual: 0 };
  return {
    calls,
    preflight: {
      getStartupReport: (): Promise<UpdatePreflightReport> => {
        calls.startup += 1;
        return Promise.resolve(report);
      },
      runManualCheck: (): Promise<UpdatePreflightReport> => {
        calls.manual += 1;
        return Promise.resolve(report);
      },
    },
  };
}

function fakeRemediation(report = baseRemediation()): UpdateRemediationManager {
  return {
    getStatus: () => report,
    runAction: () => Promise.resolve(report),
    completeRestart: () => report,
    updateCanComplete: () => report.updateCanComplete,
  };
}

function fakeSessionManager(
  initial: UpdateSessionStatus,
  terminal = updateSession(),
): {
  readonly manager: UpdateSessionManager;
  readonly startedTargets: () => readonly string[];
} {
  let status = initial;
  const startedTargets: string[] = [];
  const manager: UpdateSessionManager = {
    getStatus: () => status,
    start: (input): UpdateSessionStartOutcome => {
      startedTargets.push(input.targetVersion);
      status = { ...status, lastSession: terminal };
      return { session: terminal, reused: false };
    },
    retry: (): never => {
      throw new Error("retry not used");
    },
    cancel: (): never => {
      throw new Error("cancel not used");
    },
    verifyRestart: (): never => {
      throw new Error("verifyRestart not used");
    },
  };
  return { manager, startedTargets: () => startedTargets };
}

function output(captured: Captured): string {
  return `${captured.out()}\n${captured.err()}`;
}

function runUpdate(
  args: readonly string[],
  captured: Captured,
  deps: UpdateCliDeps,
): Promise<number> {
  return runUpdateCli(args, captured.io, {}, deps);
}

describe("keiko update CLI", () => {
  it("is listed and dispatched by top-level help", async () => {
    const help = makeIo();
    expect(runCli(["--help"], help.io)).toBe(0);
    expect(help.out()).toContain("keiko update <status|check|apply>");

    const command = makeIo();
    await expect(runCli(["update", "--help"], command.io)).resolves.toBe(0);
    expect(command.out()).toContain("keiko update status");
    expect(command.out()).toContain("UI remains the primary");
  });

  it("prints status through startup preflight without leaking paths or logs", async () => {
    const c = makeIo();
    const preflight = fakePreflight(impactedReport());
    const session = fakeSessionManager(baseStatus(), updateSession());
    const code = await runUpdate(["status"], c, {
      preflight: preflight.preflight,
      session: session.manager,
      remediation: fakeRemediation(reindexRemediation()),
    });

    expect(code).toBe(0);
    expect(preflight.calls).toEqual({ startup: 1, manual: 0 });
    expect(c.out()).toContain("Affected state: local-knowledge");
    expect(c.out()).toContain("Action: local-knowledge-reindex-required");
    expect(output(c)).not.toContain("/Users/private");
    expect(output(c)).not.toContain("SECRET_TOKEN");
    expect(output(c)).not.toContain("raw package-manager");
  });

  it("prints portable-managed status without package-manager fallback instructions", async () => {
    const c = makeIo();
    const preflight = fakePreflight(baseReport({ installabilitySource: "github-release-asset" }));
    const session = fakeSessionManager(portableStatus());
    const code = await runUpdate(["status"], c, {
      preflight: preflight.preflight,
      session: session.manager,
      remediation: fakeRemediation(),
    });

    expect(code).toBe(0);
    expect(c.out()).toContain("Install mode: supported (portable-managed (windows-x64))");
    expect(c.out()).toContain("Manual instructions: not required");
    expect(output(c)).not.toContain("Use your package manager outside Keiko");
    expect(output(c)).not.toContain("unknown package manager");
  });

  it("uses a fresh manual check for update check", async () => {
    const c = makeIo();
    const preflight = fakePreflight(baseReport());
    const session = fakeSessionManager(baseStatus());
    const code = await runUpdate(["check"], c, {
      preflight: preflight.preflight,
      session: session.manager,
      remediation: fakeRemediation(),
    });

    expect(code).toBe(0);
    expect(preflight.calls).toEqual({ startup: 0, manual: 1 });
    expect(c.out()).toContain("Keiko update check");
  });

  it("blocks apply when mutation policy is disabled", async () => {
    const c = makeIo();
    const session = fakeSessionManager(
      baseStatus({
        policy: {
          enabled: false,
          source: "environment",
          reason: "KEIKO_UPDATE_MUTATION_DISABLED disables in-app package mutation.",
        },
      }),
    );
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport()).preflight,
      session: session.manager,
      remediation: fakeRemediation(),
    });

    expect(code).toBe(1);
    expect(session.startedTargets()).toEqual([]);
    expect(output(c)).toContain("Policy: disabled");
    expect(output(c)).toContain("Use your package manager outside Keiko");
  });

  it("blocks portable apply when mutation policy is disabled without npm guidance", async () => {
    const c = makeIo();
    const session = fakeSessionManager(
      portableStatus({
        policy: {
          enabled: false,
          source: "environment",
          reason: "Portable self-update is disabled by policy.",
        },
      }),
    );
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport({ installabilitySource: "github-release-asset" }))
        .preflight,
      session: session.manager,
      remediation: fakeRemediation(),
    });

    expect(code).toBe(1);
    expect(session.startedTargets()).toEqual([]);
    expect(output(c)).toContain("Portable self-update is disabled by policy.");
    expect(output(c)).toContain("download the latest Keiko release asset manually");
    expect(output(c)).not.toContain("Use your package manager outside Keiko");
    expect(output(c)).not.toContain("npm install");
  });

  it("blocks unsupported install modes with manual instructions only", async () => {
    const c = makeIo();
    const session = fakeSessionManager(
      baseStatus({
        installMode: {
          schemaVersion: "1",
          status: "unsupported",
          packageName: "@oscharko-dev/keiko",
          reason: "local-checkout",
          manualInstructions:
            "Automatic update is unavailable: this is a repository checkout. Use your package manager outside Keiko, then restart Keiko.",
        },
      }),
    );
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport()).preflight,
      session: session.manager,
      remediation: fakeRemediation(),
    });

    expect(code).toBe(1);
    expect(session.startedTargets()).toEqual([]);
    expect(output(c)).toContain("Install mode: unsupported (local-checkout)");
    expect(output(c)).toContain("Use your package manager outside Keiko");
    expect(output(c)).not.toContain("npm install");
  });

  it("blocks ineligible portable release assets without package-manager guidance", async () => {
    const c = makeIo();
    const session = fakeSessionManager(portableStatus());
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(
        baseReport({
          installabilitySource: "github-release-asset",
          manualUpdateRequired: true,
          oneClickEligible: false,
          blockers: [
            {
              code: "portable-asset-missing",
              severity: "high",
              message: "The required release asset is missing.",
              userActionRequired: true,
            },
          ],
        }),
      ).preflight,
      session: session.manager,
      remediation: fakeRemediation(),
    });

    expect(code).toBe(1);
    expect(session.startedTargets()).toEqual([]);
    expect(output(c)).toContain("This portable release asset is not eligible");
    expect(output(c)).toContain("keep using the current version");
    expect(output(c)).not.toContain("Use your package manager outside Keiko");
    expect(output(c)).not.toContain("manual path");
  });

  it("starts safe apply and reports restart-required without raw logs", async () => {
    const c = makeIo();
    const session = fakeSessionManager(baseStatus(), updateSession());
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport()).preflight,
      session: session.manager,
      remediation: fakeRemediation(),
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      maxWaitMs: 1,
    });

    expect(code).toBe(0);
    expect(session.startedTargets()).toEqual(["0.2.11"]);
    expect(c.out()).toContain("Update apply result: restart-required");
    expect(output(c)).not.toContain("SECRET_TOKEN");
    expect(output(c)).not.toContain("/Users/private");
  });

  it("refuses portable apply through the CLI and routes users back to the update window", async () => {
    const c = makeIo();
    const session = fakeSessionManager(portableStatus());
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport({ installabilitySource: "github-release-asset" }))
        .preflight,
      session: session.manager,
      remediation: fakeRemediation(),
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      maxWaitMs: 1,
    });

    expect(code).toBe(1);
    expect(session.startedTargets()).toEqual([]);
    expect(output(c)).toContain(
      "Portable-managed one-click updates run through the Keiko update window.",
    );
    expect(output(c)).toContain("download the latest release asset manually");
    expect(output(c)).not.toContain("Update session: started");
    expect(output(c)).not.toContain("npm install");
  });

  it("reports failed apply without exposing stdout or stderr previews", async () => {
    const c = makeIo();
    const failed = updateSession({
      phase: "failed",
      failureReason: "non-zero-exit",
      restartRequired: false,
      message: "Package-manager update failed.",
    });
    const session = fakeSessionManager(baseStatus(), failed);
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport()).preflight,
      session: session.manager,
      remediation: fakeRemediation(),
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      maxWaitMs: 1,
    });

    expect(code).toBe(1);
    expect(c.out()).toContain("Update apply result: failed");
    expect(c.out()).toContain("Package-manager update failed.");
    expect(output(c)).not.toContain("SECRET_TOKEN");
    expect(output(c)).not.toContain("raw package-manager stderr");
  });
});
