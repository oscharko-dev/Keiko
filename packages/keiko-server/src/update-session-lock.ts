import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "./diagnostics-log.js";
import { publishFileWithoutReplacement } from "./publish-file-without-replacement.js";
import {
  isOptionalProcessIdentity,
  processIdentityField,
  PROCESS_START_IDENTITY,
} from "./process-identity.js";

const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
// KEIKO-0812: forensic-evidence retention window for `*.corrupt.*` quarantine files. A file
// older than this is pruned from the lock's parent directory the next time acquire() runs so
// they cannot accumulate unboundedly across many upgrade sessions. Seven days matches the
// retention shape ADR-0173 D5 pinned for other operator-diagnostic artifacts.
const DEFAULT_CORRUPT_LOCK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOCK_DIR_MODE = 0o700;
const LOCK_FILE_MODE = 0o600;
const UPDATE_SESSION_LOCK_FILE = "update-session.lock";
const UPDATE_SESSION_LOCK_DIR = "updates";

export interface UpdateSessionLockRecord {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly childPid?: number | undefined;
  readonly processIdentity?: string | undefined;
}

export interface UpdateSessionLock {
  readonly isLocked: () => boolean;
  readonly acquire: (record: UpdateSessionLockRecord) => boolean;
  readonly updateChildPid: (sessionId: string, childPid: number) => boolean;
  readonly release: (sessionId: string) => void;
}

export interface FileUpdateSessionLockOptions {
  readonly staleMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly pidAlive?: ((pid: number) => boolean) | undefined;
  readonly processIdentity?: string | undefined;
  // KEIKO-0812 follow-up (#2906 round 3): optional sink for the corrupt-lock quarantine prune's
  // bounded removal/failure evidence. Absent means the prune stays silent on success exactly as
  // before (most callers, including tests, never wire this) -- see emitQuarantinePruneDiagnostic.
  readonly diagnostics?: ServerDiagnosticSink | undefined;
}

interface ResolvedFileUpdateSessionLockOptions {
  readonly staleMs: number;
  readonly now: () => number;
  readonly pidAlive: (pid: number) => boolean;
  readonly processIdentity: string;
  readonly diagnostics: ServerDiagnosticSink | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RequiredLockFields {
  readonly sessionId: string;
  readonly targetVersion: string;
  readonly startedAt: string;
}

function hasRequiredLockFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RequiredLockFields {
  return (
    typeof value.sessionId === "string" &&
    typeof value.targetVersion === "string" &&
    typeof value.startedAt === "string"
  );
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseRecord(value: string): UpdateSessionLockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !hasRequiredLockFields(parsed)) return undefined;
    if (!isPositivePid(parsed.pid)) return undefined;
    if (parsed.childPid !== undefined && !isPositivePid(parsed.childPid)) return undefined;
    if (!isOptionalProcessIdentity(parsed.processIdentity)) return undefined;
    if (!Number.isFinite(Date.parse(parsed.startedAt))) {
      return undefined;
    }
    return {
      sessionId: parsed.sessionId,
      targetVersion: parsed.targetVersion,
      startedAt: parsed.startedAt,
      pid: parsed.pid,
      ...(parsed.childPid === undefined ? {} : { childPid: parsed.childPid }),
      ...processIdentityField(parsed.processIdentity),
    };
  } catch {
    return undefined;
  }
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockAgeMs(record: UpdateSessionLockRecord, now: () => number): number | undefined {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt)) return undefined;
  return Math.max(0, now() - startedAt);
}

function readLock(lockPath: string): UpdateSessionLockRecord | undefined {
  return parseRecord(readFileSync(lockPath, "utf8"));
}

interface ChildPidRecord {
  readonly sessionId: string;
  readonly lockIdentity: string;
  readonly childPid: number;
}

function childPidPath(lockPath: string, sessionId: string): string {
  const sessionKey = createHash("sha256").update(sessionId).digest("hex");
  return `${lockPath}.${sessionKey}.child`;
}

function lockIdentity(record: UpdateSessionLockRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: record.sessionId,
        targetVersion: record.targetVersion,
        startedAt: record.startedAt,
        pid: record.pid,
        processIdentity: record.processIdentity ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

function parseChildPidRecord(
  value: string,
  record: UpdateSessionLockRecord,
): ChildPidRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      parsed.sessionId !== record.sessionId ||
      parsed.lockIdentity !== lockIdentity(record) ||
      !isPositivePid(parsed.childPid)
    ) {
      return undefined;
    }
    return {
      sessionId: record.sessionId,
      lockIdentity: lockIdentity(record),
      childPid: parsed.childPid,
    };
  } catch {
    return undefined;
  }
}

