// `keiko repair` — an offline, deterministic remediation pass that fixes a broken or
// half-installed local Keiko state so a user gets a working install without a full
// reinstall. CLI-only surface; no model call, no network, no server change.
//
// Each check reports one of: `ok` (healthy), `would-fix`/`fixed` (a safe automatic
// remediation), or `action` (needs a user step the command will not take for them).
// Checks REUSE existing modules rather than reimplementing their logic:
//   - stale UI pid + state-dir permissions via `state-paths.ts` / `lifecycle.ts` semantics
//   - launcher record drift via `launcher-state.ts` (home-contained, content-hash verified)
//   - build/install layout via `install-layout.ts`
//   - stale global-vs-local launch path via `doctor.ts`
//   - gateway config presence via `gateway-config.ts`
//
// Exit code: 0 when the system is healthy or every issue was repaired; 1 when an
// `action` item remains (so scripts can detect "manual step required"). `--dry-run`
// reports without changing anything and exits 1 if any issue (fixable or action) exists.

import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { join } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import type { CliIo } from "./runner.js";
import { collectDoctorReport } from "./doctor.js";
import { resolvePreferredInstallLayout } from "./install-layout.js";
import { resolveConfigPathFromArgs } from "./gateway-config.js";
import {
  hashContent,
  loadState,
  removeEntry,
  saveState,
  type LauncherState,
  type LauncherStateEntry,
} from "./launcher-state.js";
import { classifyPid, defaultIsProcessAlive, resolveStateDir } from "./state-paths.js";

const USAGE = `Usage:
  keiko repair [--state-dir PATH] [--config PATH] [--dry-run]

Runs an offline diagnostic-and-repair pass over the local Keiko install:
  - removes a stale UI pid file left by an unclean shutdown
  - tightens the .keiko state directory permissions to 0o700
  - prunes launcher records whose shortcut files were deleted
  - verifies the built CLI/UI assets and the launch path
  - validates a configured model-gateway config file

Options:
  --state-dir PATH  inspect this state directory instead of <cwd>/.keiko.
  --config PATH     validate this model-gateway config file (else KEIKO_CONFIG_FILE).
  --dry-run         report findings without changing anything.

Exit code: 0 when the install is healthy or every issue was repaired; 1 when an item
needs manual action (with --dry-run, also when a fixable item is found).
`;

type CheckStatus = "ok" | "fixed" | "fixable" | "action-required";

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

function ok(name: string, detail: string): CheckResult {
  return { name, status: "ok", detail };
}
function fixed(name: string, detail: string): CheckResult {
  return { name, status: "fixed", detail };
}
function fixable(name: string, detail: string): CheckResult {
  return { name, status: "fixable", detail };
}
function action(name: string, detail: string): CheckResult {
  return { name, status: "action-required", detail };
}

interface RepairOptions {
  readonly dryRun: boolean;
  readonly stateDirArg: string | undefined;
}

export interface RepairCliDeps {
  readonly cwd?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly homedir?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

function readFlagValue(args: readonly string[], index: number): string | null {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

function parseRepairArgs(args: readonly string[]): RepairOptions | "help" | null {
  let dryRun = false;
  let stateDirArg: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--state-dir" || arg === "--config") {
      const value = readFlagValue(args, i);
      if (value === null) return null;
      if (arg === "--state-dir") stateDirArg = value;
      i += 1;
    } else return null;
  }
  return { dryRun, stateDirArg };
}

function checkStalePid(
  stateDir: string,
  isAlive: (pid: number) => boolean,
  dryRun: boolean,
): CheckResult {
  const pidPath = join(stateDir, "ui.pid");
  const probe = classifyPid(pidPath, isAlive);
  if (probe.state === "absent") return ok("UI process state", "no pid file recorded");
  if (probe.state === "running")
    return ok("UI process state", `running (pid ${String(probe.pid)})`);
  if (dryRun)
    return fixable("UI process state", `stale pid file (pid ${String(probe.pid)} not running)`);
  rmSync(pidPath, { force: true });
  return fixed("UI process state", `removed stale pid file (pid ${String(probe.pid)})`);
}

function checkStateDirPerms(stateDir: string, dryRun: boolean): CheckResult {
  if (!existsSync(stateDir)) return ok("State directory", "not present (created on next start)");
  if (process.platform === "win32")
    return ok("State directory", "permission check not applicable on Windows");
  const mode = statSync(stateDir).mode & 0o777;
  if (mode === 0o700) return ok("State directory", "permissions are 0o700");
  const observed = `0o${mode.toString(8)}`;
  if (dryRun) return fixable("State directory", `permissions ${observed} (expected 0o700)`);
  chmodSync(stateDir, 0o700);
  return fixed("State directory", `tightened permissions ${observed} -> 0o700`);
}

type EntryHealth = "missing" | "modified" | "ok";

function classifyLauncherEntry(entry: LauncherStateEntry): EntryHealth {
  if (!existsSync(entry.path)) return "missing";
  try {
    return hashContent(readFileSync(entry.path, "utf8")) === entry.contentSha256
      ? "ok"
      : "modified";
  } catch {
    return "modified";
  }
}

