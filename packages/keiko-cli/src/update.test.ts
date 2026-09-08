import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReleaseImpactCatalog,
  UpdateInstallMode,
  UpdatePreflightReport,
  UpdateRemediationStatusReport,
  UpdateSession,
  UpdateSessionStartRequest,
  UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_SESSION_PHASES } from "@oscharko-dev/keiko-contracts/runtime/update-session";
import type {
  UpdateRemediationManager,
  UpdateSessionManager,
  UpdateSessionStartOutcome,
} from "@oscharko-dev/keiko-server";
import { createUpdateLocalStateManager } from "@oscharko-dev/keiko-server";
import { runCli, type CliIo } from "./runner.js";
import { runUpdateCli, type UpdateCliDeps, type UpdateCliPreflight } from "./update.js";
import { isTerminalUpdateSession, renderApplyTerminal } from "./update-output.js";

const defaultRuntimeControl = vi.hoisted(() => ({
  enabled: false,
  currentVersion: "0.2.10",
  installMode: undefined as UpdateInstallMode | undefined,
  catalog: undefined as ReleaseImpactCatalog | undefined,
  commandCalls: [] as { readonly command: string; readonly args: readonly string[] }[],
  failSessionConstruction: false,
  sinkCloseCount: 0,
  storeCloseCount: 0,
}));

vi.mock("@oscharko-dev/keiko-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-server")>();
  return {
    ...actual,
    createInMemoryUiStore(
      ...args: Parameters<typeof actual.createInMemoryUiStore>
    ): ReturnType<typeof actual.createInMemoryUiStore> {
      const store = actual.createInMemoryUiStore(...args);
      if (!defaultRuntimeControl.enabled) return store;
      return new Proxy(store, {
        get(target, property, receiver): unknown {
          if (property !== "close") return Reflect.get(target, property, receiver);
          return (): void => {
            defaultRuntimeControl.storeCloseCount += 1;
            target.close();
          };
        },
      });
    },
    createFileServerLogSink(
      ...args: Parameters<typeof actual.createFileServerLogSink>
    ): ReturnType<typeof actual.createFileServerLogSink> {
      const sink = actual.createFileServerLogSink(...args);
      if (!defaultRuntimeControl.enabled) return sink;
      return {
        write: sink.write,
        ...(sink.flush === undefined ? {} : { flush: sink.flush }),
        close: (): void => {
          defaultRuntimeControl.sinkCloseCount += 1;
          sink.close?.();
        },
      };
    },
    createUpdatePreflightService(
      options?: Parameters<typeof actual.createUpdatePreflightService>[0],
    ): ReturnType<typeof actual.createUpdatePreflightService> {
      if (!defaultRuntimeControl.enabled) return actual.createUpdatePreflightService(options);
      const installMode = defaultRuntimeControl.installMode;
      const catalog = defaultRuntimeControl.catalog;
      if (installMode === undefined || catalog === undefined) {
        throw new TypeError("Default update runtime test control is incomplete.");
      }
      return actual.createUpdatePreflightService({
        ...options,
        currentVersion: defaultRuntimeControl.currentVersion,
        bundledCatalog: catalog,
        clock: () => new Date("2026-07-01T12:00:00.000Z"),
        installMode: () => installMode,
      });
    },
    createUpdateSessionManager(
      options?: Parameters<typeof actual.createUpdateSessionManager>[0],
    ): ReturnType<typeof actual.createUpdateSessionManager> {
      if (!defaultRuntimeControl.enabled) return actual.createUpdateSessionManager(options);
      const installMode = defaultRuntimeControl.installMode;
      if (installMode === undefined) {
        throw new TypeError("Default update runtime install mode is missing.");
      }
      if (defaultRuntimeControl.failSessionConstruction) {
        throw new Error("Synthetic default session construction failure.");
      }
      return actual.createUpdateSessionManager({
        ...options,
        detector: () => installMode,
        currentVersion: () => defaultRuntimeControl.currentVersion,
        now: () => Date.parse("2026-07-01T12:00:00.000Z"),
        idFactory: () => "cli-default-runtime-session",
        runCommandImpl: (input) => {
          defaultRuntimeControl.commandCalls.push({
            command: input.command,
            args: [...input.args],
          });
          return Promise.resolve({
            command: input.command,
            args: [...input.args],
            exitCode: 0,
            signal: null,
            stdout: "installed",
            stderr: "",
            durationMs: 1,
            timedOut: false,
            truncated: false,
          });
        },
      });
    },
  };
});

