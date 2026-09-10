import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  UpdateActivationWalCheckpoint,
  UpdateRuntimeState,
  UpdateSession,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "@oscharko-dev/keiko-security";
import { digestUpdateCandidate } from "./update-candidate-authority.js";
import { hashPortableHandoffTree } from "./update-portable-handoff-builder.js";
import {
  createPortableHandoffPlan,
  portableHandoffRoot,
  writePortableHandoffPlan,
  type PortableHandoffPlan,
  type WindowsPortableHandoffPlan,
} from "./update-portable-handoff-plan.js";
import {
  appendPortableHandoffReceipt,
  type PortableHandoffReceiptKind,
} from "./update-portable-handoff-receipts.js";
import {
  encodePortableRecoveredLaunchDescriptor,
  readPortableRecoveredLaunchDescriptor,
  reconcilePortableNormalStartup,
  runPortableNativeRecoveryProcess,
  type PortableNativeRecoveryInput,
  type PortableNativeRecoveryProcess,
} from "./update-portable-normal-startup.js";
import {
  createUpdateLocalStateManager,
  type UpdateLocalStateManager,
} from "./update-local-state.js";
import {
  createStateDirUpdateSessionLock,
  inspectStateDirUpdateSessionLockForRecovery,
  updateSessionLockPath,
  type UpdateSessionLock,
} from "./update-session-lock.js";
import type { WindowsGenerationBinding } from "./update-portable-windows-generation.js";

const roots: string[] = [];
const NOW = Date.parse("2026-09-07T10:00:00.000Z");

interface NormalStartupFixture {
  readonly activationId: string;
  readonly coordinatorSha256: string;
  readonly localState: UpdateLocalStateManager;
  readonly lock: UpdateSessionLock;
  readonly managedRoot: string;
  readonly plan: PortableHandoffPlan;
  readonly session: UpdateSession;
  readonly state: UpdateRuntimeState;
  readonly stateDir: string;
}

