import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { CommandResult } from "@oscharko-dev/keiko-tools";
import {
  UPDATE_PREFLIGHT_SCHEMA_VERSION,
  UPDATE_SESSION_SCHEMA_VERSION,
  type ReleaseImpactCatalog,
  type UpdateInstallMode,
  type UpdateRemediationStatusReport,
  type UpdatePreflightReport,
  type UpdateSession,
  type UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCspHeader } from "./csp.js";
import { buildUiHandlerDeps } from "./deps.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import { detectUpdateInstallMode } from "./update-install-mode.js";
import { createUpdateSessionManager, type UpdateSessionManagerOptions } from "./update-session.js";
import { createUpdatePreflightService } from "./update-preflight.js";
import { createUpdateLocalStateManager } from "./update-local-state.js";
import { createUpdateRemediationManager } from "./update-remediation.js";
import type {
  LocalKnowledgeRemediationPort,
  LocalKnowledgeRemediationRunResult,
  LocalKnowledgeRemediationScope,
} from "./local-knowledge-remediation.js";

const PACKAGE_NAME = "@oscharko-dev/keiko";
const INSTALL_ROOT = `/usr/local/lib/node_modules/${PACKAGE_NAME}`;
const FIXED_NOW = Date.parse("2026-07-01T12:00:00.000Z");

interface ReleaseImpactCatalogOptions {
  readonly localKnowledgeReindexRequired?: boolean | undefined;
}

interface SyntheticPreflightReportOptions {
  readonly localKnowledgeReindexRequired?: boolean | undefined;
}

function nextPatchVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (match === null)
    throw new Error(`SDK_VERSION must be stable semver for this test: ${version}`);
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`SDK_VERSION must include major, minor, and patch: ${version}`);
  }
  return `${major}.${minor}.${String(Number(patch) + 1)}`;
}

function releaseImpactCatalog(
  targetVersion: string,
  supportedFrom: string,
  options: ReleaseImpactCatalogOptions = {},
): ReleaseImpactCatalog {
  const localKnowledgeReindexRequired = options.localKnowledgeReindexRequired === true;
  const affectedStateStores = localKnowledgeReindexRequired ? ["local-knowledge"] : [];
  const stateImpact = localKnowledgeReindexRequired
    ? [
        {
          store: "local-knowledge",
          description: "Local Knowledge vectors must be rebuilt after the package update.",
          remediation: "local-knowledge-reindex-required" as const,
          userActionRequired: true,
        },
      ]
    : [];
  const remediation = localKnowledgeReindexRequired
    ? "local-knowledge-reindex-required"
    : "no-action-required";
  const releaseNoteBullets = localKnowledgeReindexRequired
    ? ["Refresh Local Knowledge vectors before grounded workflows are fully ready."]
    : ["Exercises update detection without a real published release."];
  return {
    schemaVersion: 1,
    entries: [
      {
        id: `integration-${targetVersion}`,
        packageName: PACKAGE_NAME,
        packageVersion: targetVersion,
        distTag: "latest",
        registry: "https://registry.npmjs.org/",
        releaseTag: `v${targetVersion}`,
        releaseNoteCategory: localKnowledgeReindexRequired
          ? "state-or-compatibility-changes"
          : "update-notes",
        releaseNotePriority: localKnowledgeReindexRequired ? "high" : "normal",
        userVisibleChange: localKnowledgeReindexRequired ? "compatibility" : "observable",
        userVisibleSummary: localKnowledgeReindexRequired
          ? "Local Knowledge vectors need to be rebuilt after the update."
          : "Governed updater integration fixture.",
        affectedStateStores,
        stateImpact,
        userActionRequired: localKnowledgeReindexRequired,
        remediation,
        supportedFrom: [supportedFrom],
        releaseNoteBullets,
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
          approvalReference: "github-pr-review:oscharko-dev/keiko#1717#1",
          rationale: "Synthetic release-impact metadata for the updater integration test.",
        },
      },
    ],
  };
}

