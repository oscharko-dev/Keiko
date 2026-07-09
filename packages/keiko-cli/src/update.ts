import {
  type ReleaseImpactRemediation,
  type UpdatePreflightReport,
  type UpdateReleaseImpactInput,
  type UpdateRemediationStatusReport,
  type UpdateSession,
  type UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type {
  UiHandlerDeps,
  UpdatePreflightService,
  UpdateRemediationManager,
  UpdateSessionManager,
} from "@oscharko-dev/keiko-server";
// GEN-PERF-CLI-001 — server/evidence graphs load at dispatch; module scope stays type-only.
import { loadEvidence, loadServer } from "./lazy-modules.js";
import type { CliIo } from "./runner.js";
import {
  isPortableManagedInstallMode,
  renderApplyTerminal,
  renderUpdateStatus,
} from "./update-output.js";
import { resolveStateDir as resolveRuntimeStateDir } from "./state-paths.js";

type ServerModule = typeof import("@oscharko-dev/keiko-server");
type EvidenceModule = typeof import("@oscharko-dev/keiko-evidence");

const USAGE = `Usage:
  keiko update status
  keiko update check
  keiko update apply

Support-oriented governed updater commands. The UI remains the primary update
surface; these commands expose the same policy, install-mode, release-impact,
and remediation concepts for headless or support workflows.
`;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

type UpdateSubcommand = "status" | "check" | "apply";
type SleepFn = (ms: number) => Promise<void>;

export interface UpdateCliPreflight {
  readonly getStartupReport: () => Promise<UpdatePreflightReport>;
  readonly runManualCheck: () => Promise<UpdatePreflightReport>;
}

export interface UpdateCliDeps {
  readonly preflight?: UpdateCliPreflight | undefined;
  readonly session?: UpdateSessionManager | undefined;
  readonly remediation?: UpdateRemediationManager | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly cwd?: string | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly maxWaitMs?: number | undefined;
}

interface UpdateRuntime {
  readonly preflight: UpdateCliPreflight;
  readonly session: UpdateSessionManager;
  readonly remediation: UpdateRemediationManager;
  readonly server?: ServerModule | undefined;
  readonly close: () => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, ms);
  });
}

function processEnvFrom(env: EnvSource): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function stringRedactor(env: EnvSource, server: ServerModule): (input: string) => string {
  const redact = server.buildRedactor(env);
  return (input: string): string => {
    const redacted = redact(input);
    return typeof redacted === "string" ? redacted : "[redacted]";
  };
}

function bindPreflight(
  service: UpdatePreflightService,
  handlerDeps: UiHandlerDeps,
): UpdateCliPreflight {
  return {
    getStartupReport: (): Promise<UpdatePreflightReport> => service.getStartupReport(handlerDeps),
    runManualCheck: (): Promise<UpdatePreflightReport> => service.runManualCheck(handlerDeps),
  };
}

function createHandlerDeps(
  env: EnvSource,
  fetchImpl: typeof fetch | undefined,
  server: ServerModule,
  evidence: EvidenceModule,
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: evidence.createInMemoryEvidenceStore(),
    env,
    redactor: server.buildRedactor(env),
    registry: server.createRunRegistry(),
    modelPortFactory: () => undefined,
    store: server.createInMemoryUiStore(),
    ...(fetchImpl === undefined ? {} : { gatewayReadinessFetch: fetchImpl }),
  };
}

function injectedRuntime(deps: UpdateCliDeps): UpdateRuntime | undefined {
  if (
    deps.preflight === undefined ||
    deps.session === undefined ||
    deps.remediation === undefined
  ) {
    return undefined;
  }
  return {
    preflight: deps.preflight,
    session: deps.session,
    remediation: deps.remediation,
    close: (): undefined => undefined,
  };
}

async function createRuntime(env: EnvSource, deps: UpdateCliDeps): Promise<UpdateRuntime> {
  const injected = injectedRuntime(deps);
  if (injected !== undefined) return injected;
  const [server, evidence] = await Promise.all([loadServer(), loadEvidence()]);
  const handlerDeps = createHandlerDeps(env, deps.fetchImpl, server, evidence);
  const stateDir = resolveRuntimeStateDir(deps.cwd ?? process.cwd(), env);
  const localState = server.createUpdateLocalStateManager({ stateDir });
  const processEnv = processEnvFrom(env);
  const service = server.createUpdatePreflightService();
  return {
    preflight: deps.preflight ?? bindPreflight(service, handlerDeps),
    session:
      deps.session ??
      server.createUpdateSessionManager({
        processEnv,
        lock: server.createStateDirUpdateSessionLock(stateDir),
        redactor: stringRedactor(env, server),
      }),
    remediation: deps.remediation ?? server.createUpdateRemediationManager({ localState }),
    server,
    close: (): void => {
      handlerDeps.store.close();
    },
  };
}