function summarizeLauncher(state: LauncherState, stateDir: string, dryRun: boolean): CheckResult {
  let missing = 0;
  let modified = 0;
  let healthy = 0;
  let next = state;
  for (const entry of state.entries) {
    const health = classifyLauncherEntry(entry);
    if (health === "missing") {
      missing += 1;
      next = removeEntry(next, entry.path);
    } else if (health === "modified") modified += 1;
    else healthy += 1;
  }
  if (modified > 0)
    return action(
      "Launcher records",
      `${String(modified)} shortcut(s) modified — run \`keiko launcher remove\` then re-install`,
    );
  if (missing === 0) return ok("Launcher records", `${String(healthy)} shortcut(s) verified`);
  if (dryRun)
    return fixable(
      "Launcher records",
      `${String(missing)} dangling record(s) for deleted shortcut(s)`,
    );
  saveState(stateDir, next);
  return fixed("Launcher records", `pruned ${String(missing)} dangling record(s)`);
}

function checkLauncherRecords(
  stateDir: string,
  homedir: string,
  io: CliIo,
  dryRun: boolean,
): CheckResult {
  const state = loadState(stateDir, {
    homedir,
    onWarn: (msg: string): void => {
      io.err(msg);
    },
  });
  if (state.entries.length === 0) return ok("Launcher records", "no shortcuts recorded");
  return summarizeLauncher(state, stateDir, dryRun);
}

function checkInstallLayout(cwd: string, env: EnvSource): CheckResult {
  // The UI static export is what `keiko start` / `keiko ui` serve. The bin shim exports
  // KEIKO_UI_STATIC_ROOT for the running install (so a global install resolves even when
  // run outside a project), while a local checkout/install resolves via
  // resolvePreferredInstallLayout. Either reachable -> ok.
  const staticRoot = env.KEIKO_UI_STATIC_ROOT ?? process.env.KEIKO_UI_STATIC_ROOT;
  if (
    typeof staticRoot === "string" &&
    staticRoot.length > 0 &&
    existsSync(join(staticRoot, "index.html"))
  )
    return ok("Install layout", "UI static export present");
  if (resolvePreferredInstallLayout(cwd) !== undefined)
    return ok("Install layout", "built CLI and UI assets present");
  return action(
    "Install layout",
    "UI assets not found — reinstall `npm install @oscharko-dev/keiko` or rebuild `npm run build`",
  );
}

function checkLaunchPath(cwd: string, argv: readonly string[]): CheckResult {
  const report = collectDoctorReport({ cwd, argv });
  if (report.warning === undefined) return ok("Launch path", "no stale-launch mismatch detected");
  return action(
    "Launch path",
    report.warning.split("\n")[0] ?? "stale launch path detected (see `keiko doctor`)",
  );
}

function checkGatewayConfig(args: readonly string[], env: EnvSource): CheckResult {
  const resolution = resolveConfigPathFromArgs(args, env);
  if (resolution.kind === "not-configured")
    return ok("Gateway config", "no config file configured (set up on first run)");
  if (resolution.kind === "missing-value")
    return action("Gateway config", "--config flag is missing its value");
  if (!existsSync(resolution.path))
    return action("Gateway config", `configured file not found: ${resolution.path}`);
  try {
    JSON.parse(readFileSync(resolution.path, "utf8"));
  } catch {
    return action("Gateway config", `configured file is not valid JSON: ${resolution.path}`);
  }
  return ok("Gateway config", `valid JSON at ${resolution.path}`);
}

interface ResolvedRepairDeps {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly homedir: () => string;
  readonly isProcessAlive: (pid: number) => boolean;
}

function resolveDeps(deps: RepairCliDeps): ResolvedRepairDeps {
  return {
    cwd: deps.cwd ?? process.cwd(),
    argv: deps.argv ?? process.argv,
    homedir: deps.homedir ?? defaultHomedir,
    isProcessAlive: deps.isProcessAlive ?? defaultIsProcessAlive,
  };
}

const TAG: Readonly<Record<CheckStatus, string>> = {
  ok: "ok",
  fixed: "fixed",
  fixable: "would-fix",
  "action-required": "action",
};

function reportResults(io: CliIo, results: readonly CheckResult[]): void {
  io.out("Keiko repair\n");
  for (const r of results) {
    io.out(`  [${TAG[r.status]}] ${r.name}: ${r.detail}\n`);
  }
}

function exitCodeFor(results: readonly CheckResult[], dryRun: boolean): number {
  const hasAction = results.some((r) => r.status === "action-required");
  const hasFixable = results.some((r) => r.status === "fixable");
  if (dryRun) return hasAction || hasFixable ? 1 : 0;
  return hasAction ? 1 : 0;
}

export function runRepairCli(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  deps: RepairCliDeps = {},
): number {
  const parsed = parseRepairArgs(args);
  if (parsed === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed === null) {
    io.err(USAGE);
    return 2;
  }
  const resolved = resolveDeps(deps);
  const stateDir = resolveStateDir(resolved.cwd, env, parsed.stateDirArg);
  const results: CheckResult[] = [
    checkStalePid(stateDir, resolved.isProcessAlive, parsed.dryRun),
    checkStateDirPerms(stateDir, parsed.dryRun),
    checkLauncherRecords(stateDir, resolved.homedir(), io, parsed.dryRun),
    checkInstallLayout(resolved.cwd, env),
    checkLaunchPath(resolved.cwd, resolved.argv),
    checkGatewayConfig(args, env),
  ];
  reportResults(io, results);
  const code = exitCodeFor(results, parsed.dryRun);
  io.out(summaryMessage(results, code));
  return code;
}

function summaryMessage(results: readonly CheckResult[], code: number): string {
  if (code === 0) return "\nKeiko repair: system is healthy.\n";
  if (results.some((r) => r.status === "action-required"))
    return "\nKeiko repair: review the items marked `action` above.\n";
  // dry-run with only fixable items: nothing needs manual action, the fixes are pending.
  return "\nKeiko repair: run `keiko repair` (without --dry-run) to apply the fixes above.\n";
}
