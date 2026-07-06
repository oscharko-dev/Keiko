import { spawn } from "node:child_process";
import { arch as hostArch, homedir as defaultHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { runLifecycleCli } from "./lifecycle.js";
import {
  attestedManagedRoot,
  sameRealPath,
  setupPortable,
  spawnManagedLauncher,
  statusPortable,
  validatePortableRoot,
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
import type { CliIo } from "./runner.js";

type LifecycleFn = (
  command: "start",
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
}

export interface PortableSetupDeps {
  readonly cwd?: string | undefined;
  readonly homedir?: (() => string) | undefined;
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly arch?: (() => string) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly spawnFn?: SpawnFn | undefined;
  readonly lifecycleFn?: LifecycleFn | undefined;
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
}

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

Manages archive-first portable setup into a user-owned Keiko install root.
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
  for (let index = 1; index < args.length; index += 1) {
    const flag = parsePortableFlag(args, index);
    if (flag === undefined) return undefined;
    index = flag.nextIndex;
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
  };
}

async function launchManaged(
  layout: PortableLayout,
  io: CliIo,
  env: EnvSource,
  stateDir: string,
  lifecycleFn: LifecycleFn,
): Promise<number> {
  return lifecycleFn("start", ["--open", "--state-dir", stateDir], io, env, {
    cwd: layout.appRoot,
  });
}

async function launchPortable(
  options: PortableCliOptions,
  io: CliIo,
  env: EnvSource,
  deps: Pick<PortableRuntimeDeps, "now" | "spawnFn" | "lifecycleFn">,
): Promise<number> {
  try {
    const source = validatePortableRoot(options.target, options.portableRoot);
    const attestedManaged = attestedManagedRoot(
      options.target,
      options.managedRoot,
      options.stateDir,
    );
    if (attestedManaged !== undefined) {
      return await launchManaged(attestedManaged, io, env, options.stateDir, deps.lifecycleFn);
    }
    if (sameRealPath(source.layout.installRoot, options.managedRoot)) {
      const setup = setupPortable(options, io, deps.now());
      if (setup.code !== 0 || setup.layout === undefined) return setup.code;
      return await launchManaged(setup.layout, io, env, options.stateDir, deps.lifecycleFn);
    }
    const setup = setupPortable(options, io, deps.now());
    if (setup.code !== 0 || setup.layout === undefined || options.noRelaunch) return setup.code;
    spawnManagedLauncher(setup.layout, deps.spawnFn);
    return 0;
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
  };
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
  if (options.command === "setup") return setupPortable(options, io, r.now()).code;
  return launchPortable(options, io, env, r);
}
