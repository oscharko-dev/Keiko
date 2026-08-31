import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { bindSecurityLogCorrelation, type SecurityLogSink } from "@oscharko-dev/keiko-security";
import type {
  UpdatePortableActivationSummary,
  UpdatePortableStagingSummary,
} from "@oscharko-dev/keiko-contracts";
import type { UpdateRuntimeFacts } from "./update-install-mode.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";
import {
  activationIdFor,
  beginPortableActivationRecovery,
  clearPortableActivationRecovery,
  capturePortableRegistration,
  cleanupPortableRegistrationSnapshot,
  commitPortableActivationCleanup,
  PortableUpdateActivationError,
  promotePortableInstall,
  readPortableActivationRecovery,
  recoveryPaths,
  refreshPortableRegistration,
  refreshPortableShortcut,
  restorePortableActivation,
  restorePortableRegistration,
  type PortableActivationCleanupOptions,
  type PortableActivationRecovery,
  type PortableActivationLayout,
  type PortablePromotionResult,
  writePortableActivationRecovery,
} from "./update-portable-activation-files.js";

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type SleepFn = (ms: number) => Promise<void>;
type VersionVerifier = (targetVersion: string, signal: AbortSignal | undefined) => Promise<boolean>;

export interface PortableUpdateActivateInput {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly stage: UpdatePortableStagingSummary;
  readonly runtimeFacts?: UpdateRuntimeFacts | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PortableUpdateActivator {
  readonly activate: (
    input: PortableUpdateActivateInput,
  ) => Promise<UpdatePortableActivationSummary>;
}

export interface PortableUpdateActivatorOptions {
  readonly env: EnvSource;
  readonly localState?: UpdateLocalStateManager | undefined;
  readonly spawnFn?: SpawnFn | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly now?: (() => number) | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly versionVerifier?: VersionVerifier | undefined;
  readonly relaunchTimeoutMs?: number | undefined;
  // Forwarded to `refreshPortableShortcut` (update-portable-activation-files.js): a hostile or
  // malformed SystemRoot/WINDIR encountered while creating or verifying the Windows Start Menu
  // shortcut is logged through this sink instead of only degrading to `shortcutRefreshed: false`.
  readonly securityLogSink?: SecurityLogSink | undefined;
  // Test seam for Windows backup-delete deferral; production omits these and uses process values.
  readonly platform?: NodeJS.Platform | undefined;
  readonly execPath?: string | undefined;
}

export { PortableUpdateActivationError } from "./update-portable-activation-files.js";

const DEFAULT_RELAUNCH_TIMEOUT_MS = 30_000;
const HEALTH_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
const activePortableStateDirs = new Set<string>();

function assertAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PortableUpdateActivationError("cancelled", "portable activation was cancelled");
  }
}

// Returns the spawned child so the rollback path can terminate it (KEIKO-0493). The process is
// still unref'd — this server must never keep the event loop alive for the relaunch — but a
// cancellation landing between here and the relaunch's own version-verification poll would
// otherwise roll back the promoted layout underneath a live process that is starting up against
// exactly those files.
function requestRelaunch(layout: PortableActivationLayout, spawnFn: SpawnFn): ChildProcess {
  try {
    const child = spawnFn(layout.launcherPath, [], { detached: true, stdio: "ignore" });
    child.unref();
    return child;
  } catch {
    throw new PortableUpdateActivationError(
      "portable-relaunch-failed",
      "portable relaunch could not be started",
    );
  }
}

function healthUrl(env: EnvSource): string | undefined {
  const host = env.KEIKO_UI_HOST ?? "127.0.0.1";
  const port = env.KEIKO_UI_PORT;
  if (!HEALTH_HOSTS.has(host) || port === undefined || !/^\d{1,5}$/u.test(port)) return undefined;
  const parsedPort = Number(port);
  if (parsedPort < 1 || parsedPort > 65535) return undefined;
  return `http://${host}:${port}/api/health`;
}

function healthVersion(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const version = (body as { readonly version?: unknown }).version;
  return typeof version === "string" ? version : undefined;
}