interface WindowsNormalStartupFixture extends NormalStartupFixture {
  readonly activeGenerationFile: string;
  readonly candidateGenerationTreeSha256: string;
  readonly currentGenerationTreeSha256: string;
  readonly plan: WindowsPortableHandoffPlan;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fakeNativeProcess(pid: number | "missing" = 404): {
  readonly child: PortableNativeRecoveryProcess;
  readonly destroyControl: ReturnType<typeof vi.fn>;
  readonly emitControlError: () => void;
  readonly emitError: () => void;
  readonly emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  readonly endControl: ReturnType<typeof vi.fn>;
  readonly terminate: ReturnType<typeof vi.fn>;
} {
  let onError: ((error: Error) => void) | undefined;
  let onControlError: ((error: Error) => void) | undefined;
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const destroyControl = vi.fn();
  const endControl = vi.fn();
  const terminate = vi.fn();
  return {
    child: {
      pid: pid === "missing" ? undefined : pid,
      destroyControl,
      endControl,
      onControlError: (listener): void => {
        onControlError = listener;
      },
      onError: (listener): void => {
        onError = listener;
      },
      onExit: (listener): void => {
        onExit = listener;
      },
      terminate,
    },
    destroyControl,
    emitControlError: (): void => {
      onControlError?.(new Error("control pipe failed"));
    },
    emitError: (): void => {
      onError?.(new Error("spawn failed"));
    },
    emitExit: (code, signal): void => {
      onExit?.(code, signal);
    },
    endControl,
    terminate,
  };
}

function nativeInput(
  onSpawn: PortableNativeRecoveryInput["onSpawn"] = () => true,
): PortableNativeRecoveryInput {
  return {
    coordinator: "/fixture/coordinator",
    activationId: "a".repeat(32),
    control: Buffer.from("KUR1\n", "ascii"),
    stateDir: "/fixture/state",
    timeoutMs: 100,
    onSpawn,
  };
}

describe("portable recovered launch descriptor", () => {
  const descriptor = {
    sessionId: "session-recovered",
    targetVersion: "1.2.3",
    lockIdentity: "1".repeat(64),
    activationId: "2".repeat(32),
    planSha256: "3".repeat(64),
    launchId: "4".repeat(32),
    host: "127.0.0.1" as const,
    port: 1983,
    expectedVersion: "1.2.3",
  };

  it("round-trips the exact recovery authority passed to the relaunched process", () => {
    const encoded = encodePortableRecoveredLaunchDescriptor(descriptor);

    expect(readPortableRecoveredLaunchDescriptor(encoded)).toEqual(descriptor);
  });

  it("rejects malformed or non-canonical descriptor envelopes", () => {
    expect(readPortableRecoveredLaunchDescriptor(undefined)).toBeUndefined();
    expect(readPortableRecoveredLaunchDescriptor("=")).toBeUndefined();
    expect(readPortableRecoveredLaunchDescriptor("a".repeat(4097))).toBeUndefined();
    expect(
      readPortableRecoveredLaunchDescriptor(Buffer.from("{", "utf8").toString("base64url")),
    ).toBeUndefined();
    expect(
      readPortableRecoveredLaunchDescriptor(Buffer.from("[]", "utf8").toString("base64url")),
    ).toBeUndefined();
    expect(
      readPortableRecoveredLaunchDescriptor(
        `${Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url")}=`,
      ),
    ).toBeUndefined();
  });

  it("rejects descriptors that could escape the recovered process authority", () => {
    const invalid = [
      { ...descriptor, sessionId: "" },
      { ...descriptor, sessionId: "s".repeat(257) },
      { ...descriptor, targetVersion: "invalid version" },
      { ...descriptor, lockIdentity: "not-a-digest" },
      { ...descriptor, activationId: "not-an-activation" },
      { ...descriptor, planSha256: "not-a-digest" },
      { ...descriptor, launchId: "not-a-launch" },
      { ...descriptor, expectedVersion: "invalid version" },
      { ...descriptor, host: "0.0.0.0" },
      { ...descriptor, port: 0 },
      { ...descriptor, port: 65_536 },
      { ...descriptor, port: 1983.5 },
    ];

    for (const value of invalid) {
      const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
      expect(readPortableRecoveredLaunchDescriptor(encoded)).toBeUndefined();
    }
    expect(() => encodePortableRecoveredLaunchDescriptor({ ...descriptor, port: 0 })).toThrow(
      TypeError,
    );
  });
});

async function prepare(terminal = false): Promise<NormalStartupFixture> {
  const root = mkdtempSync(join(tmpdir(), "keiko-normal-startup-recovery-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const managedRoot = join(root, "install", "Keiko.app");
  mkdirSync(managedRoot, { recursive: true });
  writeFileSync(join(managedRoot, "installed.txt"), "old tree");
  mkdirSync(stateDir, { recursive: true });
  const localState = createUpdateLocalStateManager({ stateDir, now: () => NOW });
  const initial = localState.writeRuntimeState(localState.readRuntimeState());
  const registration = JSON.stringify({
    schemaVersion: 1,
    status: "managed",
    updateEligible: true,
    stable: true,
    platformTarget: "macos-arm64",
    packageVersion: "1.2.2",
    installRootIdentitySha256: createHash("sha256").update(realpathSync(managedRoot)).digest("hex"),
  });
  writeFileSync(join(stateDir, "portable-install-state.json"), registration);
  const currentTreeSha256 = await hashPortableHandoffTree(managedRoot, {
    deadline: Date.now() + 30_000,
  });
  const activationId = "a".repeat(32);
  const sessionId = "session-normal-startup";
  const stageRoot = join(root, "install", ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko", "Keiko.app");
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId,
    stageId: "stage-1",
    target: "macos-arm64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: initial.revision + 1,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 101,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(root, "install", `.keiko-previous-${activationId}`),
      candidateLauncher: join(candidateRoot, "Contents", "MacOS", "Keiko"),
      candidateSupervisor: join(
        candidateRoot,
        "Contents",
        "Resources",
        "runtime",
        "native",
        "keiko-runtime-supervisor",
      ),
    },
    digests: {
      currentTreeSha256,
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: "3".repeat(64),
      currentSupervisorSha256: "4".repeat(64),
      candidateLauncherSha256: "e".repeat(64),
      candidateSupervisorSha256: "f".repeat(64),
      previousRegistrationSha256: createHash("sha256").update(registration).digest("hex"),
      preparedRegistrationSha256: "1".repeat(64),
    },
    deadlines: {
      oldExitAt: NOW - 120_000,
      startAt: NOW - 90_000,
      verifyAt: NOW - 60_000,
      cleanupAt: NOW - 30_000,
    },
  });
  const { sha256: planSha256 } = writePortableHandoffPlan({ stateDir, plan });
  const coordinator = join(portableHandoffRoot(stateDir, activationId), "coordinator");
  writeFileSync(coordinator, "native recovery fixture");
  const coordinatorSha256 = createHash("sha256").update("native recovery fixture").digest("hex");
  const candidate = {
    schemaVersion: "1" as const,
    candidateId: "candidate-1.2.3",
    currentVersion: "1.2.2",
    targetVersion: "1.2.3",
    channel: "stable" as const,
    install: {
      packageName: "@oscharko-dev/keiko",
      installKind: "package-manager" as const,
      packageManager: "npm" as const,
      installIdentitySha256: "8".repeat(64),
    },
    release: { source: "github-release" as const, tag: "v1.2.3" },
    releaseImpactDigest: "7".repeat(64),
    issuedAt: "2026-09-07T09:00:00.000Z",
    expiresAt: "2026-09-07T11:00:00.000Z",
  };
  const session: UpdateSession = {
    schemaVersion: "1",
    sessionId,
    candidateId: candidate.candidateId,
    candidateDigest: digestUpdateCandidate(candidate),
    correlationId: "corr-normal-startup",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "1.2.3",
    phase: terminal ? "succeeded" : "running",
    lifecycle: {
      phase: terminal ? "succeeded" : "staging",
      progress: { completedBytes: 1, totalBytes: 1 },
      cancellationCutoff: terminal ? "handoff-committed" : "not-reached",
    },
    failureReason: "none",
    packageManager: "npm",
    startedAt: "2026-09-07T09:00:00.000Z",
    updatedAt: "2026-09-07T09:00:00.000Z",
    cancelable: !terminal,
    retryable: false,
    restartRequired: false,
    message: "Native handoff pending.",
  };
  const state = localState.writeRuntimeState({
    ...initial,
    activeSession: terminal ? undefined : session,
    activeCandidate: terminal ? undefined : candidate,
    lastSession: terminal ? session : undefined,
    activationWal: {
      activationId,
      planSha256,
      coordinatorSha256,
      intentRevision: plan.aggregateRevision,
      checkpoint: "prepared",
      receiptSequence: 0,
      ...(terminal ? { coordinatorId: coordinatorSha256 } : {}),
    },
  });
  const lock = createStateDirUpdateSessionLock(stateDir, {
    processIdentity: "old-owner",
    pidAlive: () => false,
  });
  expect(
    lock.acquire({ sessionId, targetVersion: "1.2.3", startedAt: session.startedAt, pid: 101 }),
  ).toBe(true);
  return {
    activationId,
    coordinatorSha256,
    localState,
    lock,
    managedRoot,
    plan,
    session,
    state,
    stateDir,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeWindowsGeneration(
  managedRoot: string,
  label: string,
): Promise<{ readonly file: string; readonly treeSha256: string }> {
  const generations = join(managedRoot, ".portable", "generations");
  const staged = join(generations, `.fixture-${label}`);
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, "runtime.txt"), `${label} generation bytes`);
  const treeSha256 = await hashPortableHandoffTree(staged, { deadline: Date.now() + 30_000 });
  const generationRoot = join(generations, treeSha256);
  renameSync(staged, generationRoot);
  return { file: join(generationRoot, "runtime.txt"), treeSha256 };
}

function windowsGenerationBinding(
  treeSha256: string,
  launcherSha256: string,
): WindowsGenerationBinding {
  return {
    schemaVersion: 1 as const,
    resourceRoot: `.portable/generations/${treeSha256}`,
    treeHashSchema: "KHT1" as const,
    treeSha256,
    launcherPath: "Keiko.exe" as const,
    launcherSha256,
  };
}

type WindowsActiveSelection = "candidate" | "current" | "third";
type WindowsRecoveryHistory = "accepted" | "unaccepted";

interface WindowsRecoverySessionFacts {
  readonly cancelable: boolean;
  readonly cancellationCutoff: "handoff-committed" | "not-reached";
  readonly lifecyclePhase: "handoff-pending" | "staging";
  readonly message: string;
  readonly phase: "restart-required" | "running";
  readonly restartRequired: boolean;
}

function windowsRecoverySessionFacts(history: WindowsRecoveryHistory): WindowsRecoverySessionFacts {
  return history === "unaccepted"
    ? {
        cancelable: true,
        lifecyclePhase: "staging" as const,
        cancellationCutoff: "not-reached" as const,
        message: "Preparing handoff.",
        phase: "running" as const,
        restartRequired: false,
      }
    : {
        cancelable: false,
        lifecyclePhase: "handoff-pending" as const,
        cancellationCutoff: "handoff-committed" as const,
        message: "Native handoff pending.",
        phase: "restart-required" as const,
        restartRequired: true,
      };
}

interface GeneratedWindowsGeneration {
  readonly file: string;
  readonly treeSha256: string;
}

interface WindowsActiveFacts {
  readonly binding: WindowsGenerationBinding;
  readonly file: string;
  readonly launcher: string;
  readonly version: string;
}

function selectedWindowsFacts(
  active: WindowsActiveSelection,
  current: GeneratedWindowsGeneration,
  candidate: GeneratedWindowsGeneration,
  third: GeneratedWindowsGeneration | undefined,
): WindowsActiveFacts {
  if (active === "current") {
    return {
      binding: windowsGenerationBinding(current.treeSha256, sha256("current signed launcher")),
      file: current.file,
      launcher: "current signed launcher",
      version: "1.2.2",
    };
  }
  if (active === "candidate") {
    return {
      binding: windowsGenerationBinding(candidate.treeSha256, sha256("candidate signed launcher")),
      file: candidate.file,
      launcher: "candidate signed launcher",
      version: "1.2.3",
    };
  }
  if (third === undefined) throw new TypeError("expected third Windows generation");
  return {
    binding: windowsGenerationBinding(third.treeSha256, sha256("third signed launcher")),
    file: third.file,
    launcher: "third signed launcher",
    version: "1.2.3",
  };
}

async function optionalThirdGeneration(
  managedRoot: string,
  active: WindowsActiveSelection,
): Promise<GeneratedWindowsGeneration | undefined> {
  return active === "third" ? writeWindowsGeneration(managedRoot, "third") : undefined;
}

function selectedRegistrationDigests(
  active: WindowsActiveSelection,
  registrationSha256: string,
): { readonly prepared: string; readonly previous: string } {
  return active === "current"
    ? { prepared: "1".repeat(64), previous: registrationSha256 }
    : { prepared: registrationSha256, previous: "0".repeat(64) };
}

function windowsSetup(
  version: string,
  windowsGeneration: ReturnType<typeof windowsGenerationBinding>,
): string {
  return JSON.stringify({
    schemaVersion: 2,
    platformTarget: "windows-x64",
    packageName: "@oscharko-dev/keiko",
    packageVersion: version,
    stable: true,
    bootstrapUpdateEligible: false,
    primaryLauncher: "Keiko.exe",
    runtime: { nodePlatform: "win32", nodeArchitecture: "x64" },
    windowsGeneration,
  });
}

function windowsRegistration(input: {
  readonly managedRoot: string;
  readonly setup: string;
  readonly version: string;
  readonly windowsGeneration: ReturnType<typeof windowsGenerationBinding>;
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    status: "managed",
    updateEligible: true,
    stable: true,
    platformTarget: "windows-x64",
    packageVersion: input.version,
    installRootIdentitySha256: sha256(realpathSync(input.managedRoot)),
    setupManifestSha256: sha256(input.setup),
    launcherIdentitySha256: input.windowsGeneration.launcherSha256,
    windowsGeneration: input.windowsGeneration,
  });
}

