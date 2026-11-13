// The Windows UI process's startup progress, for the launcher that waits on it (#4358).
//
// `keiko start` gave a UI process 20 seconds to answer its health check and ended it otherwise. On
// Windows the first start after an installation or update needs far longer: Node reads thousands of
// freshly written files while the virus scanner inspects each one (63 to 239 s measured under x64
// emulation, 21 s on the second start). The process was healthy and busy, and the launcher ended
// it, every time, with nothing the person could do except pass a larger number.
//
// The window was never meant to bound how long a working start may take; it bounds how long the
// launcher waits on a process that makes no progress. This module makes that the thing it measures:
//
//   - PROGRESS comes from the main thread only, at real startup steps: every module the process
//     loads (a load hook) and every startup phase the UI command completes. A main thread that
//     hangs, in a wait or in a loop, advances nothing, and the launcher ends it one window later.
//   - Before a step that legitimately blocks the whole process for a known bound (an inbox
//     PowerShell program, bounded by keiko-security), the main thread ANNOUNCES that bound, so the
//     launcher waits that long for the next record instead of one window. There is no heartbeat.
//
// The record is one fixed-width line in `<stateDir>/ui.starting`, written through one descriptor
// opened once without following a link. It carries the launch id, a counter and the announced
// bound: no path, no account, no content. The launcher only ever uses it to wait LONGER on a live
// process; it can never make a start succeed or shorten a wait. Only the Windows launcher reads
// it and only a Windows UI process writes it: other platforms keep their start path unchanged.
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { isKeikoUiLaunchId } from "@oscharko-dev/keiko-contracts/runtime/ui-launch";
import {
  assertRegularSingleLinkFile,
  openPidFileNoFollow,
  UI_STARTUP_PROGRESS_STATE_FILE,
} from "./state-paths.js";

/** The longest bound a blocking step may announce; a larger announcement is clamped to it. */
export const UI_STARTUP_MAX_HORIZON_MS = 120_000;
/** Progress is recorded at most this often; a busy load would otherwise write per module. */
export const UI_STARTUP_PROGRESS_INTERVAL_MS = 250;
const COUNTER_WIDTH = 16;
const HORIZON_WIDTH = 7;
const RECORD_BYTES = 32 + 1 + COUNTER_WIDTH + 1 + HORIZON_WIDTH + 1;
const RECORD_PATTERN = /^([0-9a-f]{32}) (\d{16}) (\d{7})\n$/u;

export interface UiStartupSign {
  /** Changes with every record; equal tokens are the same record. */
  readonly token: string;
  /** The bound the UI process announced for its current blocking step; 0 when it named none. */
  readonly horizonMs: number;
}

export interface UiStartupProgress {
  /** A real startup step completed on the main thread. Recorded at most every 250 ms. */
  readonly advance: () => void;
  /** Announces a step that blocks the whole process for at most `horizonMs`. */
  readonly announce: (horizonMs: number) => void;
  /** Ends the reporting and removes the record. Idempotent. */
  readonly stop: () => void;
}

/**
 * Why progress could not be recorded or read. The report is optional and can only make the
 * launcher wait longer, so a failure never fails the start; it is handed to the caller, which owns
 * the Activity Log line that shows it (`process.started` in the UI process, `cli.lifecycle.health`
 * in the launcher).
 */
export type UiStartupProgressFailure = "record-unavailable" | "write-failed" | "unreadable";
export type UiStartupProgressFailureRecorder = (failure: UiStartupProgressFailure) => void;

/** Registers `onLoad` for every module the process loads; returns how to remove it again. */
export type UiStartupLoadHook = (onLoad: () => void) => () => void;

export interface UiStartupProgressOptions {
  readonly recordFailure?: UiStartupProgressFailureRecorder | undefined;
  /** Hermetic seams; production callers pass neither. */
  readonly now?: (() => number) | undefined;
  readonly registerLoadHook?: UiStartupLoadHook | undefined;
}

export function uiStartupProgressPath(stateDir: string): string {
  return join(stateDir, UI_STARTUP_PROGRESS_STATE_FILE);
}

function record(launchId: string, counter: number, horizonMs: number): Buffer {
  const horizon = Math.min(UI_STARTUP_MAX_HORIZON_MS, Math.max(0, Math.trunc(horizonMs)));
  return Buffer.from(
    `${launchId} ${String(counter).padStart(COUNTER_WIDTH, "0")} ${String(horizon).padStart(HORIZON_WIDTH, "0")}\n`,
    "ascii",
  );
}

interface LoadHooks {
  readonly registerHooks?: (hooks: {
    load: (
      url: string,
      context: unknown,
      nextLoad: (url: string, context: unknown) => unknown,
    ) => unknown;
  }) => { deregister: () => void };
}

