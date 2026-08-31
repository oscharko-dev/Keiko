// Shared UI-process teardown for `keiko stop`/`restart`, unhealthy `keiko start`, and
// `keiko uninstall --force`. POSIX still delivers SIGTERM cross-process. Windows does not:
// libuv maps any non-zero signal onto TerminateProcess, so the in-process drain in
// `waitForShutdown` never runs (issue #3351). The graceful channel on every platform is
// therefore a pid-bound `<stateDir>/ui.shutdown` sentinel the child already polls; POSIX
// additionally sends SIGTERM. Escalation reuses `nodeWindowsTreeKill` (ADR-0006 D5) rather
// than a second taskkill wrapper, and runs that tree kill TO COMPLETION before SIGKILL.

import { join } from "node:path";
import type {
  WindowsTreeKillDisposition,
  WindowsTreeKillResult,
} from "@oscharko-dev/keiko-contracts";
import {
  emitSecurityLogEvent,
  securityErrorKind,
  type SecurityLogSink,
} from "@oscharko-dev/keiko-security";
import { loadTools } from "./lazy-modules.js";
import { liveProcessHasLaunchId, type LiveLaunchIdentityReaders } from "./ui-process-identity.js";
import { clearShutdownRequest, readPidRecord, writeShutdownRequest } from "./state-paths.js";

export type WindowsTreeKill = (pid: number, processEnv: NodeJS.ProcessEnv) => WindowsTreeKillResult;

const GRACEFUL_POLL_MS = 500;
const FORCED_POLL_MS = 100;
const FORCED_WAIT_MS = 2_000;
const UI_PID_FILE = "ui.pid";

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
  readonly currentPid?: number | undefined;
  readonly parentPid?: number | undefined;
  readonly launchId?: string | undefined;
  readonly verifyLaunchIdentity?: ((pid: number, launchId: string) => boolean) | undefined;
  readonly readProcessEnviron?: LiveLaunchIdentityReaders["readEnviron"];
  readonly readProcessCommandLine?: LiveLaunchIdentityReaders["readCommandLine"];
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
  if (isForbiddenTarget(input)) {
    emitStopRequestFailed(input, "refused-self-pid");
    return { confirmed: false, escalated: false };
  }
  const windowsChannelReady = requestGracefulStop(input);
  const skipWait = input.platform === "win32" && !windowsChannelReady && input.escalate;
  if (!skipWait && (await diedDuringGrace(input))) {
    return confirmedWithoutEscalation(input.stateDir);
  }
  if (!input.isProcessAlive(input.pid)) {
    return confirmedWithoutEscalation(input.stateDir);
  }
  if (!input.escalate) {
    return finishWithoutEscalation(input);
  }
  if (!targetIdentityVerified(input)) {
    emitStopRequestFailed(input, "unverified-pid");
    return { confirmed: false, escalated: false };
  }
  return forceStopAfterGrace(input);
}