function readChildPid(lockPath: string, record: UpdateSessionLockRecord): number | undefined {
  const path = childPidPath(lockPath, record.sessionId);
  try {
    return parseChildPidRecord(readFileSync(path, "utf8"), record)?.childPid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function recordWithChildPid(
  lockPath: string,
  record: UpdateSessionLockRecord,
): UpdateSessionLockRecord {
  const childPid = readChildPid(lockPath, record);
  return childPid === undefined ? record : { ...record, childPid };
}

type LockInspection =
  | { readonly status: "absent" }
  | { readonly status: "valid"; readonly record: UpdateSessionLockRecord }
  | { readonly status: "corrupt"; readonly identity: string }
  | { readonly status: "unreadable" };

function lockContentIdentity(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function inspectLock(lockPath: string): LockInspection {
  if (!existsSync(lockPath)) {
    return { status: "absent" };
  }
  try {
    const contents = readFileSync(lockPath, "utf8");
    const record = parseRecord(contents);
    return record === undefined
      ? { status: "corrupt", identity: lockContentIdentity(contents) }
      : { status: "valid", record: recordWithChildPid(lockPath, record) };
  } catch {
    return { status: "unreadable" };
  }
}

function ensurePrivateParent(lockPath: string): void {
  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true, mode: LOCK_DIR_MODE });
  try {
    chmodSync(parent, LOCK_DIR_MODE);
  } catch {
    // POSIX modes are best-effort on non-POSIX filesystems.
  }
}

function writeLock(lockPath: string, record: UpdateSessionLockRecord): void {
  ensurePrivateParent(lockPath);
  writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: LOCK_FILE_MODE });
  try {
    chmodSync(lockPath, LOCK_FILE_MODE);
  } catch {
    // POSIX modes are best-effort on non-POSIX filesystems.
  }
}

function replaceJsonFile(path: string, value: unknown): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    flag: "wx",
    mode: LOCK_FILE_MODE,
  });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup; the original lock remains authoritative.
    }
    throw error;
  }
}

function reclaimableValidRecord(
  record: UpdateSessionLockRecord,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  const ageMs = lockAgeMs(record, options.now);
  if (ageMs === undefined || ageMs < options.staleMs) return false;
  if (record.pid === process.pid && record.processIdentity === options.processIdentity)
    return false;
  const childCanBeReclaimed = record.childPid === undefined || !options.pidAlive(record.childPid);
  if (record.pid === process.pid) return childCanBeReclaimed;
  if (options.pidAlive(record.pid)) return false;
  return childCanBeReclaimed;
}

function reclaimable(
  inspection: LockInspection,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  if (inspection.status === "absent" || inspection.status === "corrupt") return true;
  if (inspection.status === "unreadable") return false;
  return reclaimableValidRecord(inspection.record, options);
}

function corruptQuarantinePath(lockPath: string, now: () => number): string {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  return `${lockPath}.corrupt.${stamp}`;
}

function claimedInspectionMatches(claimedPath: string, inspection: LockInspection): boolean {
  if (inspection.status === "corrupt") {
    return lockContentIdentity(readFileSync(claimedPath, "utf8")) === inspection.identity;
  }
  const claimed = readLock(claimedPath);
  return (
    inspection.status === "valid" &&
    claimed !== undefined &&
    lockIdentity(claimed) === lockIdentity(inspection.record)
  );
}

function inspectionIdentity(inspection: LockInspection): string | undefined {
  if (inspection.status === "corrupt") return inspection.identity;
  if (inspection.status === "valid") return lockIdentity(inspection.record);
  return undefined;
}

function removeOwnershipClaim(claimedPath: string): void {
  try {
    unlinkSync(claimedPath);
  } catch {
    // A failed cleanup leaves a fail-closed ownership claim instead of risking a second owner.
  }
}

function claimInspectedLock(lockPath: string, inspection: LockInspection): string | undefined {
  const identity = inspectionIdentity(inspection);
  if (identity === undefined) return undefined;
  const claimedPath = `${lockPath}.claim.${identity}`;
  try {
    publishFileWithoutReplacement(lockPath, claimedPath);
  } catch {
    return undefined;
  }
  try {
    if (claimedInspectionMatches(claimedPath, inspection)) return claimedPath;
  } catch {
    // The claim stays fail-closed until the cleanup below completes.
  }
  removeOwnershipClaim(claimedPath);
  return undefined;
}

