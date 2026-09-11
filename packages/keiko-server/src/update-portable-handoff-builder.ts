import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";
import {
  activationIdFor,
  capturePortableRegistration,
  cleanupPortableRegistrationSnapshot,
  portableRegistrationDocument,
  resolvePortableHandoffLayouts,
  type PortableActivationFileInput,
} from "./update-portable-activation-files.js";
import {
  createPortableHandoffPlan,
  portableHandoffRoot,
  writePortableHandoffPlan,
  type PortableHandoffPlan,
  type WindowsPortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  assertPortableHandoffOperation,
  digestPortableHandoffFile,
  hashPortableHandoffTree,
  portableHandoffOperationFrom,
  PortableHandoffBuilderError,
  type PortableHandoffOperation,
} from "./update-portable-handoff-tree.js";

const PREPARED_REGISTRATION = "registration.next";
const DEFAULT_OPERATION_TIMEOUT_MS = 15 * 60 * 1_000;

export { hashPortableHandoffTree, PortableHandoffBuilderError };
export { PORTABLE_HANDOFF_TREE_HASH_SCHEMA } from "./update-portable-handoff-tree.js";
export type { PortableHandoffOperationOptions } from "./update-portable-handoff-tree.js";

export interface PortableHandoffProcessIdentity {
  readonly pid: number;
  readonly launchId: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly version: string;
}

export interface PortableHandoffPlanBuilderOptions {
  readonly env: EnvSource;
  readonly stateDir: string;
  readonly currentVersion: string;
  readonly currentProcess: () => PortableHandoffProcessIdentity;
  readonly now?: (() => number) | undefined;
  readonly newLaunchId?: (() => string) | undefined;
  readonly restoreLaunchId?: (() => string) | undefined;
  readonly home?: (() => string) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly operationTimeoutMs?: number | undefined;
  readonly operationNow?: (() => number) | undefined;
  readonly yieldControl?: (() => Promise<void>) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}

export interface PortableHandoffPreparedPlan {
  readonly activationId: string;
  readonly plan: PortableHandoffPlan;
  readonly planSha256: string;
}

function fail(message: string): never {
  throw new PortableHandoffBuilderError(message);
}

async function writePreparedRegistration(input: {
  readonly stateDir: string;
  readonly activationId: string;
  readonly content: string;
  readonly operation: PortableHandoffOperation;
}): Promise<string> {
  assertPortableHandoffOperation(input.operation);
  const root = portableHandoffRoot(input.stateDir, input.activationId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(portableHandoffRoot(input.stateDir, input.activationId), PREPARED_REGISTRATION);
  if (existsSync(path)) fail("portable handoff registration is already prepared");
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, input.content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return (await digestPortableHandoffFile(path, input.operation)).toString("hex");
}

function deadlines(now: number): PortableHandoffPlan["deadlines"] {
  return {
    oldExitAt: now + DEFAULT_OPERATION_TIMEOUT_MS,
    startAt: now + DEFAULT_OPERATION_TIMEOUT_MS + 60_000,
    verifyAt: now + DEFAULT_OPERATION_TIMEOUT_MS + 5 * 60_000,
    cleanupAt: now + DEFAULT_OPERATION_TIMEOUT_MS + 10 * 60_000,
  };
}

function builderOperation(options: PortableHandoffPlanBuilderOptions): PortableHandoffOperation {
  const now = options.operationNow ?? Date.now;
  const timeout = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DEFAULT_OPERATION_TIMEOUT_MS) {
    fail("portable handoff operation timeout is invalid");
  }
  return portableHandoffOperationFrom({
    signal: options.signal,
    deadline: now() + timeout,
    now,
    yieldControl: options.yieldControl,
    securityLogSink: options.securityLogSink,
  });
}

interface HandoffProcessIdentities {
  readonly oldProcess: PortableHandoffProcessIdentity;
  readonly newLaunchId: string;
  readonly restoreLaunchId: string;
}

function launchId(factory: (() => string) | undefined): string {
  return factory?.() ?? randomBytes(16).toString("hex");
}

function assertProcessIdentities(
  identities: HandoffProcessIdentities,
  currentVersion: string,
): void {
  if (
    identities.oldProcess.version !== currentVersion ||
    identities.newLaunchId === identities.oldProcess.launchId ||
    identities.restoreLaunchId === identities.oldProcess.launchId ||
    identities.restoreLaunchId === identities.newLaunchId
  ) {
    fail("portable handoff process identity is inconsistent");
  }
}

function processIdentities(options: PortableHandoffPlanBuilderOptions): HandoffProcessIdentities {
  const identities = {
    oldProcess: options.currentProcess(),
    newLaunchId: launchId(options.newLaunchId),
    restoreLaunchId: launchId(options.restoreLaunchId),
  };
  assertProcessIdentities(identities, options.currentVersion);
  return identities;
}