const FORWARD_COMPLETE_RECEIPTS = [
  ["prepared", "completed"],
  ["old-exit", "intent"],
  ["old-exit", "completed"],
  ["promote", "intent"],
  ["promote", "completed"],
  ["register", "intent"],
  ["register", "completed"],
  ["start", "intent"],
  ["start", "completed"],
  ["verify", "intent"],
  ["verify", "completed"],
  ["cleanup", "intent"],
  ["cleanup", "completed"],
  ["complete", "completed"],
] as const;

const RESTORED_RECEIPTS = [
  ...FORWARD_COMPLETE_RECEIPTS.slice(0, 9),
  ["restore", "intent"],
  ["restore", "completed"],
] as const;

function receiptEntriesFor(
  active: WindowsActiveSelection,
): readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[] {
  return active === "current" ? RESTORED_RECEIPTS : FORWARD_COMPLETE_RECEIPTS;
}

function walCheckpointsFor(
  active: WindowsActiveSelection,
): readonly (readonly [UpdateActivationWalCheckpoint, number])[] {
  return active === "current"
    ? ([
        ["old-exited", 3],
        ["promoted", 5],
        ["registered", 7],
        ["new-started", 9],
        ["restoring", 10],
        ["restoring", 11],
      ] as const)
    : ([
        ["old-exited", 3],
        ["promoted", 5],
        ["registered", 7],
        ["new-started", 9],
        ["verified", 11],
        ["cleanup-pending", 12],
        ["complete", 14],
      ] as const);
}

