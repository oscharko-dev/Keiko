// `keiko uninstall` — reverses the runtime artifacts Keiko creates on a machine so a
// user can clean their device and reinstall a clean version. CLI-only surface; no UI
// route, no server change, no new runtime dependency.
//
// SCOPE BOUNDARY (deliberate, see PR rationale): Keiko never removes its own installed
// npm package. A running Node process cannot reliably delete the package files it is
// executing from, and the deterministic-first architecture avoids shelling into a
// package manager. `uninstall` therefore reverses only Keiko-OWNED runtime artifacts
// and prints the exact package-manager command to remove the package itself — the same
// guidance `keiko doctor` already gives. The artifacts reversed are:
//
//   1. Launcher OS shortcuts — delegated to `removeLauncherShortcuts`, which
//      content-hash-verifies each recorded shortcut and refuses any foreign/modified
//      file (home-contained; never deletes a file Keiko did not generate).
//   2. `keiko:start` / `keiko:stop` scripts in the project `package.json` — removed
//      ONLY when their value exactly matches what `keiko init` writes, so a
//      user-customized script is never clobbered.
//   3. The `.keiko/` state directory — only the enumerated `KEIKO_STATE_FILES` and the
//      launcher's `.launcher-state-*` temp dirs are deleted, then the directory is
//      removed when (and only when) it is empty. Nothing recursively deletes an
//      arbitrary directory.
//
// With no scope flag every step runs; `--state` / `--launchers` / `--scripts` narrow
// it. `--dry-run` reports `would-...` without changing anything.

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";
import { LauncherError } from "./launcher-platforms.js";
import { removeLauncherShortcuts } from "./launcher.js";
import { KEIKO_START_SCRIPT, KEIKO_STOP_SCRIPT } from "./init.js";
import { localPackageRoot } from "./install-layout.js";
import {
  KEIKO_STATE_FILES,
  LAUNCHER_STATE_TMP_PREFIX,
  classifyPid,
  defaultIsProcessAlive,
  resolveStateDir,
} from "./state-paths.js";

const USAGE = `Usage:
  keiko uninstall [--state] [--launchers] [--scripts] [--state-dir PATH]
                  [--package PATH] [--force] [--dry-run]

Reverses the runtime artifacts Keiko creates on this machine:
  --launchers  remove the user-local OS shortcut(s) (\`keiko launcher install\`)
  --scripts    remove the keiko:start / keiko:stop scripts from package.json
  --state      remove the .keiko state directory (ui.pid, ui.log, launcher state)

With no scope flag, all three are removed. The installed npm package itself is left in
place; the command prints the package-manager step to remove it. \`--force\` stops a
running UI before removing state; \`--dry-run\` shows what would be removed.
`;

const KEIKO_SCRIPTS: Readonly<Record<string, string>> = {
  "keiko:start": KEIKO_START_SCRIPT,
  "keiko:stop": KEIKO_STOP_SCRIPT,
};

interface UninstallScopes {
  readonly state: boolean;
  readonly launchers: boolean;
  readonly scripts: boolean;
}

interface UninstallOptions {
  readonly scopes: UninstallScopes;
  readonly packagePath: string;
  readonly stateDirArg: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
}

export interface UninstallCliDeps {
  readonly cwd?: string | undefined;
  readonly homedir?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly killProcess?: (pid: number, signal?: NodeJS.Signals | 0) => void;
}

interface RawUninstallArgs {
  state: boolean;
  launchers: boolean;
  scripts: boolean;
  stateDirArg: string | undefined;
  packageArg: string | undefined;
  dryRun: boolean;
  force: boolean;
}

function readFlagValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function applyValuedFlag(raw: RawUninstallArgs, arg: string, value: string): void {
  if (arg === "--state-dir") raw.stateDirArg = value;
  else raw.packageArg = value;
}

function applyBooleanFlag(raw: RawUninstallArgs, arg: string): boolean {
  switch (arg) {
    case "--state":
      raw.state = true;
      return true;
    case "--launchers":
      raw.launchers = true;
      return true;
    case "--scripts":
      raw.scripts = true;
      return true;
    case "--dry-run":
      raw.dryRun = true;
      return true;
    case "--force":
      raw.force = true;
      return true;
    default:
      return false;
  }
}