function primaryRemediation(
  remediations: readonly ReleaseImpactRemediation[],
): ReleaseImpactRemediation | undefined {
  return remediations.find((item) => item !== "no-action-required") ?? remediations[0];
}

function impactInput(report: UpdatePreflightReport): UpdateReleaseImpactInput | undefined {
  const impact = report.impact;
  if (impact === undefined) return undefined;
  const remediation = primaryRemediation(impact.remediations);
  return {
    affectedStateStores: impact.affectedStateStores,
    stateImpact: impact.stateImpact,
    userActionRequired: impact.userActionRequired,
    ...(remediation === undefined ? {} : { remediation }),
  };
}

function remediationStatus(
  runtime: UpdateRuntime,
  report: UpdatePreflightReport,
): UpdateRemediationStatusReport {
  return runtime.remediation.getStatus({
    targetVersion: report.targetVersion,
    impact: impactInput(report),
    persist: false,
  });
}

function writeLines(io: CliIo, lines: readonly string[]): void {
  io.out(`${lines.join("\n")}\n`);
}

function parseSubcommand(args: readonly string[]): UpdateSubcommand | "help" | undefined {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") return "help";
  if (subcommand === "status" || subcommand === "check" || subcommand === "apply") {
    return args.length === 1 ? subcommand : undefined;
  }
  return undefined;
}

function noUpdateApplyGuard(report: UpdatePreflightReport): string | undefined {
  if (!report.updateAvailable || report.targetVersion === undefined) return "No update available.";
  return undefined;
}

function portableApplyFallback(): string {
  return [
    "Use the Keiko update window to retry, review technical details,",
    "keep using the current version, or download the latest Keiko release asset manually.",
  ].join(" ");
}

function releaseEligibilityApplyGuard(
  report: UpdatePreflightReport,
  status: UpdateSessionStatus,
): string | undefined {
  if (report.manualUpdateRequired || !report.oneClickEligible) {
    if (isPortableManagedInstallMode(status.installMode)) {
      return `This portable release asset is not eligible for automatic CLI apply. ${portableApplyFallback()}`;
    }
    return "This release is not eligible for automatic CLI apply. Review the blockers and use the manual path.";
  }
  return undefined;
}

function portableCliApplyGuard(status: UpdateSessionStatus): string | undefined {
  if (!isPortableManagedInstallMode(status.installMode)) return undefined;
  return [
    "Portable-managed one-click updates run through the Keiko update window.",
    "Open Keiko and use Review updates to apply, retry, inspect remediation,",
    "or download the latest release asset manually.",
  ].join(" ");
}

function policyApplyGuard(status: UpdateSessionStatus): string | undefined {
  if (status.policy.enabled) return undefined;
  if (isPortableManagedInstallMode(status.installMode)) {
    return `${status.policy.reason ?? "Portable self-update is disabled by policy."} ${portableApplyFallback()}`;
  }
  return `${status.policy.reason ?? "Package mutation is disabled."} Use your package manager outside Keiko, then restart Keiko.`;
}

function installModeApplyGuard(status: UpdateSessionStatus): string | undefined {
  if (status.installMode.status === "supported") return undefined;
  if (
    isPortableManagedInstallMode(status.installMode) ||
    status.installMode.installKind?.startsWith("portable-") === true
  ) {
    return (
      status.installMode.manualInstructions ??
      [
        "Portable self-update is unavailable for this install.",
        "Keep using the current version, choose a managed user-writable install location",
        "when setup asks, or download the latest release asset manually.",
      ].join(" ")
    );
  }
  return (
    status.installMode.manualInstructions ??
    "Automatic update is unavailable. Use your package manager outside Keiko, then restart Keiko."
  );
}

function remediationApplyGuard(remediation: UpdateRemediationStatusReport): string | undefined {
  if (
    remediation.overallStatus === "manual-review-required" ||
    remediation.overallStatus === "failed"
  ) {
    return "Required remediation needs manual review before the update can be completed.";
  }
  return undefined;
}

function applyGuard(
  report: UpdatePreflightReport,
  status: UpdateSessionStatus,
  remediation: UpdateRemediationStatusReport,
): string | undefined {
  return (
    noUpdateApplyGuard(report) ??
    policyApplyGuard(status) ??
    installModeApplyGuard(status) ??
    releaseEligibilityApplyGuard(report, status) ??
    portableCliApplyGuard(status) ??
    remediationApplyGuard(remediation)
  );
}

