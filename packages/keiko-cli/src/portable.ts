import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { arch as hostArch, homedir as defaultHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { loadServer } from "./lazy-modules.js";
import {
  installLayoutOverrideEvidence,
  writeInstallLayoutOverrideEvidenceWithFactory,
} from "./install-layout.js";
import { runLifecycleCli } from "./lifecycle.js";
import { PORTABLE_MANAGEMENT_ENV, PROGRAM_FOLDER_LAUNCH_ENV } from "./portable-management.js";
import {
  activateMacosPortableRuntime,
  type MacosRuntimeActivationFn,
} from "./portable-macos-activation.js";
import {
  notifyPortableLaunchFailure,
  type PortableFailureNotifierFn,
} from "./portable-launch-notifier.js";
import { writeLaunchFailureNote, type LaunchFailureReason } from "./launch-failure-note.js";
import {
  emitPortableLaunchFailed,
  LaunchFailureRecorder,
  PortableLaunchRefusal,
} from "./portable-launch-failure.js";
import {
  attestedPortableInstallRecord,
  attestedExistingPortableInstall,
  attestedManagedInstall,
  attestedRecordedManagedInstall,
  portableSourceCanReplaceManaged,
  recoverableFailedManagedRoot,
  recoverableFailedWindowsManagedRoot,
  PortableSetupBusyError,
  sameRealPath,
  setupPortable,
  spawnManagedLauncher,
  statusPortable,
  validatePortableRoot,
  withPortableManagedMutation,
  type PortableManagedInspectionAllowance,
  type PortableManagedInspectionFn,
  type PortableManagedUpgradeFn,
  type ValidatedPortableRoot,
} from "./portable-install.js";
import {
  defaultManagedRoot,
  isPortableCommand,
  isPortableTarget,
  targetForHost,
  type PortableCommand,
  type PortableLayout,
  type PortableTarget,
  type SpawnFn,
} from "./portable-shared.js";
import { hasPortableInstallRegistration } from "./portable-registration.js";
import { assertManagedRootAllowed } from "./portable-root-policy.js";
import type { CliIo } from "./runner.js";
import { createCliSecurityLogSink, type CliSecurityLogSinkFactory } from "./security-log.js";
import { inspectStateRoot } from "./state-paths.js";
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";

type LifecycleFn = (
  command: "start" | "stop",
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: {
    readonly cwd: string;
    readonly securityLogSink?: SecurityLogSink | undefined;
    /** Receives the closed reason a start ends non-zero with (#4358). */
    readonly recordFailure?: ((reason: LaunchFailureReason) => void) | undefined;
  },
) => Promise<number>;

type PortableNormalStartupRecoveryFn = (input: {
  readonly stateDir: string;
  readonly target: PortableTarget;
  readonly expectedManagedRoot: string;
  readonly securityLogSink?: SecurityLogSink | undefined;
}) => Promise<PortableNormalStartupRecoveryResult>;

interface PortableRecoveredLaunchDescriptor {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly lockIdentity: string;
  readonly activationId: string;
  readonly planSha256: string;
  readonly launchId: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly expectedVersion: string;
}

type PortableNormalStartupRecoveryResult =
  | { readonly status: "normal"; readonly inspectionAllowance?: PortableManagedInspectionAllowance }
  | { readonly status: "recovery-required" }
  | {
      readonly status: "recovered";
      readonly descriptor: PortableRecoveredLaunchDescriptor;
      readonly inspectionAllowance?: PortableManagedInspectionAllowance;
    };

interface PortableCliOptions {
  readonly command: PortableCommand;
  readonly target: PortableTarget;
  readonly portableRoot: string;
  readonly managedRoot: string;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly noRelaunch: boolean;
  /** Launch the payload where it is: no managed setup, no registration (ADR-0121 D9). */
  readonly inPlace: boolean;
  readonly provisionedConfig?: string | undefined;
  readonly home: string;
  readonly securityLogSink?: SecurityLogSink | undefined;
  /** Collects the closed reason a start ends non-zero with (#4358). */
  readonly launchFailure?: LaunchFailureRecorder | undefined;
}

export interface PortableSetupDeps {
  readonly cwd?: string | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly arch?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly spawnFn?: SpawnFn | undefined;
  readonly lifecycleFn?: LifecycleFn | undefined;
  readonly activateMacosRuntimeFn?: MacosRuntimeActivationFn | undefined;
  readonly notifyFailureFn?: PortableFailureNotifierFn | undefined;
  readonly securityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
  readonly recoverNormalStartupFn?: PortableNormalStartupRecoveryFn | undefined;
  readonly encodeRecoveredLaunchFn?:
    ((descriptor: PortableRecoveredLaunchDescriptor) => string) | undefined;
}

interface PortableArgDeps {
  readonly cwd: string;
  readonly homedir: () => string;
  readonly platform: () => NodeJS.Platform;
  readonly arch: () => string;
}

interface PortableRuntimeDeps extends PortableArgDeps {
  readonly now: () => Date;
  readonly spawnFn: SpawnFn;
  readonly lifecycleFn: LifecycleFn;
  readonly activateMacosRuntimeFn: MacosRuntimeActivationFn;
  readonly recoverNormalStartupFn: PortableNormalStartupRecoveryFn;
  readonly encodeRecoveredLaunchFn: (descriptor: PortableRecoveredLaunchDescriptor) => string;
}

type PortableUpgradeDeps = Pick<
  PortableRuntimeDeps,
  "activateMacosRuntimeFn" | "now" | "lifecycleFn"
>;

interface PortableFlag {
  readonly name: string;
  readonly value: string | undefined;
  readonly nextIndex: number;
}

interface PortableRawOptions {
  readonly target: PortableTarget | undefined;
  readonly portableRoot: string;
  readonly managedRoot: string | undefined;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly noRelaunch: boolean;
  readonly inPlace: boolean;
  readonly provisionedConfig: string | undefined;
}

const USAGE = `Usage:
  keiko portable setup  [--target TARGET] [--portable-root PATH] [--managed-root PATH] [--state-dir PATH] [--dry-run]
  keiko portable launch [--target TARGET] [--portable-root PATH] [--managed-root PATH] [--state-dir PATH]
                        [--in-place [--provisioned-config PATH]]
  keiko portable status [--target TARGET] [--portable-root PATH] [--managed-root PATH] [--state-dir PATH]
  keiko portable resolve-root [--target TARGET] [--managed-root PATH] [--state-dir PATH]

Manages archive-first portable setup into Keiko's target-specific install root.
launch --in-place starts the payload where it is: nothing is copied or registered, and Keiko
reports itself as managed outside the app.
`;

function parsePortableCommandToken(
  value: string | undefined,
): PortableCommand | "help" | undefined {
  if (value === undefined || value === "--help" || value === "-h") return "help";
  return isPortableCommand(value) ? value : undefined;
}

function readFlag(args: readonly string[], index: number): string | undefined {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function resolveInputPath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

const PORTABLE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--target",
  "--portable-root",
  "--managed-root",
  "--state-dir",
  "--provisioned-config",
]);

