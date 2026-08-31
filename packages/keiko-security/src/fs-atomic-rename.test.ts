import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WINDOWS_ATOMIC_RENAME_BACKOFF_MS,
  WINDOWS_ATOMIC_RENAME_RETRY_CODES,
  atomicPublishRename,
  withCwdOutsideTree,
  type AtomicPublishRenameFn,
} from "./fs-atomic-rename.js";
import type { SecurityLogEvent, SecurityLogSink } from "./log-port.js";

function eperm(message = "operation not permitted"): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EPERM" });
}

function ebusy(): NodeJS.ErrnoException {
  return Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("no such file"), { code: "ENOENT" });
}

function recordingSink(): { readonly sink: SecurityLogSink; readonly events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return {
    events,
    sink: {
      write(event: SecurityLogEvent): void {
        events.push(event);
      },
    },
  };
}

function failingThenSucceeding(failures: readonly NodeJS.ErrnoException[]): {
  readonly rename: AtomicPublishRenameFn;
  readonly calls: { readonly from: string; readonly to: string }[];
} {
  const calls: { from: string; to: string }[] = [];
  const remaining = [...failures];
  return {
    calls,
    rename: (from, to): void => {
      calls.push({ from, to });
      const next = remaining.shift();
      if (next !== undefined) throw next;
    },
  };
}

describe("WINDOWS_ATOMIC_RENAME_BACKOFF_MS", () => {
  it("is a bounded exponential series that starts with an immediate first try", () => {
    expect(WINDOWS_ATOMIC_RENAME_BACKOFF_MS[0]).toBe(0);
    expect(WINDOWS_ATOMIC_RENAME_BACKOFF_MS.length).toBeGreaterThanOrEqual(4);
    let totalMs = 0;
    for (const ms of WINDOWS_ATOMIC_RENAME_BACKOFF_MS) totalMs += ms;
    expect(totalMs).toBeLessThan(2_000);
  });
});