function parseUninstallArgs(
  args: readonly string[],
  cwd: string,
): UninstallOptions | "help" | null {
  const raw: RawUninstallArgs = {
    state: false,
    launchers: false,
    scripts: false,
    stateDirArg: undefined,
    packageArg: undefined,
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return null;
    if (arg === "--help" || arg === "-h") return "help";
    if (applyBooleanFlag(raw, arg)) continue;
    if (arg === "--state-dir" || arg === "--package") {
      const value = readFlagValue(args, i);
      if (value === null) return null;
      applyValuedFlag(raw, arg, value);
      i += 1;
      continue;
    }
    return null;
  }
  return finalizeOptions(raw, cwd);
}

function finalizeOptions(raw: RawUninstallArgs, cwd: string): UninstallOptions {
  const anyScope = raw.state || raw.launchers || raw.scripts;
  return {
    scopes: anyScope
      ? { state: raw.state, launchers: raw.launchers, scripts: raw.scripts }
      : { state: true, launchers: true, scripts: true },
    packagePath:
      raw.packageArg === undefined ? resolve(cwd, "package.json") : resolve(cwd, raw.packageArg),
    stateDirArg: raw.stateDirArg,
    dryRun: raw.dryRun,
    force: raw.force,
  };
}

interface ResolvedDeps {
  readonly cwd: string;
  readonly homedir: () => string;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: (pid: number, signal?: NodeJS.Signals | 0) => void;
}

function resolveDeps(deps: UninstallCliDeps): ResolvedDeps {
  return {
    cwd: deps.cwd ?? process.cwd(),
    homedir: deps.homedir ?? defaultHomedir,
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    killProcess: deps.killProcess ?? process.kill.bind(process),
  };
}

// Returns "ok" to proceed, or "refused" when state removal is requested while the UI is
// running and `--force` was not given (removing live state would orphan the process).
function ensureServerStoppable(
  opts: UninstallOptions,
  io: CliIo,
  deps: ResolvedDeps,
  stateDir: string,
): "ok" | "refused" {
  if (!opts.scopes.state) return "ok";
  const probe = classifyPid(join(stateDir, "ui.pid"), deps.isProcessAlive);
  if (probe.state !== "running" || probe.pid === undefined) return "ok";
  if (!opts.force) {
    io.err(
      `keiko uninstall: the Keiko UI is running (pid ${String(probe.pid)}). Run \`keiko stop\` first, or re-run with --force to stop it.\n`,
    );
    return "refused";
  }
  if (opts.dryRun) {
    io.out(`would-stop: Keiko UI (pid ${String(probe.pid)})\n`);
    return "ok";
  }
  io.out(`Stopping Keiko UI (pid ${String(probe.pid)}) ...\n`);
  try {
    deps.killProcess(probe.pid, "SIGTERM");
  } catch {
    // Process already exited between the probe and the signal — nothing to stop.
  }
  return "ok";
}

function removeLaunchersStep(
  opts: UninstallOptions,
  io: CliIo,
  deps: ResolvedDeps,
  stateDir: string,
): number {
  if (!opts.scopes.launchers) return 0;
  const result = removeLauncherShortcuts(io, {
    stateDir,
    homedir: deps.homedir(),
    dryRun: opts.dryRun,
  });
  return result.refused;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneKeikoScripts(
  scripts: Record<string, unknown>,
  io: CliIo,
  dryRun: boolean,
): { readonly next: Record<string, unknown>; readonly removed: number } {
  const removeNames = new Set<string>();
  for (const [name, expected] of Object.entries(KEIKO_SCRIPTS)) {
    if (!(name in scripts)) continue;
    if (scripts[name] !== expected) {
      io.out(`kept: ${name} (customized — not the script keiko init writes)\n`);
      continue;
    }
    io.out(`${dryRun ? "would-remove" : "removed"}: package.json script ${name}\n`);
    removeNames.add(name);
  }
  const next = Object.fromEntries(Object.entries(scripts).filter(([key]) => !removeNames.has(key)));
  return { next, removed: removeNames.size };
}

function removeScriptsStep(opts: UninstallOptions, io: CliIo): void {
  if (!opts.scopes.scripts) return;
  if (!existsSync(opts.packagePath)) {
    io.out(`scripts: package.json not found at ${opts.packagePath} (nothing to remove)\n`);
    return;
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(opts.packagePath, "utf8"));
  } catch {
    io.err(
      `keiko uninstall: package.json at ${opts.packagePath} is not valid JSON; skipping scripts.\n`,
    );
    return;
  }
  const scripts = isRecord(pkg) ? pkg.scripts : undefined;
  if (!isRecord(pkg) || !isRecord(scripts)) {
    io.out("scripts: no keiko:start / keiko:stop scripts found.\n");
    return;
  }
  const { next, removed } = pruneKeikoScripts(scripts, io, opts.dryRun);
  if (removed > 0 && !opts.dryRun) {
    writeFileSync(
      opts.packagePath,
      `${JSON.stringify({ ...pkg, scripts: next }, null, 2)}\n`,
      "utf8",
    );
  }
}