function parsePortableFlag(args: readonly string[], index: number): PortableFlag | undefined {
  const name = args[index];
  if (name === "--dry-run" || name === "--no-relaunch" || name === "--in-place") {
    return { name, value: undefined, nextIndex: index };
  }
  if (name === undefined || !PORTABLE_VALUE_FLAGS.has(name)) return undefined;
  const value = readFlag(args, index);
  if (value === undefined) return undefined;
  if (name === "--target" && !isPortableTarget(value)) return undefined;
  return { name, value, nextIndex: index + 1 };
}

function applyPortableFlag(
  flag: PortableFlag,
  cwd: string,
  options: PortableRawOptions,
): PortableRawOptions {
  if (flag.name === "--dry-run") return { ...options, dryRun: true };
  if (flag.name === "--no-relaunch") return { ...options, noRelaunch: true };
  if (flag.name === "--in-place") return { ...options, inPlace: true };
  if (flag.name === "--target") return { ...options, target: flag.value as PortableTarget };
  if (flag.value === undefined) return options;
  return applyPortablePathFlag(flag.name, resolveInputPath(cwd, flag.value), options);
}

function applyPortablePathFlag(
  name: string,
  value: string,
  options: PortableRawOptions,
): PortableRawOptions {
  if (name === "--portable-root") return { ...options, portableRoot: value };
  if (name === "--managed-root") return { ...options, managedRoot: value };
  if (name === "--provisioned-config") return { ...options, provisionedConfig: value };
  return { ...options, stateDir: value };
}