type HandoffLayouts = ReturnType<typeof resolvePortableHandoffLayouts>;
type PreviousRegistration = ReturnType<typeof capturePortableRegistration>;

function requiredPreviousRegistration(input: {
  readonly options: PortableHandoffPlanBuilderOptions;
  readonly activation: PortableActivationFileInput;
  readonly activationId: string;
  readonly layouts: HandoffLayouts;
}): PreviousRegistration {
  const previous = capturePortableRegistration({
    stateDir: input.options.stateDir,
    activationId: input.activationId,
    expectedManagedRootIdentitySha256: createHash("sha256")
      .update(input.layouts.paths.managedRoot, "utf8")
      .digest("hex"),
    expectedTarget: input.activation.stage.target,
    expectedVersion: input.options.currentVersion,
    expectedWindowsGeneration: input.layouts.current.windowsGeneration,
  });
  if (previous.state === "present") return previous;
  cleanupPortableRegistrationSnapshot({
    stateDir: input.options.stateDir,
    activationId: input.activationId,
  });
  fail("portable handoff requires an existing managed registration");
}

interface PreparedRegistrationDigests {
  readonly candidateLauncherSha256: string;
  readonly preparedRegistrationSha256: string;
}

async function prepareRegistrationDigests(input: {
  readonly options: PortableHandoffPlanBuilderOptions;
  readonly activation: PortableActivationFileInput;
  readonly activationId: string;
  readonly layouts: HandoffLayouts;
  readonly operation: PortableHandoffOperation;
  readonly now: number;
}): Promise<PreparedRegistrationDigests> {
  const candidateLauncherSha256 = (
    await digestPortableHandoffFile(input.layouts.candidate.launcherPath, input.operation)
  ).toString("hex");
  const preparedRegistrationSha256 = await writePreparedRegistration({
    stateDir: input.options.stateDir,
    activationId: input.activationId,
    operation: input.operation,
    content: portableRegistrationDocument({
      layout: { ...input.layouts.candidate, installRoot: input.layouts.paths.managedRoot },
      target: input.activation.stage.target,
      env: input.options.env,
      home: input.options.home?.() ?? homedir(),
      now: input.now,
      launcherIdentitySha256: candidateLauncherSha256,
    }),
  });
  return { candidateLauncherSha256, preparedRegistrationSha256 };
}

export async function preparePortableHandoffPlan(
  options: PortableHandoffPlanBuilderOptions,
  activation: PortableActivationFileInput,
  aggregateRevision: number,
): Promise<PortableHandoffPreparedPlan> {
  const operation = builderOperation(options);
  const activationId = activationIdFor(activation);
  const layouts = resolvePortableHandoffLayouts({
    activation,
    activationId,
    currentVersion: options.currentVersion,
  });
  assertWindowsDestinationsVacant(layouts, activationId);
  const identities = processIdentities(options);
  const previousRegistration = requiredPreviousRegistration({
    options,
    activation,
    activationId,
    layouts,
  });
  const now = options.now?.() ?? Date.now();
  const registration = await prepareRegistrationDigests({
    options,
    activation,
    activationId,
    layouts,
    operation,
    now,
  });
  const plan = await buildPortableHandoffPlan({
    activation,
    aggregateRevision,
    activationId,
    layouts,
    ...registration,
    ...identities,
    previousRegistration,
    operation,
  });
  assertPortableHandoffOperation(operation);
  const published = writePortableHandoffPlan({ stateDir: options.stateDir, plan });
  return { activationId, plan, planSha256: published.sha256 };
}

function assertWindowsDestinationsVacant(layouts: HandoffLayouts, activationId: string): void {
  if (layouts.current.windowsGeneration === undefined) return;
  const candidate = layouts.candidate.windowsGeneration;
  if (
    candidate === undefined ||
    candidate.treeSha256 === layouts.current.windowsGeneration.treeSha256
  ) {
    fail("portable Windows handoff generation identity is invalid");
  }
  const generations = join(layouts.paths.managedRoot, ".portable", "generations");
  if (
    existsSync(layouts.paths.backupRoot) ||
    existsSync(join(generations, candidate.treeSha256)) ||
    existsSync(join(generations, `.incoming-${activationId}`))
  ) {
    fail("portable Windows handoff destination is occupied");
  }
}

interface BuildPortableHandoffPlanInput {
  readonly activation: PortableActivationFileInput;
  readonly aggregateRevision: number;
  readonly activationId: string;
  readonly layouts: HandoffLayouts;
  readonly preparedRegistrationSha256: string;
  readonly candidateLauncherSha256: string;
  readonly oldProcess: PortableHandoffProcessIdentity;
  readonly newLaunchId: string;
  readonly restoreLaunchId: string;
  readonly previousRegistration: PreviousRegistration;
  readonly operation: PortableHandoffOperation;
}