function fixedUpdatePreflight(report: UpdatePreflightReport): UiHandlerDeps["updatePreflight"] {
  return {
    getStartupReport: () => Promise.resolve(report),
    runManualCheck: () => Promise.resolve(report),
  };
}

function manualInstallMode(): UpdateInstallMode {
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    status: "unsupported",
    packageName: PACKAGE_NAME,
    reason: "manifest-unavailable",
    manualInstructions:
      "Automatic update is unavailable: this simulated state requires a manual package install. Use your package manager outside Keiko, then restart Keiko.",
  };
}

function syntheticPreflightReport(
  targetVersion: string,
  options: SyntheticPreflightReportOptions = {},
): UpdatePreflightReport {
  const localKnowledgeReindexRequired = options.localKnowledgeReindexRequired === true;
  const stateImpact = localKnowledgeReindexRequired
    ? [
        {
          store: "local-knowledge",
          description: "Local Knowledge vectors must be rebuilt after the package update.",
          remediation: "local-knowledge-reindex-required" as const,
          userActionRequired: true,
        },
      ]
    : [];
  const releaseNoteBullets = localKnowledgeReindexRequired
    ? ["Refresh Local Knowledge vectors before grounded workflows are fully ready."]
    : ["Exercises injected updater wiring without a real published release."];
  return {
    schemaVersion: UPDATE_PREFLIGHT_SCHEMA_VERSION,
    checkedAt: new Date(FIXED_NOW).toISOString(),
    currentVersion: SDK_VERSION,
    targetVersion,
    updateAvailable: true,
    status: "update-available",
    availabilityState: "update-available",
    severity: localKnowledgeReindexRequired ? "high" : "normal",
    registryStatus: "ok",
    releaseMetadataStatus: "live",
    userActionRequired: localKnowledgeReindexRequired,
    affectedStateStores: localKnowledgeReindexRequired ? ["local-knowledge"] : [],
    blockers: [],
    manualUpdateRequired: false,
    oneClickEligible: true,
    impact: {
      entries: [
        {
          packageVersion: targetVersion,
          releaseTag: `v${targetVersion}`,
          summary: localKnowledgeReindexRequired
            ? "Injected update with Local Knowledge reindex."
            : "Injected update fixture.",
          releaseNoteBullets,
          stateImpact,
          userActionRequired: localKnowledgeReindexRequired,
          remediation: localKnowledgeReindexRequired
            ? "local-knowledge-reindex-required"
            : "no-action-required",
        },
      ],
      releaseNoteBullets,
      stateImpact,
      affectedStateStores: localKnowledgeReindexRequired ? ["local-knowledge"] : [],
      userActionRequired: localKnowledgeReindexRequired,
      remediations: [
        localKnowledgeReindexRequired ? "local-knowledge-reindex-required" : "no-action-required",
      ],
    },
    warnings: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function createMetadataFetch(targetVersion: string): {
  readonly fetchImpl: typeof fetch;
  readonly calls: () => readonly string[];
} {
  const calls: string[] = [];
  const fakeFetch = vi.fn((input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    calls.push(url);
    if (url.startsWith("https://registry.npmjs.org/")) {
      return Promise.resolve(jsonResponse({ "dist-tags": { latest: targetVersion } }));
    }
    if (url === `https://api.github.com/repos/oscharko-dev/keiko/releases/tags/v${targetVersion}`) {
      return Promise.resolve(
        jsonResponse({
          tag_name: `v${targetVersion}`,
          name: `Keiko ${targetVersion}`,
          html_url: `https://github.com/oscharko-dev/keiko/releases/tag/v${targetVersion}`,
          published_at: "2026-07-01T12:00:00.000Z",
          body: "- Integrated updater regression\n- No real release required",
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  return { fetchImpl: fakeFetch, calls: () => calls };
}

function commandResult(input: {
  readonly command: string;
  readonly args: readonly string[];
}): CommandResult {
  return {
    command: input.command,
    args: [...input.args],
    exitCode: 0,
    signal: null,
    stdout: "installed token=SECRET",
    stderr: "",
    durationMs: 3,
    timedOut: false,
    truncated: false,
  };
}

function fakeLocalKnowledgeRemediation(): LocalKnowledgeRemediationPort & {
  readonly runs: () => number;
} {
  let runs = 0;
  const scope: LocalKnowledgeRemediationScope = {
    capsules: 2,
    sources: 3,
    documents: 11,
    chunks: 41,
    vectors: 39,
  };
  return {
    inspect: () => scope,
    reindexAll: (): Promise<LocalKnowledgeRemediationRunResult> => {
      runs += 1;
      return Promise.resolve({
        status: "completed",
        scope,
        failedCapsules: 0,
        message: "Reindexed synthetic Local Knowledge capsules.",
      });
    },
    runs: () => runs,
  };
}

function impactInput(report: UpdatePreflightReport): {
  readonly affectedStateStores: readonly string[];
  readonly stateImpact: NonNullable<UpdatePreflightReport["impact"]>["stateImpact"];
  readonly remediation: "local-knowledge-reindex-required";
  readonly userActionRequired: boolean;
} {
  const impact = report.impact;
  if (impact === undefined) throw new Error("Expected update impact in integration report");
  return {
    affectedStateStores: impact.affectedStateStores,
    stateImpact: impact.stateImpact,
    remediation: "local-knowledge-reindex-required",
    userActionRequired: impact.userActionRequired,
  };
}

let server: Server;
let staticRoot: string;
let port: number;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<void> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  server = next;
  port = chosenPort;
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function updateSessionStatus(): Promise<UpdateSessionStatus> {
  const response = await fetch(`${baseUrl()}/api/update/session`);
  expect(response.status).toBe(200);
  return readJson<UpdateSessionStatus>(response);
}

async function waitForPhase(phase: UpdateSession["phase"]): Promise<UpdateSessionStatus> {
  let latest: UpdateSessionStatus | undefined;
  await vi.waitFor(async () => {
    latest = await updateSessionStatus();
    expect(latest.activeSession?.phase ?? latest.lastSession?.phase).toBe(phase);
  });
  if (latest === undefined) throw new Error(`Update session never reached phase ${phase}`);
  return latest;
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-update-integration-"));
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
});

describe("governed updater integration", () => {
  it("detects a synthetic release and completes the safe BFF update session path", async () => {
    const targetVersion = nextPatchVersion(SDK_VERSION);
    const metadata = createMetadataFetch(targetVersion);
    let runningVersion = SDK_VERSION;
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    runCommandImpl.mockImplementation((input) => Promise.resolve(commandResult(input)));
    const updateSession = createUpdateSessionManager({
      processEnv: {},
      detector: () =>
        detectUpdateInstallMode({
          packageRoot: INSTALL_ROOT,
          packageName: PACKAGE_NAME,
          packageManagerHint: "npm",
          installScope: "global",
        }),
      currentVersion: () => runningVersion,
      idFactory: () => "update-integration-session",
      now: () => FIXED_NOW,
      redactor: (value) => value.replaceAll("SECRET", "[REDACTED]"),
      runCommandImpl,
    });
    const updatePreflight = createUpdatePreflightService({
      currentVersion: SDK_VERSION,
      bundledCatalog: releaseImpactCatalog(targetVersion, SDK_VERSION),
      clock: () => new Date(FIXED_NOW),
    });
    await buildServer({
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: (): string => "",
        list: (): readonly string[] => [],
        get: (): string | undefined => undefined,
        delete: (): void => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (): undefined => undefined,
      store: createInMemoryUiStore(),
      gatewayReadinessFetch: metadata.fetchImpl,
      updatePreflight,
      updateSession,
    });

    const preflightResponse = await fetch(`${baseUrl()}/api/update/preflight`);
    const preflight = await readJson<UpdatePreflightReport>(preflightResponse);

    expect(preflightResponse.status).toBe(200);
    expect(preflight).toMatchObject({
      currentVersion: SDK_VERSION,
      targetVersion,
      updateAvailable: true,
      status: "update-available",
      registryStatus: "ok",
      releaseMetadataStatus: "live",
      oneClickEligible: true,
      manualUpdateRequired: false,
    });
    expect(metadata.calls()).toEqual([
      "https://registry.npmjs.org/%40oscharko-dev%2Fkeiko",
      `https://api.github.com/repos/oscharko-dev/keiko/releases/tags/v${targetVersion}`,
    ]);

    const startedResponse = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion, requestId: "integration-test" }),
    });
    const started = await readJson<UpdateSession>(startedResponse);

    expect(startedResponse.status).toBe(202);
    expect(started).toMatchObject({
      sessionId: "update-integration-session",
      targetVersion,
      phase: "preparing",
    });

    const restartRequired = await waitForPhase("restart-required");
    expect(runCommandImpl).toHaveBeenCalledTimes(1);
    expect(runCommandImpl.mock.calls[0]?.[0]).toMatchObject({
      command: "npm",
      args: ["install", "--global", "--ignore-scripts", `${PACKAGE_NAME}@${targetVersion}`],
      cwd: undefined,
    });
    expect(restartRequired.activeSession).toMatchObject({
      targetVersion,
      phase: "restart-required",
      restartRequired: true,
      logs: { stdoutPreview: "installed token=[REDACTED]" },
    });

    runningVersion = targetVersion;
    const verifiedResponse = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion }),
    });
    const verified = await readJson<UpdateSession>(verifiedResponse);
    const finalStatus = await updateSessionStatus();

    expect(verifiedResponse.status).toBe(200);
    expect(verified).toMatchObject({
      targetVersion,
      phase: "succeeded",
      restartRequired: false,
    });
    expect(finalStatus.activeSession).toBeUndefined();
    expect(finalStatus.lastSession).toMatchObject({ targetVersion, phase: "succeeded" });
  });

  it("keeps a synthetic update pending until Local Knowledge reindex remediation completes", async () => {
    const targetVersion = nextPatchVersion(SDK_VERSION);
    const metadata = createMetadataFetch(targetVersion);
    let runningVersion = SDK_VERSION;
    const runCommandImpl = vi.fn<NonNullable<UpdateSessionManagerOptions["runCommandImpl"]>>();
    runCommandImpl.mockImplementation((input) => Promise.resolve(commandResult(input)));
    const updateSession = createUpdateSessionManager({
      processEnv: {},
      detector: () =>
        detectUpdateInstallMode({
          packageRoot: INSTALL_ROOT,
          packageName: PACKAGE_NAME,
          packageManagerHint: "npm",
          installScope: "global",
        }),
      currentVersion: () => runningVersion,
      idFactory: () => "update-reindex-integration-session",
      now: () => FIXED_NOW,
      redactor: (value) => value.replaceAll("SECRET", "[REDACTED]"),
      runCommandImpl,
    });
    const updatePreflight = createUpdatePreflightService({
      currentVersion: SDK_VERSION,
      bundledCatalog: releaseImpactCatalog(targetVersion, SDK_VERSION, {
        localKnowledgeReindexRequired: true,
      }),
      clock: () => new Date(FIXED_NOW),
    });
    const stateDir = join(staticRoot, ".keiko-state");
    await mkdir(stateDir, { recursive: true });
    const updateLocalState = createUpdateLocalStateManager({
      stateDir,
      now: () => FIXED_NOW,
      idFactory: () => "update-reindex-event",
    });
    const localKnowledge = fakeLocalKnowledgeRemediation();
    const updateRemediation = createUpdateRemediationManager({
      localState: updateLocalState,
      localKnowledge,
      now: () => FIXED_NOW,
    });
    await buildServer({
      config: undefined,
      configPresent: false,
      evidenceStore: {
        put: (): string => "",
        list: (): readonly string[] => [],
        get: (): string | undefined => undefined,
        delete: (): void => undefined,
      },
      env: {},
      redactor: buildRedactor({}),
      registry: createRunRegistry(),
      modelPortFactory: (): undefined => undefined,
      store: createInMemoryUiStore(),
      gatewayReadinessFetch: metadata.fetchImpl,
      updatePreflight,
      updateLocalState,
      updateRemediation,
      updateSession,
    });

    const preflightResponse = await fetch(`${baseUrl()}/api/update/preflight`);
    const preflight = await readJson<UpdatePreflightReport>(preflightResponse);
    const impact = impactInput(preflight);

    expect(preflightResponse.status).toBe(200);
    expect(preflight).toMatchObject({
      currentVersion: SDK_VERSION,
      targetVersion,
      updateAvailable: true,
      status: "update-available",
      severity: "high",
      affectedStateStores: ["local-knowledge"],
      userActionRequired: true,
      oneClickEligible: true,
      manualUpdateRequired: false,
    });
    expect(preflight.impact?.remediations).toEqual(["local-knowledge-reindex-required"]);

    const remediationStatusResponse = await fetch(`${baseUrl()}/api/update/remediation/status`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion, impact, persist: true }),
    });
    const remediationStatus =
      await readJson<UpdateRemediationStatusReport>(remediationStatusResponse);

    expect(remediationStatusResponse.status).toBe(200);
    expect(remediationStatus).toMatchObject({
      targetVersion,
      overallStatus: "pending",
      updateCanComplete: false,
      affectedFeatures: [
        {
          featureId: "local-knowledge",
          label: "Local Knowledge",
          state: "unavailable",
        },
      ],
    });
    expect(remediationStatus.actions[0]).toMatchObject({
      actionId: "local-knowledge-reindex:local-knowledge",
      kind: "local-knowledge-reindex",
      status: "pending",
      canRun: true,
      canDefer: true,
      userApprovalRequired: true,
      scopeCounts: { capsules: 2, documents: 11, vectors: 39 },
    });

    const startedResponse = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion, requestId: "reindex-integration-test" }),
    });
    const started = await readJson<UpdateSession>(startedResponse);

    expect(startedResponse.status).toBe(202);
    expect(started).toMatchObject({
      sessionId: "update-reindex-integration-session",
      targetVersion,
      phase: "preparing",
    });

    const restartRequired = await waitForPhase("restart-required");
    expect(restartRequired.activeSession).toMatchObject({
      targetVersion,
      phase: "restart-required",
      restartRequired: true,
    });

    runningVersion = targetVersion;
    const blockedRestartResponse = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion }),
    });
    const blockedRestart = await readJson<UpdateSession>(blockedRestartResponse);

    expect(blockedRestartResponse.status).toBe(200);
    expect(blockedRestart).toMatchObject({
      targetVersion,
      phase: "restart-required",
      restartRequired: false,
    });
    expect(blockedRestart.message).toContain("Complete remaining remediation");

    const actionResponse = await fetch(`${baseUrl()}/api/update/remediation/actions`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({
        actionId: "local-knowledge-reindex:local-knowledge",
        targetVersion,
        impact,
        decision: "run",
      }),
    });
    const completedRemediation = await readJson<UpdateRemediationStatusReport>(actionResponse);

    expect(actionResponse.status).toBe(200);
    expect(localKnowledge.runs()).toBe(1);
    expect(completedRemediation).toMatchObject({
      targetVersion,
      overallStatus: "completed",
      updateCanComplete: true,
    });
    expect(completedRemediation.actions[0]).toMatchObject({
      actionId: "local-knowledge-reindex:local-knowledge",
      status: "completed",
    });

    const verifiedResponse = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion }),
    });
    const verified = await readJson<UpdateSession>(verifiedResponse);
    const finalStatus = await updateSessionStatus();

    expect(verifiedResponse.status).toBe(200);
    expect(verified).toMatchObject({
      targetVersion,
      phase: "succeeded",
      restartRequired: false,
    });
    expect(finalStatus.activeSession).toBeUndefined();
    expect(finalStatus.lastSession).toMatchObject({ targetVersion, phase: "succeeded" });
  });

  it("uses explicit injected updater seams when automatic update is unsupported", async () => {
    const targetVersion = nextPatchVersion(SDK_VERSION);
    const updateSession = createUpdateSessionManager({
      processEnv: {},
      detector: () => manualInstallMode(),
      currentVersion: () => SDK_VERSION,
      idFactory: () => "manual-install-integration-session",
      now: () => FIXED_NOW,
      redactor: (value) => value,
    });
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: join(staticRoot, "evidence"),
      env: {
        KEIKO_STATE_DIR: join(staticRoot, "state"),
        KEIKO_SIMULATE_UPDATE_AVAILABLE: "1",
        KEIKO_SIMULATED_UPDATE_TARGET_VERSION: targetVersion,
        KEIKO_SIMULATED_UPDATE_MANUAL_INSTALL_REQUIRED: "1",
      },
      uiDbPath: join(staticRoot, "ui.db"),
      modelPortFactory: (): undefined => undefined,
      updatePreflight: fixedUpdatePreflight(syntheticPreflightReport(targetVersion)),
      updateSession,
    });
    await buildServer(deps);

    const preflightResponse = await fetch(`${baseUrl()}/api/update/preflight`);
    const preflight = await readJson<UpdatePreflightReport>(preflightResponse);

    expect(preflightResponse.status).toBe(200);
    expect(preflight).toMatchObject({
      currentVersion: SDK_VERSION,
      targetVersion,
      updateAvailable: true,
      status: "update-available",
      oneClickEligible: true,
      manualUpdateRequired: false,
    });

    const sessionStatusResponse = await fetch(`${baseUrl()}/api/update/session`);
    const sessionStatus = await readJson<UpdateSessionStatus>(sessionStatusResponse);

    expect(sessionStatusResponse.status).toBe(200);
    expect(sessionStatus).toMatchObject({
      installMode: {
        status: "unsupported",
        reason: "manifest-unavailable",
        manualInstructions:
          "Automatic update is unavailable: this simulated state requires a manual package install. Use your package manager outside Keiko, then restart Keiko.",
      },
    });

    const startedResponse = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion, requestId: "manual-install-integration-test" }),
    });
    const started = await readJson<{ readonly error: { readonly code: string } }>(startedResponse);

    expect(startedResponse.status).toBe(409);
    expect(started.error.code).toBe("UPDATE_INSTALL_MODE_UNSUPPORTED");
    expect(sessionStatus.activeSession).toBeUndefined();
    expect(sessionStatus.lastSession).toBeUndefined();
  });

  it("does not fabricate Local Knowledge remediation from env flags alone", async () => {
    const targetVersion = nextPatchVersion(SDK_VERSION);
    const deps = buildUiHandlerDeps({
      configPath: undefined,
      evidenceDir: join(staticRoot, "evidence"),
      env: {
        KEIKO_STATE_DIR: join(staticRoot, "state"),
        KEIKO_SIMULATED_UPDATE_REINDEX_REQUIRED: "1",
      },
      uiDbPath: join(staticRoot, "ui.db"),
      modelPortFactory: (): undefined => undefined,
      updatePreflight: fixedUpdatePreflight(
        syntheticPreflightReport(targetVersion, { localKnowledgeReindexRequired: true }),
      ),
    });
    await buildServer(deps);

    const preflightResponse = await fetch(`${baseUrl()}/api/update/preflight`);
    const preflight = await readJson<UpdatePreflightReport>(preflightResponse);
    const impact = impactInput(preflight);
    const remediationStatusResponse = await fetch(`${baseUrl()}/api/update/remediation/status`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion, impact, persist: true }),
    });
    const remediationStatus =
      await readJson<UpdateRemediationStatusReport>(remediationStatusResponse);

    expect(preflightResponse.status).toBe(200);
    expect(preflight.impact?.remediations).toEqual(["local-knowledge-reindex-required"]);
    expect(remediationStatusResponse.status).toBe(200);
    expect(remediationStatus).toMatchObject({
      targetVersion,
      overallStatus: "not-required",
      updateCanComplete: true,
      affectedFeatures: [
        {
          featureId: "local-knowledge",
          label: "Local Knowledge",
          state: "ready",
        },
      ],
    });
    expect(remediationStatus.actions[0]).toMatchObject({
      actionId: "local-knowledge-reindex:local-knowledge",
      status: "not-needed",
      required: false,
      scopeCounts: { capsules: 0, documents: 0, vectors: 0 },
      message: "No Local Knowledge capsules are present.",
    });
  });
});
