import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
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

// KEIKO-0734: even after every tracked pid has exited, an orphaned `dev-bff.mjs` child (spawned
// via `node --watch`) can keep the BFF port bound long enough for the next `npm run dev:start`
// to collide. Report "stopped cleanly" only when the tracked ports are also released. Mirrors
// scripts/dev-start.mjs's checkPortAvailable — a bind-and-close probe on the loopback host.
const host = "127.0.0.1";
function checkPortReleased(port) {
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return Promise.resolve(true);
  }
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

export function trackedListeningPorts(state) {
  const ports = new Set();
  const collect = (value) => {
    if (typeof value !== "number") return;
    if (!Number.isInteger(value) || value <= 0 || value > 65_535) return;
    ports.add(value);
  };
  collect(state?.publicPort);
  collect(state?.bffPort);
  collect(state?.nextPort);
  return [...ports];
}

async function checkPortsReleased(ports) {
  const remaining = [];
  for (const port of ports) {
    if (!(await checkPortReleased(port))) remaining.push(port);
  }
  return remaining;
}

const DEFAULT_STOP_SEAMS = {
  killPid,
  waitForPidsToExit,
  checkPortsReleased,
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
  const boundPorts = await ops.checkPortsReleased(trackedListeningPorts(state));
  if (boundPorts.length > 0) {
    ops.error(
      `Keiko dev UI tracked processes exited, but the following port(s) are still bound: ${boundPorts.join(", ")}. An orphaned watcher child likely survived; retry with \`npm run dev:stop -- --force\`.`,
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
    const boundPorts = await ops.checkPortsReleased(trackedListeningPorts(state));
    if (boundPorts.length > 0) {
      ops.error(
        `Keiko dev UI processes exited, but the following port(s) are still bound: ${boundPorts.join(", ")}. An orphaned watcher child likely survived; retry with \`npm run dev:stop -- --force\`.`,
      );
      return 1;
    }
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