// Node's synchronous module hooks run on the main thread for every module it loads, by `import`
// and by `require`. A runtime without them reports no load progress; the phases still do.
const nodeLoadHook: UiStartupLoadHook = (onLoad) => {
  const registerHooks = (nodeModule as LoadHooks).registerHooks;
  if (registerHooks === undefined) return (): void => undefined;
  const hooks = registerHooks({
    load: (url, context, nextLoad) => {
      onLoad();
      return nextLoad(url, context);
    },
  });
  return (): void => {
    hooks.deregister();
  };
};

const INERT: UiStartupProgress = {
  advance: (): void => undefined,
  announce: (): void => undefined,
  stop: (): void => undefined,
};

function openRecord(path: string): number {
  // A record left by an earlier launch is replaced by NAME; nothing is written through a link.
  rmSync(path, { force: true });
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const fd = openPidFileNoFollow(path, flags);
  try {
    assertRegularSingleLinkFile(fd, path);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

interface Reporting {
  readonly path: string;
  readonly fd: number;
  readonly launchId: string;
  readonly recordFailure: UiStartupProgressFailureRecorder;
  readonly now: () => number;
  readonly registerLoadHook: UiStartupLoadHook;
}

function reporting(input: Reporting): UiStartupProgress {
  const { recordFailure } = input;
  let open = true;
  let counter = 0;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  // A record that cannot be written ends the report for this start: the same as no record.
  const write = (horizonMs: number): void => {
    if (!open) return;
    counter += 1;
    lastWriteAt = input.now();
    try {
      writeSync(input.fd, record(input.launchId, counter, horizonMs), 0, RECORD_BYTES, 0);
    } catch {
      open = false;
      recordFailure("write-failed");
    }
  };
  const advance = (): void => {
    if (input.now() - lastWriteAt >= UI_STARTUP_PROGRESS_INTERVAL_MS) write(0);
  };
  write(0);
  const removeLoadHook = input.registerLoadHook(advance);
  return {
    advance,
    announce: write,
    stop: (): void => {
      open = false;
      removeLoadHook();
      closeSync(input.fd);
      rmSync(input.path, { force: true });
    },
  };
}

function openReporting(
  path: string,
  launchId: string,
  options: UiStartupProgressOptions,
  recordFailure: UiStartupProgressFailureRecorder,
): UiStartupProgress {
  const fd = openRecord(path);
  try {
    return reporting({
      path,
      fd,
      launchId,
      recordFailure,
      now: options.now ?? ((): number => performance.now()),
      registerLoadHook: options.registerLoadHook ?? nodeLoadHook,
    });
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
}

function once(progress: UiStartupProgress): UiStartupProgress {
  let stopped = false;
  return {
    advance: (): void => {
      if (!stopped) progress.advance();
    },
    announce: (horizonMs): void => {
      if (!stopped) progress.announce(horizonMs);
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      progress.stop();
    },
  };
}

/**
 * Starts recording this UI process's startup progress for the launcher that waits on `launchId`.
 * Never throws: when the record cannot be created the start proceeds without it and the launcher
 * waits one window, as it did before this report existed.
 */
export function beginUiStartupProgress(
  stateDir: string,
  launchId: string,
  options: UiStartupProgressOptions = {},
): UiStartupProgress {
  if (!isKeikoUiLaunchId(launchId)) return INERT;
  const recordFailure = options.recordFailure ?? ((): void => undefined);
  try {
    return once(openReporting(uiStartupProgressPath(stateDir), launchId, options, recordFailure));
  } catch {
    recordFailure("record-unavailable");
    return INERT;
  }
}

// No record is the ordinary case before the UI process wrote its first one. A record that cannot
// be opened without following a link, or that is not a regular single-link file, also reads as "no
// progress" (the launcher then waits one window) and is handed to the caller as unreadable.
function readRecord(
  path: string,
  recordFailure: UiStartupProgressFailureRecorder,
): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const fd = openPidFileNoFollow(path, fsConstants.O_RDONLY);
    try {
      assertRegularSingleLinkFile(fd, path);
      const buffer = Buffer.alloc(RECORD_BYTES + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytes).toString("ascii");
    } finally {
      closeSync(fd);
    }
  } catch {
    recordFailure("unreadable");
    return undefined;
  }
}

/**
 * The UI process's latest progress record for `launchId`, or `undefined` when there is none: no
 * record, a record of another launch, a link, or anything that is not exactly one record.
 */
export function readUiStartupSign(
  stateDir: string,
  launchId: string,
  recordFailure: UiStartupProgressFailureRecorder = (): void => undefined,
): UiStartupSign | undefined {
  const text = readRecord(uiStartupProgressPath(stateDir), recordFailure);
  const match = text === undefined ? null : RECORD_PATTERN.exec(text);
  if (match?.[1] !== launchId) return undefined;
  return {
    token: match[2] ?? "",
    horizonMs: Math.min(UI_STARTUP_MAX_HORIZON_MS, Number(match[3])),
  };
}
