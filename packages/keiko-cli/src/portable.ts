import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { arch as hostArch, homedir as defaultHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { loadServer } from "./lazy-modules.js";
import { runLifecycleCli } from "./lifecycle.js";
import {
  activateMacosPortableRuntime,
  type MacosRuntimeActivationFn,
} from "./portable-macos-activation.js";
import {
  notifyPortableLaunchFailure,
  type PortableFailureNotifierFn,
} from "./portable-launch-notifier.js";
import {
  attestedPortableInstallRecord,
  attestedExistingPortableInstall,
  attestedManagedInstall,
  attestedRecordedManagedInstall,
  portableSourceCanReplaceManaged,
  recoverableFailedManagedRoot,
  recoverableFailedWindowsManagedRoot,
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
import type { SecurityLogSink } from "@oscharko-dev/keiko-security";

type LifecycleFn = (
  command: "start" | "stop",
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: { readonly cwd: string; readonly securityLogSink?: SecurityLogSink | undefined },
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
  readonly home: string;
  readonly securityLogSink?: SecurityLogSink | undefined;
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
}

const USAGE = `Usage:
  keiko portable setup  [--target TARGET] [--portable-root PATH] [--managed-root PATH] [--state-dir PATH] [--dry-run]
  keiko portable launch [--target TARGET] [--portable-root PATH] [--managed-root PATH] [--state-dir PATH]
  keiko portable status [--target TARGET] [--portable-root PATH] [--managed-root PATH] [--state-dir PATH]
  keiko portable resolve-root [--target TARGET] [--managed-root PATH] [--state-dir PATH]

Manages archive-first portable setup into Keiko's target-specific install root.
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

function parsePortableFlag(args: readonly string[], index: number): PortableFlag | undefined {
  const name = args[index];
  if (name === "--dry-run" || name === "--no-relaunch") {
    return { name, value: undefined, nextIndex: index };
  }
  if (
    name !== "--target" &&
    name !== "--portable-root" &&
    name !== "--managed-root" &&
    name !== "--state-dir"
  ) {
    return undefined;
  }
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
  if (flag.name === "--target") return { ...options, target: flag.value as PortableTarget };
  if (flag.value === undefined) return options;
  const value = resolveInputPath(cwd, flag.value);
  if (flag.name === "--portable-root") return { ...options, portableRoot: value };
  if (flag.name === "--managed-root") return { ...options, managedRoot: value };
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
    ...(recovered === undefined ? {} : { recovered }),
  };
}

async function launchManaged(
  options: LaunchManagedOptions,
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "lifecycleFn">,
): Promise<number> {
  const { target, layout, io, env, stateDir, securityLogSink, recovered } = options;
  if (target === "macos-arm64" || target === "macos-x64") {
    const activation = await deps.activateMacosRuntimeFn(layout, target);
    if (activation === "unavailable") {
      io.err("keiko portable launch: macOS runtime activation is incomplete\n");
      return 1;
    }
    if (activation === "waived-unsigned") {
      io.out(
        "Keiko platform runtime containment is waived: this install carries no release signature.\n",
      );
    }
  }
  const args = ["--open", "--state-dir", stateDir];
  if (recovered !== undefined) {
    args.push("--host", recovered.descriptor.host, "--port", String(recovered.descriptor.port));
  }
  const launchEnv =
    recovered === undefined ? env : { ...env, KEIKO_PORTABLE_RECOVERED_LAUNCH: recovered.encoded };
  return deps.lifecycleFn("start", args, io, launchEnv, {
    cwd: layout.appRoot,
    securityLogSink,
  });
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

async function relaunchPreviousManaged(
  target: PortableTarget,
  layout: PortableLayout,
  io: CliIo,
  env: EnvSource,
  stateDir: string,
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "lifecycleFn">,
  securityLogSink?: SecurityLogSink,
): Promise<number> {
  await launchManaged({ target, layout, io, env, stateDir, securityLogSink }, deps);
  return 1;
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
  if (stopped !== 0) return stopped;
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
    return relaunchPreviousManaged(
      current.manifest.platformTarget,
      current.layout,
      io,
      env,
      options.stateDir,
      deps,
      options.securityLogSink,
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
    if (record === undefined) throw new Error("portable install registration is invalid");
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
  if (setup.code !== 0 || setup.layout === undefined) return setup.code;
  return await launchManaged(managedLaunchOptions(options, setup.layout, io, env), deps);
}

function setupDownloadedPortable(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<PortableRuntimeDeps, "now" | "spawnFn">,
): number {
  const setup = setupPortable({ ...options, env, home: options.home }, io, deps.now());
  if (setup.code !== 0 || setup.layout === undefined || options.noRelaunch) return setup.code;
  spawnManagedLauncher(setup.layout, deps.spawnFn);
  return 0;
}

async function launchPortable(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<
    PortableRuntimeDeps,
    | "activateMacosRuntimeFn"
    | "now"
    | "spawnFn"
    | "lifecycleFn"
    | "recoverNormalStartupFn"
    | "encodeRecoveredLaunchFn"
  >,
): Promise<number> {
  try {
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
  } catch (error) {
    io.err(`keiko portable launch: ${error instanceof Error ? error.message : "unavailable"}\n`);
    return 1;
  }
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
    throw new Error("portable update recovery is required before launch");
  }
  if (recovery.status === "normal") {
    if (attestedRecovery.managed === undefined) return undefined;
    return launchManaged(
      managedLaunchOptions(options, attestedRecovery.managed.layout, io, env),
      deps,
    );
  }
  if (attestedRecovery.managed === undefined) {
    throw new Error("recovered portable install could not be attested");
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

function notifyPortableFailureIfNeeded(
  code: number,
  message: string,
  env: EnvSource,
  io: CliIo,
  deps: PortableSetupDeps,
  securityLogSink: SecurityLogSink | undefined,
): void {
  if (code === 0) return;
  const notify =
    deps.notifyFailureFn ??
    ((failureMessage: string, notifyEnv: EnvSource): void => {
      notifyPortableLaunchFailure(failureMessage, notifyEnv, {
        reportAlertFailure: io.err,
        securityLogSink,
      });
    });
  notify(message, env);
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
  const commandOptions: PortableCliOptions = {
    ...options,
    securityLogSink: createCliSecurityLogSink(options.stateDir, deps.securityLogSinkFactory),
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
  notifyPortableFailureIfNeeded(code, lastError, env, io, deps, commandOptions.securityLogSink);
  return code;
}