function retireClaimedLock(
  lockPath: string,
  claimedPath: string,
  inspection: LockInspection,
  now: () => number,
): boolean {
  try {
    unlinkSync(lockPath);
  } catch {
    removeOwnershipClaim(claimedPath);
    return false;
  }
  if (inspection.status === "corrupt") {
    try {
      renameSync(claimedPath, corruptQuarantinePath(lockPath, now));
    } catch {
      // Preserve the verified corrupt claim for diagnosis if quarantine publication fails.
    }
    return true;
  }
  removeOwnershipClaim(claimedPath);
  if (inspection.status === "valid") {
    try {
      removeChildPid(lockPath, inspection.record.sessionId);
    } catch {
      // The canonical owner is gone; an identity-bound child sidecar is inert.
    }
  }
  return true;
}

function claimReclaimableLock(
  lockPath: string,
  inspection: LockInspection,
  now: () => number,
): boolean {
  const claimedPath = claimInspectedLock(lockPath, inspection);
  return claimedPath !== undefined && retireClaimedLock(lockPath, claimedPath, inspection, now);
}

function removeChildPid(lockPath: string, sessionId: string): void {
  try {
    unlinkSync(childPidPath(lockPath, sessionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function resolveLockOptions(
  input: FileUpdateSessionLockOptions,
): ResolvedFileUpdateSessionLockOptions {
  return {
    staleMs: input.staleMs ?? DEFAULT_STALE_LOCK_MS,
    now: input.now ?? Date.now,
    pidAlive: input.pidAlive ?? defaultPidAlive,
    processIdentity: input.processIdentity ?? PROCESS_START_IDENTITY,
    diagnostics: input.diagnostics,
  };
}

function fileLockIsActive(
  lockPath: string,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  const inspection = inspectLock(lockPath);
  if (inspection.status === "absent" || inspection.status === "corrupt") return false;
  if (inspection.status === "unreadable") return true;
  return !reclaimableValidRecord(inspection.record, options);
}

function acquireFileLock(
  lockPath: string,
  record: UpdateSessionLockRecord,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  try {
    writeLock(lockPath, record);
  } catch {
    try {
      const inspection = inspectLock(lockPath);
      if (!reclaimable(inspection, options)) return false;
      if (!claimReclaimableLock(lockPath, inspection, options.now)) return false;
      writeLock(lockPath, record);
    } catch {
      return false;
    }
  }
  try {
    removeChildPid(lockPath, record.sessionId);
    return true;
  } catch {
    releaseFileLock(lockPath, record.sessionId);
    return false;
  }
}

function updateFileLockChildPid(lockPath: string, sessionId: string, childPid: number): boolean {
  if (!isPositivePid(childPid)) return false;
  try {
    const record = readLock(lockPath);
    if (record?.sessionId !== sessionId) return false;
    const identity = lockIdentity(record);
    replaceJsonFile(childPidPath(lockPath, sessionId), {
      sessionId,
      lockIdentity: identity,
      childPid,
    });
    const current = readLock(lockPath);
    if (current?.sessionId === sessionId && lockIdentity(current) === identity) return true;
    const sidecarPath = childPidPath(lockPath, sessionId);
    const published = parseChildPidRecord(readFileSync(sidecarPath, "utf8"), record);
    if (published?.lockIdentity === identity) unlinkSync(sidecarPath);
    return false;
  } catch {
    return false;
  }
}

function lockOwnedForRelease(
  lockPath: string,
  sessionId: string,
): UpdateSessionLockRecord | undefined {
  try {
    const current = readLock(lockPath);
    return current?.sessionId === sessionId ? current : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        removeChildPid(lockPath, sessionId);
      } catch {
        // The authoritative lock is absent; an identity-bound sidecar is inert if cleanup fails.
      }
    }
    return undefined;
  }
}

function releaseFileLock(lockPath: string, sessionId: string): void {
  const expected = lockOwnedForRelease(lockPath, sessionId);
  if (expected === undefined) return;
  const inspection: LockInspection = { status: "valid", record: expected };
  const claimedPath = claimInspectedLock(lockPath, inspection);
  if (claimedPath === undefined) return;
  try {
    unlinkSync(lockPath);
  } catch {
    removeOwnershipClaim(claimedPath);
    return;
  }
  removeOwnershipClaim(claimedPath);
  try {
    removeChildPid(lockPath, sessionId);
  } catch {
    // The canonical owner is already released; a stale identity-bound sidecar is inert.
  }
}

export interface QuarantinePruneResult {
  readonly removed: number;
  readonly failed: number;
}

// No single request owns a prune sweep (it can run opportunistically inside any acquire() call),
// so there is no per-request correlation id to thread -- UNKNOWN_CORRELATION_ID is the sanctioned
// shape-valid stand-in (see codingAppSessionRoutes.ts's identical rationale for its own aggregate
// diagnostic).
function emitQuarantinePruneDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  result: QuarantinePruneResult,
): void {
  if (diagnostics === undefined || (result.removed === 0 && result.failed === 0)) return;
  emitServerDiagnostic(diagnostics, {
    correlationId: UNKNOWN_CORRELATION_ID,
    timestamp: new Date().toISOString(),
    operation: "update-session.lock-quarantine-prune",
    source: "update-session-lock",
    errorClass:
      result.failed > 0
        ? "UpdateSessionLockQuarantinePruneDegraded"
        : "UpdateSessionLockQuarantinePruned",
    message:
      result.failed > 0
        ? "update-session-quarantine-prune-degraded"
        : "update-session-quarantine-pruned",
    occurrenceCount: result.removed,
    ...(result.failed > 0 ? { quarantinePruneFailedCount: result.failed } : {}),
  });
}

// KEIKO-0812: prunes quarantined `${lockPath}.corrupt.<iso-stamp>` files older than the
// retention window. Modeled on pruneOlderSnapshots in update-local-state-snapshot.ts. Uses the
// file's own mtime (statSync().mtimeMs) rather than the ISO stamp in its name so a clock skew
// between the original quarantine and today does not falsely evict a recent forensic file. A
// prune failure stays non-fatal -- the surrounding acquire() must not fail closed on best-effort
// housekeeping -- but is now counted rather than swallowed (#2906 round 3): a directory read
// failure counts as one failure (the sweep could not even enumerate its candidates), and each
// stat/unlink failure counts individually, so a caller-supplied diagnostics sink can see when
// forensic quarantine evidence is piling up instead of losing that signal outright. Exported so
// tests and future `keiko repair` scans can drive it directly.
export function pruneCorruptLockQuarantine(
  lockPath: string,
  now: () => number = Date.now,
  retentionMs: number = DEFAULT_CORRUPT_LOCK_RETENTION_MS,
  diagnostics?: ServerDiagnosticSink,
): QuarantinePruneResult {
  const parent = dirname(lockPath);
  if (!existsSync(parent)) return { removed: 0, failed: 0 };
  const prefix = `${basename(lockPath)}.corrupt.`;
  const cutoffMs = now() - retentionMs;
  let removed = 0;
  let failed = 0;
  let names: readonly string[];
  try {
    names = readdirSync(parent);
  } catch {
    const result: QuarantinePruneResult = { removed: 0, failed: 1 };
    emitQuarantinePruneDiagnostic(diagnostics, result);
    return result;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(parent, name);
    try {
      const stat = statSync(path);
      if (stat.mtimeMs >= cutoffMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Non-fatal: forensic evidence stays intact and the next acquire retries. Counted (not
      // silently swallowed) so emitQuarantinePruneDiagnostic can surface repeated failures.
      failed += 1;
    }
  }
  const result: QuarantinePruneResult = { removed, failed };
  emitQuarantinePruneDiagnostic(diagnostics, result);
  return result;
}

export function createFileUpdateSessionLock(
  lockPath: string,
  inputOptions: FileUpdateSessionLockOptions = {},
): UpdateSessionLock {
  const options = resolveLockOptions(inputOptions);
  return {
    isLocked: () => fileLockIsActive(lockPath, options),
    acquire: (record): boolean => {
      // KEIKO-0812: opportunistic prune runs BEFORE the acquire attempt so a long-running
      // deployment does not accumulate `.corrupt.*` files. Prune is best-effort (never throws,
      // never blocks the acquire itself) but reports through options.diagnostics when wired.
      pruneCorruptLockQuarantine(lockPath, options.now, undefined, options.diagnostics);
      return acquireFileLock(
        lockPath,
        { ...record, processIdentity: options.processIdentity },
        options,
      );
    },
    updateChildPid: (sessionId, childPid) => updateFileLockChildPid(lockPath, sessionId, childPid),
    release: (sessionId): void => {
      releaseFileLock(lockPath, sessionId);
    },
  };
}

export function updateSessionLockPath(stateDir: string): string {
  return join(stateDir, UPDATE_SESSION_LOCK_DIR, UPDATE_SESSION_LOCK_FILE);
}

export function createStateDirUpdateSessionLock(
  stateDir: string,
  inputOptions: FileUpdateSessionLockOptions = {},
): UpdateSessionLock {
  return createFileUpdateSessionLock(updateSessionLockPath(stateDir), inputOptions);
}