function diedDuringGrace(input: TerminateUiProcessInput): Promise<boolean> {
  return pollUntilDead(
    input.pid,
    input.isProcessAlive,
    input.sleep,
    input.stopTimeoutMs,
    GRACEFUL_POLL_MS,
    true,
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
  if (input.platform === "win32") {
    emitStopRequested(input, "shutdown-request");
    return true;
  }
  return requestPosixGracefulStop(input, written);
}

function requestPosixGracefulStop(input: TerminateUiProcessInput, written: boolean): boolean {
  if (!targetIdentityVerified(input)) {
    if (written) emitStopRequested(input, "shutdown-request");
    return written;
  }
  if (!signalPosixTerm(input)) return written;
  emitStopRequested(input, "sigterm");
  return true;
}

function emitStopRequested(
  input: TerminateUiProcessInput,
  channel: "shutdown-request" | "sigterm",
): void {
  emitSecurityLogEvent(input.securityLogSink, {
    level: "info",
    category: "diagnostic",
    op: "cli.lifecycle.stop-requested",
    extra: { channel },
  });
}

function signalPosixTerm(input: TerminateUiProcessInput): boolean {
  try {
    input.killProcess(input.pid, "SIGTERM");
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return true;
    emitStopRequestFailed(input, securityErrorKind(error));
    return false;
  }
}

function tryWriteShutdownRequest(input: TerminateUiProcessInput): boolean {
  try {
    writeShutdownRequest(input.stateDir, input.pid, resolveLaunchId(input));
    return true;
  } catch (error) {
    emitStopRequestFailed(input, securityErrorKind(error));
    return false;
  }
}

async function forceStopAfterGrace(
  input: TerminateUiProcessInput,
): Promise<TerminateUiProcessResult> {
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

async function escalateForcedStop(input: TerminateUiProcessInput): Promise<void> {
  const windowsTreeKill =
    input.platform === "win32" ? await runWindowsTreeKill(input) : "not-attempted";
  if (shouldSignalAfterTreeKill(windowsTreeKill)) {
    signalForcedKill(input);
  }
  emitSecurityLogEvent(input.securityLogSink, {
    level: "info",
    category: "diagnostic",
    op: "cli.lifecycle.stop-escalated",
    extra: { windowsTreeKill },
  });
}

function shouldSignalAfterTreeKill(result: WindowsTreeKillDisposition): boolean {
  return result !== "succeeded" && result !== "refused-self-pid" && result !== "root-not-found";
}

function signalForcedKill(input: TerminateUiProcessInput): void {
  try {
    input.killProcess(input.pid, "SIGKILL");
  } catch (error) {
    if (errorCode(error) === "ESRCH") return;
    emitStopEscalationFailed(input, securityErrorKind(error));
  }
}

async function runWindowsTreeKill(
  input: TerminateUiProcessInput,
): Promise<WindowsTreeKillDisposition> {
  try {
    const kill = await resolveWindowsTreeKill(input.killWindowsTree);
    return kill(input.pid, input.processEnv ?? process.env);
  } catch (error) {
    emitStopEscalationFailed(input, securityErrorKind(error));
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

function isForbiddenTarget(input: TerminateUiProcessInput): boolean {
  const currentPid = input.currentPid ?? process.pid;
  const parentPid = input.parentPid ?? process.ppid;
  return input.pid === currentPid || input.pid === parentPid;
}

function targetIdentityVerified(input: TerminateUiProcessInput): boolean {
  const record = readPidRecord(join(input.stateDir, UI_PID_FILE));
  if (record?.pid !== input.pid) return false;
  const launchId = input.launchId ?? record.launchId;
  if (launchId === undefined) return false;
  return verifyLiveLaunchId(input, launchId);
}

function verifyLiveLaunchId(input: TerminateUiProcessInput, launchId: string): boolean {
  if (input.verifyLaunchIdentity !== undefined) {
    return input.verifyLaunchIdentity(input.pid, launchId);
  }
  return liveProcessHasLaunchId(input.pid, launchId, {
    platform: input.platform,
    ...(input.readProcessEnviron === undefined ? {} : { readEnviron: input.readProcessEnviron }),
    ...(input.readProcessCommandLine === undefined
      ? {}
      : { readCommandLine: input.readProcessCommandLine }),
  });
}

function resolveLaunchId(input: TerminateUiProcessInput): string | undefined {
  if (input.launchId !== undefined) return input.launchId;
  return readPidRecord(join(input.stateDir, UI_PID_FILE))?.launchId;
}

function emitStopRequestFailed(input: TerminateUiProcessInput, errorKind: string): void {
  emitSecurityLogEvent(input.securityLogSink, {
    level: "warn",
    category: "diagnostic",
    op: "cli.lifecycle.stop-request-failed",
    errorKind,
  });
}

function emitStopEscalationFailed(input: TerminateUiProcessInput, errorKind: string): void {
  emitSecurityLogEvent(input.securityLogSink, {
    level: "warn",
    category: "diagnostic",
    op: "cli.lifecycle.stop-escalation-failed",
    errorKind,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
