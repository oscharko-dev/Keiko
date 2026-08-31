// Shared resolution of Keiko's runtime state directory and the set of files Keiko
// itself writes there. Consumed by `keiko uninstall` (to reverse them) and
// `keiko repair` (to detect and clean stale ones). Resolution mirrors `lifecycle.ts`
// (`--state-dir` > KEIKO_STATE_DIR > <cwd>/.keiko) so `start`, `uninstall`, and
// `repair` all operate on the same directory.
//
// DELETION SAFETY CONTRACT: callers remove ONLY the explicitly enumerated state
// artifacts below (the fixed `KEIKO_STATE_FILES` plus the launcher's
// `.launcher-state-*` mkdtemp dirs) and then rmdir the state directory when it is
// empty. Nothing here recursively deletes an arbitrary directory, so a mis-pointed
// `--state-dir`/KEIKO_STATE_DIR can never escalate into data loss outside Keiko's
// own files.

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { EnvSource } from "@oscharko-dev/keiko-model-gateway";
import { assertValidRunId } from "@oscharko-dev/keiko-security";
import { assertRealpathContained } from "./launcher-paths.js";
import { LauncherError } from "./launcher-platforms.js";

export const DEFAULT_STATE_DIR_NAME = ".keiko";
export const DEFAULT_UI_STATE_SUBDIR = "ui";

export function defaultUiDataDir(stateDir: string): string {
  return join(stateDir, DEFAULT_UI_STATE_SUBDIR);
}

export const ATLASSIAN_CREDENTIALS_VAULT = "atlassian-connector-credentials.vault";
export const ATLASSIAN_CREDENTIALS_KEYFILE = "atlassian-connector-credentials-vault.key";
export const ATLASSIAN_CREDENTIALS_METADATA = "atlassian-connector-credentials.metadata.json";
export const ATLASSIAN_CREDENTIAL_ARTIFACTS = [
  ATLASSIAN_CREDENTIALS_VAULT,
  ATLASSIAN_CREDENTIALS_KEYFILE,
  ATLASSIAN_CREDENTIALS_METADATA,
] as const;
const ATLASSIAN_CREDENTIAL_ARTIFACT_SET: ReadonlySet<string> = new Set(
  ATLASSIAN_CREDENTIAL_ARTIFACTS,
);

// Runtime files Keiko writes under the state dir. `ui.pid`/`ui.log`/`ui.shutdown`
// come from `lifecycle.ts` (the shutdown request is the Windows-safe graceful
// channel — issue #3351); `launcher-state.json` from `launcher-state.ts`; portable
// install attestation from `portable.ts`.
export const UI_SHUTDOWN_REQUEST_FILE = "ui.shutdown";

export const KEIKO_STATE_FILES = [
  "ui.pid",
  "ui.log",
  UI_SHUTDOWN_REQUEST_FILE,
  "launcher-state.json",
  "portable-install-state.json",
] as const;

// `launcher-state.ts` writes ephemeral mkdtemp dirs with this prefix during atomic
// state saves; a crash can leave one behind, so uninstall/repair sweep them by prefix.
const LAUNCHER_STATE_TMP_PREFIX = ".launcher-state-";
// KEIKO-0333 (PR-review follow-up): portable-registration.ts writes atomic-save temp dirs
// with this prefix. Register them under the same "launcher" subtree so a crash leaves a
// classifiable stub that repair/uninstall can sweep instead of retaining as customer data.
const PORTABLE_REGISTRATION_TMP_PREFIX = ".portable-registration-";

// Resolves the state directory the same way `keiko start` does. An explicit
// `--state-dir` argument wins, then `KEIKO_STATE_DIR`, then `<cwd>/.keiko`. Relative
// values resolve against `cwd`.
export function resolveStateDir(cwd: string, env: EnvSource, stateDirArg?: string): string {
  const value =
    stateDirArg !== undefined && stateDirArg.length > 0
      ? stateDirArg
      : (env.KEIKO_STATE_DIR ?? DEFAULT_STATE_DIR_NAME);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

// Home-contained variant of `resolveStateDir` (#KEIKO-0330). When the state dir comes
// from an explicit `--state-dir` argument or `KEIKO_STATE_DIR`, its resolved realpath
// MUST live under the user's homedir; the default `<cwd>/.keiko` fallback is trusted
// (the user owns their own cwd). Refusing violates a fail-closed contract with the
// operator: without this guard, an attacker who can plant the env var (wrapper script
// in PATH, dev-container `.env`, exported in a parent shell) can steer the pid file
// (fed to `process.kill`) and the append-mode log file to any user-writable path.
// Callers that need the raw (unchecked) resolution stay on `resolveStateDir`; every
// path that ends up mkdir-ing / writing / spawning the state dir must go through this
// helper. Shared by `keiko launcher` (launcher.ts) and `keiko start|stop|status|restart`
// (lifecycle.ts) — see ADR-0024 §9 / #125 audit findings F4.
export function resolveContainedStateDir(
  cwd: string,
  env: EnvSource,
  home: string,
  stateDirArg?: string,
): string {
  const explicit = explicitStateDirSource(env, stateDirArg);
  if (explicit === undefined) return resolve(cwd, DEFAULT_STATE_DIR_NAME);
  const resolved = isAbsolute(explicit.value) ? explicit.value : resolve(cwd, explicit.value);
  try {
    assertRealpathContained(home, resolved);
  } catch (e) {
    if (e instanceof LauncherError && e.code === "PATH_ESCAPE") {
      throw new LauncherError(
        "STATE_DIR_ESCAPE",
        `keiko: ${explicit.source} ${explicit.value} resolves outside the user's home directory (${home}); refusing to proceed.`,
      );
    }
    throw e;
  }
  return resolved;
}

function explicitStateDirSource(
  env: EnvSource,
  stateDirArg?: string,
): { readonly source: string; readonly value: string } | undefined {
  if (stateDirArg !== undefined && stateDirArg.length > 0) {
    return { source: "--state-dir", value: stateDirArg };
  }
  // KEIKO-0553: no `?? process.env.X` fallback — callers own their EnvSource. Every
  // production caller threads an env through (launcher.ts, lifecycle.ts); a test that
  // passes `{}` MUST be able to suppress an ambient KEIKO_STATE_DIR that would otherwise
  // steer the pid/log/state files outside the user's homedir (F4).
  const fromEnv = env.KEIKO_STATE_DIR;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return { source: "KEIKO_STATE_DIR", value: fromEnv };
  }
  return undefined;
}

