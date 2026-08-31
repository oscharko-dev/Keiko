// Shared UI-process teardown for `keiko stop`/`restart`, unhealthy `keiko start`, and
// `keiko uninstall --force`. POSIX still delivers SIGTERM cross-process. Windows does not:
// libuv maps any non-zero signal onto TerminateProcess, so the in-process drain in
// `waitForShutdown` never runs (issue #3351). The graceful channel on every platform is
// therefore a pid-bound `<stateDir>/ui.shutdown` sentinel the child already polls; POSIX
// additionally sends SIGTERM. Escalation reuses `nodeWindowsTreeKill` (ADR-0006 D5) rather
// than a second taskkill wrapper, and runs that tree kill TO COMPLETION before SIGKILL.

import type { WindowsTreeKillResult } from "@oscharko-dev/keiko-contracts";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import { loadTools } from "./lazy-modules.js";
import { clearShutdownRequest, writeShutdownRequest } from "./state-paths.js";

export type WindowsTreeKill = (pid: number, processEnv: NodeJS.ProcessEnv) => WindowsTreeKillResult;

const GRACEFUL_POLL_MS = 500;
const FORCED_POLL_MS = 100;
const FORCED_WAIT_MS = 2_000;

export interface TerminateUiProcessInput {
  readonly pid: number;
  readonly stateDir: string;
  readonly stopTimeoutMs: number;
  readonly platform: NodeJS.Platform;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: (pid: number, signal?: NodeJS.Signals | 0) => void;
  readonly killWindowsTree?: WindowsTreeKill | undefined;
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  readonly securityLogSink?: SecurityLogSink | undefined;
  readonly escalate: boolean;
  readonly onEscalate?: (() => void) | undefined;
}

export interface TerminateUiProcessResult {
  readonly confirmed: boolean;
  readonly escalated: boolean;
}

export async function pollUntilDead(
  pid: number,
  isProcessAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  budgetMs: number,
  intervalMs: number,
  confirmAfterTimeout = false,
): Promise<boolean> {
  const start = performance.now();
  while (performance.now() - start <= budgetMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return confirmAfterTimeout ? !isProcessAlive(pid) : false;
}

export async function terminateUiProcess(
  input: TerminateUiProcessInput,
): Promise<TerminateUiProcessResult> {
  const windowsChannelReady = requestGracefulStop(input);
  const skipWait = input.platform === "win32" && !windowsChannelReady && input.escalate;
  if (!skipWait && (await diedDuringGrace(input))) {
    return confirmedWithoutEscalation(input.stateDir);
  }
  if (!input.escalate) {
    return finishWithoutEscalation(input);
  }
  input.onEscalate?.();
  await escalateForcedStop(input);
  const confirmed = await pollUntilDead(
    input.pid,
    input.isProcessAlive,
    input.sleep,
    FORCED_WAIT_MS,
    FORCED_POLL_MS,
    true,
  );
  if (confirmed) clearShutdownRequest(input.stateDir);
  return { confirmed, escalated: true };
}

function diedDuringGrace(input: TerminateUiProcessInput): Promise<boolean> {
  return pollUntilDead(
    input.pid,
    input.isProcessAlive,
    input.sleep,
    input.stopTimeoutMs,
    GRACEFUL_POLL_MS,
  );
}

function confirmedWithoutEscalation(stateDir: string): TerminateUiProcessResult {
  clearShutdownRequest(stateDir);
  return { confirmed: true, escalated: false };
}

function finishWithoutEscalation(input: TerminateUiProcessInput): TerminateUiProcessResult {
  const confirmed = !input.isProcessAlive(input.pid);
  if (confirmed) clearShutdownRequest(input.stateDir);
  return { confirmed, escalated: false };
}

function requestGracefulStop(input: TerminateUiProcessInput): boolean {
  const written = tryWriteShutdownRequest(input);
  if (!written && input.platform === "win32") return false;
  if (input.platform !== "win32") signalPosixTerm(input);
  emitSecurityLogEvent(input.securityLogSink, {
    level: "info",
    category: "diagnostic",
    op: "cli.lifecycle.stop-requested",
    extra: {
      channel: input.platform === "win32" ? "shutdown-request" : "sigterm",
    },
  });
  return true;
}

function signalPosixTerm(input: TerminateUiProcessInput): void {
  try {
    input.killProcess(input.pid, "SIGTERM");
  } catch {
    // ESRCH: already gone. The poll loop confirms death; do not fail the stop.
  }
}

function tryWriteShutdownRequest(input: TerminateUiProcessInput): boolean {
  try {
    writeShutdownRequest(input.stateDir, input.pid);
    return true;
  } catch (error) {
    emitSecurityLogEvent(input.securityLogSink, {
      level: "warn",
      category: "diagnostic",
      op: "cli.lifecycle.stop-request-failed",
      errorKind: securityErrorKind(error),
    });
    return false;
  }
}

async function escalateForcedStop(input: TerminateUiProcessInput): Promise<void> {
  const windowsTreeKill =
    input.platform === "win32" ? await runWindowsTreeKill(input) : "not-attempted";
  input.killProcess(input.pid, "SIGKILL");
  emitSecurityLogEvent(input.securityLogSink, {
    level: "info",
    category: "diagnostic",
    op: "cli.lifecycle.stop-escalated",
    extra: { windowsTreeKill },
  });
}

async function runWindowsTreeKill(input: TerminateUiProcessInput): Promise<WindowsTreeKillResult> {
  try {
    const kill = await resolveWindowsTreeKill(input.killWindowsTree);
    return kill(input.pid, input.processEnv ?? process.env);
  } catch {
    return "failed";
  }
}

async function resolveWindowsTreeKill(
  injected: WindowsTreeKill | undefined,
): Promise<WindowsTreeKill> {
  if (injected !== undefined) return injected;
  const tools = await loadTools();
  return tools.nodeWindowsTreeKill;
}
