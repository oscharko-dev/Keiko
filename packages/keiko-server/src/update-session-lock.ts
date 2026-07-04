import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
}

export interface UpdateSessionLock {
  readonly isLocked: () => boolean;
  readonly acquire: (record: UpdateSessionLockRecord) => boolean;
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

function parseRecord(value: string): UpdateSessionLockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.sessionId !== "string" ||
      typeof parsed.targetVersion !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.pid !== "number"
    ) {
      return undefined;
    }
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    if (!Number.isFinite(Date.parse(parsed.startedAt))) {
      return undefined;
    }
    return parsed as unknown as UpdateSessionLockRecord;
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
    return record === undefined ? { status: "corrupt" } : { status: "valid", record };
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

function reclaimableValidRecord(
  record: UpdateSessionLockRecord,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  if (!options.pidAlive(record.pid)) return true;
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
}

export function createFileUpdateSessionLock(
  lockPath: string,
  inputOptions: FileUpdateSessionLockOptions = {},
): UpdateSessionLock {
  const options: ResolvedFileUpdateSessionLockOptions = {
    staleMs: inputOptions.staleMs ?? DEFAULT_STALE_LOCK_MS,
    now: inputOptions.now ?? Date.now,
    pidAlive: inputOptions.pidAlive ?? defaultPidAlive,
  };
  return {
    isLocked: (): boolean => {
      const inspection = inspectLock(lockPath);
      if (inspection.status === "absent" || inspection.status === "corrupt") return false;
      if (inspection.status === "unreadable") return true;
      return !reclaimableValidRecord(inspection.record, options);
    },
    acquire: (record): boolean => {
      try {
        writeLock(lockPath, record);
        return true;
      } catch {
        try {
          const inspection = inspectLock(lockPath);
          if (!reclaimable(inspection, options)) return false;
          removeReclaimableLock(lockPath, inspection, options.now);
          writeLock(lockPath, record);
          return true;
        } catch {
          return false;
        }
      }
    },
    release: (sessionId): void => {
      try {
        const record = readLock(lockPath);
        if (record?.sessionId === sessionId) unlinkSync(lockPath);
      } catch {
        // Malformed or inaccessible locks fail closed; only the owner session may remove the lock.
      }
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