const defaultRuntimeDirs: string[] = [];

afterEach(() => {
  defaultRuntimeControl.enabled = false;
  defaultRuntimeControl.installMode = undefined;
  defaultRuntimeControl.catalog = undefined;
  defaultRuntimeControl.commandCalls.length = 0;
  defaultRuntimeControl.failSessionConstruction = false;
  defaultRuntimeControl.sinkCloseCount = 0;
  defaultRuntimeControl.storeCloseCount = 0;
  for (const dir of defaultRuntimeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    candidate: {
      schemaVersion: "1",
      candidateId: "candidate-0.2.11",
      targetVersion: "0.2.11",
      confirmationDigest: "a".repeat(64),
      executionToken: "b".repeat(64),
      issuedAt: "2026-06-30T00:00:00.000Z",
      expiresAt: "2026-06-30T00:10:00.000Z",
    },
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

function defaultRuntimeInstallMode(installRoot: string): UpdateInstallMode {
  return {
    schemaVersion: "1",
    status: "supported",
    packageName: "@oscharko-dev/keiko",
    installKind: "package-manager",
    packageManager: "npm",
    installRoot,
    recommendedAction: "package-manager-maintenance",
    commandPreview: {
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.11"],
      label: "npm install --global --ignore-scripts @oscharko-dev/keiko@0.2.11",
    },
  };
}

function defaultRuntimeCatalog(): ReleaseImpactCatalog {
  return {
    schemaVersion: 1,
    entries: [
      {
        id: "cli-default-runtime-0.2.11",
        packageName: "@oscharko-dev/keiko",
        packageVersion: "0.2.11",
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: "v0.2.11",
        releaseNoteCategory: "update-notes",
        releaseNotePriority: "normal",
        userVisibleChange: "observable",
        userVisibleSummary: "Default CLI runtime integration fixture.",
        affectedStateStores: [],
        stateImpact: [],
        userActionRequired: false,
        remediation: "no-action-required",
        supportedFrom: ["0.2.10"],
        releaseNoteBullets: ["Exercises the default CLI update runtime."],
        internalOnly: false,
        observableImpact: true,
        defaultPatchNotes: true,
        oneClickEligible: true,
        publishGates: [
          "version-consistency",
          "publish-manifests",
          "release-impact",
          "package-surface",
          "qi-supply-chain",
        ],
        review: {
          status: "reviewed",
          reviewer: "release-owner",
          reviewedAt: "2026-07-01",
          humanApproved: true,
          approvalReference: "github-pr-review:synthetic/keiko-cli-fixture#1#1",
          rationale: "Synthetic reviewed metadata for the CLI composition regression.",
        },
      },
    ],
  };
}

function defaultRuntimeFetch(): typeof fetch {
  return vi.fn((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://registry.npmjs.org/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ "dist-tags": { latest: "0.2.11" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/releases/tags/v0.2.11")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            tag_name: "v0.2.11",
            name: "Keiko 0.2.11",
            html_url: "https://github.com/oscharko-dev/keiko/releases/tag/v0.2.11",
            published_at: "2026-07-01T12:00:00.000Z",
            body: "- Default CLI runtime regression",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

function activityLogOperations(stateDir: string): readonly string[] {
  return readFileSync(join(stateDir, "logs", "server.log"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { readonly op?: unknown })
    .flatMap((record) => (typeof record.op === "string" ? [record.op] : []));
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
    candidateId: "candidate-0.2.11",
    candidateDigest: "c".repeat(64),
    correlationId: "update-correlation-1",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "0.2.11",
    phase: "restart-required",
    lifecycle: {
      phase: "verifying-relaunch",
      progress: { completedBytes: 0 },
      cancellationCutoff: "handoff-committed",
    },
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
  // #2906 round 3 (comment 3865273709): the number of getStatus() calls that must report the
  // session as still "running" before it flips to `terminal`. Defaults to 0 (the original,
  // immediately-terminal behavior every other call site relies on) — only a test that wants to
  // reach waitForTerminalSession's polling loop itself passes a positive value.
  nonTerminalPolls = 0,
): {
  readonly manager: UpdateSessionManager;
  readonly startedCandidateIds: () => readonly string[];
  readonly startedClaims: () => readonly UpdateSessionStartRequest[];
  readonly getStatusCallCount: () => number;
} {
  let status = initial;
  let started = false;
  let statusCalls = 0;
  const startedCandidateIds: string[] = [];
  const startedClaims: UpdateSessionStartRequest[] = [];
  const manager: UpdateSessionManager = {
    getStatus: (): UpdateSessionStatus => {
      if (!started) return status;
      statusCalls += 1;
      const stillPending = statusCalls <= nonTerminalPolls;
      return {
        ...status,
        lastSession: stillPending ? { ...terminal, phase: "running" } : terminal,
      };
    },
    start: (input): UpdateSessionStartOutcome => {
      startedCandidateIds.push(input.candidateId);
      startedClaims.push(input);
      started = true;
      const outcomeSession =
        nonTerminalPolls > 0 ? { ...terminal, phase: "running" as const } : terminal;
      status = { ...status, lastSession: outcomeSession };
      return { session: outcomeSession, reused: false };
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
  return {
    manager,
    startedCandidateIds: () => startedCandidateIds,
    startedClaims: () => startedClaims,
    getStatusCallCount: () => statusCalls,
  };
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
    expect(session.startedCandidateIds()).toEqual([]);
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
    expect(session.startedCandidateIds()).toEqual([]);
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
    expect(session.startedCandidateIds()).toEqual([]);
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
    expect(session.startedCandidateIds()).toEqual([]);
    expect(output(c)).toContain("This portable release asset is not eligible");
    expect(output(c)).toContain("keep using the current version");
    expect(output(c)).not.toContain("Use your package manager outside Keiko");
    expect(output(c)).not.toContain("manual path");
  });

  // KEIKO-0809: `waitForTerminalSession` used pollIntervalMs as both the sleep interval
  // AND the loop's `elapsed +=` increment, so a caller-supplied `pollIntervalMs: 0`
  // produced `elapsed += 0` and looped forever. The clamp forces a positive tick so the
  // maxWaitMs bound applies even when the caller passes 0.
  //
  // #2906 round 3 (comment 3865273709): the ORIGINAL fixture here stored the terminal session
  // inside `start()` itself, so `waitForTerminalSession` found it terminal on its very first
  // probe — sleep was never called, elapsed was never incremented, and the clamp this test
  // claims to protect never ran at all. It passed identically against the pre-fix
  // zero-increment loop, because that loop never got a chance to iterate either way. Holding
  // the session "running" for a few polls forces the loop to actually iterate — and therefore
  // to actually exercise the pollIntervalMs=0 clamp — before it resolves.
  it("bounds the apply wait even when the poll interval is zero", async () => {
    const c = makeIo();
    const session = fakeSessionManager(baseStatus(), updateSession(), 3);
    const sleepIntervals: number[] = [];
    const code = await runUpdate(["apply"], c, {
      preflight: fakePreflight(baseReport()).preflight,
      session: session.manager,
      remediation: fakeRemediation(),
      sleep: (ms: number): Promise<void> => {
        sleepIntervals.push(ms);
        return Promise.resolve();
      },
      pollIntervalMs: 0,
      maxWaitMs: 10,
    });

    expect(code).toBe(0);
    // The loop must actually have run: at least one sleep, driven by the non-terminal polls
    // above. The pre-fix bug produced `elapsed += 0` — every requested interval must be
    // strictly positive, which the clamp guarantees and the bug did not.
    expect(sleepIntervals.length).toBeGreaterThan(0);
    expect(sleepIntervals.every((ms) => ms > 0)).toBe(true);
    // A hard upper bound well below the previous infinite-spin behavior.
    expect(sleepIntervals.length).toBeLessThan(100);
    // The session must have actually reached the terminal phase (not merely timed out).
    expect(session.getStatusCallCount()).toBeGreaterThan(0);
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
    expect(session.startedCandidateIds()).toEqual(["candidate-0.2.11"]);
    expect(session.startedClaims()).toEqual([
      {
        candidateId: "candidate-0.2.11",
        confirmationDigest: "a".repeat(64),
        executionToken: "b".repeat(64),
      },
    ]);
    expect(c.out()).toContain("Update apply result: restart-required");
    expect(output(c)).not.toContain("SECRET_TOKEN");
    expect(output(c)).not.toContain("/Users/private");
  });

  it("composes the default runtime around one candidate authority and durable activity sink", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-cli-default-"));
    defaultRuntimeDirs.push(root);
    const stateDir = join(root, "state");
    defaultRuntimeControl.enabled = true;
    defaultRuntimeControl.installMode = defaultRuntimeInstallMode(join(root, "install"));
    defaultRuntimeControl.catalog = defaultRuntimeCatalog();
    const c = makeIo();

    const code = await runUpdateCli(
      ["apply"],
      c.io,
      { KEIKO_STATE_DIR: stateDir },
      {
        cwd: root,
        fetchImpl: defaultRuntimeFetch(),
        sleep: () => Promise.resolve(),
        pollIntervalMs: 1,
        maxWaitMs: 100,
      },
    );

    expect(code).toBe(0);
    expect(defaultRuntimeControl.commandCalls).toEqual([
      {
        command: "npm",
        args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@0.2.11"],
      },
    ]);
    expect(c.out()).toContain("Update apply result: restart-required");
    expect(defaultRuntimeControl.sinkCloseCount).toBe(1);
    expect(defaultRuntimeControl.storeCloseCount).toBe(1);

    const freshState = createUpdateLocalStateManager({ stateDir }).inspectRuntimeState();
    expect(freshState).toMatchObject({
      status: "ok",
      state: {
        activeSession: {
          sessionId: "cli-default-runtime-session",
          targetVersion: "0.2.11",
          phase: "restart-required",
        },
        recovery: {
          status: "reconciling",
          sessionId: "cli-default-runtime-session",
        },
      },
    });
    expect(activityLogOperations(stateDir)).toEqual(
      expect.arrayContaining([
        "update.candidate.issued",
        "update.candidate.consumed",
        "update.session.lifecycle",
      ]),
    );
  });

  it("closes owned default-runtime resources when session construction fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-update-cli-construction-"));
    defaultRuntimeDirs.push(root);
    defaultRuntimeControl.enabled = true;
    defaultRuntimeControl.installMode = defaultRuntimeInstallMode(join(root, "install"));
    defaultRuntimeControl.catalog = defaultRuntimeCatalog();
    defaultRuntimeControl.failSessionConstruction = true;
    const c = makeIo();

    const code = await runUpdateCli(
      ["status"],
      c.io,
      { KEIKO_STATE_DIR: join(root, "state") },
      { cwd: root },
    );

    expect(code).toBe(1);
    expect(defaultRuntimeControl.commandCalls).toEqual([]);
    expect(defaultRuntimeControl.sinkCloseCount).toBe(1);
    expect(defaultRuntimeControl.storeCloseCount).toBe(1);
    expect(c.err()).toContain("Unexpected update command failure. Error");
    expect(c.err()).not.toContain("Synthetic default session construction failure");
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
    expect(session.startedCandidateIds()).toEqual([]);
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

describe("keiko update CLI — safe error discriminator", () => {
  it("reports a redacted error discriminator on unexpected failures", async () => {
    const c = makeIo();
    const secretPath = "/Users/me/secret";
    const preflight: UpdateCliPreflight = {
      getStartupReport: (): Promise<UpdatePreflightReport> => Promise.resolve(baseReport()),
      runManualCheck: (): Promise<UpdatePreflightReport> => {
        // A synthetic EACCES surfaced during manual check — the body carries a workspace path
        // that must NEVER appear in the operator-visible error line.
        const err = Object.assign(new Error(`boom ${secretPath}`), { code: "EACCES" });
        return Promise.reject(err);
      },
    };
    const session = fakeSessionManager(baseStatus());
    const code = await runUpdate(["apply"], c, {
      preflight,
      session: session.manager,
      remediation: fakeRemediation(),
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
      maxWaitMs: 1,
    });

    expect(code).toBe(1);
    expect(c.err()).toContain("Unexpected update command failure.");
    expect(c.err()).toContain("EACCES");
    expect(output(c)).not.toContain(secretPath);
    expect(output(c)).not.toContain("boom ");
  });
});

// Structural guard: waitForTerminalSession (via isTerminalUpdateSession) and renderApplyTerminal
// must agree about which UpdateSessionPhase values are terminal. The two branches were duplicated
// in update.ts and update-output.ts and would drift silently: the poller could accept a session
// the renderer still treated as "timed out". Iterating UPDATE_SESSION_PHASES here catches the drift
// against every declared phase, including any added later.
describe("update terminal-phase agreement (structural)", () => {
  it("has renderApplyTerminal treat exactly the isTerminalUpdateSession-terminal phases as terminal", () => {
    for (const phase of UPDATE_SESSION_PHASES) {
      const session = updateSession({ phase });
      const terminalByPredicate = isTerminalUpdateSession(session);
      const rendered = renderApplyTerminal(session);
      const treatedAsTerminalByRenderer = !rendered.some((line) =>
        line.includes("timed out before a terminal session state"),
      );
      expect(treatedAsTerminalByRenderer).toBe(terminalByPredicate);
    }
  });
});
