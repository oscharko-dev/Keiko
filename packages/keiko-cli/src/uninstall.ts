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
//   3. The `.keiko/` state directory — every artifact the allowlisted runtime-state
//      manifest (`state-paths.ts`, Issue #1321) recognizes is removed: lifecycle/launcher
//      files, the UI / Memory / Local-Knowledge databases and their WAL/SHM sidecars,
//      Evidence and Quality-Intelligence records, and the sealed credential vaults. An
//      unrecognized customer file and any symlink are left in place; a directory (and the
//      state root) is removed only once no such entry survives beneath it. Nothing
//      recursively deletes an arbitrary directory or follows a symlink out of `.keiko`.
//
// With no scope flag every step runs; `--state` / `--launchers` / `--scripts` narrow
// it. `--dry-run` reports `would-...` without changing anything.

import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";
import { LauncherError } from "./launcher-platforms.js";
import { removeLauncherShortcuts } from "./launcher.js";
import { KEIKO_START_SCRIPT, KEIKO_STOP_SCRIPT } from "./init.js";
import { localPackageRoot } from "./install-layout.js";
import {
  classifyPid,
  defaultIsProcessAlive,
  inspectStateRoot,
  isInsidePath,
  resolveStateDir,
  scanRuntimeState,
  type RuntimeStateScan,
  type StateRootInspection,
} from "./state-paths.js";

const USAGE = `Usage:
  keiko uninstall [--state] [--launchers] [--scripts] [--state-dir PATH]
                  [--package PATH] [--force] [--dry-run]

Reverses the runtime artifacts Keiko creates on this machine:
  --launchers  remove the user-local OS shortcut(s) (\`keiko launcher install\`)
  --scripts    remove the keiko:start / keiko:stop scripts from package.json
  --state      remove Keiko-owned runtime state under .keiko: lifecycle/launcher files,
               UI / Memory / Local-Knowledge databases and their WAL/SHM sidecars,
               Evidence and Quality-Intelligence records, and the sealed credential vaults

With no scope flag, all three are removed. An unknown (non-Keiko) file under .keiko and any
symlink are always left in place, and the state directory is removed only once nothing of
yours remains. The installed npm package itself is left in place; the command prints the
package-manager step to remove it. \`--force\` stops a running UI before removing state;
\`--dry-run\` shows what would be removed. Filesystem unlinking does not guarantee secure
erasure of SSD-backed data.
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

// Issue #1321: remove every Keiko-owned sensitive runtime artifact under the state dir,
// not only the three lifecycle/launcher files. The set is the allowlisted manifest in
// `state-paths.ts` (UI/Memory/Knowledge DBs + sidecars, Evidence/QI records, the sealed
// credential vaults, config, logs). Anything the manifest does not recognize — an unknown
// customer file or a symlink — is reported and left in place, and a directory is removed
// only when no such retained entry survives beneath it. Content-free: paths only.
function removeOwnedFiles(scan: RuntimeStateScan, io: CliIo, dryRun: boolean): void {
  for (const file of scan.files) {
    if (dryRun) {
      io.out(`would-remove: ${file.absPath}\n`);
      continue;
    }
    unlinkSync(file.absPath);
    io.out(`removed: ${file.absPath}\n`);
  }
}

function reportRetained(scan: RuntimeStateScan, io: CliIo): void {
  for (const entry of scan.retained) {
    const why =
      entry.reason === "symlink"
        ? "symlink — not followed"
        : entry.reason === "hardlink"
          ? "hardlink — not modified or removed"
          : "not a recognized Keiko artifact";
    io.out(`kept: ${entry.absPath} (${why})\n`);
  }
}

// Owned directories are visited deepest-first (the scan lists them shallowest-first). A
// directory is removed only when no retained entry lives beneath it, so an unknown file or
// a refused symlink anywhere inside keeps the whole chain up to the state root in place.
function removeOwnedDirectories(scan: RuntimeStateScan, io: CliIo, dryRun: boolean): void {
  for (const dir of [...scan.directories].reverse()) {
    if (scan.retained.some((entry) => isInsidePath(dir.absPath, entry.absPath))) continue;
    if (dryRun) {
      io.out(`would-remove: ${dir.absPath}\n`);
      continue;
    }
    rmdirSync(dir.absPath);
    io.out(`removed: ${dir.absPath}\n`);
  }
}

function finalizeStateDir(
  scan: RuntimeStateScan,
  stateDir: string,
  io: CliIo,
  dryRun: boolean,
): void {
  if (scan.retained.length === 0) {
    if (dryRun) io.out(`would-remove: ${stateDir} (empty after removals)\n`);
    else {
      rmdirSync(stateDir);
      io.out(`removed: ${stateDir}\n`);
    }
    return;
  }
  const topLevel = new Set(
    scan.retained.map((entry) => entry.relPath.split("/")[0] ?? entry.relPath),
  );
  const count = topLevel.size;
  io.out(
    `kept: ${stateDir} (still contains ${String(count)} non-Keiko entr${count === 1 ? "y" : "ies"})\n`,
  );
}

function removeStateStep(opts: UninstallOptions, io: CliIo, stateDir: string): void {
  if (!opts.scopes.state) return;
  if (!existsSync(stateDir)) {
    io.out(`state: ${stateDir} not found (nothing to remove)\n`);
    return;
  }
  const scan = scanRuntimeState(stateDir);
  removeOwnedFiles(scan, io, opts.dryRun);
  reportRetained(scan, io);
  removeOwnedDirectories(scan, io, opts.dryRun);
  finalizeStateDir(scan, stateDir, io, opts.dryRun);
}

function refuseUnsafeStateRoot(opts: UninstallOptions, io: CliIo, root: StateRootInspection): boolean {
  if (!opts.scopes.state && !opts.scopes.launchers) return false;
  if (root.status === "symlink") {
    io.err(`keiko uninstall: refusing to use symlinked state directory: ${root.absPath}\n`);
    return true;
  }
  if (root.status === "not-directory") {
    io.err(`keiko uninstall: refusing to use non-directory state path: ${root.absPath}\n`);
    return true;
  }
  return false;
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
  io.out("  yarn remove @oscharko-dev/keiko  •  pnpm remove @oscharko-dev/keiko  (yarn / pnpm)\n");
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
  const stateRoot = inspectStateRoot(stateDir);
  if (refuseUnsafeStateRoot(opts, io, stateRoot)) return 1;
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
    // Filesystem errors (e.g. a read-only package.json or state file) are reported as a
    // clean non-zero exit rather than crashing the CLI with an unhandled exception.
    io.err(`keiko uninstall: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