// #2906 round 3 (comment 3865273699): the descriptor-safe pid-read invariant, formerly
// duplicated as `lifecycle.ts`'s own private `readPid` while THIS function (reached by
// `classifyPid`, and therefore by `keiko uninstall --force` and `keiko repair` too) still
// followed `existsSync`/`readFileSync` — a symlinked `ui.pid` could steer those commands at an
// unrelated process even though `keiko start`/`stop`/`status`/`restart` were already hardened.
// `lifecycle.ts` now imports and reuses this SAME implementation instead of keeping a second
// copy, so every consumer gets the identical guarantee:
//   * O_NOFOLLOW makes the symlink check and the read the SAME syscall on POSIX — a symlink at
//     the final path component fails ELOOP, whether it was there from the start or planted a
//     moment before this call.
//   * O_NOFOLLOW alone does not refuse a HARD LINK (a hard link has no symlink component), so
//     `assertRegularSingleLinkFile` independently verifies the OPENED descriptor is a regular,
//     single-link file before its content is trusted.
//   * O_NONBLOCK keeps a planted FIFO from hanging this call indefinitely.
//   * Windows has no O_NOFOLLOW; `assertNotSymlink` is the documented, residual-TOCTOU fallback.
export function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`keiko: refusing to use symlinked ${path}`);
    }
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return; // path does not exist yet — nothing to follow
    }
    throw error;
  }
}

export function openPidFileNoFollow(path: string, flags: number): number {
  const nofollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonblock = (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  if (nofollow === 0) assertNotSymlink(path);
  return openSync(path, flags | nofollow | nonblock, 0o600);
}

// Defense in depth beyond O_NOFOLLOW/O_EXCL: neither refuses a HARD LINK, so every reader and
// writer independently verifies the descriptor it actually opened is a regular, SINGLE-LINK
// file — never trusting or writing through a hard-linked inode — before doing anything with it.
export function assertRegularSingleLinkFile(fd: number, path: string): void {
  const stats = fstatSync(fd);
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`keiko: refusing to use non-regular or hard-linked ${path}`);
  }
}

function isFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// Exclusive create of a pid-shaped regular single-link file. Shared by `ui.pid` (lifecycle
// start) and `ui.shutdown` (graceful stop request, issue #3351): both are a decimal pid plus
// a newline, both must refuse a symlink/hard-link/FIFO, and neither may truncate an existing
// inode. On EEXIST the NAME is unlinked (never a hard-linked target's content) and exclusive
// create is retried once; a second collision fails closed.
function createExclusivePidFileSlot(path: string): number {
  const exclusive = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  try {
    return openPidFileNoFollow(path, exclusive);
  } catch (error) {
    if (!isFsCode(error, "EEXIST")) throw error;
  }
  rmSync(path, { force: true });
  return openPidFileNoFollow(path, exclusive);
}

export const KEIKO_UI_LAUNCH_ID_ENV = "KEIKO_UI_LAUNCH_ID";
export const UI_LAUNCH_ID_FLAG = "--launch-id";
const UI_LAUNCH_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isKeikoUiLaunchId(value: string): boolean {
  return UI_LAUNCH_ID_PATTERN.test(value);
}

export interface PidRecord {
  readonly pid: number;
  readonly launchId?: string | undefined;
}

export function writeExclusivePidFile(path: string, pid: number, launchId?: string): void {
  const fd = createExclusivePidFileSlot(path);
  try {
    assertRegularSingleLinkFile(fd, path);
    writeSync(fd, encodePidFile(pid, launchId), null, "utf8");
  } finally {
    closeSync(fd);
  }
}

function encodePidFile(pid: number, launchId: string | undefined): string {
  if (launchId === undefined) return `${String(pid)}\n`;
  return `${String(pid)}\n${launchId}\n`;
}

export function shutdownRequestPath(stateDir: string): string {
  return join(stateDir, UI_SHUTDOWN_REQUEST_FILE);
}

export function writeShutdownRequest(stateDir: string, pid: number, launchId?: string): void {
  writeExclusivePidFile(shutdownRequestPath(stateDir), pid, launchId);
}

export function peekShutdownRequest(stateDir: string, pid: number, launchId?: string): boolean {
  const record = readPidRecord(shutdownRequestPath(stateDir));
  if (record === undefined) return false;
  if (launchId !== undefined && launchId.length > 0 && record.launchId !== undefined) {
    return record.launchId === launchId;
  }
  return record.pid === pid;
}

export function clearShutdownRequest(stateDir: string): void {
  unlinkOwnedPidShapedName(shutdownRequestPath(stateDir), true);
}

export function removeStaleShutdownRequest(stateDir: string): void {
  unlinkOwnedPidShapedName(shutdownRequestPath(stateDir), false);
}

