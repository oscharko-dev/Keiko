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

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir as defaultHomedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  ATLASSIAN_CONNECTOR_SCHEMA_VERSION,
  isAtlassianConnectorAuthRef,
  isAtlassianConnectorProvider,
  isSafeAtlassianConnectorBaseUrl,
  isSafeAtlassianDisplayName,
} from "@oscharko-dev/keiko-contracts";
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
  ATLASSIAN_CREDENTIALS_KEYFILE,
  ATLASSIAN_CREDENTIALS_METADATA,
  ATLASSIAN_CREDENTIALS_VAULT,
  classifyPid,
  defaultUiDataDir,
  defaultIsProcessAlive,
  inspectStateRoot,
  resolveStateDir,
  scanRuntimeState,
  type RetainedNode,
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
  "activity-log": "activity log",
};

interface LoosePermFinding {
  readonly category: RuntimeStateCategory;
  readonly relPath: string;
  readonly observed: string;
}

// Records every node not already at `targetMode`, applying the fix unless this is a dry-run.
// #KEIKO-0301: guard each node's statSync/chmodSync so one unreadable / vanished artifact
// is recorded as an "unreadable" finding rather than aborting the whole repair run. The
// happy path (a stable, readable state tree) is unchanged; only the newly-guarded error
// paths differ.
function tightenNodes(
  nodes: readonly RuntimeStateNode[],
  targetMode: number,
  dryRun: boolean,
  findings: LoosePermFinding[],
  unreadable: LoosePermFinding[],
): void {
  for (const node of nodes) {
    // PR-review follow-up (Codex thread 3770211419): use lstatSync so a TOCTOU race where
    // another process replaces the scanned regular file/directory with a symlink between
    // scanRuntimeState and this call does not silently follow the swap. scanRuntimeState
    // classifies symlinks as retained and never tightens them, so a symlink observed here
    // is by definition unexpected and belongs in `unreadable`, not chmodded.
    let observed: string;
    try {
      const stat = lstatSync(node.absPath);
      if (stat.isSymbolicLink()) {
        unreadable.push({
          category: node.category,
          relPath: node.relPath,
          observed: "unreadable",
        });
        continue;
      }
      const mode = stat.mode & 0o777;
      if (mode === targetMode) continue;
      observed = `0o${mode.toString(8)}`;
    } catch {
      unreadable.push({
        category: node.category,
        relPath: node.relPath,
        observed: "unreadable",
      });
      continue;
    }
    // PR-review follow-up on KEIKO-0301: only record the node as "fixed" after chmod actually
    // applied — a chmod failure (read-only filesystem, ownership race) leaves the node loose
    // and must show up as an unreadable/action finding, not double-reported as fixed AND
    // unreadable. The dry-run path skips chmod so it always records under findings.
    if (dryRun) {
      findings.push({ category: node.category, relPath: node.relPath, observed });
      continue;
    }
    // PR-review follow-up (Codex thread 3770211419): apply the mode through a fresh
    // O_NOFOLLOW-guarded descriptor so a symlink that lands between the lstat above and this
    // block cannot redirect the chmod to a target outside the state directory. openSync with
    // O_NOFOLLOW errors with ELOOP when the final path element is a symlink; fchmodSync then
    // targets the exact inode we opened. Directories need O_DIRECTORY | O_RDONLY.
    if (tightenNodeMode(node, targetMode)) {
      findings.push({ category: node.category, relPath: node.relPath, observed });
    } else {
      unreadable.push({
        category: node.category,
        relPath: node.relPath,
        observed: "unreadable",
      });
    }
  }
}