async function portableHandoffDigests(
  input: BuildPortableHandoffPlanInput,
): Promise<PortableHandoffPlan["digests"]> {
  const { layouts, operation } = input;
  const currentTreeSha256 = await hashPortableHandoffTree(layouts.paths.managedRoot, operation);
  const candidateTreeSha256 = await hashPortableHandoffTree(layouts.paths.candidateRoot, operation);
  const currentLauncherSha256 = (
    await digestPortableHandoffFile(layouts.current.launcherPath, operation)
  ).toString("hex");
  const currentSupervisorSha256 = (
    await digestPortableHandoffFile(layouts.currentSupervisorPath, operation)
  ).toString("hex");
  const candidateSupervisorSha256 = (
    await digestPortableHandoffFile(layouts.candidateSupervisorPath, operation)
  ).toString("hex");
  return {
    currentTreeSha256,
    candidateTreeSha256,
    currentLauncherSha256,
    currentSupervisorSha256,
    candidateLauncherSha256: input.candidateLauncherSha256,
    candidateSupervisorSha256,
    previousRegistrationSha256: input.previousRegistration.sha256,
    preparedRegistrationSha256: input.preparedRegistrationSha256,
  };
}

type WindowsPlanBinding = Pick<
  WindowsPortableHandoffPlan,
  | "cutoverKind"
  | "currentGenerationTreeSha256"
  | "candidateGenerationTreeSha256"
  | "currentSetupManifestSha256"
  | "candidateSetupManifestSha256"
>;

async function windowsPlanBinding(
  input: BuildPortableHandoffPlanInput,
): Promise<WindowsPlanBinding> {
  const { layouts } = input;
  const currentGeneration = layouts.current.windowsGeneration;
  const candidateGeneration = layouts.candidate.windowsGeneration;
  if (currentGeneration === undefined || candidateGeneration === undefined) {
    fail("portable Windows handoff generation binding is unavailable");
  }
  const currentGenerationTreeSha256 = await hashPortableHandoffTree(
    layouts.current.resourceRoot,
    input.operation,
  );
  const candidateGenerationTreeSha256 = await hashPortableHandoffTree(
    layouts.candidate.resourceRoot,
    input.operation,
  );
  if (
    currentGenerationTreeSha256 !== currentGeneration.treeSha256 ||
    candidateGenerationTreeSha256 !== candidateGeneration.treeSha256
  ) {
    fail("portable Windows handoff generation digest mismatch");
  }
  return {
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256,
    candidateGenerationTreeSha256,
    currentSetupManifestSha256: (
      await digestPortableHandoffFile(layouts.current.setupManifestPath, input.operation)
    ).toString("hex"),
    candidateSetupManifestSha256: (
      await digestPortableHandoffFile(layouts.candidate.setupManifestPath, input.operation)
    ).toString("hex"),
  };
}

async function buildPortableHandoffPlan(
  input: BuildPortableHandoffPlanInput,
): Promise<PortableHandoffPlan> {
  const { activation, aggregateRevision, activationId, layouts } = input;
  const common = {
    activationId,
    sessionId: activation.sessionId,
    stageId: activation.stage.stageId,
    target: activation.stage.target,
    targetVersion: activation.targetVersion,
    newLaunchId: input.newLaunchId,
    restoreLaunchId: input.restoreLaunchId,
    aggregateRevision,
    previousRegistrationState: input.previousRegistration.state,
    oldProcess: input.oldProcess,
    paths: {
      managedRoot: layouts.paths.managedRoot,
      stageRoot: layouts.paths.stageRoot,
      candidateRoot: layouts.paths.candidateRoot,
      backupRoot: layouts.paths.backupRoot,
      candidateLauncher: layouts.candidate.launcherPath,
      candidateSupervisor: layouts.candidateSupervisorPath,
    },
    digests: await portableHandoffDigests(input),
    deadlines: deadlines(input.operation.now()),
  } as const;
  if (activation.stage.target !== "windows-x64") {
    return createPortableHandoffPlan({ ...common, target: activation.stage.target });
  }
  return createPortableHandoffPlan({
    ...common,
    target: "windows-x64",
    ...(await windowsPlanBinding(input)),
  });
}

export function createPortableHandoffTreeAttestor(input: {
  readonly managedRoot: string;
  readonly signal?: AbortSignal | undefined;
  readonly operationTimeoutMs?: number | undefined;
  readonly operationNow?: (() => number) | undefined;
  readonly yieldControl?: (() => Promise<void>) | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
}): (expectedTreeSha256: string) => Promise<boolean> {
  return async (expectedTreeSha256) => {
    const now = input.operationNow ?? Date.now;
    const actual = await hashPortableHandoffTree(input.managedRoot, {
      signal: input.signal,
      deadline: now() + (input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS),
      now,
      yieldControl: input.yieldControl,
      securityLogSink: input.securityLogSink,
    });
    return actual === expectedTreeSha256;
  };
}
