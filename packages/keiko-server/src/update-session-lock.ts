import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_STALE_LOCK_MS = 10 * 60_000;

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

function writeLock(lockPath: string, record: UpdateSessionLockRecord): void {
  writeFileSync(lockPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
}

function reclaimable(
  record: UpdateSessionLockRecord | undefined,
  options: ResolvedFileUpdateSessionLockOptions,
): boolean {
  if (record === undefined) return false;
  const ageMs = lockAgeMs(record, options.now);
  if (ageMs === undefined || ageMs < options.staleMs) return false;
  return !options.pidAlive(record.pid) || ageMs >= options.staleMs * 2;
}

export function createFileUpdateSessionLock(
  lockPath = join(tmpdir(), "keiko-update-session.lock"),
  inputOptions: FileUpdateSessionLockOptions = {},
): UpdateSessionLock {
  const options: ResolvedFileUpdateSessionLockOptions = {
    staleMs: inputOptions.staleMs ?? DEFAULT_STALE_LOCK_MS,
    now: inputOptions.now ?? Date.now,
    pidAlive: inputOptions.pidAlive ?? defaultPidAlive,
  };
  return {
    isLocked: (): boolean => existsSync(lockPath),
    acquire: (record): boolean => {
      try {
        writeLock(lockPath, record);
        return true;
      } catch {
        try {
          if (!reclaimable(readLock(lockPath), options)) return false;
          unlinkSync(lockPath);
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
