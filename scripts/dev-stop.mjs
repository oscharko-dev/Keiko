import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = join(stateDir, "dev-ui.pid.json");
const force = process.argv.includes("--force");

function readState() {
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid)) return false;
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

const state = readState();
if (state === undefined) {
  console.log("Keiko dev UI is not running.");
  process.exit(0);
}

const runnerPid = state.runnerPid;
const childPids = Array.isArray(state.children)
  ? state.children.filter((pid) => typeof pid === "number" && Number.isInteger(pid))
  : [];

if (!isAlive(runnerPid)) {
  for (const pid of childPids) killPid(pid, force ? "SIGKILL" : "SIGTERM");
  rmSync(pidFile, { force: true });
  console.log("Removed stale Keiko dev UI PID file.");
  process.exit(0);
}

console.log(`Stopping Keiko dev UI (pid ${String(runnerPid)}) ...`);
killPid(runnerPid, "SIGTERM");

for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  if (!isAlive(runnerPid)) {
    rmSync(pidFile, { force: true });
    console.log("Keiko dev UI stopped.");
    process.exit(0);
  }
}

if (force) {
  killPid(runnerPid, "SIGKILL");
  for (const pid of childPids) killPid(pid, "SIGKILL");
  rmSync(pidFile, { force: true });
  console.log("Keiko dev UI force-stopped.");
  process.exit(0);
}

console.error("Keiko dev UI did not stop within 30s. Retry with `npm run dev:stop -- --force`.");
process.exit(1);