// PR-review follow-up (Codex threads 3770357730 + 3770792796 + 3771011305 + 3771181239):
// open a genuinely no-follow descriptor and chmod through it. Priority order:
//   1. O_RDONLY | O_NOFOLLOW — POSIX, for entries readable by the owner.
//   2. O_WRONLY | O_NOFOLLOW — POSIX fallback for write-only files.
// An O_PATH candidate stood first here until KfQ thread 3780142203. It never ran and could
// not have worked: Node exposes no `fs.constants.O_PATH` on any platform (verified on
// linux/node 24.18.0), so the guard was always false; and forcing the raw Linux value shows
// `fchmod` on such a descriptor failing with EBADF for both a 0666 file and a 0333 directory,
// leaving the mode untouched — open(2) excludes fchmod from what an O_PATH descriptor permits.
// The "no permission bits required" coverage it advertised therefore never existed.
// If no descriptor strategy works (an execute-only 0333 directory has no readable or writable
// open mode), REFUSE to tighten via path-based chmod — a symlink/hardlink swap between an lstat
// check and the chmod call could redirect the mode change outside the state directory. The
// operator sees the entry as unreadable and can repair it manually.
function tightenNodeMode(node: RuntimeStateNode, targetMode: number): boolean {
  for (const flags of tightenOpenFlagCandidates()) {
    if (tightenViaOpenFlag(node, targetMode, flags)) return true;
  }
  return false;
}

function tightenOpenFlagCandidates(): readonly number[] {
  // `O_NOFOLLOW` is POSIX-only, but `@types/node` declares it as a plain `number`, so a platform
  // that does not define it yields `undefined` at runtime — and `X | undefined` evaluates to `X`,
  // silently dropping the very bit these flags exist for. The result would be an open that follows
  // a symlink, then an fchmod on whatever it pointed at.
  //
  // Unreachable today: `checkRuntimeStateArtifacts` returns before this on win32, the only platform
  // in question. That is exactly why the guard belongs here — otherwise the no-follow guarantee
  // rests on an early return in another function, and removing that early return would weaken this
  // one silently (KfQ thread 3780545514). With no candidates, `tightenNodeMode` refuses and the
  // operator sees the entry reported, which is the documented fail-closed path.
  const noFollow = (fsConstants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (noFollow === undefined) return [];
  return [fsConstants.O_RDONLY | noFollow, fsConstants.O_WRONLY | noFollow];
}

function tightenViaOpenFlag(node: RuntimeStateNode, targetMode: number, flags: number): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(node.absPath, flags);
    // PR-review follow-up (Codex thread 3771600808): fstat the opened descriptor and
    // refuse if a REGULAR file has nlink > 1. Between the scanner's lstat and this open,
    // another same-user process could have replaced the scanned Keiko-owned file with a
    // hardlink to an unrelated inode; fchmodSync would otherwise change that inode's
    // permissions. O_NOFOLLOW already blocks symlink swaps at the final component; the
    // fstat here covers the hardlink case at the exact inode the fd points at. Directories
    // inherently have nlink >= 2 ("." + parent), so the check only applies to regular files.
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.nlink > 1) return false;
    fchmodSync(fd, targetMode);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort close; a descriptor left dangling here does not weaken the mode we
        // already applied atomically via fchmodSync.
      }
    }
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