function initialRawOptions(env: EnvSource, deps: PortableArgDeps): PortableRawOptions {
  return {
    target: targetForHost(deps.platform(), deps.arch()),
    portableRoot: env.KEIKO_PORTABLE_ROOT ?? deps.cwd,
    managedRoot: undefined,
    stateDir: env.KEIKO_STATE_DIR ?? join(deps.homedir(), ".keiko"),
    dryRun: false,
    noRelaunch: false,
    inPlace: false,
    provisionedConfig: undefined,
  };
}

function parsePortableArgs(
  args: readonly string[],
  env: EnvSource,
  deps: PortableArgDeps,
): PortableCliOptions | "help" | undefined {
  const command = parsePortableCommandToken(args[0]);
  if (command === "help") return "help";
  if (command === undefined) return undefined;
  let raw = initialRawOptions(env, deps);
  let index = 1;
  while (index < args.length) {
    const flag = parsePortableFlag(args, index);
    if (flag === undefined) return undefined;
    index = flag.nextIndex + 1;
    raw = applyPortableFlag(flag, deps.cwd, raw);
  }
  return finalizePortableOptions(command, raw, deps, env);
}

function finalizePortableOptions(
  command: PortableCommand,
  raw: PortableRawOptions,
  deps: PortableArgDeps,
  env: EnvSource,
): PortableCliOptions | undefined {
  const target = raw.target;
  if (target === undefined) return undefined;
  // In place is a way to launch, and a provisioned configuration belongs to it: the managed
  // launcher has no administrator's file beside it.
  if (raw.inPlace && command !== "launch") return undefined;
  if (raw.provisionedConfig !== undefined && !raw.inPlace) return undefined;
  return {
    command,
    target,
    portableRoot: resolveInputPath(deps.cwd, raw.portableRoot),
    managedRoot: resolveInputPath(
      deps.cwd,
      raw.managedRoot ?? defaultManagedRoot(target, env, deps.homedir()),
    ),
    stateDir: resolveInputPath(deps.cwd, raw.stateDir),
    dryRun: raw.dryRun,
    noRelaunch: raw.noRelaunch,
    inPlace: raw.inPlace,
    ...(raw.provisionedConfig === undefined ? {} : { provisionedConfig: raw.provisionedConfig }),
    home: deps.homedir(),
  };
}

interface LaunchManagedOptions {
  readonly target: PortableTarget;
  readonly layout: PortableLayout;
  readonly io: CliIo;
  readonly env: EnvSource;
  readonly stateDir: string;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly launchFailure?: LaunchFailureRecorder | undefined;
  readonly provisionedConfig?: string | undefined;
  /**
   * In place, the start window is read by a person, not an operator: the waiver sentence would
   * only alarm them, and the Coding Workbench states the runtime's evaluation status where it
   * matters.
   */
  readonly quietActivationWaiver?: boolean | undefined;
  readonly recovered?: {
    readonly descriptor: PortableRecoveredLaunchDescriptor;
    readonly encoded: string;
  };
}

function managedLaunchOptions(
  options: PortableCliOptions,
  layout: PortableLayout,
  io: CliIo,
  env: EnvSource,
  recovered?: LaunchManagedOptions["recovered"],
): LaunchManagedOptions {
  return {
    target: options.target,
    layout,
    io,
    env,
    stateDir: options.stateDir,
    securityLogSink: options.securityLogSink,
    launchFailure: options.launchFailure,
    ...(recovered === undefined ? {} : { recovered }),
  };
}

