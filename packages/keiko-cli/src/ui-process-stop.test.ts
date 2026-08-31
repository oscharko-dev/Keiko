import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent, SecurityLogSink } from "@oscharko-dev/keiko-security";
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

describe("terminateUiProcess", () => {
  it("on POSIX writes the shutdown sentinel, sends SIGTERM, and does not SIGKILL when the pid dies", async () => {
    const stateDir = makeStateDir();
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

  it("on Windows escalates with tree-kill before SIGKILL and never sends SIGTERM", async () => {
    const stateDir = makeStateDir();
    const { sink, events } = recordingSink();
    const treeEnv: NodeJS.ProcessEnv = { SystemRoot: String.raw`C:\Windows` };
    const killProcess = vi.fn();
    const killWindowsTree = vi.fn(() => {
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
        isProcessAlive: () => killProcess.mock.calls.length === 0,
        killProcess,
        killWindowsTree,
        processEnv: treeEnv,
        securityLogSink: sink,
        escalate: true,
      });
      expect(outcome.escalated).toBe(true);
      expect(outcome.confirmed).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
    expect(killWindowsTree).toHaveBeenCalledWith(77, treeEnv);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledWith(77, "SIGKILL");
    const treeOrder = killWindowsTree.mock.invocationCallOrder[0];
    const killOrder = killProcess.mock.invocationCallOrder[0];
    expect(treeOrder).toBeDefined();
    expect(killOrder).toBeDefined();
    expect(treeOrder ?? 0).toBeLessThan(killOrder ?? 0);
    const escalated = events.find((event) => event.op === "cli.lifecycle.stop-escalated");
    expect(escalated?.extra).toEqual({ windowsTreeKill: "succeeded" });
  });

  it("on POSIX escalates to SIGKILL without calling the Windows tree-kill helper", async () => {
    const stateDir = makeStateDir();
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

  it("skips the graceful wait on Windows when the sentinel cannot be written and escalate is on", async () => {
    const stateDir = join(makeStateDir(), "missing");
    const { sink, events } = recordingSink();
    const killWindowsTree = vi.fn(() => "failed" as const);
    let escalated = false;
    await terminateUiProcess({
      pid: 5,
      stateDir,
      stopTimeoutMs: 10_000,
      platform: "win32",
      sleep: () => Promise.resolve(),
      isProcessAlive: () => false,
      killProcess: () => {
        /* SIGKILL after tree kill */
      },
      killWindowsTree,
      securityLogSink: sink,
      escalate: true,
      onEscalate: () => {
        escalated = true;
      },
    });
    expect(escalated).toBe(true);
    expect(killWindowsTree).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.op === "cli.lifecycle.stop-request-failed")).toBe(true);
  });

  it("without escalate leaves a live POSIX pid running after SIGTERM and does not SIGKILL", async () => {
    const stateDir = makeStateDir();
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
      });
      expect(outcome).toEqual({ confirmed: false, escalated: false });
    } finally {
      nowSpy.mockRestore();
    }
    expect(killed).toEqual([[8, "SIGTERM"]]);
    expect(existsSync(join(stateDir, "ui.shutdown"))).toBe(true);
  });
});
