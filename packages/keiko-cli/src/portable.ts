import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { arch as hostArch, homedir as defaultHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
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

type LifecycleFn = (
  command: "start" | "stop",
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: { readonly cwd: string },
) => Promise<number>;

interface PortableCliOptions {
  readonly command: PortableCommand;
  readonly target: PortableTarget;
  readonly portableRoot: string;
  readonly managedRoot: string;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly noRelaunch: boolean;
  readonly home: string;
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

async function launchManaged(
  target: PortableTarget,
  layout: PortableLayout,
  io: CliIo,
  env: EnvSource,
  stateDir: string,
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "lifecycleFn">,
): Promise<number> {
  if (target !== "windows-x64") {
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
  return deps.lifecycleFn("start", ["--open", "--state-dir", stateDir], io, env, {
    cwd: layout.appRoot,
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
): Promise<number> {
  await launchManaged(target, layout, io, env, stateDir, deps);
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
    return launchManaged(options.target, current.layout, io, env, options.stateDir, deps);
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
    });
    io.out("Keiko portable upgrade installed from downloaded package.\n");
    return await launchManaged(options.target, upgraded, io, env, options.stateDir, deps);
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
    );
  }
}

function attestedKnownManagedInstall(
  options: PortableCliOptions,
  env: EnvSource,
): ValidatedPortableRoot | undefined {
  const registrationExists = hasPortableInstallRegistration(options.stateDir);
  const record = attestedPortableInstallRecord(options.stateDir, env, options.home);
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
  return await launchManaged(options.target, setup.layout, io, env, options.stateDir, deps);
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
  deps: Pick<PortableRuntimeDeps, "activateMacosRuntimeFn" | "now" | "spawnFn" | "lifecycleFn">,
): Promise<number> {
  try {
    const source = validatePortableRoot(options.target, options.portableRoot);
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
  return recoverableFailedWindowsManagedRoot(options.stateDir, env, options.home);
}

function resolvedPortableManagedRoot(options: PortableCliOptions, env: EnvSource): string {
  const registrationExists = hasPortableInstallRegistration(options.stateDir);
  const record = attestedPortableInstallRecord(options.stateDir, env, options.home);
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
  assertManagedRootAllowed(managedRoot, options.stateDir, options.target);
  const hasControlCharacter = Array.from(managedRoot).some(
    (character): boolean => (character.codePointAt(0) ?? 0) <= 0x1f,
  );
  if (hasControlCharacter || (options.target === "windows-x64" && managedRoot.includes('"'))) {
    throw new Error("managed install root cannot be safely transported");
  }
  io.out(`${managedRoot}\n`);
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
  if (options.command === "resolve-root") return resolvePortableManagedRoot(options, io, env);
  if (options.command === "status") return statusPortable(options, io);
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
    options.command === "setup"
      ? setupPortable({ ...options, env }, trackedIo, r.now()).code
      : await launchPortable(options, trackedIo, env, r);
  if (code !== 0) {
    const notify =
      deps.notifyFailureFn ??
      ((message: string, notifyEnv: EnvSource): void => {
        notifyPortableLaunchFailure(message, notifyEnv, { reportAlertFailure: io.err });
      });
    notify(lastError, env);
  }
  return code;
}