function terminalSessionFor(
  status: UpdateSessionStatus,
  sessionId: string,
): UpdateSession | undefined {
  for (const session of [status.activeSession, status.lastSession]) {
    if (session?.sessionId === sessionId) return session;
  }
  return undefined;
}

function isTerminal(session: UpdateSession): boolean {
  return (
    session.phase === "restart-required" ||
    session.phase === "succeeded" ||
    session.phase === "failed" ||
    session.phase === "cancelled"
  );
}

async function waitForTerminalSession(
  manager: UpdateSessionManager,
  sessionId: string,
  sleep: SleepFn,
  pollIntervalMs: number,
  maxWaitMs: number,
): Promise<UpdateSession | undefined> {
  for (let elapsed = 0; elapsed <= maxWaitMs; elapsed += pollIntervalMs) {
    const session = terminalSessionFor(manager.getStatus(), sessionId);
    if (session !== undefined && isTerminal(session)) return session;
    await sleep(pollIntervalMs);
  }
  return terminalSessionFor(manager.getStatus(), sessionId);
}

function successfulApply(session: UpdateSession | undefined): boolean {
  return session?.phase === "restart-required" || session?.phase === "succeeded";
}

function applyGuardExitCode(report: UpdatePreflightReport): number {
  return report.updateAvailable ? 1 : 0;
}

function writeApplyGuard(io: CliIo, report: UpdatePreflightReport, guard: string): void {
  const line = `keiko update apply: ${guard}\n`;
  if (report.updateAvailable) io.err(line);
  else io.out(line);
}

function targetVersionForApply(report: UpdatePreflightReport, io: CliIo): string | undefined {
  if (report.targetVersion !== undefined) return report.targetVersion;
  io.err("keiko update apply: No target version was available.\n");
  return undefined;
}

async function runStatus(runtime: UpdateRuntime, io: CliIo): Promise<number> {
  const report = await runtime.preflight.getStartupReport();
  const status = runtime.session.getStatus();
  writeLines(
    io,
    renderUpdateStatus({
      title: "Keiko update status",
      report,
      status,
      remediation: remediationStatus(runtime, report),
    }),
  );
  return 0;
}

async function runCheck(runtime: UpdateRuntime, io: CliIo): Promise<number> {
  const report = await runtime.preflight.runManualCheck();
  const status = runtime.session.getStatus();
  writeLines(
    io,
    renderUpdateStatus({
      title: "Keiko update check",
      report,
      status,
      remediation: remediationStatus(runtime, report),
    }),
  );
  return 0;
}

async function runApply(runtime: UpdateRuntime, io: CliIo, deps: UpdateCliDeps): Promise<number> {
  const report = await runtime.preflight.runManualCheck();
  const status = runtime.session.getStatus();
  const remediation = remediationStatus(runtime, report);
  writeLines(io, renderUpdateStatus({ title: "Keiko update apply", report, status, remediation }));
  const guard = applyGuard(report, status, remediation);
  if (guard !== undefined) {
    writeApplyGuard(io, report, guard);
    return applyGuardExitCode(report);
  }
  const targetVersion = targetVersionForApply(report, io);
  if (targetVersion === undefined) {
    return 1;
  }
  const started = runtime.session.start({ targetVersion });
  io.out(`Update session: ${started.reused ? "reused" : "started"} for ${targetVersion}\n`);
  const terminal = await waitForTerminalSession(
    runtime.session,
    started.session.sessionId,
    deps.sleep ?? defaultSleep,
    deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  );
  writeLines(io, renderApplyTerminal(terminal, status));
  return successfulApply(terminal) ? 0 : 1;
}

function safeErrorMessage(error: unknown, server: ServerModule | undefined): string {
  if (server !== undefined && error instanceof server.UpdateSessionError) return error.message;
  return "Unexpected update command failure.";
}

export async function runUpdateCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UpdateCliDeps = {},
): Promise<number> {
  const subcommand = parseSubcommand(args);
  if (subcommand === "help") {
    io.out(USAGE);
    return 0;
  }
  if (subcommand === undefined) {
    io.err(USAGE);
    return 2;
  }
  let runtime: UpdateRuntime | undefined;
  try {
    runtime = await createRuntime(env, deps);
    if (subcommand === "status") return await runStatus(runtime, io);
    if (subcommand === "check") return await runCheck(runtime, io);
    return await runApply(runtime, io, deps);
  } catch (error) {
    io.err(`keiko update ${subcommand}: ${safeErrorMessage(error, runtime?.server)}\n`);
    return 1;
  } finally {
    runtime?.close();
  }
}