// macOS asks the runtime activation before every launch. `false` means the launch is refused and
// its reason is already written and recorded.
async function macosRuntimeAdmitsLaunch(
  options: LaunchManagedOptions,
  activate: MacosRuntimeActivationFn,
): Promise<boolean> {
  const { target, layout, io } = options;
  if (target !== "macos-arm64" && target !== "macos-x64") return true;
  const activation = await activate(layout, target);
  if (activation === "unavailable") {
    io.err("keiko portable launch: macOS runtime activation is incomplete\n");
    recordLaunchFailure(options.launchFailure, "macos-activation");
    return false;
  }
  if (activation === "waived-unsigned" && options.quietActivationWaiver !== true) {
    io.out(
      "Keiko platform runtime containment is waived: this install carries no release signature.\n",
    );
  }
  return true;
}

function managedStartArguments(options: LaunchManagedOptions): string[] {
  const args = ["--open", "--state-dir", options.stateDir];
  if (options.provisionedConfig !== undefined) {
    args.push("--provisioned-config", options.provisionedConfig);
  }
  if (options.recovered !== undefined) {
    const { host, port } = options.recovered.descriptor;
    args.push("--host", host, "--port", String(port));
  }
  return args;
}

async function launchManaged(
  options: LaunchManagedOptions,
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "lifecycleFn">,
): Promise<number> {
  const { target, layout, io, env, securityLogSink, recovered, launchFailure } = options;
  if (!(await macosRuntimeAdmitsLaunch(options, deps.activateMacosRuntimeFn))) return 1;
  const launchEnv = {
    ...env,
    // Every managed launch runs inside the program folder (`cwd` below): it is no project.
    [PROGRAM_FOLDER_LAUNCH_ENV]: "1",
    ...(recovered === undefined ? {} : { KEIKO_PORTABLE_RECOVERED_LAUNCH: recovered.encoded }),
  };
  const nativeUiRuntime =
    target === "linux-x64"
      ? (await import("./native-ui-runtime.js")).nativeUiRuntimeForLayout(layout, securityLogSink)
      : undefined;
  return deps.lifecycleFn("start", managedStartArguments(options), io, launchEnv, {
    cwd: layout.appRoot,
    securityLogSink,
    recordFailure: failureRecorderFor(launchFailure),
    ...(nativeUiRuntime === undefined ? {} : { nativeUiRuntime }),
  });
}

function recordLaunchFailure(
  recorder: LaunchFailureRecorder | undefined,
  reason: LaunchFailureReason,
): void {
  recorder?.record(reason);
}

function failureRecorderFor(
  recorder: LaunchFailureRecorder | undefined,
): ((reason: LaunchFailureReason) => void) | undefined {
  if (recorder === undefined) return undefined;
  return (reason): void => {
    recorder.record(reason);
  };
}

async function stopManaged(
  layout: PortableLayout,
  io: CliIo,
  env: EnvSource,
  stateDir: string,
  lifecycleFn: LifecycleFn,
): Promise<number> {
  return lifecycleFn("stop", ["--state-dir", stateDir], io, env, {
    cwd: layout.appRoot,
  });
}

async function upgradeManagedFromClickedPackage(
  options: PortableCliOptions,
  source: ValidatedPortableRoot,
  current: ValidatedPortableRoot,
  io: CliIo,
  env: EnvSource,
  deps: PortableUpgradeDeps,
): Promise<number> {
  if (!portableSourceCanReplaceManaged(source, current)) {
    return launchManaged(managedLaunchOptions(options, current.layout, io, env), deps);
  }
  try {
    return await withPortableManagedMutation(options, (upgrade) =>
      upgradeManagedWhileLocked(options, source, current, io, env, deps, upgrade),
    );
  } catch (error) {
    io.err(
      `keiko portable launch: ${error instanceof Error ? error.message : "portable upgrade failed"}\n`,
    );
    options.launchFailure?.record(failureReasonOf(error, "upgrade-failed"));
    return 1;
  }
}

