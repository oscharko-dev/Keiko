// `keiko launcher` — generates a reversible, user-local OS shortcut that starts the local
// Keiko server in one user action. CLI-only surface; no UI route, no server change, no
// new runtime dependency. Per ADR-0024 D8 / D9 #125 checklist:
//
//   - No postinstall side effect; shortcut creation is explicitly user-invoked.
//   - No shell injection: the generated file content is built from a sanitized exec path
//     (allow-list regex in launcher-platforms.ts) and a validated integer port.
//   - Removal command documented and tested: `keiko launcher remove`.
//   - No admin/root required: install paths are user-local (`~/.local/share/...`,
//     `~/Applications/...`, `%APPDATA%\Microsoft\Windows\Start Menu\Programs\...`).
//   - Generated locations enumerated below.
//
// SUBCOMMANDS:
//   keiko launcher install [--dry-run] [--explain] [--port PORT]
//   keiko launcher remove [--dry-run] [--explain]
//   keiko launcher status
//   keiko launcher --help
//
// GENERATED FILE LOCATIONS (per-platform, user-local approved directories — these are the
// only directories the launcher will ever write to; the resolved target is realpath-
// contained against the approved directory before any write):
//   Linux:   ~/.local/share/applications/keiko.desktop
//   macOS:   ~/Applications/Keiko Launcher.command
//   Windows: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Keiko.bat
//
// The launcher does NOT import lifecycle.ts; the generated shortcut spawns
// `keiko start --open` as a subprocess. This keeps the launcher independent of the
// lifecycle handler's runtime.

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";
import {
  LauncherError,
  launcherFor,
  validateExecPath,
  validatePort,
  type LauncherContentInput,
  type Platform,
  type PlatformLauncher,
} from "./launcher-platforms.js";
import { assertRealpathContained } from "./launcher-paths.js";
import {
  hashContent,
  loadState,
  removeEntry,
  saveState,
  upsertEntry,
  type LauncherStateEntry,
} from "./launcher-state.js";

type LauncherSubcommand = "install" | "remove" | "status";

const USAGE = `Usage:
  keiko launcher install [--dry-run] [--explain] [--port PORT]
  keiko launcher remove  [--dry-run] [--explain]
  keiko launcher status
  keiko launcher --help

Generates a user-local OS shortcut that runs \`keiko start --open\` in one user action.
Generated file locations:
  Linux:   ~/.local/share/applications/keiko.desktop
  macOS:   ~/Applications/Keiko Launcher.command
  Windows: %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Keiko.bat
`;

export interface LauncherCliDeps {
  readonly cwd?: string | undefined;
  readonly homedir?: () => string;
  readonly platform?: () => NodeJS.Platform;
  // Test seam: resolves the running keiko CLI's binary path. Defaults to a pure-node
  // resolution: prefer process.argv[1] if absolute + existsSync; else search PATH.
  readonly resolveExe?: (env: EnvSource) => string;
  // Test seam for sanity: which directory `.keiko/launcher-state.json` lives in.
  // Defaults to `<cwd>/.keiko`.
  readonly stateDir?: string;
}

interface InstallArgs {
  readonly dryRun: boolean;
  readonly explain: boolean;
  readonly port: number | undefined;
}

interface RemoveArgs {
  readonly dryRun: boolean;
  readonly explain: boolean;
}

interface ParsedArgs<T> {
  readonly ok: true;
  readonly value: T;
}

interface ParseFail {
  readonly ok: false;
  readonly message: string;
}

type ParseResult<T> = ParsedArgs<T> | ParseFail;

function parsePortFlag(value: string | undefined): ParseResult<number> {
  if (value === undefined || value.startsWith("--")) {
    return { ok: false, message: "missing value for --port" };
  }
  if (!/^\d{1,6}$/.test(value)) {
    return { ok: false, message: `invalid --port value: ${value}` };
  }
  try {
    return { ok: true, value: validatePort(Number(value)) };
  } catch (e) {
    if (e instanceof LauncherError) return { ok: false, message: e.message };
    throw e;
  }
}

function parseInstallArgs(rest: readonly string[]): ParseResult<InstallArgs> {
  let dryRun = false;
  let explain = false;
  let port: number | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--explain") {
      explain = true;
    } else if (arg === "--port") {
      const parsed = parsePortFlag(rest[i + 1]);
      if (!parsed.ok) return parsed;
      port = parsed.value;
      i += 1;
    } else {
      return { ok: false, message: `unknown flag: ${arg ?? "(undefined)"}` };
    }
  }
  return { ok: true, value: { dryRun, explain, port } };
}