function appendReceiptSequence(
  fixture: NormalStartupFixture,
  entries: readonly (readonly [PortableHandoffReceiptKind, "intent" | "completed"])[],
): readonly string[] {
  const sha256s: string[] = [];
  let previousSha256: string | undefined;
  for (const [kind, outcome] of entries) {
    previousSha256 = appendPortableHandoffReceipt({
      stateDir: fixture.stateDir,
      activationId: fixture.activationId,
      planSha256: fixture.state.activationWal?.planSha256 ?? "",
      kind,
      outcome,
      at: NOW,
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
    }).sha256;
    sha256s.push(previousSha256);
  }
  return sha256s;
}

async function prepareWindows(
  active: WindowsActiveSelection = "candidate",
  history: WindowsRecoveryHistory = "accepted",
): Promise<WindowsNormalStartupFixture> {
  const root = mkdtempSync(join(tmpdir(), "keiko-windows-normal-startup-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const managedRoot = join(root, "install", "Keiko");
  mkdirSync(managedRoot, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const localState = createUpdateLocalStateManager({ stateDir, now: () => NOW });
  const initial = localState.writeRuntimeState(localState.readRuntimeState());
  const currentGeneration = await writeWindowsGeneration(managedRoot, "current");
  const candidateGeneration = await writeWindowsGeneration(managedRoot, "candidate");
  const thirdGeneration = await optionalThirdGeneration(managedRoot, active);
  const currentLauncher = "current signed launcher";
  const candidateLauncher = "candidate signed launcher";
  const currentBinding = windowsGenerationBinding(
    currentGeneration.treeSha256,
    sha256(currentLauncher),
  );
  const candidateBinding = windowsGenerationBinding(
    candidateGeneration.treeSha256,
    sha256(candidateLauncher),
  );
  const selected = selectedWindowsFacts(
    active,
    currentGeneration,
    candidateGeneration,
    thirdGeneration,
  );
  const setup = windowsSetup(selected.version, selected.binding);
  const registration = windowsRegistration({
    managedRoot,
    setup,
    version: selected.version,
    windowsGeneration: selected.binding,
  });
  writeFileSync(join(managedRoot, "Keiko.exe"), selected.launcher);
  writeFileSync(join(managedRoot, ".portable", "setup-manifest.json"), setup);
  writeFileSync(join(stateDir, "portable-install-state.json"), registration);
  const activationId = "a".repeat(32);
  const sessionId = "session-windows-normal-startup";
  const sessionFacts = windowsRecoverySessionFacts(history);
  const stageRoot = join(root, "install", ".keiko-portable-updates", "stage-1");
  const candidateRoot = join(stageRoot, "Keiko");
  const currentSetup = windowsSetup("1.2.2", currentBinding);
  const candidateSetup = active === "third" ? setup : windowsSetup("1.2.3", candidateBinding);
  const registrationDigests = selectedRegistrationDigests(active, sha256(registration));
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId,
    stageId: "stage-1",
    target: "windows-x64",
    targetVersion: "1.2.3",
    newLaunchId: "2".repeat(32),
    restoreLaunchId: "3".repeat(32),
    aggregateRevision: initial.revision + 1,
    previousRegistrationState: "present",
    oldProcess: {
      pid: 101,
      launchId: "1".repeat(32),
      host: "127.0.0.1",
      port: 1983,
      version: "1.2.2",
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(root, "install", `.keiko-previous-${activationId}`),
      candidateLauncher: join(candidateRoot, "Keiko.exe"),
      candidateSupervisor: join(candidateRoot, "runtime", "native", "keiko-runtime-supervisor.exe"),
    },
    digests: {
      currentTreeSha256: "c".repeat(64),
      candidateTreeSha256: "d".repeat(64),
      currentLauncherSha256: currentBinding.launcherSha256,
      currentSupervisorSha256: "4".repeat(64),
      candidateLauncherSha256: candidateBinding.launcherSha256,
      candidateSupervisorSha256: "f".repeat(64),
      previousRegistrationSha256: registrationDigests.previous,
      preparedRegistrationSha256: registrationDigests.prepared,
    },
    deadlines: {
      oldExitAt: NOW - 120_000,
      startAt: NOW - 90_000,
      verifyAt: NOW - 60_000,
      cleanupAt: NOW - 30_000,
    },
    cutoverKind: "windows-generation-v1",
    currentGenerationTreeSha256: currentGeneration.treeSha256,
    candidateGenerationTreeSha256: candidateGeneration.treeSha256,
    currentSetupManifestSha256: sha256(currentSetup),
    candidateSetupManifestSha256: sha256(candidateSetup),
  });
  if (plan.target !== "windows-x64") throw new TypeError("expected Windows plan");
  const { sha256: planSha256 } = writePortableHandoffPlan({ stateDir, plan });
  const coordinatorBytes = "Windows native recovery fixture";
  const coordinator = join(portableHandoffRoot(stateDir, activationId), "coordinator.exe");
  writeFileSync(coordinator, coordinatorBytes);
  const coordinatorSha256 = sha256(coordinatorBytes);
  const candidate = {
    schemaVersion: "1" as const,
    candidateId: "candidate-1.2.3",
    currentVersion: "1.2.2",
    targetVersion: "1.2.3",
    channel: "stable" as const,
    install: {
      packageName: "@oscharko-dev/keiko",
      installKind: "package-manager" as const,
      packageManager: "npm" as const,
      installIdentitySha256: "8".repeat(64),
    },
    release: { source: "github-release" as const, tag: "v1.2.3" },
    releaseImpactDigest: "7".repeat(64),
    issuedAt: "2026-09-07T09:00:00.000Z",
    expiresAt: "2026-09-07T11:00:00.000Z",
  };
  const session: UpdateSession = {
    schemaVersion: "1",
    sessionId,
    candidateId: candidate.candidateId,
    candidateDigest: digestUpdateCandidate(candidate),
    correlationId: "corr-windows-normal-startup",
    packageName: "@oscharko-dev/keiko",
    targetVersion: "1.2.3",
    phase: sessionFacts.phase,
    lifecycle: {
      phase: sessionFacts.lifecyclePhase,
      progress: { completedBytes: 1, totalBytes: 1 },
      cancellationCutoff: sessionFacts.cancellationCutoff,
    },
    failureReason: "none",
    packageManager: "npm",
    startedAt: "2026-09-07T09:00:00.000Z",
    updatedAt: "2026-09-07T09:00:00.000Z",
    cancelable: sessionFacts.cancelable,
    retryable: false,
    restartRequired: sessionFacts.restartRequired,
    message: sessionFacts.message,
  };
  const state = localState.writeRuntimeState({
    ...initial,
    activeSession: session,
    activeCandidate: candidate,
    activationWal: {
      activationId,
      planSha256,
      coordinatorSha256,
      ...(history === "accepted" ? { coordinatorId: coordinatorSha256 } : {}),
      intentRevision: plan.aggregateRevision,
      checkpoint: "prepared",
      receiptSequence: 0,
    },
  });
  const lock = createStateDirUpdateSessionLock(stateDir, {
    processIdentity: "windows-old-owner",
    pidAlive: () => false,
  });
  const fixture = {
    activationId,
    activeGenerationFile: selected.file,
    candidateGenerationTreeSha256: candidateGeneration.treeSha256,
    coordinatorSha256,
    currentGenerationTreeSha256: currentGeneration.treeSha256,
    localState,
    lock,
    managedRoot,
    plan,
    session,
    state,
    stateDir,
  } satisfies WindowsNormalStartupFixture;
  expect(
    lock.acquire({ sessionId, targetVersion: "1.2.3", startedAt: session.startedAt, pid: 101 }),
  ).toBe(true);
  if (history === "unaccepted") return { ...fixture, lock, state };
  const entries = receiptEntriesFor(active);
  const receiptSha256s = appendReceiptSequence(fixture, entries);
  let terminalState = state;
  for (const [checkpoint, receiptSequence] of walCheckpointsFor(active)) {
    const activationWal = terminalState.activationWal;
    if (activationWal === undefined) throw new TypeError("expected Windows activation WAL");
    terminalState = localState.writeRuntimeState({
      ...terminalState,
      activationWal: {
        ...activationWal,
        checkpoint,
        receiptSequence,
        receiptSha256: receiptSha256s[receiptSequence - 1],
      },
    });
  }
  expect(lock.updateChildPid(sessionId, 202)).toBe(true);
  return { ...fixture, lock, state: terminalState };
}

function appendComplete(fixture: Awaited<ReturnType<typeof prepare>>): string {
  return appendReceiptSequence(fixture, FORWARD_COMPLETE_RECEIPTS).at(-1) ?? "";
}

function prepareAcceptedRecovery(fixture: NormalStartupFixture): void {
  const preparedSha256 = appendPortableHandoffReceipt({
    stateDir: fixture.stateDir,
    activationId: fixture.activationId,
    planSha256: fixture.state.activationWal?.planSha256 ?? "",
    kind: "prepared",
    outcome: "completed",
    at: NOW,
  }).sha256;
  appendPortableHandoffReceipt({
    stateDir: fixture.stateDir,
    activationId: fixture.activationId,
    planSha256: fixture.state.activationWal?.planSha256 ?? "",
    kind: "old-exit",
    outcome: "intent",
    at: NOW,
    previousSha256: preparedSha256,
  });
  const activationWal = fixture.state.activationWal;
  if (activationWal === undefined) throw new TypeError("expected activation WAL");
  fixture.localState.writeRuntimeState({
    ...fixture.localState.readRuntimeState(),
    activationWal: { ...activationWal, coordinatorId: fixture.coordinatorSha256 },
  });
  expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
}

describe("portable normal startup recovery", () => {
  it("treats a Windows installation with no WAL as selected-only normal startup", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-windows-normal-startup-fresh-"));
    roots.push(stateDir);
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir,
        target: "windows-x64",
        expectedManagedRoot: stateDir,
        runNative,
      }),
    ).resolves.toEqual({ status: "normal" });
    expect(runNative).not.toHaveBeenCalled();
  });

  it("settles a verified unaccepted Windows handoff before native recovery", async () => {
    const fixture = await prepareWindows("current", "unaccepted");
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    const events: SecurityLogEvent[] = [];

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "windows-preacceptance-cli",
        pidAlive: () => false,
        runNative,
        securityLogSink: { write: (event) => events.push(event) },
      }),
    ).resolves.toEqual({ status: "normal" });

    expect(fixture.localState.readRuntimeState()).toMatchObject({
      activeSession: { sessionId: fixture.session.sessionId },
      recovery: { status: "settled", sessionId: fixture.session.sessionId },
    });
    expect(fixture.localState.readRuntimeState().activationWal).toBeUndefined();
    expect(runNative).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "portable.normal-startup-recovery.completed",
        correlationId: fixture.session.correlationId,
        extra: { outcome: "unaccepted-settled", target: "windows-x64" },
      }),
    );
  });

  it("rejects an unaccepted Windows handoff when the N-1 generation no longer attests", async () => {
    const fixture = await prepareWindows("current", "unaccepted");
    writeFileSync(fixture.activeGenerationFile, "drifted N-1 generation bytes");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "windows-preacceptance-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(inspectStateDirUpdateSessionLockForRecovery(fixture.stateDir)?.ownerPid).toBe(303);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
    expect(runNative).not.toHaveBeenCalled();
  });

  it("recovers the verified Windows candidate through coordinator.exe and grants only N", async () => {
    const fixture = await prepareWindows("candidate");
    const events: SecurityLogEvent[] = [];
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.coordinator).toBe(
        join(portableHandoffRoot(fixture.stateDir, fixture.activationId), "coordinator.exe"),
      );
      expect(input.control.toString("ascii").split("\n")[0]).toBe("KUR1");
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "succeeded" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "windows-recovery-cli",
        pidAlive: () => false,
        runNative,
        securityLogSink: { write: (event) => events.push(event) },
      }),
    ).resolves.toMatchObject({
      status: "recovered",
      descriptor: {
        launchId: fixture.plan.newLaunchId,
        expectedVersion: fixture.plan.targetVersion,
      },
      inspectionAllowance: {
        kind: "windows-generation-v1",
        managedRoot: fixture.managedRoot,
        activationId: fixture.activationId,
        allowedResourceRoots: [`.portable/generations/${fixture.candidateGenerationTreeSha256}`],
      },
    });
    expect(runNative).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "portable.normal-startup-recovery.completed",
        correlationId: fixture.session.correlationId,
        extra: { outcome: "native-recovered", target: "windows-x64" },
      }),
    );
    const auditEvent = events.find((event) => event.op === "update.runtime.event");
    expect(auditEvent?.correlationId).toBe(fixture.session.correlationId);
    expect(auditEvent?.extra).toMatchObject({
      type: "portable-relaunch-result",
      status: "succeeded",
    });
  });

  it("anchors failed Windows native launch ownership before any child PID is published", async () => {
    const fixture = await prepareWindows("candidate");
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.coordinator).toBe(
        join(portableHandoffRoot(fixture.stateDir, fixture.activationId), "coordinator.exe"),
      );
      throw new Error("native launch failed before child publication");
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "windows-recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(inspectStateDirUpdateSessionLockForRecovery(fixture.stateDir)?.childPid).toBe(303);
    const retryNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 505,
        processIdentity: "windows-retry-cli",
        pidAlive: (pid) => pid === 303,
        runNative: retryNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(retryNative).not.toHaveBeenCalled();
  });

  it("recovers a restored Windows N-1 without granting candidate rollback access", async () => {
    const fixture = await prepareWindows("current");
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "succeeded" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "windows-restore-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toMatchObject({
      status: "recovered",
      descriptor: {
        launchId: fixture.plan.restoreLaunchId,
        expectedVersion: fixture.plan.oldProcess.version,
      },
      inspectionAllowance: {
        allowedResourceRoots: [`.portable/generations/${fixture.currentGenerationTreeSha256}`],
      },
    });
  });

  it("rejects a non-prefix Windows receipt journal before native recovery", async () => {
    const fixture = await prepareWindows("candidate");
    const receiptRoot = join(
      portableHandoffRoot(fixture.stateDir, fixture.activationId),
      "receipts",
    );
    writeFileSync(join(receiptRoot, "000001.khr"), readFileSync(join(receiptRoot, "000002.khr")));
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(runNative).not.toHaveBeenCalled();
  });

  it.each(["generation drift", "third generation"] as const)(
    "withholds a Windows inspection allowance after %s",
    async (failure) => {
      const fixture = await prepareWindows(failure === "third generation" ? "third" : "candidate");
      if (failure === "generation drift") {
        writeFileSync(fixture.activeGenerationFile, "drifted generation bytes");
      }
      const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
        expect(input.onSpawn(404)).toBe(true);
        return Promise.resolve({ status: "succeeded" as const });
      });

      await expect(
        reconcilePortableNormalStartup({
          stateDir: fixture.stateDir,
          target: "windows-x64",
          expectedManagedRoot: fixture.managedRoot,
          currentPid: 303,
          processIdentity: "windows-invalid-root-cli",
          pidAlive: () => false,
          runNative,
        }),
      ).resolves.toEqual({ status: "recovery-required" });
      expect(runNative).toHaveBeenCalledOnce();
    },
  );

  it("withholds Windows recovery after native completion changes the candidate generation", async () => {
    const fixture = await prepareWindows("candidate");
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      writeFileSync(fixture.activeGenerationFile, "changed during native recovery");
      return Promise.resolve({ status: "succeeded" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "windows-x64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "windows-post-native-attestation-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(runNative).toHaveBeenCalledOnce();
  });

  it("treats an installation with no aggregate or interrupted anchors as fresh", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "keiko-normal-startup-fresh-"));
    roots.push(stateDir);
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    await expect(
      reconcilePortableNormalStartup({
        stateDir,
        target: "macos-arm64",
        expectedManagedRoot: stateDir,
        runNative,
      }),
    ).resolves.toEqual({ status: "normal" });
    expect(runNative).not.toHaveBeenCalled();
  });

  it("settles an unaccepted prepared crash before child publication against exact old state", async () => {
    const fixture = await prepare();
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
      }),
    ).resolves.toEqual({ status: "normal" });
    const settled = fixture.localState.readRuntimeState();
    expect(settled).toMatchObject({
      activeSession: { sessionId: fixture.session.sessionId },
      recovery: { status: "settled", sessionId: fixture.session.sessionId },
    });
    expect(settled.activationWal).toBeUndefined();
    expect(() => {
      writeFileSync(updateSessionLockPath(fixture.stateDir), "occupied", { flag: "wx" });
    }).not.toThrow();
  });

  it("settles the exact one-receipt preacceptance crash and starts normally afterward", async () => {
    const fixture = await prepare();
    appendPortableHandoffReceipt({
      stateDir: fixture.stateDir,
      activationId: fixture.activationId,
      planSha256: fixture.state.activationWal?.planSha256 ?? "",
      kind: "prepared",
      outcome: "completed",
      at: NOW,
    });
    expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    const options = {
      stateDir: fixture.stateDir,
      target: "macos-arm64" as const,
      expectedManagedRoot: fixture.managedRoot,
      currentPid: 303,
      processIdentity: "recovery-cli",
      pidAlive: (): boolean => false,
      runNative,
    };

    await expect(reconcilePortableNormalStartup(options)).resolves.toEqual({ status: "normal" });
    await expect(reconcilePortableNormalStartup(options)).resolves.toEqual({ status: "normal" });
    expect(runNative).not.toHaveBeenCalled();
    expect(fixture.localState.readRuntimeState()).toMatchObject({
      activeSession: { sessionId: fixture.session.sessionId },
      recovery: { status: "settled", sessionId: fixture.session.sessionId },
    });
  });

  it("rejects a prepared-only crash whose published child PID is missing", async () => {
    const fixture = await prepare();
    appendPortableHandoffReceipt({
      stateDir: fixture.stateDir,
      activationId: fixture.activationId,
      planSha256: fixture.state.activationWal?.planSha256 ?? "",
      kind: "prepared",
      outcome: "completed",
      at: NOW,
    });
    const beforeLock = readFileSync(updateSessionLockPath(fixture.stateDir), "utf8");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(readFileSync(updateSessionLockPath(fixture.stateDir), "utf8")).toBe(beforeLock);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
    expect(runNative).not.toHaveBeenCalled();
  });

  it.each(["old-tree", "previous-registration"] as const)(
    "rejects one-receipt preacceptance settlement when %s no longer attests",
    async (mismatch) => {
      const fixture = await prepare();
      appendPortableHandoffReceipt({
        stateDir: fixture.stateDir,
        activationId: fixture.activationId,
        planSha256: fixture.state.activationWal?.planSha256 ?? "",
        kind: "prepared",
        outcome: "completed",
        at: NOW,
      });
      expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
      if (mismatch === "old-tree") {
        writeFileSync(join(fixture.managedRoot, "installed.txt"), "mutated old tree");
      } else {
        writeFileSync(join(fixture.stateDir, "portable-install-state.json"), "{}\n");
      }
      const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

      await expect(
        reconcilePortableNormalStartup({
          stateDir: fixture.stateDir,
          target: "macos-arm64",
          expectedManagedRoot: fixture.managedRoot,
          currentPid: 303,
          processIdentity: "recovery-cli",
          pidAlive: () => false,
          runNative,
        }),
      ).resolves.toEqual({ status: "recovery-required" });
      expect(runNative).not.toHaveBeenCalled();
      expect(fixture.localState.readRuntimeState().activationWal).toBeDefined();
    },
  );

  it("recovers a complete receipt chain anchored by a terminal last session", async () => {
    const fixture = await prepare(true);
    const receiptSha256 = appendComplete(fixture);
    const activationWal = fixture.state.activationWal;
    if (activationWal === undefined) throw new TypeError("expected activation WAL");
    fixture.localState.writeRuntimeState({
      ...fixture.localState.readRuntimeState(),
      activationWal: {
        ...activationWal,
        checkpoint: "complete",
        receiptSequence: 14,
        receiptSha256,
        coordinatorId: fixture.coordinatorSha256,
      },
    });
    expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      const runtimeBytes = readFileSync(join(fixture.stateDir, "updates", "runtime-state.json"));
      expect(input.control.toString("ascii").split("\n")[0]).toBe("KUR1");
      expect(input.control.toString("ascii").split("\n")[7]).toBe(
        createHash("sha256").update(runtimeBytes).digest("hex"),
      );
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "succeeded" as const });
    });
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toMatchObject({
      status: "recovered",
      descriptor: {
        sessionId: fixture.session.sessionId,
        launchId: fixture.plan.newLaunchId,
        expectedVersion: fixture.plan.targetVersion,
      },
    });
    expect(runNative).toHaveBeenCalledOnce();
  });

  it("emits a correlated body-free diagnostic when validated ownership is still live", async () => {
    const fixture = await prepare();
    const events: SecurityLogEvent[] = [];
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        pidAlive: (pid) => pid === 101,
        securityLogSink: { write: (event) => events.push(event) },
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "portable.normal-startup-recovery.required",
        correlationId: fixture.session.correlationId,
        errorKind: "PortableNormalStartupRecoveryRequired",
        extra: { reason: "ownership-live-or-mismatch" },
      }),
    );
    expect(JSON.stringify(events)).not.toContain(fixture.stateDir);
    expect(JSON.stringify(events)).not.toContain("old tree");
  });

  it("rejects a recovery plan outside the managed root whose mutation lock is held", async () => {
    const fixture = await prepare();
    const otherManagedRoot = join(dirname(fixture.managedRoot), "Other.app");
    mkdirSync(otherManagedRoot, { recursive: true });
    const beforeLock = readFileSync(updateSessionLockPath(fixture.stateDir), "utf8");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: otherManagedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(runNative).not.toHaveBeenCalled();
    expect(readFileSync(updateSessionLockPath(fixture.stateDir), "utf8")).toBe(beforeLock);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
  });

  it("refuses a changed recovery coordinator before publishing a native PID", async () => {
    const fixture = await prepare();
    prepareAcceptedRecovery(fixture);
    writeFileSync(
      join(portableHandoffRoot(fixture.stateDir, fixture.activationId), "coordinator"),
      "changed recovery coordinator",
    );
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(runNative).not.toHaveBeenCalled();
    expect(inspectStateDirUpdateSessionLockForRecovery(fixture.stateDir)?.childPid).toBe(202);
  });

  it("does not settle an unaccepted handoff while its published coordinator is live", async () => {
    const fixture = await prepare();
    expect(fixture.lock.updateChildPid(fixture.session.sessionId, 202)).toBe(true);
    const beforeLock = readFileSync(updateSessionLockPath(fixture.stateDir), "utf8");
    const beforeState = fixture.localState.readRuntimeState();
    const runNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: (pid) => pid === 202,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(runNative).not.toHaveBeenCalled();
    expect(readFileSync(updateSessionLockPath(fixture.stateDir), "utf8")).toBe(beforeLock);
    expect(fixture.localState.readRuntimeState()).toEqual(beforeState);
  });

  it("waits for a delayed exit after timeout before confirming native recovery death", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    fixture.emitExit(null, "SIGKILL");

    await expect(result).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
  });

  it("reports an ambiguous live process when timeout teardown has no exit", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);

    await vi.advanceTimersByTimeAsync(5_100);

    await expect(result).resolves.toEqual({ status: "failed", process: "ambiguous-live" });
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
  });

  it("fails closed when native PID publication fails and process exit stays ambiguous", async () => {
    vi.useFakeTimers();
    const onSpawn = vi.fn(() => false);
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(onSpawn), () => fixture.child);

    expect(onSpawn).toHaveBeenCalledWith(404);
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({ status: "failed", process: "ambiguous-live" });
  });

  it("contains asynchronous control-pipe errors through bounded native teardown", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);

    fixture.emitControlError();
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    fixture.emitExit(null, "SIGKILL");

    await expect(result).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
  });

  it("does not arm an ambiguity timer when termination synchronously observes exit", async () => {
    vi.useFakeTimers();
    const fixture = fakeNativeProcess();
    fixture.terminate.mockImplementation(() => {
      fixture.emitExit(null, "SIGKILL");
    });

    await expect(
      runPortableNativeRecoveryProcess(
        nativeInput(() => false),
        () => fixture.child,
      ),
    ).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a spawn failure without a PID as confirmed dead", async () => {
    const onSpawn = vi.fn(() => true);
    const fixture = fakeNativeProcess("missing");

    await expect(
      runPortableNativeRecoveryProcess(nativeInput(onSpawn), () => fixture.child),
    ).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(fixture.endControl).not.toHaveBeenCalled();
  });

  it("treats a synchronous native spawn failure as confirmed dead", async () => {
    await expect(
      runPortableNativeRecoveryProcess(nativeInput(), () => {
        throw new Error("native spawn failed");
      }),
    ).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
  });

  it("accepts only a clean native exit after publishing the PID and control packet", async () => {
    const onSpawn = vi.fn(() => true);
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(onSpawn), () => fixture.child);

    expect(onSpawn).toHaveBeenCalledWith(404);
    expect(fixture.endControl).toHaveBeenCalledWith(Buffer.from("KUR1\n", "ascii"));
    fixture.emitExit(0, null);

    await expect(result).resolves.toEqual({ status: "succeeded" });
    expect(fixture.destroyControl).not.toHaveBeenCalled();
    expect(fixture.terminate).not.toHaveBeenCalled();
  });

  it("tears down a published child after an asynchronous spawn error", async () => {
    const fixture = fakeNativeProcess();
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);

    fixture.emitError();
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
    fixture.emitExit(null, "SIGKILL");

    await expect(result).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
  });

  it("uses process exit as authority when control and termination teardown both throw", async () => {
    const fixture = fakeNativeProcess();
    fixture.endControl.mockImplementation(() => {
      throw new Error("control write failed");
    });
    fixture.destroyControl.mockImplementation(() => {
      throw new Error("control close failed");
    });
    fixture.terminate.mockImplementation(() => {
      throw new Error("termination failed");
    });
    const result = runPortableNativeRecoveryProcess(nativeInput(), () => fixture.child);

    fixture.emitExit(null, "SIGKILL");

    await expect(result).resolves.toEqual({ status: "failed", process: "confirmed-dead" });
    expect(fixture.destroyControl).toHaveBeenCalledOnce();
    expect(fixture.terminate).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not reclaim while an ambiguously live native recovery PID remains published", async () => {
    const fixture = await prepare();
    prepareAcceptedRecovery(fixture);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "failed" as const, process: "ambiguous-live" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    const retryNative = vi.fn(() => Promise.resolve({ status: "succeeded" as const }));
    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 505,
        processIdentity: "retry-cli",
        pidAlive: (pid) => pid === 404,
        runNative: retryNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });
    expect(runNative).toHaveBeenCalledOnce();
    expect(retryNative).not.toHaveBeenCalled();
  });

  it("retains a native PID when recovery throws after durable publication", async () => {
    const fixture = await prepare();
    prepareAcceptedRecovery(fixture);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      throw new Error("native recovery failed after publication");
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(runNative).toHaveBeenCalledOnce();
    expect(inspectStateDirUpdateSessionLockForRecovery(fixture.stateDir)?.childPid).toBe(404);
  });

  it("retains a confirmed-dead native PID instead of replacing its durable sidecar", async () => {
    const fixture = await prepare();
    prepareAcceptedRecovery(fixture);
    const runNative = vi.fn((input: PortableNativeRecoveryInput) => {
      expect(input.onSpawn(404)).toBe(true);
      return Promise.resolve({ status: "failed" as const, process: "confirmed-dead" as const });
    });

    await expect(
      reconcilePortableNormalStartup({
        stateDir: fixture.stateDir,
        target: "macos-arm64",
        expectedManagedRoot: fixture.managedRoot,
        currentPid: 303,
        processIdentity: "recovery-cli",
        pidAlive: () => false,
        runNative,
      }),
    ).resolves.toEqual({ status: "recovery-required" });

    expect(inspectStateDirUpdateSessionLockForRecovery(fixture.stateDir)?.childPid).toBe(404);
  });
});