async function upgradeManagedWhileLocked(
  options: PortableCliOptions,
  source: ValidatedPortableRoot,
  current: ValidatedPortableRoot,
  io: CliIo,
  env: EnvSource,
  deps: PortableUpgradeDeps,
  upgrade: PortableManagedUpgradeFn,
): Promise<number> {
  const stopped = await stopManaged(current.layout, io, env, options.stateDir, deps.lifecycleFn);
  if (stopped !== 0) {
    options.launchFailure?.record("stop-failed");
    return stopped;
  }
  try {
    const upgraded = upgrade({
      target: options.target,
      source,
      current,
      managedRoot: options.managedRoot,
      stateDir: options.stateDir,
      env,
      home: options.home,
      now: deps.now(),
      io,
      securityLogSink: options.securityLogSink,
    });
    io.out("Keiko portable upgrade installed from downloaded package.\n");
    return await launchManaged(managedLaunchOptions(options, upgraded, io, env), deps);
  } catch (error) {
    io.err(
      `keiko portable launch: ${error instanceof Error ? error.message : "portable upgrade failed"}\n`,
    );
    // The upgrade failed and the previous version is started again: when that start succeeds Keiko
    // runs and the command ends with 0, not with the failure of the upgrade (#4358). The failed
    // upgrade still leaves its line now, whatever the exit code, because stderr is all a double-click
    // would otherwise keep of it. The recorder gets no `upgrade-failed` here on purpose: if the
    // relaunch then fails too, the reason the person must act on is the relaunch's (Keiko does not
    // run at all), and the first reason recorded is the one the box and the final line carry.
    emitPortableLaunchFailed(options.securityLogSink, "upgrade-failed", "not-requested");
    return launchManaged(
      {
        target: current.manifest.platformTarget,
        layout: current.layout,
        io,
        env,
        stateDir: options.stateDir,
        securityLogSink: options.securityLogSink,
        launchFailure: options.launchFailure,
      },
      deps,
    );
  }
}

function attestedKnownManagedInstall(
  options: PortableCliOptions,
  env: EnvSource,
): ValidatedPortableRoot | undefined {
  const registrationExists = hasPortableInstallRegistration(options.stateDir);
  const record = attestedPortableInstallRecord(options.stateDir, env, options.home, {
    securityLogSink: options.securityLogSink,
  });
  if (registrationExists) {
    if (record === undefined) {
      throw new PortableLaunchRefusal(
        "portable install registration is invalid",
        "registration-invalid",
      );
    }
    if (record.registration.status !== "managed") return undefined;
  }
  return (
    attestedManagedInstall(options.target, options.managedRoot, options.stateDir) ??
    attestedRecordedManagedInstall(options.managedRoot, options.stateDir) ??
    (registrationExists
      ? undefined
      : attestedExistingPortableInstall(options.managedRoot, options.stateDir))
  );
}

async function setupAndLaunchManaged(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "now" | "lifecycleFn">,
): Promise<number> {
  const setup = setupPortable({ ...options, env, home: options.home }, io, deps.now());
  if (setup.code !== 0 || setup.layout === undefined) {
    options.launchFailure?.record("setup-failed");
    return setup.code;
  }
  return await launchManaged(managedLaunchOptions(options, setup.layout, io, env), deps);
}

function setupDownloadedPortable(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<PortableRuntimeDeps, "now" | "spawnFn">,
): number {
  const setup = setupPortable({ ...options, env, home: options.home }, io, deps.now());
  if (setup.code !== 0 || setup.layout === undefined) {
    options.launchFailure?.record("setup-failed");
    return setup.code;
  }
  if (options.noRelaunch) return setup.code;
  spawnManagedLauncher(setup.layout, deps.spawnFn);
  return 0;
}

// A folder package runs where it was unpacked. The payload is validated like every portable root,
// but nothing is copied, registered or attested, and the UI process is told that this install is
// managed outside the app, so it offers neither the managed setup nor an in-app update. Update
// recovery belongs to a managed install and is not consulted.
async function launchInPlace(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "lifecycleFn">,
): Promise<number> {
  const source = validatePortableRoot(
    options.target,
    options.portableRoot,
    options.securityLogSink,
  );
  return launchManaged(
    {
      ...managedLaunchOptions(options, source.layout, io, {
        ...env,
        [PORTABLE_MANAGEMENT_ENV]: "organization-managed",
      }),
      quietActivationWaiver: true,
      ...(options.provisionedConfig === undefined
        ? {}
        : { provisionedConfig: options.provisionedConfig }),
    },
    deps,
  );
}