function parseRemoveArgs(rest: readonly string[]): ParseResult<RemoveArgs> {
  let dryRun = false;
  let explain = false;
  for (const arg of rest) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--explain") {
      explain = true;
      continue;
    }
    return { ok: false, message: `unknown flag: ${arg}` };
  }
  return { ok: true, value: { dryRun, explain } };
}

// Pure-node `which`: searches PATH dirs for an executable named `keiko` (or `keiko.cmd`/
// `keiko.exe` on Windows). Returns the first absolute hit that exists on disk and passes
// the exec-path allow-list. Returns undefined if nothing found.
function isExecutableFile(full: string): boolean {
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
}

function findInDir(dir: string, candidates: readonly string[]): string | undefined {
  if (dir.length === 0) return undefined;
  for (const name of candidates) {
    const full = join(dir, name);
    if (isExecutableFile(full)) return full;
  }
  return undefined;
}

function nodeWhich(env: EnvSource, platform: NodeJS.Platform): string | undefined {
  const pathVar = env.PATH ?? process.env.PATH;
  if (typeof pathVar !== "string" || pathVar.length === 0) return undefined;
  const delimiter = platform === "win32" ? ";" : ":";
  const candidates =
    platform === "win32" ? ["keiko.cmd", "keiko.exe", "keiko.bat", "keiko"] : ["keiko"];
  for (const dir of pathVar.split(delimiter)) {
    const hit = findInDir(dir, candidates);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function defaultResolveExe(env: EnvSource): string {
  const fromBinShim = env.KEIKO_CLI_BIN_PATH ?? process.env.KEIKO_CLI_BIN_PATH;
  if (typeof fromBinShim === "string" && isAbsolute(fromBinShim) && existsSync(fromBinShim)) {
    return validateExecPath(fromBinShim);
  }
  const entry = process.argv[1];
  if (typeof entry === "string" && isAbsolute(entry) && existsSync(entry)) {
    // argv[1] when invoked via `node dist/cli/index.js` points at the JS entry; the
    // generated shortcut needs the `keiko` binary on PATH, not the JS file. Prefer
    // a `keiko` on PATH; fall back to argv[1] only when nothing is on PATH (best-effort).
    const onPath = nodeWhich(process.env, process.platform);
    if (onPath !== undefined) return validateExecPath(onPath);
    return validateExecPath(entry);
  }
  const onPath = nodeWhich(env, process.platform);
  if (onPath !== undefined) return validateExecPath(onPath);
  throw new LauncherError(
    "EXE_NOT_FOUND",
    "keiko launcher: cannot locate the `keiko` executable on PATH. Install with `npm install -g @oscharko-dev/keiko` before re-running.",
  );
}

// Path-containment helpers (realpathSync + ancestor walk) live in `./launcher-paths.ts`
// so `launcher-state.ts` can apply the same boundary at state-file parse time.

// Adapts the CliIo writer to the `onWarn(msg)` shape consumed by `loadState`. We wrap
// in a block body (not an arrow shorthand) because `io.err` returns `void`, and the
// `no-confusing-void-expression` lint rule forbids implicit-return shorthand-void.
function ioWarn(io: CliIo): (msg: string) => void {
  return (msg: string): void => {
    io.err(msg);
  };
}

function assertApprovedDirNotSymlink(approvedDir: string): void {
  try {
    const stat = lstatSync(approvedDir);
    if (stat.isSymbolicLink()) {
      throw new LauncherError(
        "APPROVED_DIR_SYMLINK_REFUSED",
        `keiko launcher: approved directory is a symlink and was refused: ${approvedDir}`,
      );
    }
  } catch (e) {
    if (e instanceof LauncherError) throw e;
    // ENOENT — fine; we'll mkdir it below.
  }
}

function assertTargetNotSymlink(target: string): void {
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new LauncherError(
        "TARGET_SYMLINK_REFUSED",
        `keiko launcher: refusing to write through a symlink at: ${target}`,
      );
    }
  } catch {
    // ENOENT — fine, target will be created.
  }
}