function collectRuntimeStateFindings(
  unreadable: readonly LoosePermFinding[],
  refusedOwned: readonly RetainedNode[],
  results: CheckResult[],
): void {
  // #KEIKO-0301: report each unreadable Keiko-owned artifact as an action item so a
  // filesystem hiccup during the state walk is visible rather than crashing the CLI.
  // Path is relative — no raw absolute path, uid, or stack trace escapes.
  for (const entry of unreadable) {
    results.push(
      action(
        "Runtime state artifacts",
        `${RUNTIME_STATE_LABEL[entry.category]} artifact could not be inspected (unreadable): ${entry.relPath}`,
      ),
    );
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
  const unreadable: LoosePermFinding[] = [];
  tightenNodes(scan.directories, RUNTIME_STATE_DIR_MODE, dryRun, findings, unreadable);
  tightenNodes(scan.files, RUNTIME_STATE_FILE_MODE, dryRun, findings, unreadable);

  const results: CheckResult[] = [];
  for (const category of new Set(findings.map((f) => f.category))) {
    results.push(summarizeLooseCategory(category, findings, dryRun));
  }
  collectRuntimeStateFindings(unreadable, refusedOwned, results);
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
function defaultLocalGatewayConfigCandidates(
  env: EnvSource,
  homedir: string,
  stateDir: string,
): readonly string[] {
  const dataDir = env.KEIKO_UI_DATA_DIR;
  if (dataDir !== undefined && dataDir.length > 0 && isAbsolute(dataDir)) {
    return [join(dataDir, "keiko.config.json")];
  }
  const stateDirCandidate = join(defaultUiDataDir(stateDir), "keiko.config.json");
  const homeCandidate = join(homedir, ".keiko", "keiko.config.json");
  return stateDirCandidate === homeCandidate
    ? [stateDirCandidate]
    : [stateDirCandidate, homeCandidate];
}

function credentialConfigPaths(
  args: readonly string[],
  env: EnvSource,
  defaultConfigCandidates: readonly string[],
): readonly string[] {
  const resolution = resolveConfigPathFromArgs(args, env);
  if (resolution.kind === "path") return [resolution.path];
  if (resolution.kind === "not-configured") return defaultConfigCandidates;
  return [];
}

function credentialReferenceCheck(configPath: string, raw: unknown): CheckResult {
  let orphaned: number;
  try {
    orphaned =
      (raw === undefined ? 0 : orphanedSecretRefs(raw, configPath)) +
      orphanedAtlassianSecretRefs(configPath);
  } catch (error) {
    if (error instanceof SecretVaultStoreError) {
      return action(
        "Credential storage",
        "encrypted credential vault is unreadable — refusing to treat it as empty; restore the vault file or move it aside intentionally",
      );
    }
    if (error instanceof AtlassianCredentialStateError) {
      return action(
        "Credential storage",
        "encrypted Atlassian credential state is unreadable — refusing to treat it as empty; restore the credential files or move them aside intentionally",
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
  return raw === undefined
    ? ok("Credential storage", "no config file to inspect")
    : ok("Credential storage", "no plaintext credentials in config");
}

function checkCredentialConfig(configPath: string): CheckResult {
  if (configPath.length === 0) return ok("Credential storage", "no config file to inspect");
  if (!existsSync(configPath)) return credentialReferenceCheck(configPath, undefined);
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
  return credentialReferenceCheck(configPath, raw);
}

function checkCredentialStorage(
  args: readonly string[],
  env: EnvSource,
  defaultConfigCandidates: readonly string[],
): readonly CheckResult[] {
  const paths = credentialConfigPaths(args, env, defaultConfigCandidates);
  if (paths.length === 0) return [ok("Credential storage", "no config file to inspect")];
  const includePath = paths.length > 1;
  return paths.map((configPath) => {
    const result = checkCredentialConfig(configPath);
    return includePath ? { ...result, name: `${result.name} (${configPath})` } : result;
  });
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
  io: CliIo,
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
    io,
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

class AtlassianCredentialStateError extends Error {
  constructor(cause?: unknown) {
    super("Atlassian credential state is unreadable", cause === undefined ? undefined : { cause });
    this.name = "AtlassianCredentialStateError";
  }
}

function atlassianCredentialPaths(configPath: string): {
  readonly vault: string;
  readonly keyfile: string;
  readonly metadata: string;
} {
  const credentialsDir = join(dirname(configPath), "credentials");
  return {
    vault: join(credentialsDir, ATLASSIAN_CREDENTIALS_VAULT),
    keyfile: join(credentialsDir, ATLASSIAN_CREDENTIALS_KEYFILE),
    metadata: join(credentialsDir, ATLASSIAN_CREDENTIALS_METADATA),
  };
}

const ATLASSIAN_METADATA_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "authRef",
  "provider",
  "displayName",
  "baseUrl",
  "authScheme",
  "createdAt",
]);

function hasCompleteAtlassianMetadataKeys(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === ATLASSIAN_METADATA_KEYS.size &&
    keys.every((key) => ATLASSIAN_METADATA_KEYS.has(key))
  );
}

function hasValidAtlassianMetadataIdentity(
  reference: string,
  record: Record<string, unknown>,
): boolean {
  return (
    record.schemaVersion === ATLASSIAN_CONNECTOR_SCHEMA_VERSION &&
    record.authRef === reference &&
    isAtlassianConnectorAuthRef(record.authRef) &&
    isAtlassianConnectorProvider(record.provider)
  );
}

function hasValidAtlassianMetadataDetails(record: Record<string, unknown>): boolean {
  return (
    isSafeAtlassianDisplayName(record.displayName) &&
    isSafeAtlassianConnectorBaseUrl(record.baseUrl) &&
    record.authScheme === "basic-api-token"
  );
}

function hasValidAtlassianCreatedAt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCompleteAtlassianMetadata(reference: string, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasCompleteAtlassianMetadataKeys(record) &&
    hasValidAtlassianMetadataIdentity(reference, record) &&
    hasValidAtlassianMetadataDetails(record) &&
    hasValidAtlassianCreatedAt(record.createdAt)
  );
}

function readAtlassianMetadataReferences(path: string): readonly string[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new TypeError("metadata envelope is malformed");
    }
    const record = raw as Record<string, unknown>;
    const credentials = record.credentials;
    if (record.version !== 1 || typeof credentials !== "object" || credentials === null) {
      throw new TypeError("metadata schema is unsupported");
    }
    return Object.entries(credentials).map(([reference, entry]) => {
      if (!isCompleteAtlassianMetadata(reference, entry)) {
        throw new TypeError("metadata entry is malformed");
      }
      return reference;
    });
  } catch (error) {
    throw new AtlassianCredentialStateError(error);
  }
}