type PortableLaunchDeps = Pick<
  PortableRuntimeDeps,
  | "activateMacosRuntimeFn"
  | "now"
  | "spawnFn"
  | "lifecycleFn"
  | "recoverNormalStartupFn"
  | "encodeRecoveredLaunchFn"
  | "platform"
>;

async function launchThroughManagedInstall(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: PortableLaunchDeps,
): Promise<number> {
  const recovered = await recoverBeforePortableLaunch(options, io, env, deps);
  if (recovered !== undefined) return recovered;
  const source = validatePortableRoot(
    options.target,
    options.portableRoot,
    options.securityLogSink,
  );
  if (sameRealPath(source.layout.installRoot, options.managedRoot)) {
    return await setupAndLaunchManaged(options, io, env, deps);
  }
  const attestedKnownManaged = attestedKnownManagedInstall(options, env);
  if (attestedKnownManaged !== undefined) {
    return await upgradeManagedFromClickedPackage(
      options,
      source,
      attestedKnownManaged,
      io,
      env,
      deps,
    );
  }
  const recoveryRoot = failedPortableRecoveryRoot(options, env);
  return setupDownloadedPortable(
    recoveryRoot === undefined ? options : { ...options, managedRoot: recoveryRoot },
    io,
    env,
    deps,
  );
}

async function launchPortable(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: PortableLaunchDeps,
): Promise<number> {
  try {
    return options.inPlace
      ? await launchInPlace(options, io, env, deps)
      : await launchThroughManagedInstall(options, io, env, deps);
  } catch (error) {
    io.err(`keiko portable launch: ${error instanceof Error ? error.message : "unavailable"}\n`);
    options.launchFailure?.record(failureReasonOf(error, "launch-error"));
    return 1;
  }
}

// The closed reason of an error that ended the launch: a refusal carries its own, a busy setup lock
// is a conflict with another setup, anything else is the caller's fallback.
function failureReasonOf(error: unknown, fallback: LaunchFailureReason): LaunchFailureReason {
  if (error instanceof PortableLaunchRefusal) return error.reason;
  if (error instanceof PortableSetupBusyError) return "setup-busy";
  return fallback;
}

async function recoverBeforePortableLaunch(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<
    PortableRuntimeDeps,
    "activateMacosRuntimeFn" | "lifecycleFn" | "recoverNormalStartupFn" | "encodeRecoveredLaunchFn"
  >,
): Promise<number | undefined> {
  const attestedRecovery = await withPortableManagedMutation(options, (_upgrade, inspect) =>
    inspectNormalStartupRecovery(options, env, deps.recoverNormalStartupFn, inspect),
  );
  const { recovery } = attestedRecovery;
  if (recovery.status === "recovery-required") {
    throw new PortableLaunchRefusal(
      "portable update recovery is required before launch",
      "recovery-required",
    );
  }
  if (recovery.status === "normal") {
    if (attestedRecovery.managed === undefined) return undefined;
    return launchManaged(
      managedLaunchOptions(options, attestedRecovery.managed.layout, io, env),
      deps,
    );
  }
  if (attestedRecovery.managed === undefined) {
    throw new PortableLaunchRefusal(
      "recovered portable install could not be attested",
      "recovery-required",
    );
  }
  return launchManaged(
    managedLaunchOptions(options, attestedRecovery.managed.layout, io, env, {
      descriptor: recovery.descriptor,
      encoded: deps.encodeRecoveredLaunchFn(recovery.descriptor),
    }),
    deps,
  );
}

interface AttestedNormalStartupRecovery {
  readonly recovery: PortableNormalStartupRecoveryResult;
  readonly managed?: ValidatedPortableRoot | undefined;
}