function unlinkOwnedPidShapedName(path: string, ignoreDirectory: boolean): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    // Node 24 reports a directory unlink as ERR_FS_EISDIR (legacy EISDIR is kept).
    if (ignoreDirectory && (isFsCode(error, "EISDIR") || isFsCode(error, "ERR_FS_EISDIR"))) {
      return;
    }
    throw error;
  }
}

export function removePidFileIfMatches(path: string, pid: number, launchId?: string): boolean {
  const record = readPidRecord(path);
  if (!pidRecordMatches(record, pid, launchId)) return false;
  rmSync(path, { force: true });
  return true;
}

function pidRecordMatches(
  record: PidRecord | undefined,
  pid: number,
  launchId: string | undefined,
): boolean {
  if (record === undefined) return false;
  if (record.pid !== pid) return false;
  if (launchId === undefined || record.launchId === undefined) return true;
  return record.launchId === launchId;
}

// Small bound on <stateDir>/ui.pid: decimal pid, optional 32-hex launch id, newlines.
const MAX_PID_FILE_BYTES = 64;

function parsePidRecord(raw: string): PidRecord | undefined {
  const lines = raw.split("\n");
  const pidLine = lines[0]?.trim();
  if (pidLine === undefined || !/^[1-9]\d*$/.test(pidLine)) return undefined;
  const launchLine = lines[1]?.trim();
  if (launchLine !== undefined && isKeikoUiLaunchId(launchLine)) {
    return { pid: Number(pidLine), launchId: launchLine };
  }
  return { pid: Number(pidLine) };
}