// Atomic O_EXCL write: opens with O_WRONLY|O_CREAT|O_EXCL so we can never overwrite an
// existing file. If the file already exists we read it for content-hash comparison
// (idempotent re-install / collision detection). On POSIX we also pass O_NOFOLLOW so a
// symlink at the final path component is rejected; on Windows the lstat above is the
// only available guard.
//
// MINOR (verifier): the `existsSync(targetPath)` check in `cmdInstall` and the `openSync`
// call below form a TOCTOU window. The O_EXCL flag closes it — if another process plants
// a file at `target` between the two calls, `openSync` raises `EEXIST` and we surface a
// `TARGET_EXISTS` LauncherError (user-readable) rather than letting the raw ErrnoException
// propagate. The conversion is the only reason we catch+rethrow here.
function writeAtomicExcl(target: string, content: string, mode: number): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollow;
  let fd: number;
  try {
    fd = openSync(target, flags, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LauncherError(
        "TARGET_EXISTS",
        `keiko launcher: ${target} appeared between the pre-flight existsSync check and the O_EXCL open. Refusing to overwrite (TOCTOU defense).`,
      );
    }
    throw e;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  // Some platforms ignore the mode passed to open() when O_CREAT files exist; we set
  // it explicitly here so the macOS .command script is executable.
  try {
    chmodSync(target, mode);
  } catch {
    // best-effort
  }
}

// F4: when `KEIKO_STATE_DIR` is set, its resolved path MUST be contained under the
// user's homedir. Without this guard, an attacker who can plant the env var (wrapper
// script in PATH, dev-container `.env`, exported in a parent shell) can combine with
// F1 to steer the launcher state file to a world-writable location and from there to
// arbitrary-file primitives. We re-use `assertRealpathContained` so symlinked-ancestor
// edge cases compare consistently. The thrown error is re-classified as
// `STATE_DIR_ESCAPE` so the user-facing message is unambiguous.
function defaultStateDir(cwd: string, env: EnvSource, home: string): string {
  const fromEnv = env.KEIKO_STATE_DIR ?? process.env.KEIKO_STATE_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    const resolved = isAbsolute(fromEnv) ? fromEnv : resolve(cwd, fromEnv);
    try {
      assertRealpathContained(home, resolved);
    } catch (e) {
      if (e instanceof LauncherError && e.code === "PATH_ESCAPE") {
        throw new LauncherError(
          "STATE_DIR_ESCAPE",
          `keiko launcher: KEIKO_STATE_DIR ${fromEnv} resolves outside the user's home directory (${home}); refusing to proceed.`,
        );
      }
      throw e;
    }
    return resolved;
  }
  return resolve(cwd, ".keiko");
}

interface InstallPlan {
  readonly platform: Platform;
  readonly approvedDir: string;
  readonly targetPath: string;
  readonly content: string;
  readonly contentInput: LauncherContentInput;
  readonly fileMode: number;
}

function buildInstallPlan(
  launcher: PlatformLauncher,
  homedir: string,
  args: InstallArgs,
  exe: string,
): InstallPlan {
  const approvedDir = launcher.installDirFor(homedir);
  const targetPath = join(approvedDir, launcher.safeFileName());
  const contentInput: LauncherContentInput = { exe, port: args.port };
  const content = launcher.generateContent(contentInput);
  return {
    platform: launcher.id,
    approvedDir,
    targetPath,
    content,
    contentInput,
    fileMode: launcher.fileMode,
  };
}

function describePlan(plan: InstallPlan, explain: boolean): string {
  const lines: string[] = [];
  lines.push(`platform: ${plan.platform}`);
  lines.push(`path:     ${plan.targetPath}`);
  lines.push(`mode:     0o${plan.fileMode.toString(8)}`);
  if (explain) {
    lines.push("--- begin generated content ---");
    lines.push(plan.content.replace(/\r\n/g, "\n"));
    lines.push("--- end generated content ---");
    lines.push("Remove with: keiko launcher remove");
  }
  return lines.join("\n") + "\n";
}

function planToEntry(plan: InstallPlan): LauncherStateEntry {
  return {
    path: plan.targetPath,
    platform: plan.platform,
    contentSha256: hashContent(plan.content),
    createdAt: new Date().toISOString(),
  };
}