async function probeHealth(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? healthVersion(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

async function defaultVerifyRelaunch(
  options: PortableUpdateActivatorOptions,
  targetVersion: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const url = healthUrl(options.env);
  if (url === undefined) return false;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + (options.relaunchTimeoutMs ?? DEFAULT_RELAUNCH_TIMEOUT_MS);
  while (Date.now() <= deadline) {
    assertAbort(signal);
    if ((await probeHealth(fetchImpl, url)) === targetVersion) return true;
    await sleep(500);
  }
  return false;
}

function recordActivation(
  options: PortableUpdateActivatorOptions,
  summary: UpdatePortableActivationSummary,
): void {
  const localState = options.localState;
  if (localState === undefined) return;
  const current = localState.readRuntimeState();
  localState.writeRuntimeState({
    ...current,
    targetVersion: summary.packageVersion,
    portableActivation: summary,
  });
  localState.recordAuditEvent("portable-activation-result", {
    targetVersion: summary.packageVersion,
    store: "package-install",
    status: "succeeded",
    portableStageId: summary.stageId,
    portableActivationId: summary.activationId,
    portableTarget: summary.target,
  });
  localState.recordAuditEvent("portable-relaunch-result", {
    targetVersion: summary.packageVersion,
    store: "package-install",
    status: "succeeded",
    portableStageId: summary.stageId,
    portableActivationId: summary.activationId,
    portableTarget: summary.target,
  });
}

function recordFailure(
  options: PortableUpdateActivatorOptions,
  input: PortableUpdateActivateInput,
  activationId: string,
): void {
  options.localState?.recordAuditEvent("portable-activation-result", {
    targetVersion: input.targetVersion,
    store: "package-install",
    status: "failed",
    portableStageId: input.stage.stageId,
    portableActivationId: activationId,
    portableTarget: input.stage.target,
  });
}

function buildSummary(input: {
  readonly activationId: string;
  readonly stage: UpdatePortableStagingSummary;
  readonly targetVersion: string;
  readonly shortcutRefreshed: boolean;
}): UpdatePortableActivationSummary {
  return {
    activationId: input.activationId,
    status: "activated",
    stageId: input.stage.stageId,
    target: input.stage.target,
    packageVersion: input.targetVersion,
    registrationRefreshed: true,
    shortcutRefreshed: input.shortcutRefreshed,
    relaunchRequested: true,
    versionVerified: true,
  };
}

async function verifyRelaunch(
  options: PortableUpdateActivatorOptions,
  input: PortableUpdateActivateInput,
): Promise<void> {
  const verifier =
    options.versionVerifier ??
    ((target, signal): Promise<boolean> => defaultVerifyRelaunch(options, target, signal));
  if (!(await verifier(input.targetVersion, input.signal))) {
    throw new PortableUpdateActivationError(
      "portable-version-verification-failed",
      "portable relaunch version was not verified",
    );
  }
}

function portableStateDir(
  options: PortableUpdateActivatorOptions,
  request: PortableUpdateActivateInput,
): string {
  return request.runtimeFacts?.portableStateDir ?? options.env.KEIKO_STATE_DIR ?? ".keiko";
}

function activationCleanupOptions(
  options: PortableUpdateActivatorOptions,
  updaterPid?: number,
): PortableActivationCleanupOptions {
  return {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    ...(updaterPid === undefined ? {} : { updaterPid }),
  };
}

function boundActivationCleanupSink(
  sink: SecurityLogSink | undefined,
): { readonly securityLogSink: SecurityLogSink } | Record<string, never> {
  return sink === undefined ? {} : { securityLogSink: sink };
}

function settleInterruptedActivation(input: {
  readonly stateDir: string;
  readonly request: PortableUpdateActivateInput;
  readonly options: PortableUpdateActivatorOptions;
}): "idle" | "deferred" {
  const recovery = readPortableActivationRecovery(input.stateDir);
  if (recovery === undefined) return "idle";
  const securityLogSink = activationLogSinkFromRaw(
    input.options.securityLogSink,
    recovery.activationId,
  );
  const paths = recoveryPaths({
    target: recovery.target,
    stageId: recovery.stageId,
    runtimeFacts: input.request.runtimeFacts,
    activationId: recovery.activationId,
  });
  if (recovery.phase === "verified" || recovery.phase === "cleanup-pending") {
    const outcome = commitPortableActivationCleanup({
      stateDir: input.stateDir,
      paths,
      recovery,
      cleanup: activationCleanupOptions(input.options, recovery.updaterPid),
      ...boundActivationCleanupSink(securityLogSink),
    });
    return outcome === "deferred" ? "deferred" : "idle";
  }
  restorePortableRegistration({ stateDir: input.stateDir, activationId: recovery.activationId });
  restorePortableActivation(paths, securityLogSink);
  cleanupPortableRegistrationSnapshot({
    stateDir: input.stateDir,
    activationId: recovery.activationId,
  });
  clearPortableActivationRecovery(input.stateDir);
  return "idle";
}

function assertActivationSettlementIdle(settlement: "idle" | "deferred"): void {
  if (settlement === "deferred") {
    throw new PortableUpdateActivationError(
      "portable-activation-failed",
      "portable activation recovery is pending",
    );
  }
}

function prepareActivation(input: {
  readonly request: PortableUpdateActivateInput;
  readonly activationId: string;
  readonly securityLogSink?: SecurityLogSink | undefined;
}): PortablePromotionResult {
  return promotePortableInstall(input.request, input.activationId, input.securityLogSink);
}

function activationLogSinkFromRaw(
  sink: SecurityLogSink | undefined,
  correlationId: string,
): SecurityLogSink | undefined {
  return bindSecurityLogCorrelation(sink, correlationId);
}

function activationLogSink(
  options: PortableUpdateActivatorOptions,
  correlationId: string,
): SecurityLogSink | undefined {
  return bindSecurityLogCorrelation(options.securityLogSink, correlationId);
}

function finishPreparedActivation(
  input: {
    readonly options: PortableUpdateActivatorOptions;
    readonly request: PortableUpdateActivateInput;
    readonly correlationId: string;
  },
  promoted: PortablePromotionResult,
): { readonly shortcutRefreshed: boolean; readonly layout: PortableActivationLayout } {
  const home = input.options.homedir?.() ?? homedir();
  refreshPortableRegistration({
    stateDir: portableStateDir(input.options, input.request),
    layout: promoted.layout,
    target: input.request.stage.target,
    env: input.options.env,
    home,
    now: input.options.now?.() ?? Date.now(),
  });
  const shortcutRefreshed = refreshPortableShortcut({
    target: input.request.stage.target,
    layout: promoted.layout,
    env: input.options.env,
    home,
    securityLogSink: activationLogSink(input.options, input.correlationId),
  });
  return { shortcutRefreshed, layout: promoted.layout };
}

interface ActivationContext {
  readonly options: PortableUpdateActivatorOptions;
  readonly request: PortableUpdateActivateInput;
  readonly activationId: string;
  readonly stateDir: string;
}

interface ActivationProgress {
  promoted?: PortablePromotionResult | undefined;
  recoveryPhase?: PortableActivationRecovery["phase"] | undefined;
  // The relaunch child, once spawned, so a rollback can terminate it before reverting the
  // layout it was launched against (KEIKO-0493).
  relaunchChild?: ChildProcess | undefined;
}

function recoveryRecord(
  context: ActivationContext,
  phase: PortableActivationRecovery["phase"],
  updaterPid?: number,
): PortableActivationRecovery {
  return {
    activationId: context.activationId,
    stageId: context.request.stage.stageId,
    target: context.request.stage.target,
    phase,
    ...(updaterPid === undefined ? {} : { updaterPid }),
  };
}

function preparePortablePromotion(
  context: ActivationContext,
  progress: ActivationProgress,
): {
  readonly shortcutRefreshed: boolean;
  readonly layout: PortableActivationLayout;
  readonly promotion: PortablePromotionResult;
} {
  assertAbort(context.request.signal);
  assertActivationSettlementIdle(
    settleInterruptedActivation({
      stateDir: context.stateDir,
      request: context.request,
      options: context.options,
    }),
  );
  beginPortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "prepared"),
  });
  progress.recoveryPhase = "prepared";
  const promoted = prepareActivation({
    request: context.request,
    activationId: context.activationId,
    securityLogSink: activationLogSink(context.options, context.activationId),
  });
  progress.promoted = promoted;
  writePortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "promoted"),
  });
  progress.recoveryPhase = "promoted";
  capturePortableRegistration({ stateDir: context.stateDir, activationId: context.activationId });
  const prepared = finishPreparedActivation(
    {
      options: context.options,
      request: context.request,
      correlationId: context.activationId,
    },
    promoted,
  );
  writePortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "registered"),
  });
  progress.recoveryPhase = "registered";
  return { ...prepared, promotion: promoted };
}

