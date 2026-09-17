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
//   4. For attested portable-managed installs, `--state` also removes the managed install
//      tree and its user-local registration artifact, but only after attesting the
//      recorded install root and refusing any symlink, unknown entry, or tampered
//      registration artifact.
//
// With no scope flag every step runs; `--state` / `--launchers` / `--scripts` narrow
// it. `--dry-run` reports `would-...` without changing anything.

import { existsSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import {
  cliControlStateWouldMutateTarget,
  cliTargetIdentitySha256,
  resolveCliControlFailureStateDir,
  resolveCliControlStateDir,
} from "./cli-control-state.js";
import type { CliIo } from "./runner.js";
import { LauncherError } from "./launcher-platforms.js";
import { removeLauncherShortcuts } from "./launcher.js";
import {
  KEIKO_START_SCRIPT,
  KEIKO_STOP_SCRIPT,
  detectPackageJsonIndent,
  stringifyPackageJson,
  writePackageJsonAtomically,
} from "./init.js";
import {
  installLayoutOverrideEvidence,
  localPackageRoot,
  writeInstallLayoutOverrideEvidenceWithFactory,
} from "./install-layout.js";
import { attestedPortableInstallRecord } from "./portable-install.js";
import {
  removePortableManagedInstall,
  removePortableRegistrationArtifacts,
} from "./portable-maintenance.js";
import { isPortableInstallRegistrationCorrupt } from "./portable-registration.js";
import {
  classifyPid,
  defaultIsProcessAlive,
  inspectStateRoot,
  isInsidePath,
  resolveStateDir,
  scanRuntimeState,
  type RetainedNode,
  type RuntimeStateScan,
  type StateRootInspection,
} from "./state-paths.js";
import {
  createCliSecurityLogSink,
  createIsolatedCliFailureSink,
  type CliSecurityLogSinkFactory,
} from "./security-log.js";
import { terminateUiProcess, type WindowsTreeKill } from "./ui-process-stop.js";

const USAGE = `Usage:
  keiko uninstall [--state] [--launchers] [--scripts] [--state-dir PATH]
                  [--package PATH] [--force] [--dry-run]

Reverses the runtime artifacts Keiko creates on this machine:
  --launchers  remove the user-local OS shortcut(s) (\`keiko launcher install\`)
  --scripts    remove the keiko:start / keiko:stop scripts from package.json
  --state      remove Keiko-owned runtime state under .keiko: lifecycle/launcher files,
               UI / Memory / Local-Knowledge databases and their WAL/SHM sidecars,
               Evidence and Quality-Intelligence records, the sealed credential vaults,
               and any attested portable-managed install + user-local registration

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
  // #KEIKO-0422: injected so tests can drive the post-stop wait deterministically.
  readonly sleep?: (ms: number) => Promise<void>;
  readonly platform?: (() => NodeJS.Platform) | undefined;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly securityLogSinkFactory?: CliSecurityLogSinkFactory | undefined;
  readonly activityStateDir?: string | undefined;
  readonly failureActivityStateDir?: string | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
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
  readonly sleep: (ms: number) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function resolveDeps(deps: UninstallCliDeps): ResolvedDeps {
  return {
    cwd: deps.cwd ?? process.cwd(),
    homedir: deps.homedir ?? defaultHomedir,
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
    killProcess: deps.killProcess ?? process.kill.bind(process),
    sleep: deps.sleep ?? defaultSleep,
    platform: deps.platform?.() ?? process.platform,
    killWindowsTree: deps.killWindowsTree,
    processEnv: deps.processEnv,
    verifyLaunchIdentity: deps.verifyLaunchIdentity,
  };
}

const SERVER_STOP_BUDGET_MS = 10_000;

// Returns "ok" to proceed, or "refused" when state removal is requested while the UI is
// running and `--force` was not given (removing live state would orphan the process).
// #KEIKO-0422 / #3351: after a graceful stop request (sentinel + SIGTERM on POSIX; sentinel
// only on Windows), wait (bounded) for the process to exit before returning "ok" — a UI
// still checkpointing SQLite WAL / rewriting ui.log/ui.pid while the uninstaller unlinks
// would leave a half-removed install and trigger ENOTEMPTY at rmdirSync. Windows `--force`
// escalates with the shared tree-kill helper; POSIX still refuses after the budget rather
// than SIGKILL, matching the pre-#3351 uninstall contract.
async function ensureServerStoppable(
  opts: UninstallOptions,
  io: CliIo,
  deps: ResolvedDeps,
  stateDir: string,
  securityLogSink: SecurityLogSink | undefined,
): Promise<"ok" | "refused"> {
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
  const outcome = await terminateUiProcess({
    pid: probe.pid,
    stateDir,
    stopTimeoutMs: SERVER_STOP_BUDGET_MS,
    platform: deps.platform,
    sleep: deps.sleep,
    isProcessAlive: deps.isProcessAlive,
    killProcess: deps.killProcess,
    killWindowsTree: deps.killWindowsTree,
    processEnv: deps.processEnv,
    securityLogSink,
    escalate: deps.platform === "win32",
    launchId: probe.launchId,
    verifyLaunchIdentity: deps.verifyLaunchIdentity,
  });
  if (!outcome.confirmed) {
    io.err(
      `keiko uninstall: Keiko UI (pid ${String(probe.pid)}) did not stop within the wait budget; state was not removed.\n`,
    );
    return "refused";
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

function removeScriptsStep(opts: UninstallOptions, io: CliIo): number {
  if (!opts.scopes.scripts) return 0;
  if (!existsSync(opts.packagePath)) {
    io.out(`scripts: package.json not found at ${opts.packagePath} (nothing to remove)\n`);
    return 0;
  }
  // KEIKO-0752: read RAW so we can detect the file's own indentation before we parse it,
  // then re-serialize with the SAME indent init.ts uses when it originally wrote scripts.
  // Previously we hardcoded `null, 2` and clobbered every non-two-space file — a
  // four-space or tab-indented package.json was silently reformatted whole even though
  // uninstall's own scope is `keiko:start` / `keiko:stop` only.
  let raw: string;
  try {
    raw = readFileSync(opts.packagePath, "utf8");
  } catch {
    io.err(
      `keiko uninstall: package.json at ${opts.packagePath} is not readable; skipping scripts.\n`,
    );
    return 0;
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    io.err(
      `keiko uninstall: package.json at ${opts.packagePath} is not valid JSON; skipping scripts.\n`,
    );
    return 0;
  }
  const scripts = isRecord(pkg) ? pkg.scripts : undefined;
  if (!isRecord(pkg) || !isRecord(scripts)) {
    io.out("scripts: no keiko:start / keiko:stop scripts found.\n");
    return 0;
  }
  const { next, removed } = pruneKeikoScripts(scripts, io, opts.dryRun);
  if (removed > 0 && !opts.dryRun) {
    const indent = detectPackageJsonIndent(raw);
    // #2906 round 3 (comment 3865273714): reuses init.ts's temp-file-plus-rename writer
    // instead of a direct writeFileSync, which could truncate/corrupt package.json if the
    // process or filesystem fails mid-write.
    writePackageJsonAtomically(
      opts.packagePath,
      stringifyPackageJson({ ...pkg, scripts: next }, indent),
    );
  }
  return removed;
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

function retainedReasonLabel(reason: RetainedNode["reason"]): string {
  if (reason === "symlink") return "symlink — not followed";
  if (reason === "hardlink") return "hardlink — not modified or removed";
  return "not a recognized Keiko artifact";
}

function reportRetained(scan: RuntimeStateScan, io: CliIo): void {
  for (const entry of scan.retained) {
    const why = retainedReasonLabel(entry.reason);
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
    scan.retained.map((entry) => entry.relPath.split(/[\\/]/)[0] ?? entry.relPath),
  );
  const count = topLevel.size;
  io.out(
    `kept: ${stateDir} (still contains ${String(count)} non-Keiko entr${count === 1 ? "y" : "ies"})\n`,
  );
}

type StateRemovalDisposition =
  "not-selected" | "absent" | "removed" | "retained" | "would-remove" | "would-retain";

interface StateRemovalOutcome {
  readonly disposition: StateRemovalDisposition;
  readonly ownedFileCount: number;
  readonly retainedCount: number;
}

function stateRemovalDisposition(dryRun: boolean, retained: boolean): StateRemovalDisposition {
  if (dryRun) return retained ? "would-retain" : "would-remove";
  return retained ? "retained" : "removed";
}

function removeStateStep(opts: UninstallOptions, io: CliIo, stateDir: string): StateRemovalOutcome {
  if (!opts.scopes.state) {
    return { disposition: "not-selected", ownedFileCount: 0, retainedCount: 0 };
  }
  if (!existsSync(stateDir)) {
    io.out(`state: ${stateDir} not found (nothing to remove)\n`);
    return { disposition: "absent", ownedFileCount: 0, retainedCount: 0 };
  }
  const scan = scanRuntimeState(stateDir);
  removeOwnedFiles(scan, io, opts.dryRun);
  reportRetained(scan, io);
  removeOwnedDirectories(scan, io, opts.dryRun);
  finalizeStateDir(scan, stateDir, io, opts.dryRun);
  const retained = scan.retained.length > 0;
  return {
    disposition: stateRemovalDisposition(opts.dryRun, retained),
    ownedFileCount: scan.files.length,
    retainedCount: scan.retained.length,
  };
}

function removePortableManagedStep(
  opts: UninstallOptions,
  io: CliIo,
  env: EnvSource,
  stateDir: string,
  homedir: string,
  securityLogSink?: SecurityLogSink,
): void {
  if (!opts.scopes.state) return;
  const record = attestedPortableInstallRecord(stateDir, env, homedir, { securityLogSink });
  if (record === undefined || record.registration.status === "setup-failed") return;
  if (record.layout === undefined || record.managedRoot === undefined) {
    throw new Error(
      "recorded portable-managed install could not be attested from user-local registration or default roots",
    );
  }
  if (!opts.dryRun) {
    inspectPortableManagedInstallForRemoval(record.layout);
    assertPortableRegistrationRemovable(record, env, homedir, securityLogSink);
    removePortableManagedInstall(record.layout, io, false);
  } else {
    removePortableManagedInstall(record.layout, io, true);
    assertPortableRegistrationRemovable(record, env, homedir, securityLogSink);
  }
  removePortableRegistrationArtifacts({
    layout: record.layout,
    target: record.target,
    managedRoot: record.managedRoot,
    env,
    home: homedir,
    dryRun: opts.dryRun,
    io,
    options: { securityLogSink },
  });
}

function inspectPortableManagedInstallForRemoval(
  layout: Parameters<typeof removePortableManagedInstall>[0],
): void {
  removePortableManagedInstall(
    layout,
    { out: (_text: string): void => undefined, err: (_text: string): void => undefined },
    true,
  );
}

function assertPortableRegistrationRemovable(
  record: Exclude<ReturnType<typeof attestedPortableInstallRecord>, undefined>,
  env: EnvSource,
  homedir: string,
  securityLogSink?: SecurityLogSink,
): void {
  if (record.layout === undefined || record.managedRoot === undefined) return;
  removePortableRegistrationArtifacts({
    layout: record.layout,
    target: record.target,
    managedRoot: record.managedRoot,
    env,
    home: homedir,
    dryRun: true,
    io: { out: (_text: string): void => undefined, err: (_text: string): void => undefined },
    options: { securityLogSink },
  });
}

function refuseUnsafeStateRoot(
  opts: UninstallOptions,
  io: CliIo,
  root: StateRootInspection,
): boolean {
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

// PR-review follow-up (Codex threads 3771181236 + 3771256642): refuse destructive uninstall
// when the portable registration file exists but is corrupt AND state removal is actually
// selected. A scripts-only or launchers-only uninstall must not read
// portable-install-state.json since it would not touch it. Extracted so runUninstallCli
// stays under the repo-wide cyclomatic-complexity ceiling.
function refuseStateRemovalOnCorruptRegistration(
  opts: UninstallOptions,
  io: CliIo,
  stateDir: string,
): boolean {
  if (!opts.scopes.state) return false;
  if (!isPortableInstallRegistrationCorrupt(stateDir)) return false;
  io.err(
    "keiko uninstall: refusing to proceed — portable install registration is corrupt. " +
      "Repair or remove the file at .keiko/portable-install-state.json before retrying.\n",
  );
  return true;
}

// Consolidates the pre-run refusal checks so runUninstallCli stays under the repo-wide
// cyclomatic-complexity ceiling: unsafe state-root (symlink / non-directory) and corrupt
// portable registration (only when state removal is selected) are both fail-closed guards.
interface UninstallPreflight {
  readonly refused: boolean;
  readonly stateRoot?: StateRootInspection;
}

function uninstallPreflight(
  opts: UninstallOptions,
  io: CliIo,
  stateDir: string,
): UninstallPreflight {
  // PR-review follow-up (Codex thread 3771542616): only inspect the state directory when
  // a scope that actually touches it is selected. --scripts alone must not lstat an
  // unrelated state dir; an EACCES/EIO on that path would otherwise abort the scripts
  // uninstall for no reason.
  const stateRoot =
    opts.scopes.state || opts.scopes.launchers ? inspectStateRoot(stateDir) : undefined;
  if (stateRoot !== undefined && refuseUnsafeStateRoot(opts, io, stateRoot)) {
    return { refused: true, stateRoot };
  }
  if (refuseStateRemovalOnCorruptRegistration(opts, io, stateDir)) {
    return stateRoot === undefined ? { refused: true } : { refused: true, stateRoot };
  }
  return stateRoot === undefined ? { refused: false } : { refused: false, stateRoot };
}

type PreparedUninstallActivity =
  | {
      readonly kind: "ready";
      readonly sink: SecurityLogSink | undefined;
      readonly targetSha256: string;
      readonly packageTargetSha256: string;
    }
  | { readonly kind: "refused" };

interface UninstallActivityContext {
  readonly stateDir: string;
  readonly activityStateDir: string;
  readonly failureStateDir: string;
  readonly factory: CliSecurityLogSinkFactory | undefined;
  readonly correlationId: string | undefined;
  readonly targetSha256: string;
  readonly packageTargetSha256: string;
}

interface UninstallActivityComposition {
  readonly activityStateDir: string | undefined;
  readonly failureStateDir: string | undefined;
  readonly factory: CliSecurityLogSinkFactory | undefined;
}

function emitUninstallPreparationFailure(
  context: UninstallActivityContext,
  errorKind: string,
  reason: string,
): void {
  const sink = createIsolatedCliFailureSink(
    context.stateDir,
    context.failureStateDir,
    context.factory,
    context.correlationId,
  );
  emitSecurityLogEvent(sink, {
    level: "error",
    category: "diagnostic",
    op: "cli.uninstall.failed",
    errorKind,
    extra: {
      reason,
      targetSha256: context.targetSha256,
      packageTargetSha256: context.packageTargetSha256,
    },
  });
}

function resolveUninstallActivityContext(
  opts: UninstallOptions,
  stateDir: string,
  env: EnvSource,
  deps: ResolvedDeps,
  activityStateDirOverride: string | undefined,
  failureStateDirOverride: string | undefined,
  factory: CliSecurityLogSinkFactory | undefined,
): UninstallActivityContext {
  const layoutEvidence = installLayoutOverrideEvidence(env);
  return {
    stateDir,
    activityStateDir:
      activityStateDirOverride ?? resolveCliControlStateDir(deps.platform, deps.homedir()),
    failureStateDir:
      failureStateDirOverride ?? resolveCliControlFailureStateDir(deps.platform, deps.homedir()),
    factory,
    correlationId: layoutEvidence?.correlationId,
    targetSha256: cliTargetIdentitySha256(stateDir),
    packageTargetSha256: cliTargetIdentitySha256(opts.packagePath),
  };
}

function openUninstallActivity(
  opts: UninstallOptions,
  env: EnvSource,
  io: CliIo,
  context: UninstallActivityContext,
): PreparedUninstallActivity {
  const layoutEvidencePending = installLayoutOverrideEvidence(env) !== undefined;
  const evidenceWritten = writeInstallLayoutOverrideEvidenceWithFactory(
    context.factory,
    context.activityStateDir,
    env,
  );
  if (layoutEvidencePending && !evidenceWritten) {
    emitUninstallPreparationFailure(
      context,
      "UninstallActivityLogUnavailableError",
      "activity-log-unavailable",
    );
    io.err(
      "keiko uninstall: refusing to consume a normalized install path because durable " +
        "activity logging is unavailable.\n",
    );
    return { kind: "refused" };
  }
  const sink = createCliSecurityLogSink(
    context.activityStateDir,
    context.factory,
    context.correlationId,
  );
  emitSecurityLogEvent(sink, {
    level: "info",
    category: "diagnostic",
    op: "cli.uninstall.started",
    extra: {
      removeState: opts.scopes.state,
      removeLaunchers: opts.scopes.launchers,
      removeScripts: opts.scopes.scripts,
      dryRun: opts.dryRun,
      force: opts.force,
      targetSha256: context.targetSha256,
      packageTargetSha256: context.packageTargetSha256,
    },
  });
  return {
    kind: "ready",
    sink,
    targetSha256: context.targetSha256,
    packageTargetSha256: context.packageTargetSha256,
  };
}

function prepareUninstallActivity(
  opts: UninstallOptions,
  stateDir: string,
  env: EnvSource,
  io: CliIo,
  deps: ResolvedDeps,
  composition: UninstallActivityComposition,
): PreparedUninstallActivity {
  const context = resolveUninstallActivityContext(
    opts,
    stateDir,
    env,
    deps,
    composition.activityStateDir,
    composition.failureStateDir,
    composition.factory,
  );
  try {
    if (
      (opts.scopes.state || opts.scopes.launchers) &&
      cliControlStateWouldMutateTarget(context.activityStateDir, stateDir)
    ) {
      emitUninstallPreparationFailure(
        context,
        "UninstallControlStateOverlapError",
        "control-state-overlap",
      );
      io.err(
        "keiko uninstall: refusing to run because the reserved CLI control state overlaps the " +
          "selected state tree. Select a different --state-dir.\n",
      );
      return { kind: "refused" };
    }
    return openUninstallActivity(opts, env, io, context);
  } catch (error) {
    emitUninstallPreparationFailure(
      context,
      securityErrorKind(error),
      "control-state-validation-failed",
    );
    io.err("keiko uninstall: the reserved CLI control state could not be validated or opened.\n");
    return { kind: "refused" };
  }
}

function emitUninstallFailure(
  activity: Extract<PreparedUninstallActivity, { readonly kind: "ready" }>,
  errorKind: string,
  reason: string,
): void {
  emitSecurityLogEvent(activity.sink, {
    level: "error",
    category: "diagnostic",
    op: "cli.uninstall.failed",
    errorKind,
    extra: {
      reason,
      targetSha256: activity.targetSha256,
      packageTargetSha256: activity.packageTargetSha256,
    },
  });
}

async function executeUninstall(
  opts: UninstallOptions,
  io: CliIo,
  env: EnvSource,
  deps: ResolvedDeps,
  stateDir: string,
  activity: Extract<PreparedUninstallActivity, { readonly kind: "ready" }>,
): Promise<number> {
  const preflight = uninstallPreflight(opts, io, stateDir);
  if (preflight.refused) {
    emitUninstallFailure(activity, "UninstallPreflightError", "preflight-refused");
    return 1;
  }
  if ((await ensureServerStoppable(opts, io, deps, stateDir, activity.sink)) === "refused") {
    emitUninstallFailure(activity, "UninstallStateInUseError", "server-stop-refused");
    return 1;
  }
  const launcherRefused = removeLaunchersStep(opts, io, deps, stateDir);
  const scriptCount = removeScriptsStep(opts, io);
  removePortableManagedStep(opts, io, env, stateDir, deps.homedir(), activity.sink);
  const stateOutcome = removeStateStep(opts, io, stateDir);
  printPackageGuidance(io, deps);
  if (launcherRefused > 0) {
    emitUninstallFailure(activity, "LauncherRemovalRefused", "launcher-removal-refused");
    return 1;
  }
  emitSecurityLogEvent(activity.sink, {
    level: "info",
    category: "diagnostic",
    op: "cli.uninstall.completed",
    extra: {
      targetSha256: activity.targetSha256,
      packageTargetSha256: activity.packageTargetSha256,
      stateDisposition: stateOutcome.disposition,
      ownedFileCount: stateOutcome.ownedFileCount,
      retainedCount: stateOutcome.retainedCount,
      scriptCount,
      dryRun: opts.dryRun,
    },
  });
  return 0;
}

function reportUninstallException(
  error: unknown,
  io: CliIo,
  activity: Extract<PreparedUninstallActivity, { readonly kind: "ready" }>,
): number {
  emitUninstallFailure(
    activity,
    securityErrorKind(error),
    error instanceof LauncherError ? "launcher-error" : "operation-error",
  );
  if (error instanceof LauncherError) {
    io.err(`${error.message}\n`);
    return 1;
  }
  io.err(`keiko uninstall: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

export async function runUninstallCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: UninstallCliDeps = {},
): Promise<number> {
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
  const activity = prepareUninstallActivity(opts, stateDir, env, io, resolved, {
    activityStateDir: deps.activityStateDir,
    failureStateDir: deps.failureActivityStateDir,
    factory: deps.securityLogSinkFactory,
  });
  if (activity.kind === "refused") return 1;
  try {
    // Preflight stays inside this catch: EACCES/EIO is a scoped command failure, not a fatal crash.
    return await executeUninstall(opts, io, env, resolved, stateDir, activity);
  } catch (error) {
    return reportUninstallException(error, io, activity);
  }
}
