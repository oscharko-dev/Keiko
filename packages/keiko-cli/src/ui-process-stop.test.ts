import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
import { writeExclusivePidFile } from "./state-paths.js";
import { terminateUiProcess } from "./ui-process-stop.js";

const tempRoots: string[] = [];

function makeStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-ui-stop-"));
  tempRoots.push(root);
  return root;
}

function recordingSink(): { readonly sink: SecurityLogSink; readonly events: SecurityLogEvent[] } {
  const events: SecurityLogEvent[] = [];
  return {
    events,
    sink: {
      write: (event: SecurityLogEvent): void => {
        events.push(event);
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const TEST_LAUNCH_ID = "a".repeat(32);

function writeOwnedPid(stateDir: string, pid: number): void {
  writeExclusivePidFile(join(stateDir, "ui.pid"), pid, TEST_LAUNCH_ID);
}

function verifiedIdentity(): {
  readonly launchId: string;
  readonly verifyLaunchIdentity: (pid: number, launchId: string) => boolean;
} {
  return { launchId: TEST_LAUNCH_ID, verifyLaunchIdentity: () => true };
}

function eperm(message = "operation not permitted"): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EPERM" });
}

describe("terminateUiProcess", () => {
  it("on POSIX writes the shutdown sentinel, sends SIGTERM, and does not SIGKILL when the pid dies", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 42);
    const { sink, events } = recordingSink();
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const outcome = await terminateUiProcess({
      pid: 42,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "darwin",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => false,
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      securityLogSink: sink,
      escalate: true,
      ...verifiedIdentity(),
    });
    expect(outcome).toEqual({ confirmed: true, escalated: false });
    expect(killed).toEqual([[42, "SIGTERM"]]);
    expect(existsSync(join(stateDir, "ui.shutdown"))).toBe(false);
    expect(events.map((event) => event.op)).toEqual(["cli.lifecycle.stop-requested"]);
    expect(events[0]?.extra).toEqual({ channel: "sigterm" });
  });

  it("on Windows writes the sentinel, never SIGTERMs, and clears the request after a graceful death", async () => {
    const stateDir = makeStateDir();
    const { sink, events } = recordingSink();
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    let sawSentinel = false;
    const outcome = await terminateUiProcess({
      pid: 99,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "win32",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => {
        sawSentinel = readFileSync(join(stateDir, "ui.shutdown"), "utf8") === "99\n";
        return false;
      },
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      killWindowsTree: () => "succeeded",
      securityLogSink: sink,
      escalate: true,
    });
    expect(outcome).toEqual({ confirmed: true, escalated: false });
    expect(sawSentinel).toBe(true);
    expect(killed).toEqual([]);
    expect(existsSync(join(stateDir, "ui.shutdown"))).toBe(false);
    expect(events[0]?.extra).toEqual({ channel: "shutdown-request" });
  });

  it("on Windows escalates with tree-kill and does not SIGKILL after a successful tree-kill", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 77);
    const { sink, events } = recordingSink();
    const treeEnv: NodeJS.ProcessEnv = { SystemRoot: String.raw`C:\Windows` };
    const killProcess = vi.fn();
    let alive = true;
    const killWindowsTree = vi.fn(() => {
      alive = false;
      return "succeeded" as const;
    });
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      const outcome = await terminateUiProcess({
        pid: 77,
        stateDir,
        stopTimeoutMs: 1,
        platform: "win32",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => alive,
        killProcess,
        killWindowsTree,
        processEnv: treeEnv,
        securityLogSink: sink,
        escalate: true,
        ...verifiedIdentity(),
      });
      expect(outcome.escalated).toBe(true);
      expect(outcome.confirmed).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).toHaveBeenCalledWith(77, treeEnv);
    expect(killProcess).not.toHaveBeenCalled();
    const escalated = events.find((event) => event.op === "cli.lifecycle.stop-escalated");
    expect(escalated?.extra).toEqual({ windowsTreeKill: "succeeded" });
  });

  it("on Windows does not SIGKILL when tree-kill refuses the current pid", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 77);
    const killProcess = vi.fn();
    const killWindowsTree = vi.fn(() => "refused-self-pid" as const);
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      await terminateUiProcess({
        pid: 77,
        stateDir,
        stopTimeoutMs: 1,
        platform: "win32",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => true,
        killProcess,
        killWindowsTree,
        escalate: true,
        ...verifiedIdentity(),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("on POSIX escalates to SIGKILL without calling the Windows tree-kill helper", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 12);
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const killWindowsTree = vi.fn(() => "succeeded" as const);
    let alive = true;
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      await terminateUiProcess({
        pid: 12,
        stateDir,
        stopTimeoutMs: 1,
        platform: "linux",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => {
          if (!alive) return false;
          return true;
        },
        killProcess: (pid, signal) => {
          killed.push([pid, signal]);
          if (signal === "SIGKILL") alive = false;
        },
        killWindowsTree,
        escalate: true,
        ...verifiedIdentity(),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killed).toEqual([
      [12, "SIGTERM"],
      [12, "SIGKILL"],
    ]);
    expect(killWindowsTree).not.toHaveBeenCalled();
  });

  it("confirms a dead Windows pid without tree-kill when the sentinel cannot be written", async () => {
    const stateDir = join(makeStateDir(), "missing");
    const { sink, events } = recordingSink();
    const killWindowsTree = vi.fn(() => "failed" as const);
    let escalated = false;
    const outcome = await terminateUiProcess({
      pid: 5,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "win32",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => false,
      killProcess: () => {
        /* must not run */
      },
      killWindowsTree,
      securityLogSink: sink,
      escalate: true,
      onEscalate: () => {
        escalated = true;
      },
    });
    expect(outcome).toEqual({ confirmed: true, escalated: false });
    expect(escalated).toBe(false);
    expect(killWindowsTree).not.toHaveBeenCalled();
    expect(events.some((event) => event.op === "cli.lifecycle.stop-request-failed")).toBe(true);
  });

  it("skips the graceful wait on Windows for a live owned pid when the sentinel cannot be written", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 5);
    mkdirSync(join(stateDir, "ui.shutdown"));
    const killWindowsTree = vi.fn(() => {
      return "failed" as const;
    });
    const killProcess = vi.fn();
    let alive = true;
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValue(0);
    try {
      await terminateUiProcess({
        pid: 5,
        stateDir,
        stopTimeoutMs: 10_000,
        platform: "win32",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => {
          if (killProcess.mock.calls.length > 0) alive = false;
          return alive;
        },
        killProcess,
        killWindowsTree,
        escalate: true,
        ...verifiedIdentity(),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(5, "SIGKILL");
  });

  it("refuses forced stop when the pid file does not prove ownership", async () => {
    const stateDir = makeStateDir();
    const killWindowsTree = vi.fn(() => "succeeded" as const);
    const outcome = await terminateUiProcess({
      pid: 5,
      stateDir,
      stopTimeoutMs: 1,
      platform: "win32",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => true,
      killProcess: () => {
        /* must not run */
      },
      killWindowsTree,
      escalate: true,
    });
    expect(outcome).toEqual({ confirmed: false, escalated: false });
    expect(killWindowsTree).not.toHaveBeenCalled();
  });

  it("refuses to signal the current process", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, process.pid);
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const outcome = await terminateUiProcess({
      pid: process.pid,
      stateDir,
      stopTimeoutMs: 1,
      platform: "darwin",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => true,
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      escalate: true,
    });
    expect(outcome).toEqual({ confirmed: false, escalated: false });
    expect(killed).toEqual([]);
  });

  it("does not emit stop-requested when POSIX SIGTERM fails with EPERM", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 42);
    const { sink, events } = recordingSink();
    await terminateUiProcess({
      pid: 42,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "darwin",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => false,
      killProcess: () => {
        throw eperm();
      },
      securityLogSink: sink,
      escalate: true,
      ...verifiedIdentity(),
    });
    expect(events.map((event) => event.op)).toEqual(["cli.lifecycle.stop-request-failed"]);
    expect(events[0]?.errorKind).toBe("EPERM");
  });

  it("emits stop-escalation-failed when Windows tree-kill throws and still SIGKILLs", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 77);
    const { sink, events } = recordingSink();
    const killProcess = vi.fn();
    let alive = true;
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      await terminateUiProcess({
        pid: 77,
        stateDir,
        stopTimeoutMs: 1,
        platform: "win32",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => {
          if (killProcess.mock.calls.length > 0) alive = false;
          return alive;
        },
        killProcess,
        killWindowsTree: (): never => {
          throw new Error("taskkill failed");
        },
        securityLogSink: sink,
        escalate: true,
        ...verifiedIdentity(),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(events.some((event) => event.op === "cli.lifecycle.stop-escalation-failed")).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(77, "SIGKILL");
  });

  it("on Linux refuses forced stop when launch identity cannot be proven", async () => {
    const stateDir = makeStateDir();
    writeExclusivePidFile(join(stateDir, "ui.pid"), 12, "a".repeat(32));
    const killProcess = vi.fn();
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      const outcome = await terminateUiProcess({
        pid: 12,
        stateDir,
        stopTimeoutMs: 1,
        platform: "linux",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => true,
        killProcess,
        escalate: true,
        launchId: "a".repeat(32),
        verifyLaunchIdentity: () => false,
      });
      expect(outcome).toEqual({ confirmed: false, escalated: false });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("without escalate leaves a live POSIX pid running after SIGTERM and does not SIGKILL", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 8);
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      const outcome = await terminateUiProcess({
        pid: 8,
        stateDir,
        stopTimeoutMs: 1,
        platform: "darwin",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => true,
        killProcess: (pid, signal) => {
          killed.push([pid, signal]);
        },
        escalate: false,
        ...verifiedIdentity(),
      });
      expect(outcome).toEqual({ confirmed: false, escalated: false });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killed).toEqual([[8, "SIGTERM"]]);
    expect(existsSync(join(stateDir, "ui.shutdown"))).toBe(true);
  });

  it("does not SIGTERM a recycled POSIX pid whose live identity does not match", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 12);
    const killProcess = vi.fn();
    const outcome = await terminateUiProcess({
      pid: 12,
      stateDir,
      stopTimeoutMs: 1,
      platform: "darwin",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => true,
      killProcess,
      escalate: true,
      launchId: TEST_LAUNCH_ID,
      verifyLaunchIdentity: () => false,
    });
    expect(outcome).toEqual({ confirmed: false, escalated: false });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("does not tree-kill a recycled Windows pid whose live identity does not match", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 12);
    const killProcess = vi.fn();
    const killWindowsTree = vi.fn(() => "succeeded" as const);
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      const outcome = await terminateUiProcess({
        pid: 12,
        stateDir,
        stopTimeoutMs: 1,
        platform: "win32",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => true,
        killProcess,
        killWindowsTree,
        escalate: true,
        launchId: TEST_LAUNCH_ID,
        verifyLaunchIdentity: () => false,
      });
      expect(outcome).toEqual({ confirmed: false, escalated: false });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("SIGTERMs when live environ proves the pid-file launch id without a verify mock", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 42);
    const killed: (readonly [number, NodeJS.Signals | 0 | undefined])[] = [];
    const outcome = await terminateUiProcess({
      pid: 42,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "darwin",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => false,
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      escalate: true,
      launchId: TEST_LAUNCH_ID,
      readProcessEnviron: () => `KEIKO_UI_LAUNCH_ID=${TEST_LAUNCH_ID}`,
    });
    expect(outcome).toEqual({ confirmed: true, escalated: false });
    expect(killed).toEqual([[42, "SIGTERM"]]);
  });

  it("refuses to signal the parent pid even when identity would otherwise match", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 7);
    const killProcess = vi.fn();
    const outcome = await terminateUiProcess({
      pid: 7,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "linux",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => true,
      killProcess,
      escalate: true,
      currentPid: 99,
      parentPid: 7,
      launchId: TEST_LAUNCH_ID,
      readProcessEnviron: () => `KEIKO_UI_LAUNCH_ID=${TEST_LAUNCH_ID}`,
    });
    expect(outcome).toEqual({ confirmed: false, escalated: false });
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("does not SIGKILL when Windows tree-kill reports root-not-found", async () => {
    const stateDir = makeStateDir();
    writeOwnedPid(stateDir, 12);
    const killProcess = vi.fn();
    const killWindowsTree = vi.fn(() => "root-not-found" as const);
    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(1_001);
    try {
      await terminateUiProcess({
        pid: 12,
        stateDir,
        stopTimeoutMs: 1,
        platform: "win32",
        sleep: () => Promise.resolve(),
        isProcessAlive: () => true,
        killProcess,
        killWindowsTree,
        escalate: true,
        ...verifiedIdentity(),
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(killProcess).not.toHaveBeenCalled();
  });
});