describe("atomicPublishRename", () => {
  it("does not retry on POSIX even when the rename reports EPERM", () => {
    const error = eperm();
    const rename = vi.fn((): void => {
      throw error;
    });
    const sleep = vi.fn();
    expect(() => {
      atomicPublishRename("/from", "/to", { platform: "darwin", rename, sleep });
    }).toThrow(error);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries EPERM on win32 and succeeds without logging a path", () => {
    const from = "/Users/secret/Keiko";
    const to = "/Users/secret/.keiko-previous-1";
    const { rename, calls } = failingThenSucceeding([eperm(), eperm()]);
    const sleep = vi.fn();
    const { sink, events } = recordingSink();
    atomicPublishRename(from, to, {
      platform: "win32",
      rename,
      sleep,
      securityLogSink: sink,
    });
    expect(calls).toEqual([
      { from, to },
      { from, to },
      { from, to },
    ]);
    expect(sleep.mock.calls).toEqual([[20], [40]]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "security",
      op: "security.fs.atomic-rename-retried",
      errorKind: "EPERM",
      extra: { attempts: 3 },
    });
    expect(JSON.stringify(events[0])).not.toContain("Users");
    expect(JSON.stringify(events[0])).not.toContain("secret");
    expect(Object.keys(events[0]?.extra ?? {})).toEqual(["attempts"]);
  });

  it("retries EBUSY on win32", () => {
    const { rename } = failingThenSucceeding([ebusy()]);
    const sleep = vi.fn();
    atomicPublishRename("from", "to", { platform: "win32", rename, sleep });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry ENOENT or EACCES on win32", () => {
    const missing = enoent();
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    const sleep = vi.fn();
    expect(() => {
      atomicPublishRename("from", "to", {
        platform: "win32",
        rename: (): void => {
          throw missing;
        },
        sleep,
      });
    }).toThrow(missing);
    expect(() => {
      atomicPublishRename("from", "to", {
        platform: "win32",
        rename: (): void => {
          throw denied;
        },
        sleep,
      });
    }).toThrow(denied);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the original error and logs exhaustion after the backoff is spent", () => {
    const error = eperm("still locked");
    const rename = vi.fn((): void => {
      throw error;
    });
    const sleep = vi.fn();
    const { sink, events } = recordingSink();
    try {
      atomicPublishRename("/tmp/from", "/tmp/to", {
        platform: "win32",
        rename,
        sleep,
        securityLogSink: sink,
      });
      expect.unreachable("rename should have exhausted");
    } catch (caught) {
      expect(caught).toBe(error);
    }
    expect(rename).toHaveBeenCalledTimes(WINDOWS_ATOMIC_RENAME_BACKOFF_MS.length);
    expect(sleep).toHaveBeenCalledTimes(WINDOWS_ATOMIC_RENAME_BACKOFF_MS.length - 1);
    expect(events).toEqual([
      expect.objectContaining({
        level: "warn",
        op: "security.fs.atomic-rename-exhausted",
        errorKind: "EPERM",
        extra: { attempts: WINDOWS_ATOMIC_RENAME_BACKOFF_MS.length },
      }),
    ]);
    expect(JSON.stringify(events[0])).not.toContain("/tmp");
  });

  it("does not log a first-try success", () => {
    const { sink, events } = recordingSink();
    atomicPublishRename("from", "to", {
      platform: "win32",
      rename: (): void => undefined,
      securityLogSink: sink,
    });
    expect(events).toEqual([]);
  });

  it("uses renameSync when no rename seam is injected", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-atomic-rename-"));
    const from = join(dir, "from.txt");
    const to = join(dir, "to.txt");
    writeFileSync(from, "ok\n");
    try {
      atomicPublishRename(from, to, { platform: "linux" });
      expect(join(dir, "to.txt")).toBe(to);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WINDOWS_ATOMIC_RENAME_RETRY_CODES", () => {
  it("names only the Windows sharing-violation class", () => {
    expect([...WINDOWS_ATOMIC_RENAME_RETRY_CODES]).toEqual(["EBUSY", "EPERM"]);
  });
});

describe("withCwdOutsideTree", () => {
  it("chdirs to the parent before running when cwd is inside the tree, then restores", () => {
    const chdir = vi.fn();
    const seen: string[] = [];
    const result = withCwdOutsideTree(
      "/Programs/Keiko",
      (): string => {
        seen.push("run");
        return "swapped";
      },
      {
        cwd: (): string => "/Programs/Keiko/app",
        chdir,
        resolvePath: (path: string): string => path,
      },
    );
    expect(result).toBe("swapped");
    expect(chdir.mock.calls).toEqual([["/Programs"], ["/Programs/Keiko/app"]]);
    expect(seen).toEqual(["run"]);
  });

  it("does not chdir when cwd is already outside the tree", () => {
    const chdir = vi.fn();
    withCwdOutsideTree("/Programs/Keiko", (): void => undefined, {
      cwd: (): string => "/tmp",
      chdir,
      resolvePath: (path: string): string => path,
    });
    expect(chdir).not.toHaveBeenCalled();
  });

  it("restores cwd when the work throws", () => {
    const chdir = vi.fn();
    expect(() => {
      withCwdOutsideTree(
        "/Programs/Keiko",
        (): void => {
          throw new Error("swap failed");
        },
        {
          cwd: (): string => "/Programs/Keiko",
          chdir,
          resolvePath: (path: string): string => path,
        },
      );
    }).toThrow("swap failed");
    expect(chdir.mock.calls).toEqual([["/Programs"], ["/Programs/Keiko"]]);
  });

  it("falls back to the parent when restoring the previous cwd fails", () => {
    const chdir = vi.fn((path: string): void => {
      if (path === "/Programs/Keiko") throw new Error("stale cwd");
    });
    withCwdOutsideTree("/Programs/Keiko", (): void => undefined, {
      cwd: (): string => "/Programs/Keiko",
      chdir,
      resolvePath: (path: string): string => path,
    });
    expect(chdir.mock.calls).toEqual([["/Programs"], ["/Programs/Keiko"], ["/Programs"]]);
  });

  it("treats a realpath-equivalent cwd as inside the tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "keiko-cwd-tree-"));
    const previous = process.cwd();
    const destinations: string[] = [];
    const realChdir = process.chdir.bind(process);
    realChdir(dir);
    const spy = vi.spyOn(process, "chdir").mockImplementation((next: string): void => {
      destinations.push(next);
      realChdir(next);
    });
    try {
      withCwdOutsideTree(dir, (): void => undefined);
      const first = destinations[0];
      expect(first).toEqual(expect.any(String));
      if (typeof first !== "string") return;
      expect(realpathSync(first)).toBe(realpathSync(dirname(dir)));
    } finally {
      spy.mockRestore();
      realChdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