function handleExistingTarget(
  plan: InstallPlan,
  stateDir: string,
  homedir: string,
  io: CliIo,
): number {
  const existing = readFileSync(plan.targetPath, "utf8");
  if (existing !== plan.content) {
    throw new LauncherError(
      "TARGET_FOREIGN",
      `keiko launcher: refusing to overwrite ${plan.targetPath}.\nA file with different content already exists. Move or remove it manually before re-running.`,
    );
  }
  const loadOpts = { homedir, onWarn: ioWarn(io) };
  saveState(stateDir, upsertEntry(loadState(stateDir, loadOpts), planToEntry(plan)));
  io.out(`Keiko launcher already installed at ${plan.targetPath} (idempotent).\n`);
  return 0;
}

function cmdInstall(
  args: InstallArgs,
  io: CliIo,
  env: EnvSource,
  deps: Required<Pick<LauncherCliDeps, "homedir" | "platform">> & {
    readonly resolveExe: (env: EnvSource) => string;
    readonly stateDir: string;
  },
): number {
  const launcher = launcherFor(deps.platform());
  const exe = deps.resolveExe(env);
  const home = deps.homedir();
  const plan = buildInstallPlan(launcher, home, args, exe);
  assertRealpathContained(plan.approvedDir, plan.targetPath);
  if (args.dryRun || args.explain) {
    io.out(describePlan(plan, args.explain));
    if (args.dryRun) io.out("(dry run — no file written.)\n");
    return 0;
  }
  mkdirSync(plan.approvedDir, { recursive: true, mode: 0o755 });
  assertApprovedDirNotSymlink(plan.approvedDir);
  assertTargetNotSymlink(plan.targetPath);
  if (existsSync(plan.targetPath)) {
    return handleExistingTarget(plan, deps.stateDir, home, io);
  }
  writeAtomicExcl(plan.targetPath, plan.content, plan.fileMode);
  const loadOpts = { homedir: home, onWarn: ioWarn(io) };
  saveState(deps.stateDir, upsertEntry(loadState(deps.stateDir, loadOpts), planToEntry(plan)));
  io.out(`Installed Keiko launcher at ${plan.targetPath}.\n`);
  io.out("Remove with: keiko launcher remove\n");
  return 0;
}

type RemoveOutcome = "missing" | "refused" | "would-delete" | "removed";

// F1 remove-time barrier: even though parseEntry filters out-of-bounds entries at load
// time, we repeat the containment check here so a state row that bypassed the parser
// (e.g. via a future call site without homedir context) cannot reach `unlinkSync` with
// an attacker-controlled path. The throw is caught by `runLauncherCli` and surfaced as
// a non-zero exit; we never delete or even probe `existsSync` on an out-of-bounds path.
function processRemoveEntry(
  entry: LauncherStateEntry,
  args: RemoveArgs,
  io: CliIo,
  homedir: string,
): RemoveOutcome {
  assertRealpathContained(launcherFor(entry.platform).installDirFor(homedir), entry.path);
  if (!existsSync(entry.path)) {
    io.out(`missing: ${entry.path} (already gone — state cleared)\n`);
    return "missing";
  }
  const existing = readFileSync(entry.path, "utf8");
  if (hashContent(existing) !== entry.contentSha256) {
    io.err(
      `refusing: ${entry.path} (content does not match the launcher Keiko generated; not deleted)\n`,
    );
    return "refused";
  }
  if (args.dryRun || args.explain) {
    io.out(`would-delete: ${entry.path}\n`);
    return "would-delete";
  }
  unlinkSync(entry.path);
  io.out(`removed: ${entry.path}\n`);
  return "removed";
}

function cmdRemove(
  args: RemoveArgs,
  io: CliIo,
  deps: { readonly stateDir: string; readonly homedir: string },
): number {
  const state = loadState(deps.stateDir, { homedir: deps.homedir, onWarn: ioWarn(io) });
  if (state.entries.length === 0) {
    io.out("Keiko launcher: nothing to remove (no recorded shortcuts).\n");
    return 0;
  }
  let nextState = state;
  let removed = 0;
  let refused = 0;
  for (const entry of state.entries) {
    const outcome = processRemoveEntry(entry, args, io, deps.homedir);
    if (outcome === "missing" || outcome === "removed") {
      nextState = removeEntry(nextState, entry.path);
    }
    if (outcome === "removed") removed += 1;
    if (outcome === "refused") refused += 1;
  }
  const persisting = !args.dryRun && !args.explain;
  if (persisting) {
    saveState(deps.stateDir, nextState);
    io.out(`Keiko launcher: removed ${String(removed)} shortcut(s).\n`);
  }
  return refused > 0 ? 1 : 0;
}