export function readPidRecord(path: string): PidRecord | undefined {
  let fd: number;
  try {
    fd = openPidFileNoFollow(path, fsConstants.O_RDONLY);
  } catch {
    return undefined;
  }
  try {
    assertRegularSingleLinkFile(fd, path);
    const buffer = Buffer.alloc(MAX_PID_FILE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead === 0 || bytesRead === MAX_PID_FILE_BYTES) return undefined;
    return parsePidRecord(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Reads a pid file written by `lifecycle.ts`. Returns the integer pid, or undefined when the
// file is absent, unsafe (symlink / hard-link / FIFO / device), or does not contain a positive
// integer — see the invariant comment above.
export function readPidFile(path: string): number | undefined {
  return readPidRecord(path)?.pid;
}

// Liveness probe identical in semantics to the lifecycle handler: a successful
// signal-0 means alive; an EPERM error means the process exists but is owned by
// another user (still alive); any other error means it is gone. Kept local to this
// leaf module so uninstall/repair do not pull in lifecycle's heavy spawn/net imports.
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export type PidState = "absent" | "stale" | "running";

export interface PidClassification {
  readonly state: PidState;
  readonly pid: number | undefined;
  readonly launchId?: string | undefined;
}

// Classifies the UI pid file: `absent` (missing or malformed), `stale` (a pid is
// recorded but the process is gone), or `running` (recorded and alive). Reads the
// pid and launch id from one record so stop/uninstall cannot pair a stale pid with
// a replacement launch id.
export function classifyPid(
  pidFilePath: string,
  isAlive: (pid: number) => boolean,
): PidClassification {
  const record = readPidRecord(pidFilePath);
  if (record === undefined) return { state: "absent", pid: undefined };
  const state: PidState = isAlive(record.pid) ? "running" : "stale";
  if (record.launchId === undefined) return { state, pid: record.pid };
  return { state, pid: record.pid, launchId: record.launchId };
}

// ── Runtime-state confidentiality manifest (Issue #1321) ──────────────────────
//
// `keiko repair` and `keiko uninstall --state` must reason about EVERY Keiko-owned
// sensitive artifact under the state directory, not only the three lifecycle/launcher
// files above. Rather than a blanket recursive chmod/delete of arbitrary content under
// `.keiko` (which could touch a customer file that merely happens to live there), this
// manifest is an explicit allowlist describing the on-disk layout each Keiko store
// writes:
//
//   <stateDir>/
//     ui.pid, ui.log, ui.shutdown           lifecycle.ts
//     launcher-state.json                   launcher-state.ts
//     portable-install-state.json           portable.ts
//     .launcher-state-*/                    launcher-state.ts atomic-save temp dirs
//     keiko-ui.db, keiko.config.json         legacy root-local UI data
//     credentials/*.vault, *.key            legacy provider credential custody
//     ui/keiko-ui.db[-wal|-shm|.corrupt.*]  keiko-server  store/paths.ts (UI_DB_FILENAME)
//     ui/keiko.config.json                   keiko-server  deps.ts (model-gateway config)
//     ui/credentials/provider-*.vault|*.key keiko-server  credentialVault.ts
//     ui/credentials/atlassian-*             keiko-server  atlassian credential stores
//     memory/keiko-memory.db[-wal|-shm|.*]  keiko-memory-vault paths.ts (MEMORY_DB_FILENAME)
//     local-knowledge/<ns>/capsules.db[…]   keiko-local-knowledge store-paths.ts
//     evidence/<runId>.json|.lock|…         keiko-evidence store.ts
//     evidence/tool-results/<sha>.tool-result.txt|… keiko-evidence tool-result-artifact-store.ts
//     evidence/figma/*.vault, *.key         keiko-server  figmaTokenStore.ts (sealed Figma PAT + keyfile)
//     evidence/qi/<runId>.qi.json|…         keiko-evidence qualityIntelligence/*
//     evidence/qi/figma-snapshots/<runId>/… keiko-evidence figmaSnapshot side files
//     editor-hot-exit/*.vault, *.key        keiko-server  editor/hotExitStore.ts
//     updates/runtime-state.json            keiko-server  update-local-state.ts
//     updates/update-audit.jsonl            keiko-server  update-local-state.ts
//     updates/snapshots/<id>/manifest.json  keiko-server  update-local-state.ts
//     logs/server.log, server-<date>.log    keiko-server  observability/server-log.ts
//
// The sealed `*.vault` ciphertext and its `*.key` keyfile (the env/keychain-tier fallback,
// ADR-0046) are the most confidentiality-critical artifacts here, so they are first-class
// manifest entries rather than incidental files.
//
// The filenames are duplicated here ON PURPOSE: keiko-cli is a leaf consumer and must
// not take a package-graph edge onto keiko-local-knowledge / keiko-evidence internals
// just to learn a constant. Each descriptor cites its source of truth so drift stays
// auditable. The walker classifies entries WITHOUT mutating anything — `repair` chmods
// and `uninstall` unlinks, but only entries this allowlist recognizes as Keiko-owned;
// every unrecognized entry is reported as `retained` and left in place.

// POSIX modes Keiko enforces on its own runtime state: private directories and private
// files. NTFS has no equivalent; callers no-op on win32 and emit a diagnostic instead.
export const RUNTIME_STATE_DIR_MODE = 0o700;
export const RUNTIME_STATE_FILE_MODE = 0o600;

const UI_DB_FILENAME = "keiko-ui.db"; // keiko-server/src/store/paths.ts
const MEMORY_DB_FILENAME = "keiko-memory.db"; // keiko-memory-vault/src/paths.ts
const CAPSULES_DB_FILENAME = "capsules.db"; // keiko-local-knowledge/src/store-paths.ts
const GATEWAY_CONFIG_FILENAME = "keiko.config.json"; // keiko-server/src/deps.ts
const CREDENTIALS_SUBDIR = "credentials"; // keiko-server/src/credentialVault.ts (CREDENTIALS_SUBDIR)
const MEMORY_SUBDIR = "memory"; // keiko-memory-vault/src/paths.ts (MEMORY_DIR_NAME)
const LOCAL_KNOWLEDGE_SUBDIR = "local-knowledge"; // keiko-local-knowledge store-paths.ts (SUBSYSTEM_DIR)
const EVIDENCE_SUBDIR = "evidence"; // keiko-evidence/src/store.ts (DEFAULT_EVIDENCE_DIR)
const LOGS_SUBDIR = "logs"; // keiko-server/src/observability/server-log.ts (createFileServerLogSink)
const TOOL_RESULTS_SUBDIR = "tool-results"; // keiko-evidence/src/tool-result-artifact-store.ts
const UPDATE_SUBDIR = "updates"; // keiko-server/src/update-local-state.ts (UPDATE_DIR)
const FIGMA_VAULT_SUBDIR = "figma"; // keiko-server figmaTokenStore.ts (Figma PAT vault dir, under evidence)
const QI_SUBDIR = "qi"; // keiko-evidence/src/qualityIntelligence/store.ts (QI_SUBDIR)
const FIGMA_SNAPSHOTS_SUBDIR = "figma-snapshots"; // keiko-evidence figmaSnapshot/store.ts (SIDE_FILE_SUBDIR)
const QI_RETENTION_AUDIT_FILE = "retention-deletion-audit.jsonl"; // keiko-evidence qualityIntelligence/deletionAuditStore.ts
const EDITOR_HOT_EXIT_SUBDIR = "editor-hot-exit"; // keiko-server/src/editor/hotExitStore.ts (HOT_EXIT_SUBDIR)

const PROVIDER_CREDENTIALS_VAULT = "provider-credentials.vault"; // keiko-server/src/credentialVault.ts
const PROVIDER_CREDENTIALS_KEYFILE = "provider-credentials-vault.key"; // keiko-server/src/credentialVault.ts
const FIGMA_TOKEN_VAULT = "figma-token.vault"; // keiko-server figmaTokenStore.ts
const FIGMA_TOKEN_KEYFILE = "figma-vault.key"; // keiko-server figmaTokenStore.ts
const EDITOR_HOT_EXIT_VAULT = "snapshots.vault"; // keiko-server/src/editor/hotExitStore.ts
const EDITOR_HOT_EXIT_KEYFILE = "editor-hot-exit-vault.key"; // keiko-server/src/editor/hotExitStore.ts

const EVIDENCE_MANIFEST_SUFFIX = ".json"; // keiko-evidence/src/store.ts
const EVIDENCE_LOCK_SUFFIX = ".lock"; // keiko-evidence/src/store.ts
const TOOL_RESULT_ARTIFACT_SUFFIX = ".tool-result.txt"; // keiko-evidence tool-result-artifact-store.ts
const PRODUCER_TEMP_SUFFIX = ".tmp"; // atomic-save temp files (`<target>.<random>.tmp`)
const PRODUCER_TEMP_TOKEN = /^[A-Za-z0-9._-]{8,}$/u;
const SECRET_VAULT_TEMP_FILE = /^\.secret-vault\.[1-9]\d*\.[0-9a-f]{16}\.tmp$/u;
const SERVER_LOG_FILE = "server.log"; // keiko-server/src/observability/server-log.ts (createFileServerLogSink)
const SERVER_LOG_ARCHIVE_FILE = /^server-\d{4}-\d{2}-\d{2}\.log$/u; // day-rotated archive (archiveCurrentDay)
const QI_OWNED_SUFFIXES = [
  ".qi.json", // keiko-evidence/src/qualityIntelligence/store.ts
  ".candidates.json", // keiko-evidence/src/qualityIntelligence/candidatesArtifact.ts
  ".review.json", // keiko-server/src/qualityIntelligence/reviewStore.ts
  ".figma-codegen.json", // keiko-server/src/qualityIntelligence/retentionRoutes.ts
  ".figma-audit.json", // keiko-server/src/qualityIntelligence/retentionRoutes.ts
  ".figma-consent.json", // keiko-server/src/qualityIntelligence/retentionRoutes.ts
  ".figma-snapshot.json", // keiko-evidence/src/qualityIntelligence/figmaSnapshot/store.ts
  ".figma-snapshot.management.json", // keiko-evidence/src/qualityIntelligence/figmaSnapshot/store.ts
] as const;

export type RuntimeStateCategory =
  | "lifecycle"
  | "launcher"
  | "ui-database"
  | "gateway-config"
  | "credential-vault"
  | "editor-hot-exit"
  | "memory-vault"
  | "local-knowledge"
  | "evidence"
  | "quality-intelligence"
  | "update-recovery"
  | "activity-log";

// A SQLite store file plus its exact WAL/SHM sidecars and `.corrupt.<ts>` quarantine copies
// — and ONLY those. Matching is exact-name or a known dotted suffix, never a bare `${base}-`
// or `${base}.` prefix, so a customer file such as `keiko-ui.db.backup` or `keiko-ui.db-old`
// is left as an unrecognized entry and is never chmod-ed or deleted.
//   `<base>`                                   the live database
//   `<base>-wal`, `<base>-shm`                 WAL/SHM sidecars
//   `<base>-wal.corrupt.<ts>`, `-shm.corrupt`  quarantined sidecars (keiko-memory-vault db.ts)
//   `<base>.corrupt.<ts>`                      quarantined database (keiko-server store/db.ts)
function isSqliteFamily(base: string, name: string): boolean {
  return (
    name === base ||
    name === `${base}-wal` ||
    name === `${base}-shm` ||
    name.startsWith(`${base}-wal.corrupt.`) ||
    name.startsWith(`${base}-shm.corrupt.`) ||
    name.startsWith(`${base}.corrupt.`)
  );
}

// Evidence and Quality-Intelligence records are run-id-derived artifacts, never arbitrary
// suffix matches. Matching by the producer suffix vocabulary prevents a customer lookalike
// such as `manual export.json` or `backup.key` from being chmod-ed or deleted.
function isValidRunId(value: string): boolean {
  if (value.length === 0) return false;
  try {
    assertValidRunId(value);
    return true;
  } catch {
    return false;
  }
}

function hasRunIdSuffix(name: string, suffix: string): boolean {
  if (!name.endsWith(suffix)) return false;
  return isValidRunId(name.slice(0, -suffix.length));
}

function hasRunIdProducerTempSuffix(name: string, suffix: string): boolean {
  if (!name.endsWith(PRODUCER_TEMP_SUFFIX)) return false;
  const withoutTmp = name.slice(0, -PRODUCER_TEMP_SUFFIX.length);
  const marker = `${suffix}.`;
  const markerIndex = withoutTmp.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  const runId = withoutTmp.slice(0, markerIndex);
  const token = withoutTmp.slice(runId.length + marker.length);
  return PRODUCER_TEMP_TOKEN.test(token) && isValidRunId(runId);
}

function hasRunIdArtifactSuffix(name: string, suffix: string): boolean {
  return hasRunIdSuffix(name, suffix) || hasRunIdProducerTempSuffix(name, suffix);
}

function isEvidenceRecord(name: string): boolean {
  return (
    hasRunIdArtifactSuffix(name, EVIDENCE_MANIFEST_SUFFIX) ||
    hasRunIdArtifactSuffix(name, EVIDENCE_LOCK_SUFFIX)
  );
}

function isSha256Hex(value: string): boolean {
  if (value.length !== 64) return false;
  for (let i = 0; i < value.length; i += 1) {
    // `i` is always a valid index (bounded by the loop condition above), so
    // `codePointAt` always resolves to a code point here.
    const code = value.codePointAt(i) ?? -1;
    const isDigit = code >= 48 && code <= 57;
    const isLowerHex = code >= 97 && code <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

function hasSha256ArtifactSuffix(name: string, suffix: string): boolean {
  if (!name.endsWith(suffix)) return false;
  return isSha256Hex(name.slice(0, -suffix.length));
}

function hasSha256ProducerTempSuffix(name: string, suffix: string): boolean {
  if (!name.endsWith(PRODUCER_TEMP_SUFFIX)) return false;
  const withoutTmp = name.slice(0, -PRODUCER_TEMP_SUFFIX.length);
  const marker = `${suffix}.`;
  const markerIndex = withoutTmp.lastIndexOf(marker);
  if (markerIndex < 0) return false;
  const artifactId = withoutTmp.slice(0, markerIndex);
  const token = withoutTmp.slice(artifactId.length + marker.length);
  return PRODUCER_TEMP_TOKEN.test(token) && isSha256Hex(artifactId);
}

function isToolResultArtifact(name: string): boolean {
  return (
    hasSha256ArtifactSuffix(name, TOOL_RESULT_ARTIFACT_SUFFIX) ||
    hasSha256ProducerTempSuffix(name, TOOL_RESULT_ARTIFACT_SUFFIX)
  );
}

function isQiRecord(name: string): boolean {
  return (
    name === QI_RETENTION_AUDIT_FILE ||
    QI_OWNED_SUFFIXES.some((suffix) => hasRunIdArtifactSuffix(name, suffix))
  );
}

// Sealed credential material: the AES-256-GCM `*.vault` ciphertext and the `*.key` keyfile
// (the env/keychain-tier fallback). Both must stay owner-only (ADR-0046).
function isProviderCredentialVaultFile(name: string): boolean {
  return (
    name === PROVIDER_CREDENTIALS_VAULT ||
    name === PROVIDER_CREDENTIALS_KEYFILE ||
    ATLASSIAN_CREDENTIAL_ARTIFACT_SET.has(name) ||
    SECRET_VAULT_TEMP_FILE.test(name)
  );
}

function isFigmaVaultFile(name: string): boolean {
  return name === FIGMA_TOKEN_VAULT || name === FIGMA_TOKEN_KEYFILE;
}

function isEditorHotExitVaultFile(name: string): boolean {
  return (
    name === EDITOR_HOT_EXIT_VAULT ||
    name === EDITOR_HOT_EXIT_KEYFILE ||
    SECRET_VAULT_TEMP_FILE.test(name)
  );
}

function isServerLogFile(name: string): boolean {
  return name === SERVER_LOG_FILE || SERVER_LOG_ARCHIVE_FILE.test(name);
}

function dirHasSqliteFamilyArtifact(absDir: string, base: string): boolean {
  try {
    return readdirSync(absDir).some((name) => isSqliteFamily(base, name));
  } catch {
    return false;
  }
}

const NO_CHILD = (): OwnedSubtree | undefined => undefined;
const OWNS_NO_FILE = (): boolean => false;

// A Keiko-owned subtree under the state directory.
//   * `whole` subtrees are leaf areas only Keiko ever writes (the figma-snapshot side-file
//     tree, launcher atomic-save temp dirs): every descendant file/dir is owned.
//   * classified subtrees own the direct files matched by `ownsFile` and recurse into the
//     child directory returned by `childSubtree`; everything else is `retained`.
interface OwnedSubtree {
  readonly category: RuntimeStateCategory;
  readonly whole: boolean;
  readonly ownsFile: (name: string) => boolean;
  readonly childSubtree: (name: string, absPath: string) => OwnedSubtree | undefined;
}

const figmaSnapshotRunSubtree: OwnedSubtree = {
  category: "quality-intelligence",
  whole: true,
  ownsFile: OWNS_NO_FILE,
  childSubtree: NO_CHILD,
};

const figmaSnapshotsSubtree: OwnedSubtree = {
  category: "quality-intelligence",
  whole: false,
  ownsFile: OWNS_NO_FILE,
  childSubtree: (name) => (isValidRunId(name) ? figmaSnapshotRunSubtree : undefined),
};

const qiSubtree: OwnedSubtree = {
  category: "quality-intelligence",
  whole: false,
  ownsFile: isQiRecord,
  childSubtree: (name) => (name === FIGMA_SNAPSHOTS_SUBDIR ? figmaSnapshotsSubtree : undefined),
};

// `evidence/figma/` holds the sealed Figma PAT vault + keyfile (figmaTokenStore.ts).
const figmaVaultSubtree: OwnedSubtree = {
  category: "credential-vault",
  whole: false,
  ownsFile: isFigmaVaultFile,
  childSubtree: NO_CHILD,
};

const toolResultsSubtree: OwnedSubtree = {
  category: "evidence",
  whole: false,
  ownsFile: isToolResultArtifact,
  childSubtree: NO_CHILD,
};

function evidenceChildSubtree(name: string): OwnedSubtree | undefined {
  if (name === QI_SUBDIR) return qiSubtree;
  if (name === FIGMA_VAULT_SUBDIR) return figmaVaultSubtree;
  if (name === TOOL_RESULTS_SUBDIR) return toolResultsSubtree;
  return undefined;
}

const evidenceSubtree: OwnedSubtree = {
  category: "evidence",
  whole: false,
  ownsFile: isEvidenceRecord,
  childSubtree: evidenceChildSubtree,
};

// `credentials/` holds the sealed provider-credential vault + keyfile (credentialVault.ts).
const credentialsSubtree: OwnedSubtree = {
  category: "credential-vault",
  whole: false,
  ownsFile: isProviderCredentialVaultFile,
  childSubtree: NO_CHILD,
};

const uiDataSubtree: OwnedSubtree = {
  category: "ui-database",
  whole: false,
  ownsFile: (name) => name === GATEWAY_CONFIG_FILENAME || isSqliteFamily(UI_DB_FILENAME, name),
  childSubtree: (name) => (name === CREDENTIALS_SUBDIR ? credentialsSubtree : undefined),
};

const editorHotExitSubtree: OwnedSubtree = {
  category: "editor-hot-exit",
  whole: false,
  ownsFile: isEditorHotExitVaultFile,
  childSubtree: NO_CHILD,
};

const memorySubtree: OwnedSubtree = {
  category: "memory-vault",
  whole: false,
  ownsFile: (name) => isSqliteFamily(MEMORY_DB_FILENAME, name),
  childSubtree: NO_CHILD,
};

const knowledgeNamespaceSubtree: OwnedSubtree = {
  category: "local-knowledge",
  whole: false,
  ownsFile: (name) => isSqliteFamily(CAPSULES_DB_FILENAME, name),
  childSubtree: NO_CHILD,
};

// `local-knowledge/` holds one directory per namespace; each namespace directory is a
// Keiko-owned store root (`local-knowledge/<ns>/capsules.db`).
const localKnowledgeSubtree: OwnedSubtree = {
  category: "local-knowledge",
  whole: false,
  ownsFile: OWNS_NO_FILE,
  childSubtree: (_name, absPath) =>
    dirHasSqliteFamilyArtifact(absPath, CAPSULES_DB_FILENAME)
      ? knowledgeNamespaceSubtree
      : undefined,
};

const launcherTmpSubtree: OwnedSubtree = {
  category: "launcher",
  whole: true,
  ownsFile: OWNS_NO_FILE,
  childSubtree: NO_CHILD,
};

const updateSubtree: OwnedSubtree = {
  category: "update-recovery",
  whole: true,
  ownsFile: OWNS_NO_FILE,
  childSubtree: NO_CHILD,
};

// `logs/` holds only `server.log` and its day-rotated `server-<date>.log` archives
// (`createFileServerLogSink`). Classified rather than `whole`: an operator file dropped into
// `logs/`, or an unexpected nested directory, must be retained rather than claimed by
// `repair`/`uninstall` — a `whole` subtree here would let anything placed under `logs/` get
// chmod'd or removed as if Keiko had written it (#2902 PR review).
const logsSubtree: OwnedSubtree = {
  category: "activity-log",
  whole: false,
  ownsFile: isServerLogFile,
  childSubtree: NO_CHILD,
};

function topLevelFileCategory(name: string): RuntimeStateCategory | undefined {
  if (name === "ui.pid" || name === "ui.log" || name === UI_SHUTDOWN_REQUEST_FILE) {
    return "lifecycle";
  }
  if (name === "launcher-state.json" || name === "portable-install-state.json") {
    return "launcher";
  }
  if (name === GATEWAY_CONFIG_FILENAME) return "gateway-config";
  if (isSqliteFamily(UI_DB_FILENAME, name)) return "ui-database";
  return undefined;
}

// A direct name->subtree map rather than a chain of `if (name === X) return Y` — the chain was
// already at the cyclomatic-complexity ceiling before `logs/` (#2902); adding a ninth top-level
// child directory here would keep pushing straight-line lookups over that budget instead of
// growing this data table by one row.
const TOP_LEVEL_CHILD_SUBTREES: ReadonlyMap<string, OwnedSubtree> = new Map([
  [DEFAULT_UI_STATE_SUBDIR, uiDataSubtree],
  [CREDENTIALS_SUBDIR, credentialsSubtree],
  [MEMORY_SUBDIR, memorySubtree],
  [LOCAL_KNOWLEDGE_SUBDIR, localKnowledgeSubtree],
  [EVIDENCE_SUBDIR, evidenceSubtree],
  [EDITOR_HOT_EXIT_SUBDIR, editorHotExitSubtree],
  [UPDATE_SUBDIR, updateSubtree],
  [LOGS_SUBDIR, logsSubtree],
]);

function topLevelChildSubtree(name: string, absPath: string): OwnedSubtree | undefined {
  const direct = TOP_LEVEL_CHILD_SUBTREES.get(name);
  if (direct !== undefined) return direct;
  if (isMkdtempOwnedDir(absPath, name, LAUNCHER_STATE_TMP_PREFIX)) return launcherTmpSubtree;
  if (isMkdtempOwnedDir(absPath, name, PORTABLE_REGISTRATION_TMP_PREFIX)) {
    return launcherTmpSubtree;
  }
  return undefined;
}

// Node's `mkdtempSync(prefix)` appends exactly six alphanumeric characters to the prefix
// (see fs.mkdtemp implementation). Match that shape strictly so a customer-created directory
// like `.portable-registration-backup` is NOT classified as launcher-owned and therefore
// erased by `keiko uninstall --state`. The prefix-only startsWith() version was flagged in a
// PR review on top of KEIKO-0333: `whole: true` on launcherTmpSubtree means every regular
// file beneath the matched entry gets removed, so a false positive here is data loss.
//
// PR-review follow-up (Codex thread 3770922333): the six-alphanum suffix reduces accidental
// matches but a customer directory that happens to fit that shape (e.g. an operator ran
// `mkdir .portable-registration-abcdef` by mistake) is still swept. Require and validate
// the writer's ownership marker file inside the directory — .keiko-owned — before classifying
// the entry as launcher-owned. saveState (launcher-state.ts) and writeRegistration
// (portable-registration.ts) drop the marker as the first act after mkdtempSync, so a real
// Keiko staging dir always has it AND a user-created dir with the same shape does not.
const MKDTEMP_SUFFIX_PATTERN = /^[A-Za-z0-9]{6}$/u;
export const STAGING_OWNERSHIP_MARKER = ".keiko-owned";

function isMkdtempOwnedDir(absPath: string, name: string, prefix: string): boolean {
  if (!isMkdtempSuffix(name, prefix)) return false;
  return existsSync(join(absPath, STAGING_OWNERSHIP_MARKER));
}

function isMkdtempSuffix(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  const suffix = name.slice(prefix.length);
  return MKDTEMP_SUFFIX_PATTERN.test(suffix);
}

// A Keiko-owned file or directory the manifest recognizes under the state directory.
export interface RuntimeStateNode {
  readonly relPath: string; // POSIX-style path relative to the state directory
  readonly absPath: string;
  readonly category: RuntimeStateCategory;
}

// An entry the manifest does NOT remove or chmod: a customer file (`reason: "unknown"`),
// a symlink that is never followed, or an owned-looking hardlink whose chmod/unlink could
// affect another path outside `.keiko`. `owned` is true when the entry sits in a slot the
// manifest WOULD own (e.g. a `keiko-ui.db` symlink); repair flags those as an action item.
// All retained entries keep their containing directory from being removed.
export interface RetainedNode {
  readonly relPath: string;
  readonly absPath: string;
  readonly reason: "unknown" | "symlink" | "hardlink";
  readonly owned: boolean;
}

export interface RuntimeStateScan {
  readonly root: StateRootInspection;
  readonly present: boolean;
  readonly files: readonly RuntimeStateNode[]; // owned files
  readonly directories: readonly RuntimeStateNode[]; // owned directories, shallowest first
  readonly retained: readonly RetainedNode[]; // unrecognized entries + refused symlinks, any depth
}

export type StateRootStatus = "absent" | "directory" | "symlink" | "not-directory";

export interface StateRootInspection {
  readonly status: StateRootStatus;
  readonly absPath: string;
}

export function inspectStateRoot(stateDir: string): StateRootInspection {
  try {
    const stat = lstatSync(stateDir);
    if (stat.isSymbolicLink()) return { status: "symlink", absPath: stateDir };
    if (stat.isDirectory()) return { status: "directory", absPath: stateDir };
    return { status: "not-directory", absPath: stateDir };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { status: "absent", absPath: stateDir };
    throw error;
  }
}

interface ScanAccumulator {
  readonly files: RuntimeStateNode[];
  readonly directories: RuntimeStateNode[];
  readonly retained: RetainedNode[];
}

function childRelPath(relDir: string, name: string): string {
  return relDir === "" ? name : `${relDir}/${name}`;
}

// `"root"` models the state directory itself: its owned files come from
// `topLevelFileCategory` and its owned child directories from `topLevelChildSubtree`.
type ScanScope = OwnedSubtree | "root";

function ownedFileCategory(scope: ScanScope, name: string): RuntimeStateCategory | undefined {
  if (scope === "root") return topLevelFileCategory(name);
  if (scope.whole) return scope.category;
  return scope.ownsFile(name) ? scope.category : undefined;
}

function ownedChildSubtree(
  scope: ScanScope,
  name: string,
  absPath: string,
): OwnedSubtree | undefined {
  if (scope === "root") return topLevelChildSubtree(name, absPath);
  if (scope.whole) return scope; // a whole subtree owns all of its descendant directories
  return scope.childSubtree(name, absPath);
}

// #KEIKO-0301: a file that vanishes between readdirSync and lstatSync (a concurrent
// remove during the scan) is a race, not an error state — return undefined so the
// enclosing repair / uninstall walk skips it. Every other lstat failure propagates.
function lstatOrRaceSkip(absPath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(absPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function classifyFileEntry(
  relPath: string,
  absPath: string,
  name: string,
  scope: ScanScope,
  nlink: number,
  acc: ScanAccumulator,
): void {
  const category = ownedFileCategory(scope, name);
  if (category === undefined) {
    acc.retained.push({ relPath, absPath, reason: "unknown", owned: false });
  } else if (nlink > 1) {
    acc.retained.push({ relPath, absPath, reason: "hardlink", owned: true });
  } else {
    acc.files.push({ relPath, absPath, category });
  }
}

function classifyEntry(
  absDir: string,
  relDir: string,
  name: string,
  scope: ScanScope,
  acc: ScanAccumulator,
): void {
  const absPath = join(absDir, name);
  const relPath = childRelPath(relDir, name);
  const stat = lstatOrRaceSkip(absPath);
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    // Never follow a symlink in any position: chmod-through and delete-through a symlink can
    // escape `.keiko`. Flag it when it occupies a slot the manifest would otherwise own.
    const owned =
      ownedFileCategory(scope, name) !== undefined ||
      ownedChildSubtree(scope, name, absPath) !== undefined;
    acc.retained.push({ relPath, absPath, reason: "symlink", owned });
    return;
  }
  if (stat.isDirectory()) {
    const child = ownedChildSubtree(scope, name, absPath);
    if (child === undefined) {
      acc.retained.push({ relPath, absPath, reason: "unknown", owned: false });
      return;
    }
    acc.directories.push({ relPath, absPath, category: child.category });
    walkOwnedDir(absPath, relPath, child, acc);
    return;
  }
  if (stat.isFile()) {
    classifyFileEntry(relPath, absPath, name, scope, Number(stat.nlink), acc);
    return;
  }
  // Sockets, FIFOs, devices: not a Keiko artifact — retain untouched.
  acc.retained.push({ relPath, absPath, reason: "unknown", owned: false });
}

function walkOwnedDir(
  absDir: string,
  relDir: string,
  scope: ScanScope,
  acc: ScanAccumulator,
): void {
  // PR-review follow-up on KEIKO-0301: an owned subtree that vanishes between the parent's
  // successful lstatSync and this readdirSync (a concurrent uninstall/rm) yields ENOENT for
  // the whole subtree — a race, not an error state. Skip it so the surrounding repair /
  // uninstall walk stays operable; anything else (EACCES, EIO) still propagates.
  let entries: readonly string[];
  try {
    entries = readdirSync(absDir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of entries) {
    classifyEntry(absDir, relDir, name, scope, acc);
  }
}

// Classifies every entry under `stateDir` against the runtime-state manifest. Pure
// read-only traversal (lstat-based, never follows symlinks); the directories list is
// ordered shallowest-first so callers can reverse it to remove leaves before parents.
export function scanRuntimeState(stateDir: string): RuntimeStateScan {
  const root = inspectStateRoot(stateDir);
  if (root.status === "absent") {
    return { root, present: false, files: [], directories: [], retained: [] };
  }
  if (root.status !== "directory") {
    return { root, present: true, files: [], directories: [], retained: [] };
  }
  const acc: ScanAccumulator = { files: [], directories: [], retained: [] };
  walkOwnedDir(stateDir, "", "root", acc);
  return {
    root,
    present: true,
    files: acc.files,
    directories: acc.directories,
    retained: acc.retained,
  };
}

// True when `descendant` lies inside `ancestor` (used to decide whether an owned directory
// can be removed: it can only be removed when no retained entry survives beneath it).
export function isInsidePath(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(`${ancestor}${sep}`);
}
