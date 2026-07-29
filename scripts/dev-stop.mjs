import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = join(stateDir, "dev-ui.pid.json");
export const DEV_STOP_GRACE_MS = 40_000;
const FORCE_STOP_GRACE_MS = 5_000;

function readState() {
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid, signal) {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Process ended between the liveness check and the signal.
  }
}

export function trackedChildPids(state) {
  if (!Array.isArray(state?.children)) return [];
  return [
    ...new Set(
      state.children.filter(
        (pid) => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
      ),
    ),
  ];
}

export async function waitForPidsToExit(pids, timeoutMs, seams = {}) {
  const alive = seams.isAlive ?? isAlive;
  const wait = seams.sleep ?? sleep;
  const deadline = Date.now() + timeoutMs;
  let remaining = pids.filter((pid) => alive(pid));
  while (remaining.length > 0 && Date.now() <= deadline) {
    await wait(250);
    remaining = remaining.filter((pid) => alive(pid));
  }
  return remaining;
}

function removePidFile() {
  rmSync(pidFile, { force: true });
}

const DEFAULT_STOP_SEAMS = {
  killPid,
  waitForPidsToExit,
  removePidFile,
  log: console.log,
  error: console.error,
};

export async function stopOrphanedChildren(childPids, force, seams = {}) {
  const ops = { ...DEFAULT_STOP_SEAMS, ...seams };
  const signal = force ? "SIGKILL" : "SIGTERM";
  for (const pid of childPids) ops.killPid(pid, signal);
  return ops.waitForPidsToExit(childPids, force ? FORCE_STOP_GRACE_MS : DEV_STOP_GRACE_MS);
}

export async function stopStaleRunner(state, force, seams = {}) {
  const ops = { ...DEFAULT_STOP_SEAMS, stopOrphanedChildren, ...seams };
  const childPids = trackedChildPids(state);
  const remaining = await ops.stopOrphanedChildren(childPids, force);
  if (remaining.length > 0) {
    ops.error(
      `Keiko dev UI has ${String(
        remaining.length,
      )} tracked process(es) still running. Retry with \`npm run dev:stop -- --force\`.`,
    );
    return 1;
  }
  ops.removePidFile();
  ops.log("Removed stale Keiko dev UI PID file after tracked processes stopped.");
  return 0;
}

export async function stopLiveRunner(state, force, seams = {}) {
  const ops = { ...DEFAULT_STOP_SEAMS, ...seams };
  const runnerPid = state.runnerPid;
  const childPids = trackedChildPids(state);
  ops.log(`Stopping Keiko dev UI (pid ${String(runnerPid)}) ...`);
  ops.killPid(runnerPid, force ? "SIGKILL" : "SIGTERM");
  if (force) {
    for (const pid of childPids) ops.killPid(pid, "SIGKILL");
  }
  const remaining = await ops.waitForPidsToExit(
    [runnerPid, ...childPids],
    force ? FORCE_STOP_GRACE_MS : DEV_STOP_GRACE_MS,
  );
  if (remaining.length === 0) {
    ops.removePidFile();
    ops.log(force ? "Keiko dev UI force-stopped." : "Keiko dev UI stopped cleanly.");
    return 0;
  }
  ops.error(
    `Keiko dev UI did not stop within ${String(
      (force ? FORCE_STOP_GRACE_MS : DEV_STOP_GRACE_MS) / 1_000,
    )}s. Retry with \`npm run dev:stop -- --force\`.`,
  );
  return 1;
}

const DEFAULT_MAIN_SEAMS = {
  readState,
  isAlive,
  stopLiveRunner,
  stopStaleRunner,
  log: console.log,
};

export async function main(argv = process.argv.slice(2), seams = {}) {
  const ops = { ...DEFAULT_MAIN_SEAMS, ...seams };
  const force = argv.includes("--force");
  const state = ops.readState();
  if (state === undefined) {
    ops.log("Keiko dev UI is not running.");
    return 0;
  }
  return ops.isAlive(state.runnerPid)
    ? ops.stopLiveRunner(state, force)
    : ops.stopStaleRunner(state, force);
}

if (process.argv[1] === scriptPath) {
  process.exitCode = await main();
}