async function verifyAndCommitPromotion(
  context: ActivationContext,
  progress: ActivationProgress,
  prepared: {
    readonly layout: PortableActivationLayout;
    readonly promotion: PortablePromotionResult;
  },
): Promise<void> {
  progress.relaunchChild = requestRelaunch(prepared.layout, context.options.spawnFn ?? spawn);
  await verifyRelaunch(context.options, context.request);
  writePortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "verified", process.pid),
  });
  progress.recoveryPhase = "verified";
  const outcome = commitPortableActivationCleanup({
    stateDir: context.stateDir,
    paths: prepared.promotion.paths,
    recovery: recoveryRecord(context, "verified", process.pid),
    cleanup: activationCleanupOptions(context.options, process.pid),
    ...boundActivationCleanupSink(activationLogSink(context.options, context.activationId)),
  });
  progress.recoveryPhase = outcome === "deferred" ? "cleanup-pending" : undefined;
}

function isCommittedActivationPhase(
  phase: PortableActivationRecovery["phase"] | undefined,
): boolean {
  return phase === "verified" || phase === "cleanup-pending";
}

function committedActivationOnDisk(stateDir: string): boolean {
  try {
    return isCommittedActivationPhase(readPortableActivationRecovery(stateDir)?.phase);
  } catch {
    return false;
  }
}

