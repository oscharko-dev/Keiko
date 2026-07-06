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
import { isAbsolute, join } from "node:path";
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
import { attestedPortableInstallRecord } from "./portable-install.js";
import {
  inspectPortableManagedInstall,
  portableRegistrationHealth,
  repairUserLocalRegistration,
} from "./portable-maintenance.js";
import {
  RUNTIME_STATE_DIR_MODE,
  RUNTIME_STATE_FILE_MODE,
  classifyPid,
  defaultIsProcessAlive,
  inspectStateRoot,
  resolveStateDir,
  scanRuntimeState,
  type RuntimeStateCategory,
  type RuntimeStateNode,
  type StateRootInspection,
} from "./state-paths.js";
import {
  RERANKER_SECRET_REF,
  credentialStorePath,
  hasPlaintextGatewayCredentials,
} from "@oscharko-dev/keiko-server/credential-vault";
import {
  SecretVaultStoreError,
  readLocalVaultReferences,
} from "@oscharko-dev/keiko-security/secret-vault";

const USAGE = `Usage:
  keiko repair [--state-dir PATH] [--config PATH] [--dry-run]

Runs an offline diagnostic-and-repair pass over the local Keiko install:
  - removes a stale UI pid file left by an unclean shutdown
  - tightens the .keiko state directory permissions to 0o700
  - tightens known Keiko-owned runtime artifacts (DBs, Evidence/QI, credential
    vaults, sidecars) to owner-only 0o700/0o600 without touching customer files
  - prunes launcher records whose shortcut files were deleted
  - repairs attested portable-managed user-local registration when safe
  - verifies the built CLI/UI assets and the launch path
  - validates a configured model-gateway config file
  - flags lingering plaintext credentials in the config

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

function stateRootRefusal(root: StateRootInspection): CheckResult | undefined {
  if (root.status === "symlink")
    return action(
      "State directory",
      `refusing to inspect symlinked state directory: ${root.absPath}`,
    );
  if (root.status === "not-directory")
    return action(
      "State directory",
      `refusing to inspect non-directory state path: ${root.absPath}`,
    );
  return undefined;
}

// Issue #1321: audit and tighten the permissions of EVERY Keiko-owned artifact under the
// state directory — UI/Memory/Knowledge DBs and their WAL/SHM sidecars, Evidence/QI records,
// the sealed credential vaults, config, and lifecycle/launcher files — not just the state
// directory itself. The set is the allowlisted manifest in `state-paths.ts`; an unrecognized
// customer file is never chmod-ed. Content-free: reports relative paths and octal modes only.
const RUNTIME_STATE_LABEL: Readonly<Record<RuntimeStateCategory, string>> = {
  lifecycle: "lifecycle files",
  launcher: "launcher state",
  "ui-database": "UI database",
  "gateway-config": "gateway config",
  "credential-vault": "credential vault",
  "editor-hot-exit": "editor recovery store",
  "memory-vault": "memory vault",
  "local-knowledge": "Local Knowledge store",
  evidence: "Evidence store",
  "quality-intelligence": "Quality Intelligence store",
  "update-recovery": "update recovery state",
};

interface LoosePermFinding {
  readonly category: RuntimeStateCategory;
  readonly relPath: string;
  readonly observed: string;
}

// Records every node not already at `targetMode`, applying the fix unless this is a dry-run.
function tightenNodes(
  nodes: readonly RuntimeStateNode[],
  targetMode: number,
  dryRun: boolean,
  findings: LoosePermFinding[],
): void {
  for (const node of nodes) {
    const mode = statSync(node.absPath).mode & 0o777;
    if (mode === targetMode) continue;
    findings.push({
      category: node.category,
      relPath: node.relPath,
      observed: `0o${mode.toString(8)}`,
    });
    if (!dryRun) chmodSync(node.absPath, targetMode);
  }
}

function summarizeLooseCategory(
  category: RuntimeStateCategory,
  findings: readonly LoosePermFinding[],
  dryRun: boolean,
): CheckResult {
  const matches = findings.filter((f) => f.category === category);
  const example = matches[0];
  const detail = `${String(matches.length)} ${RUNTIME_STATE_LABEL[category]} artifact(s) group/world-readable (e.g. ${example?.relPath ?? "?"} ${example?.observed ?? "?"})`;
  const name = "Runtime state artifacts";
  return dryRun ? fixable(name, detail) : fixed(name, detail);
}

function checkRuntimeStateArtifacts(stateDir: string, dryRun: boolean): CheckResult[] {
  if (process.platform === "win32") {
    return [
      ok(
        "Runtime state artifacts",
        "POSIX permission normalization not applicable on Windows (NTFS ACLs govern access)",
      ),
    ];
  }
  const scan = scanRuntimeState(stateDir);
  if (!scan.present) return [ok("Runtime state artifacts", "state directory not present")];
  const ownedCount = scan.files.length + scan.directories.length;
  const refusedOwned = scan.retained.filter(
    (r) => r.owned && (r.reason === "symlink" || r.reason === "hardlink"),
  );
  if (ownedCount === 0 && refusedOwned.length === 0) {
    return [ok("Runtime state artifacts", "no Keiko-owned artifacts present")];
  }

  const findings: LoosePermFinding[] = [];
  tightenNodes(scan.directories, RUNTIME_STATE_DIR_MODE, dryRun, findings);
  tightenNodes(scan.files, RUNTIME_STATE_FILE_MODE, dryRun, findings);

  const results: CheckResult[] = [];
  for (const category of new Set(findings.map((f) => f.category))) {
    results.push(summarizeLooseCategory(category, findings, dryRun));
  }
  for (const entry of refusedOwned) {
    const kind = entry.reason === "symlink" ? "symlink" : "hardlink";
    results.push(
      action(
        "Runtime state artifacts",
        `${kind} occupies a Keiko-owned path and was left untouched: ${entry.relPath}`,
      ),
    );
  }
  if (results.length === 0) {
    results.push(
      ok(
        "Runtime state artifacts",
        `${String(ownedCount)} artifact(s) have owner-only permissions`,
      ),
    );
  }
  return results;
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

// Issue #1320: detect an unmigrated or partially migrated config — one that still holds a plaintext
// provider apiKey or Figma accessToken. Credentials must live in encrypted local storage, with only
// non-secret references in the JSON file; `keiko ui` performs the one-time, crash-aware migration, so
// lingering plaintext here is the signal that a migration never ran or was interrupted.
function defaultLocalGatewayConfigPath(env: EnvSource, homedir: string): string {
  const dataDir = env.KEIKO_UI_DATA_DIR;
  if (dataDir !== undefined && dataDir.length > 0 && isAbsolute(dataDir)) {
    return join(dataDir, "keiko.config.json");
  }
  return join(homedir, ".keiko", "keiko.config.json");
}

function credentialConfigPath(
  args: readonly string[],
  env: EnvSource,
  defaultConfigPath: string,
): string | undefined {
  const resolution = resolveConfigPathFromArgs(args, env);
  if (resolution.kind === "path") {
    return resolution.path;
  }
  if (resolution.kind === "not-configured") {
    return defaultConfigPath;
  }
  return undefined;
}

function checkCredentialStorage(
  args: readonly string[],
  env: EnvSource,
  defaultConfigPath: string,
): CheckResult {
  const configPath = credentialConfigPath(args, env, defaultConfigPath);
  if (configPath === undefined || !existsSync(configPath)) {
    return ok("Credential storage", "no config file to inspect");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // Invalid JSON is already reported by the gateway-config check; avoid a duplicate action item.
    return ok("Credential storage", "config not parseable (reported above)");
  }
  if (hasPlaintextGatewayCredentials(raw)) {
    return action(
      "Credential storage",
      "plaintext credentials present in config — start `keiko ui` to migrate them into encrypted storage",
    );
  }
  let orphaned: number;
  try {
    orphaned = orphanedSecretRefs(raw, configPath);
  } catch (error) {
    if (error instanceof SecretVaultStoreError) {
      return action(
        "Credential storage",
        "encrypted credential vault is unreadable — refusing to treat it as empty; restore the vault file or move it aside intentionally",
      );
    }
    throw error;
  }
  if (orphaned > 0) {
    return action(
      "Credential storage",
      `${String(orphaned)} credential reference(s) have no encrypted entry — incomplete or interrupted migration; start \`keiko ui\` to complete it`,
    );
  }
  return ok("Credential storage", "no plaintext credentials in config");
}

