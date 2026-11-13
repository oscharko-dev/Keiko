// The UI process's startup sign of life (#4358).
//
// `keiko start` gave a UI process 20 seconds to answer its health check and ended it otherwise. On
// Windows the first start after an installation or update needs far longer: Node reads thousands of
// freshly written files while the virus scanner inspects each one (63 to 239 s measured under x64
// emulation, 21 s on the second start). The process was healthy and busy, and the launcher ended
// it, every time, with nothing the person could do except pass a larger number.
//
// The window was never meant to bound how long a working start may take; it bounds how long the
// launcher waits on a process that shows no life. This module makes that the thing it measures:
// the UI process records that it is working, and the launcher's window restarts with every new
// record. A process that stops working (a hang) is still ended one window after its last record,
// and a process that exits is noticed at once, exactly as before.
//
//   - A WORKER THREAD writes a record whenever the process consumed CPU time since the last one.
//     It runs while the main thread is busy loading code, which is when a timer on the main thread
//     cannot fire.
//   - Before a step that legitimately blocks the whole process for a known bound (an inbox
//     PowerShell program, bounded by keiko-security), the main thread writes a record that names
//     that bound, so the launcher waits that long for the next record instead of one window.
//
// The record is one fixed-width line in `<stateDir>/ui.starting`, written through one descriptor
// opened once without following a link. It carries the launch id, an opaque change counter and the
// announced bound: no path, no account, no content. The launcher only ever uses it to wait LONGER
// on a live process; it can never make a start succeed or shorten a wait.
import { closeSync, constants as fsConstants, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { isKeikoUiLaunchId } from "@oscharko-dev/keiko-contracts/runtime/ui-launch";
import {
  assertRegularSingleLinkFile,
  openPidFileNoFollow,
  UI_STARTUP_PROGRESS_STATE_FILE,
} from "./state-paths.js";

/** The longest bound a blocking step may announce; a larger announcement is clamped to it. */
export const UI_STARTUP_MAX_HORIZON_MS = 120_000;
const SAMPLE_INTERVAL_MS = 1_000;
// CPU time the process must have consumed between two samples to count as working: 5 % of one
// core. The sampling worker itself needs a small fraction of that.
const MIN_CPU_MICROS_PER_SAMPLE = 50_000;
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
  /** Announces a step that blocks the whole process for at most `horizonMs`. */
  readonly announce: (horizonMs: number) => void;
  /** Ends the reporting and removes the record. Idempotent. */
  readonly stop: () => void;
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

// The worker shares nothing with the main thread except the open descriptor and the launch id. Its
// records carry a wall-clock counter so they differ from the main thread's without coordination.
const WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const total = () => { const usage = process.cpuUsage(); return usage.user + usage.system; };
let last = total();
setInterval(() => {
  const now = total();
  if (now - last < workerData.minCpuMicros) return;
  last = now;
  const line = workerData.launchId + " " + String(Date.now()).padStart(${String(COUNTER_WIDTH)}, "0") + " " + "0".repeat(${String(HORIZON_WIDTH)}) + "\\n";
  try { writeSync(workerData.fd, Buffer.from(line, "ascii"), 0, ${String(RECORD_BYTES)}, 0); } catch {}
}, workerData.intervalMs);
`;

const INERT: UiStartupProgress = { announce: (): void => undefined, stop: (): void => undefined };

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

function startWorker(fd: number, launchId: string): Worker {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      fd,
      launchId,
      intervalMs: SAMPLE_INTERVAL_MS,
      minCpuMicros: MIN_CPU_MICROS_PER_SAMPLE,
    },
  });
  worker.unref();
  // A failing worker only ends the reporting; the start itself is unaffected.
  worker.on("error", () => undefined);
  return worker;
}

function reporting(path: string, fd: number, launchId: string, worker: Worker): UiStartupProgress {
  let open = true;
  // Reporting is best effort: a record that cannot be written is the same as no record, and the
  // launcher's `cli.lifecycle.health` line shows it as a start without signs of life.
  const write = (horizonMs: number): void => {
    if (!open) return;
    try {
      writeSync(fd, record(launchId, Date.now(), horizonMs), 0, RECORD_BYTES, 0);
    } catch {
      open = false;
    }
  };
  write(0);
  return {
    announce: write,
    stop: (): void => {
      open = false;
      void worker.terminate();
      closeSync(fd);
      rmSync(path, { force: true });
    },
  };
}

/**
 * Starts reporting that this UI process is working, for the launcher that waits on `launchId`.
 * Never throws: when the record or its worker cannot be created the start proceeds without them
 * and the launcher waits one window, as it did before this report existed.
 */
export function beginUiStartupProgress(stateDir: string, launchId: string): UiStartupProgress {
  if (!isKeikoUiLaunchId(launchId)) return INERT;
  const path = uiStartupProgressPath(stateDir);
  try {
    return once(openReporting(path, launchId));
  } catch {
    return INERT;
  }
}

function openReporting(path: string, launchId: string): UiStartupProgress {
  const fd = openRecord(path);
  try {
    return reporting(path, fd, launchId, startWorker(fd, launchId));
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
}

function once(progress: UiStartupProgress): UiStartupProgress {
  let stopped = false;
  return {
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

// No record, a record that cannot be opened without following a link, and a record that is not a
// regular single-link file all read as "no sign of life": the launcher then waits one window.
function readRecord(path: string): string | undefined {
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
    return undefined;
  }
}

/**
 * The UI process's latest sign of life for `launchId`, or `undefined` when there is none: no
 * record, a record of another launch, a link, or anything that is not exactly one record.
 */
export function readUiStartupSign(stateDir: string, launchId: string): UiStartupSign | undefined {
  const text = readRecord(uiStartupProgressPath(stateDir));
  const match = text === undefined ? null : RECORD_PATTERN.exec(text);
  if (match?.[1] !== launchId) return undefined;
  return {
    token: match[2] ?? "",
    horizonMs: Math.min(UI_STARTUP_MAX_HORIZON_MS, Number(match[3])),
  };
}