function restoreFailedPromotion(context: ActivationContext, progress: ActivationProgress): void {
  if (isCommittedActivationPhase(progress.recoveryPhase)) return;
  if (committedActivationOnDisk(context.stateDir)) return;
  if (progress.recoveryPhase === undefined) return;
  try {
    // KEIKO-0493: terminate a relaunch that was already spawned before reverting the layout it
    // was launched against, so a cancelled activation cannot leave a live process running on
    // files that are about to be rolled back — or race its own startup reads against those
    // writes. Best-effort and non-blocking by design: this function is documented to stay
    // best-effort so the recovery marker remains authoritative even if cleanup partly fails,
    // and waiting for the child to fully exit would break that contract.
    try {
      progress.relaunchChild?.kill();
    } catch {
      // A child that already exited (or cannot be signalled) needs no rollback action.
    }
    const paths =
      progress.promoted?.paths ??
      recoveryPaths({
        target: context.request.stage.target,
        stageId: context.request.stage.stageId,
        runtimeFacts: context.request.runtimeFacts,
        activationId: context.activationId,
      });
    restorePortableActivation(paths, activationLogSink(context.options, context.activationId));
    restorePortableRegistration({ stateDir: context.stateDir, activationId: context.activationId });
    cleanupPortableRegistrationSnapshot({
      stateDir: context.stateDir,
      activationId: context.activationId,
    });
    clearPortableActivationRecovery(context.stateDir);
  } catch {
    // The recovery marker remains authoritative and blocks further promotion until restart recovery.
  }
}

function activationError(error: unknown): PortableUpdateActivationError {
  if (error instanceof PortableUpdateActivationError) return error;
  return new PortableUpdateActivationError(
    "portable-activation-failed",
    "portable activation failed",
  );
}

async function activatePortableUpdate(
  options: PortableUpdateActivatorOptions,
  input: PortableUpdateActivateInput,
): Promise<UpdatePortableActivationSummary> {
  const context: ActivationContext = {
    options,
    request: input,
    activationId: activationIdFor(input),
    stateDir: portableStateDir(options, input),
  };
  const progress: ActivationProgress = {};
  try {
    const prepared = preparePortablePromotion(context, progress);
    await verifyAndCommitPromotion(context, progress, prepared);
    const summary = buildSummary({
      activationId: context.activationId,
      stage: input.stage,
      targetVersion: input.targetVersion,
      shortcutRefreshed: prepared.shortcutRefreshed,
    });
    recordActivation(options, summary);
    return summary;
  } catch (error) {
    restoreFailedPromotion(context, progress);
    recordFailure(options, input, context.activationId);
    throw activationError(error);
  }
}

export function createPortableUpdateActivator(
  options: PortableUpdateActivatorOptions,
): PortableUpdateActivator {
  return {
    activate(input): Promise<UpdatePortableActivationSummary> {
      const stateDir = portableStateDir(options, input);
      if (activePortableStateDirs.has(stateDir)) {
        return Promise.reject(
          new PortableUpdateActivationError(
            "portable-activation-failed",
            "portable activation recovery is pending",
          ),
        );
      }
      activePortableStateDirs.add(stateDir);
      return activatePortableUpdate(options, input).finally(() => {
        activePortableStateDirs.delete(stateDir);
      });
    },
  };
}