function checkPortableManagedInstall(
  stateDir: string,
  env: EnvSource,
  homedir: string,
): CheckResult {
  const recordResult = readPortableRecordForRepair(stateDir, env, homedir);
  if (recordResult.kind === "error") {
    return action("Portable managed install", recordResult.message);
  }
  const record = recordResult.record;
  if (record === undefined)
    return ok("Portable managed install", "no portable-managed install recorded");
  if (record.registration.status === "setup-failed") {
    const reason = record.registration.failureReason ?? "setup-failed";
    return action("Portable managed install", `previous portable setup failed (${reason})`);
  }
  if (
    record.managedRoot === undefined ||
    record.layout === undefined ||
    record.manifest === undefined
  ) {
    return action(
      "Portable managed install",
      "recorded portable-managed install could not be attested from user-local registration or default roots",
    );
  }
  const scan = inspectPortableManagedInstall(record.layout);
  if (scan.issues.length > 0) {
    return action(
      "Portable managed install",
      scan.issues[0] ?? "portable managed install is not safe to inspect",
    );
  }
  return ok("Portable managed install", "attested portable-managed install verified");
}

function checkPortableRegistration(
  stateDir: string,
  env: EnvSource,
  homedir: string,
  dryRun: boolean,
): CheckResult {
  const recordResult = readPortableRecordForRepair(stateDir, env, homedir);
  if (recordResult.kind === "error") {
    return action("Portable registration", recordResult.message);
  }
  const record = recordResult.record;
  if (record === undefined || record.registration.status === "setup-failed") {
    return ok("Portable registration", "no portable-managed registration recorded");
  }
  if (record.layout === undefined || record.managedRoot === undefined) {
    return action(
      "Portable registration",
      "portable-managed install could not be attested before registration repair",
    );
  }
  const health = portableRegistrationHealth(
    record.layout,
    record.target,
    record.managedRoot,
    env,
    homedir,
  );
  const status = portableRegistrationStatus(health, dryRun);
  if (status !== "repair") return status;
  const repaired = repairUserLocalRegistration(
    record.layout,
    record.target,
    record.managedRoot,
    env,
    homedir,
  );
  return fixed(
    "Portable registration",
    `repaired ${String(repaired)} user-local registration artifact(s)`,
  );
}