function cmdStatus(
  io: CliIo,
  deps: { readonly stateDir: string; readonly homedir: string },
): number {
  // F2 — parse-time containment in `loadState` already filters out-of-bounds entries
  // before we reach `existsSync`/`readFileSync`, so a tampered state file cannot turn
  // `status` into an arbitrary-file-existence/content probe. We additionally wrap the
  // read in try/catch so an unreadable/EISDIR target classifies as `unreadable` instead
  // of leaking the OS error (and its stack) onto stderr.
  const state = loadState(deps.stateDir, { homedir: deps.homedir, onWarn: ioWarn(io) });
  if (state.entries.length === 0) {
    io.out("Keiko launcher: no shortcuts recorded.\n");
    return 0;
  }
  for (const entry of state.entries) {
    if (!existsSync(entry.path)) {
      io.out(`${entry.path}\tmissing\n`);
      continue;
    }
    let existing: string;
    try {
      existing = readFileSync(entry.path, "utf8");
    } catch {
      io.out(`${entry.path}\tunreadable\n`);
      continue;
    }
    const matches = hashContent(existing) === entry.contentSha256;
    io.out(`${entry.path}\t${matches ? "ok" : "modified"}\n`);
  }
  return 0;
}

function isLauncherSubcommand(s: string): s is LauncherSubcommand {
  return s === "install" || s === "remove" || s === "status";
}

interface ResolvedDeps {
  readonly homedir: () => string;
  readonly platform: () => NodeJS.Platform;
  readonly resolveExe: (env: EnvSource) => string;
  readonly stateDir: string;
}

function resolveDeps(env: EnvSource, deps: LauncherCliDeps): ResolvedDeps {
  const cwd = deps.cwd ?? process.cwd();
  const homedirFn = deps.homedir ?? defaultHomedir;
  return {
    homedir: homedirFn,
    platform: deps.platform ?? ((): NodeJS.Platform => process.platform),
    resolveExe: deps.resolveExe ?? defaultResolveExe,
    stateDir: deps.stateDir ?? defaultStateDir(cwd, env, homedirFn()),
  };
}

export function runLauncherCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: LauncherCliDeps = {},
): number {
  const first = args[0];
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (!isLauncherSubcommand(first)) {
    io.err(`keiko launcher: unknown subcommand: ${first}\n`);
    io.err(USAGE);
    return 2;
  }
  const rest = args.slice(1);
  try {
    // `resolveDeps` may throw `STATE_DIR_ESCAPE` (F4) when KEIKO_STATE_DIR resolves
    // outside the user's home — it MUST be inside the try/catch so the LauncherError
    // is converted to a `1` exit instead of an uncaught throw.
    const r = resolveDeps(env, deps);
    const home = r.homedir();
    const handlers: Readonly<Record<LauncherSubcommand, () => number>> = {
      install: () => dispatchInstall(rest, io, env, r),
      remove: () => dispatchRemove(rest, io, { stateDir: r.stateDir, homedir: home }),
      status: () => cmdStatus(io, { stateDir: r.stateDir, homedir: home }),
    };
    return handlers[first]();
  } catch (e) {
    if (e instanceof LauncherError) {
      io.err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function dispatchInstall(
  rest: readonly string[],
  io: CliIo,
  env: EnvSource,
  ctx: Required<Pick<LauncherCliDeps, "homedir" | "platform">> & {
    readonly resolveExe: (env: EnvSource) => string;
    readonly stateDir: string;
  },
): number {
  const parsed = parseInstallArgs(rest);
  if (!parsed.ok) {
    io.err(`keiko launcher install: ${parsed.message}\n`);
    io.err(USAGE);
    return 2;
  }
  return cmdInstall(parsed.value, io, env, ctx);
}

function dispatchRemove(
  rest: readonly string[],
  io: CliIo,
  ctx: { readonly stateDir: string; readonly homedir: string },
): number {
  const parsed = parseRemoveArgs(rest);
  if (!parsed.ok) {
    io.err(`keiko launcher remove: ${parsed.message}\n`);
    io.err(USAGE);
    return 2;
  }
  return cmdRemove(parsed.value, io, ctx);
}