async function inspectNormalStartupRecovery(
  options: PortableCliOptions,
  env: EnvSource,
  recover: PortableNormalStartupRecoveryFn,
  inspect: PortableManagedInspectionFn,
): Promise<AttestedNormalStartupRecovery> {
  const recovery = await recover({
    stateDir: options.stateDir,
    target: options.target,
    expectedManagedRoot: options.managedRoot,
    securityLogSink: options.securityLogSink,
  });
  if (recovery.status === "recovery-required") {
    if (Object.hasOwn(recovery, "inspectionAllowance")) {
      throw new Error("portable recovery-required result must not carry an inspection allowance");
    }
    return { recovery };
  }
  const allowance = recovery.inspectionAllowance;
  if (recovery.status === "normal" && allowance === undefined) return { recovery };
  const managed = attestedKnownManagedInstall(options, env);
  if (managed === undefined) throw new Error("recovered portable install could not be attested");
  const scan = inspect(managed.layout, allowance);
  if (scan.issues.length > 0) throw new Error(scan.issues[0]);
  return { recovery, managed };
}

async function defaultPortableRecovery(
  input: Parameters<PortableNormalStartupRecoveryFn>[0],
): Promise<PortableNormalStartupRecoveryResult> {
  const server = (await loadServer()) as unknown as {
    readonly reconcilePortableNormalStartup: PortableNormalStartupRecoveryFn;
  };
  return server.reconcilePortableNormalStartup(input);
}

function defaultRecoveredLaunchEncoding(descriptor: PortableRecoveredLaunchDescriptor): string {
  return Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url");
}

function resolvedPortableRecoveryDeps(
  deps: PortableSetupDeps,
): Pick<PortableRuntimeDeps, "recoverNormalStartupFn" | "encodeRecoveredLaunchFn"> {
  return {
    recoverNormalStartupFn: deps.recoverNormalStartupFn ?? defaultPortableRecovery,
    encodeRecoveredLaunchFn: deps.encodeRecoveredLaunchFn ?? defaultRecoveredLaunchEncoding,
  };
}

function resolvedDeps(deps: PortableSetupDeps): PortableRuntimeDeps {
  return {
    cwd: deps.cwd ?? process.cwd(),
    homedir: deps.homedir ?? defaultHomedir,
    platform: deps.platform ?? ((): NodeJS.Platform => process.platform),
    arch: deps.arch ?? hostArch,
    now: deps.now ?? ((): Date => new Date()),
    spawnFn: deps.spawnFn ?? spawn,
    lifecycleFn: deps.lifecycleFn ?? runLifecycleCli,
    activateMacosRuntimeFn: deps.activateMacosRuntimeFn ?? activateMacosPortableRuntime,
    ...resolvedPortableRecoveryDeps(deps),
  };
}

function failedPortableRecoveryRoot(
  options: PortableCliOptions,
  env: EnvSource,
): string | undefined {
  const requestedRoot = recoverableFailedManagedRoot(
    options.target,
    options.managedRoot,
    options.stateDir,
  );
  if (requestedRoot !== undefined || options.target !== "windows-x64") return requestedRoot;
  return recoverableFailedWindowsManagedRoot(options.stateDir, env, options.home, {
    securityLogSink: options.securityLogSink,
  });
}

function resolvedPortableManagedRoot(options: PortableCliOptions, env: EnvSource): string {
  const registrationExists = hasPortableInstallRegistration(options.stateDir);
  const record = attestedPortableInstallRecord(options.stateDir, env, options.home, {
    securityLogSink: options.securityLogSink,
  });
  if (record === undefined) {
    if (registrationExists) throw new Error("portable install registration is invalid");
    return options.managedRoot;
  }
  if (record.target !== options.target) {
    throw new Error("registered managed install target does not match the requested target");
  }
  if (record.registration.status !== "managed") {
    const recoveryRoot = failedPortableRecoveryRoot(options, env);
    if (recoveryRoot !== undefined) return recoveryRoot;
    if (
      record.registration.installRootIdentitySha256 === undefined &&
      !existsSync(options.managedRoot)
    ) {
      return options.managedRoot;
    }
    throw new Error(
      "portable setup is incomplete; registered install root must be recovered before launch",
    );
  }
  if (record.managedRoot === undefined) {
    throw new Error("registered managed install root could not be attested");
  }
  return record.managedRoot;
}

function resolvePortableManagedRoot(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
): number {
  try {
    emitPortableManagedRoot(resolvedPortableManagedRoot(options, env), options, io);
    return 0;
  } catch (error) {
    io.err(
      `keiko portable resolve-root: ${error instanceof Error ? error.message : "unavailable"}\n`,
    );
    return 1;
  }
}