function orphanedAtlassianSecretRefs(configPath: string): number {
  const paths = atlassianCredentialPaths(configPath);
  const metadataRefs = new Set(readAtlassianMetadataReferences(paths.metadata));
  let vaultReferences: readonly string[] = [];
  try {
    vaultReferences = existsSync(paths.vault) ? readLocalVaultReferences(paths.vault) : [];
  } catch (error) {
    throw new AtlassianCredentialStateError(error);
  }
  const vaultedRefs = new Set(vaultReferences);
  const mismatched = new Set<string>();
  for (const reference of metadataRefs) if (!vaultedRefs.has(reference)) mismatched.add(reference);
  for (const reference of vaultedRefs) if (!metadataRefs.has(reference)) mismatched.add(reference);
  if (existsSync(paths.keyfile) && !existsSync(paths.vault)) mismatched.add("missing-vault");
  return mismatched.size;
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

// Runs every repair check and gathers their CheckResults. Extracted so `runRepairCli`
// can wrap the whole pipeline in a single try/catch (#KEIKO-0301) without exceeding
// the 50-line max-lines-per-function bar.
function collectRepairResults(
  args: readonly string[],
  io: CliIo,
  env: EnvSource,
  parsed: RepairOptions,
  resolved: ResolvedRepairDeps,
): readonly CheckResult[] {
  const stateDir = resolveStateDir(resolved.cwd, env, parsed.stateDirArg);
  const defaultConfigCandidates = defaultLocalGatewayConfigCandidates(
    env,
    resolved.homedir(),
    stateDir,
  );
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
          checkPortableRegistration(stateDir, env, resolved.homedir(), parsed.dryRun, io),
        ]
      : [stateRootAction];
  return [
    ...stateResults,
    checkInstallLayout(resolved.cwd, env),
    checkLaunchPath(resolved.cwd, resolved.argv),
    checkGatewayConfig(args, env),
    ...checkCredentialStorage(args, env, defaultConfigCandidates),
  ];
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
  // #KEIKO-0301: mirror uninstall.ts's runUninstallCli try/catch — a filesystem
  // hiccup (missing / unreadable / vanished artifact) during any check must not
  // crash the command it exists to rescue. On an unexpected error, print an
  // `[action]` line naming the class of failure (content-free) and return 1 so
  // scripts can detect "manual step required".
  let results: readonly CheckResult[];
  try {
    results = collectRepairResults(args, io, env, parsed, resolved);
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    io.out("Keiko repair\n");
    io.out(
      `  [action] Runtime state artifacts: repair aborted after an unexpected error (${name})\n`,
    );
    io.out("\nKeiko repair: review the items marked `action` above.\n");
    return 1;
  }
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