function removeStateFiles(stateDir: string, io: CliIo, dryRun: boolean): void {
  for (const name of KEIKO_STATE_FILES) {
    const target = join(stateDir, name);
    if (!existsSync(target)) continue;
    if (dryRun) {
      io.out(`would-remove: ${target}\n`);
      continue;
    }
    unlinkSync(target);
    io.out(`removed: ${target}\n`);
  }
  for (const name of readdirSync(stateDir)) {
    if (!name.startsWith(LAUNCHER_STATE_TMP_PREFIX)) continue;
    const target = join(stateDir, name);
    if (dryRun) {
      io.out(`would-remove: ${target}\n`);
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    io.out(`removed: ${target}\n`);
  }
}

// Entries Keiko owns within the state dir: the fixed state files plus launcher temp
// dirs. Used to decide whether the directory can be removed — in `--dry-run` the files
// are not actually deleted, so the emptiness check must discount what WOULD be removed.
function isKeikoOwnedEntry(name: string): boolean {
  return (
    (KEIKO_STATE_FILES as readonly string[]).includes(name) ||
    name.startsWith(LAUNCHER_STATE_TMP_PREFIX)
  );
}

function removeStateStep(opts: UninstallOptions, io: CliIo, stateDir: string): void {
  if (!opts.scopes.state) return;
  if (!existsSync(stateDir)) {
    io.out(`state: ${stateDir} not found (nothing to remove)\n`);
    return;
  }
  removeStateFiles(stateDir, io, opts.dryRun);
  const foreign = readdirSync(stateDir).filter((name) => !isKeikoOwnedEntry(name));
  if (foreign.length === 0) {
    if (opts.dryRun) io.out(`would-remove: ${stateDir} (empty after removals)\n`);
    else {
      rmdirSync(stateDir);
      io.out(`removed: ${stateDir}\n`);
    }
    return;
  }
  io.out(
    `kept: ${stateDir} (still contains ${String(foreign.length)} non-Keiko entr${foreign.length === 1 ? "y" : "ies"})\n`,
  );
}

function printPackageGuidance(io: CliIo, deps: ResolvedDeps): void {
  const localInstalled = existsSync(localPackageRoot(deps.cwd));
  io.out("\nKeiko runtime artifacts processed. To remove the package itself, run:\n");
  if (localInstalled) {
    io.out("  npm uninstall @oscharko-dev/keiko        (local install in this project)\n");
    io.out("  npm uninstall -g @oscharko-dev/keiko     (if also installed globally)\n");
  } else {
    io.out("  npm uninstall -g @oscharko-dev/keiko     (global install)\n");
    io.out("  npm uninstall @oscharko-dev/keiko        (if installed locally in a project)\n");
  }
}

export function runUninstallCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UninstallCliDeps = {},
): number {
  const resolved = resolveDeps(deps);
  const opts = parseUninstallArgs(args, resolved.cwd);
  if (opts === "help") {
    io.out(USAGE);
    return 0;
  }
  if (opts === null) {
    io.err(USAGE);
    return 2;
  }
  const stateDir = resolveStateDir(resolved.cwd, env, opts.stateDirArg);
  try {
    if (ensureServerStoppable(opts, io, resolved, stateDir) === "refused") return 1;
    const launcherRefused = removeLaunchersStep(opts, io, resolved, stateDir);
    removeScriptsStep(opts, io);
    removeStateStep(opts, io, stateDir);
    printPackageGuidance(io, resolved);
    return launcherRefused > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof LauncherError) {
      io.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
