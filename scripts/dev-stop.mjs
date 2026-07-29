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

async function stopOrphanedChildren(childPids, force) {
  const signal = force ? "SIGKILL" : "SIGTERM";
  for (const pid of childPids) killPid(pid, signal);
  return waitForPidsToExit(childPids, force ? FORCE_STOP_GRACE_MS : DEV_STOP_GRACE_MS);
}

async function stopStaleRunner(state, force) {
  const childPids = trackedChildPids(state);
  const remaining = await stopOrphanedChildren(childPids, force);
  if (remaining.length > 0) {
    console.error(
      `Keiko dev UI has ${String(
        remaining.length,
      )} tracked process(es) still running. Retry with \`npm run dev:stop -- --force\`.`,
    );
    return 1;
  }
  rmSync(pidFile, { force: true });
  console.log("Removed stale Keiko dev UI PID file after tracked processes stopped.");
  return 0;
}

async function stopLiveRunner(state, force) {
  const runnerPid = state.runnerPid;
  const childPids = trackedChildPids(state);
  console.log(`Stopping Keiko dev UI (pid ${String(runnerPid)}) ...`);
  killPid(runnerPid, force ? "SIGKILL" : "SIGTERM");
  if (force) {
    for (const pid of childPids) killPid(pid, "SIGKILL");
  }
  const remaining = await waitForPidsToExit(
    [runnerPid, ...childPids],
    force ? FORCE_STOP_GRACE_MS : DEV_STOP_GRACE_MS,
  );
  if (remaining.length === 0) {
    rmSync(pidFile, { force: true });
    console.log(force ? "Keiko dev UI force-stopped." : "Keiko dev UI stopped cleanly.");
    return 0;
  }
  console.error(
    `Keiko dev UI did not stop within ${String(
      (force ? FORCE_STOP_GRACE_MS : DEV_STOP_GRACE_MS) / 1_000,
    )}s. Retry with \`npm run dev:stop -- --force\`.`,
  );
  return 1;
}

export async function main(argv = process.argv.slice(2)) {
  const force = argv.includes("--force");
  const state = readState();
  if (state === undefined) {
    console.log("Keiko dev UI is not running.");
    return 0;
  }
  return isAlive(state.runnerPid) ? stopLiveRunner(state, force) : stopStaleRunner(state, force);
}

if (process.argv[1] === scriptPath) {
  process.exitCode = await main();
}