function emitPortableManagedRoot(
  managedRoot: string,
  options: PortableCliOptions,
  io: CliIo,
): void {
  assertManagedRootAllowed(managedRoot, options.stateDir, options.target, options.securityLogSink);
  const hasControlCharacter = Array.from(managedRoot).some(
    (character): boolean => (character.codePointAt(0) ?? 0) <= 0x1f,
  );
  if (hasControlCharacter || (options.target === "windows-x64" && managedRoot.includes('"'))) {
    throw new Error("managed install root cannot be safely transported");
  }
  io.out(`${managedRoot}\n`);
}

// The note for the native launcher's box. A note that cannot be written leaves the launcher's
// generic text, and the command says so on its own stream.
function reportLaunchNoteFailure(io: CliIo): void {
  io.err("keiko portable launch: the failure note for the launcher could not be written\n");
}

function leaveLaunchFailureNote(
  env: EnvSource,
  reason: LaunchFailureReason,
  io: CliIo,
): "written" | "not-requested" | "failed" {
  try {
    return writeLaunchFailureNote(env, reason);
  } catch {
    reportLaunchNoteFailure(io);
    return "failed";
  }
}

function notifyPortableFailureIfNeeded(
  code: number,
  message: string,
  env: EnvSource,
  io: CliIo,
  deps: PortableSetupDeps,
  options: PortableCliOptions,
): void {
  if (code === 0) return;
  // One closed line for every non-zero exit, and the reason for the Windows launcher's own box. The
  // line goes through the invocation's sink and is flushed by the command's runner before the
  // process can end; the Windows launcher shows the box, so no notifier process is started there.
  const reason =
    options.launchFailure?.reason ??
    (options.command === "setup" ? "setup-failed" : "launch-error");
  const note = leaveLaunchFailureNote(env, reason, io);
  emitPortableLaunchFailed(options.securityLogSink, reason, note);
  const notify =
    deps.notifyFailureFn ??
    ((failureMessage: string, notifyEnv: EnvSource): void => {
      notifyPortableLaunchFailure(failureMessage, notifyEnv, {
        reportAlertFailure: io.err,
      });
    });
  notify(message, env);
}

function writePortableInstallLayoutEvidence(
  options: PortableCliOptions,
  env: EnvSource,
  factory: CliSecurityLogSinkFactory | undefined,
): void {
  if (installLayoutOverrideEvidence(env) === undefined) return;
  const stateRoot = inspectStateRoot(options.stateDir);
  if (stateRoot.status !== "absent" && stateRoot.status !== "directory") return;
  writeInstallLayoutOverrideEvidenceWithFactory(factory, options.stateDir, env);
}

export async function runPortableCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: PortableSetupDeps = {},
): Promise<number> {
  const r = resolvedDeps(deps);
  const options = parsePortableArgs(args, env, r);
  if (options === "help") {
    io.out(USAGE);
    return 0;
  }
  if (options === undefined) {
    io.err(USAGE);
    return 2;
  }
  if (options.command === "status") return statusPortable(options, io);
  writePortableInstallLayoutEvidence(options, env, deps.securityLogSinkFactory);
  const commandOptions: PortableCliOptions = {
    ...options,
    securityLogSink: createCliSecurityLogSink(options.stateDir, deps.securityLogSinkFactory),
    launchFailure: new LaunchFailureRecorder(),
  };
  if (commandOptions.command === "resolve-root") {
    return resolvePortableManagedRoot(commandOptions, io, env);
  }
  let lastError = "";
  const trackedIo: CliIo = {
    out: (text): void => {
      io.out(text);
    },
    err: (text): void => {
      lastError = text;
      io.err(text);
    },
  };
  const code =
    commandOptions.command === "setup"
      ? setupPortable({ ...commandOptions, env }, trackedIo, r.now()).code
      : await launchPortable(commandOptions, trackedIo, env, r);
  notifyPortableFailureIfNeeded(code, lastError, env, io, deps, commandOptions);
  return code;
}
