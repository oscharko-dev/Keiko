import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import { UNKNOWN_CORRELATION_ID } from "./correlation.js";
import {
  createFileUpdateSessionLock,
  type UpdateSessionLockRecord,
} from "./update-session-lock.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function recordingSink(): { readonly sink: SecurityLogSink; readonly events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return {
    events,
    sink: {
      write: (event): void => {
        events.push(event);
      },
    },
  };
}

function eperm(): NodeJS.ErrnoException {
  return Object.assign(new Error("operation not permitted"), { code: "EPERM" });
}

function lockRecord(sessionId: string): UpdateSessionLockRecord {
  return {
    sessionId,
    targetVersion: "0.2.12",
    startedAt: "2026-06-30T00:00:00.000Z",
    pid: 1234,
  };
}

describe("update-session-lock atomic rename sink", () => {
  it("logs a retry-success when publishing a child-pid sidecar on win32", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lock-rename-retry-")));
    roots.push(dir);
    const lockPath = join(dir, "update.lock");
    const { sink, events } = recordingSink();
    let locked = true;
    const lock = createFileUpdateSessionLock(lockPath, {
      platform: "win32",
      sleep: (ms): void => {
        if (ms >= 20) locked = false;
      },
      securityLogSink: sink,
      rename: (from, to): void => {
        if (locked) throw eperm();
        renameSync(from, to);
      },
    });
    expect(lock.acquire(lockRecord("session-retry"))).toBe(true);
    expect(lock.updateChildPid("session-retry", 43_210)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "security.fs.atomic-rename-retried",
        correlationId: "session-retry",
        extra: { attempts: 2 },
      }),
    );
  });

  it("still emits a terminal rename failure when corrupt-lock quarantine swallows the throw", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "keiko-lock-rename-fail-")));
    roots.push(dir);
    const lockPath = join(dir, "update.lock");
    writeFileSync(lockPath, "not-json\n", { mode: 0o600 });
    const { sink, events } = recordingSink();
    const lock = createFileUpdateSessionLock(lockPath, {
      platform: "win32",
      sleep: (): void => undefined,
      securityLogSink: sink,
      rename: (): void => {
        throw eperm();
      },
    });
    expect(lock.acquire(lockRecord("session-corrupt"))).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "security.fs.atomic-rename-failed",
        correlationId: UNKNOWN_CORRELATION_ID,
        extra: { attempts: 3 },
      }),
    );
  });
});
