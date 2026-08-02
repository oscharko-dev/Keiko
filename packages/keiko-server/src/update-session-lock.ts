import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const DEFAULT_STALE_LOCK_MS = 10 * 60_000;
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
}

interface ResolvedFileUpdateSessionLockOptions {
  readonly staleMs: number;
  readonly now: () => number;
  readonly pidAlive: (pid: number) => boolean;
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
    if (!Number.isFinite(Date.parse(parsed.startedAt))) {
      return undefined;
    }
    return {
      sessionId: parsed.sessionId,
      targetVersion: parsed.targetVersion,
      startedAt: parsed.startedAt,
      pid: parsed.pid,
      ...(parsed.childPid === undefined ? {} : { childPid: parsed.childPid }),
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
  | { readonly status: "corrupt" }
  | { readonly status: "unreadable" };

function inspectLock(lockPath: string): LockInspection {
  if (!existsSync(lockPath)) {
    return { status: "absent" };
  }
  try {
    const record = parseRecord(readFileSync(lockPath, "utf8"));
    return record === undefined
      ? { status: "corrupt" }
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
  if (!options.pidAlive(record.pid)) {
    if (record.childPid === undefined || !options.pidAlive(record.childPid)) return true;
    const ageMs = lockAgeMs(record, options.now);
    return ageMs !== undefined && ageMs >= options.staleMs;
  }
  const ageMs = lockAgeMs(record, options.now);
  if (ageMs === undefined || ageMs < options.staleMs) return false;
  return ageMs >= options.staleMs * 2;
}

function reclaimable(
  inspection: LockInspection,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  if (inspection.status === "absent" || inspection.status === "corrupt") return true;
  if (inspection.status === "unreadable") return false;
  return reclaimableValidRecord(inspection.record, options);
}

function quarantineCorruptLock(lockPath: string, now: () => number): void {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  try {
    renameSync(lockPath, `${lockPath}.corrupt.${stamp}`);
  } catch {
    unlinkSync(lockPath);
  }
}

function removeReclaimableLock(
  lockPath: string,
  inspection: LockInspection,
  now: () => number,
): void {
  if (inspection.status === "corrupt") {
    quarantineCorruptLock(lockPath, now);
    return;
  }
  unlinkSync(lockPath);
  if (inspection.status === "valid") removeChildPid(lockPath, inspection.record.sessionId);
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
      removeReclaimableLock(lockPath, inspection, options.now);
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

function releaseFileLock(lockPath: string, sessionId: string): void {
  try {
    const record = readLock(lockPath);
    if (record?.sessionId === sessionId) {
      unlinkSync(lockPath);
      removeChildPid(lockPath, sessionId);
    }
  } catch {
    // Malformed or inaccessible locks fail closed; only the owner session may remove the lock.
  }
}

export function createFileUpdateSessionLock(
  lockPath: string,
  inputOptions: FileUpdateSessionLockOptions = {},
): UpdateSessionLock {
  const options = resolveLockOptions(inputOptions);
  return {
    isLocked: () => fileLockIsActive(lockPath, options),
    acquire: (record) => acquireFileLock(lockPath, record, options),
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
