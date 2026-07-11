import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { UpdatePortableActivationSummary } from "@oscharko-dev/keiko-contracts";
import type { UpdateRuntimeFacts } from "./update-install-mode.js";
import type { UpdateLocalStateManager } from "./update-local-state.js";
import {
  activationIdFor,
  beginPortableActivationRecovery,
  clearPortableActivationRecovery,
  capturePortableRegistration,
  cleanupPortableRegistrationSnapshot,
  cleanupPortableActivation,
  PortableUpdateActivationError,
  promotePortableInstall,
  readPortableActivationRecovery,
  recoveryPaths,
  refreshPortableRegistration,
  refreshPortableShortcut,
  restorePortableActivation,
  restorePortableRegistration,
  type PortableActivationRecovery,
  type PortableActivationLayout,
  type PortablePromotionResult,
  writePortableActivationRecovery,
} from "./update-portable-activation-files.js";
import type { UpdatePortableStagingSummary } from "@oscharko-dev/keiko-contracts";

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

function requestRelaunch(layout: PortableActivationLayout, spawnFn: SpawnFn): void {
  try {
    const child = spawnFn(layout.launcherPath, [], { detached: true, stdio: "ignore" });
    child.unref();
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

function settleInterruptedActivation(input: {
  readonly stateDir: string;
  readonly request: PortableUpdateActivateInput;
}): void {
  const recovery = readPortableActivationRecovery(input.stateDir);
  if (recovery === undefined) return;
  const paths = recoveryPaths({
    target: recovery.target,
    stageId: recovery.stageId,
    runtimeFacts: input.request.runtimeFacts,
    activationId: recovery.activationId,
  });
  if (recovery.phase === "verified") cleanupPortableActivation(paths);
  else {
    restorePortableRegistration({ stateDir: input.stateDir, activationId: recovery.activationId });
    restorePortableActivation(paths);
  }
  cleanupPortableRegistrationSnapshot({
    stateDir: input.stateDir,
    activationId: recovery.activationId,
  });
  clearPortableActivationRecovery(input.stateDir);
}

function prepareActivation(input: {
  readonly request: PortableUpdateActivateInput;
  readonly activationId: string;
}): PortablePromotionResult {
  return promotePortableInstall(input.request, input.activationId);
}

function finishPreparedActivation(
  input: {
    readonly options: PortableUpdateActivatorOptions;
    readonly request: PortableUpdateActivateInput;
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
}

function recoveryRecord(
  context: ActivationContext,
  phase: PortableActivationRecovery["phase"],
): PortableActivationRecovery {
  return {
    activationId: context.activationId,
    stageId: context.request.stage.stageId,
    target: context.request.stage.target,
    phase,
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
  settleInterruptedActivation({ stateDir: context.stateDir, request: context.request });
  beginPortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "prepared"),
  });
  progress.recoveryPhase = "prepared";
  const promoted = prepareActivation({
    request: context.request,
    activationId: context.activationId,
  });
  progress.promoted = promoted;
  writePortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "promoted"),
  });
  progress.recoveryPhase = "promoted";
  capturePortableRegistration({ stateDir: context.stateDir, activationId: context.activationId });
  const prepared = finishPreparedActivation(
    { options: context.options, request: context.request },
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
  requestRelaunch(prepared.layout, context.options.spawnFn ?? spawn);
  await verifyRelaunch(context.options, context.request);
  writePortableActivationRecovery({
    stateDir: context.stateDir,
    recovery: recoveryRecord(context, "verified"),
  });
  progress.recoveryPhase = "verified";
  cleanupPortableActivation(prepared.promotion.paths);
  cleanupPortableRegistrationSnapshot({
    stateDir: context.stateDir,
    activationId: context.activationId,
  });
  clearPortableActivationRecovery(context.stateDir);
  progress.recoveryPhase = undefined;
}

function restoreFailedPromotion(context: ActivationContext, progress: ActivationProgress): void {
  if (progress.recoveryPhase === undefined || progress.recoveryPhase === "verified") return;
  try {
    const paths =
      progress.promoted?.paths ??
      recoveryPaths({
        target: context.request.stage.target,
        stageId: context.request.stage.stageId,
        runtimeFacts: context.request.runtimeFacts,
        activationId: context.activationId,
      });
    restorePortableActivation(paths);
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