function portableRegistrationStatus(
  health: ReturnType<typeof portableRegistrationHealth>,
  dryRun: boolean,
): CheckResult | "repair" {
  if (health.actionRequired > 0) {
    return action(
      "Portable registration",
      `${String(health.actionRequired)} user-local registration artifact(s) modified — remove the portable registration artifact and re-run setup`,
    );
  }
  if (health.missing === 0) {
    return ok(
      "Portable registration",
      `${String(health.ok)} user-local registration artifact(s) verified`,
    );
  }
  if (dryRun) {
    return fixable(
      "Portable registration",
      `${String(health.missing)} missing user-local registration artifact(s)`,
    );
  }
  return "repair";
}

function readPortableRecordForRepair(
  stateDir: string,
  env: EnvSource,
  homedir: string,
):
  | { readonly kind: "ok"; readonly record: ReturnType<typeof attestedPortableInstallRecord> }
  | { readonly kind: "error"; readonly message: string } {
  try {
    return { kind: "ok", record: attestedPortableInstallRecord(stateDir, env, homedir) };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error ? error.message : "portable-managed install record is unreadable",
    };
  }
}

// Counts provider/reranker `apiKeySecretRef` values in the config that have no matching entry in the
// encrypted credential vault — the signature of an interrupted migration or a deleted/corrupt vault
// store.
// Reads only the non-secret reference index (no vault key resolution, no decryption).
function orphanedSecretRefs(raw: unknown, configPath: string): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const providers = (raw as { readonly providers?: unknown }).providers;
  const refs = Array.isArray(providers)
    ? providers
        .map((provider) =>
          typeof provider === "object" && provider !== null
            ? (provider as { readonly apiKeySecretRef?: unknown }).apiKeySecretRef
            : undefined,
        )
        .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
    : [];
  const reranker = (raw as { readonly reranker?: unknown }).reranker;
  if (typeof reranker === "object" && reranker !== null) {
    const ref = (reranker as { readonly apiKeySecretRef?: unknown }).apiKeySecretRef;
    if (typeof ref === "string" && ref.length > 0) {
      refs.push(ref === RERANKER_SECRET_REF ? ref : "__invalid-reranker-secret-ref__");
    }
  }
  if (refs.length === 0) return 0;
  const vaulted = new Set(readLocalVaultReferences(credentialStorePath(configPath)));
  return refs.filter((ref) => !vaulted.has(ref)).length;
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
  const defaultConfigPath = defaultLocalGatewayConfigPath(env, resolved.homedir());
  const stateRoot = inspectStateRoot(stateDir);
  const stateRootAction = stateRootRefusal(stateRoot);
  const stateResults =
    stateRootAction === undefined
      ? [
          checkStalePid(stateDir, resolved.isProcessAlive, parsed.dryRun),
          checkStateDirPerms(stateDir, parsed.dryRun),
          ...checkRuntimeStateArtifacts(stateDir, parsed.dryRun),
          checkLauncherRecords(stateDir, resolved.homedir(), io, parsed.dryRun),
          checkPortableManagedInstall(stateDir, env, resolved.homedir()),
          checkPortableRegistration(stateDir, env, resolved.homedir(), parsed.dryRun),
        ]
      : [stateRootAction];
  const results: CheckResult[] = [
    ...stateResults,
    checkInstallLayout(resolved.cwd, env),
    checkLaunchPath(resolved.cwd, resolved.argv),
    checkGatewayConfig(args, env),
    checkCredentialStorage(args, env, defaultConfigPath),
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
