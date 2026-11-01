// Parallel scorecard lanes share one Jira laboratory (#4174). A lane that restarts Jira to renew
// the test license would break every other lane's running turn, so lanes register themselves and a
// restart waits until it is the only live lane and holds the restart lock.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LANES = "lanes";
const RESTART_LOCK = "license-restart.lock";
// A lock whose owner is not yet written is being taken; only an old one is abandoned.
const UNOWNED_LOCK_GRACE_MS = 60_000;

function lanesDirectory(directory) {
  const path = join(directory, LANES);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function alive(pid, isAlive) {
  try {
    return isAlive(pid);
  } catch {
    return false;
  }
}

const processAlive = (pid) => process.kill(pid, 0);

/** Registers this process as a live lane until it exits. */
export function registerLane(directory, pid = process.pid) {
  const path = join(lanesDirectory(directory), String(pid));
  writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 });
  const release = () => rmSync(path, { force: true });
  process.once("exit", release);
  return release;
}

/** Live lanes other than `pid`; files of processes that no longer exist are removed. */
export function otherLiveLanes(directory, pid = process.pid, isAlive = processAlive) {
  const path = lanesDirectory(directory);
  const others = [];
  for (const name of readdirSync(path)) {
    const lane = Number(name);
    if (!Number.isSafeInteger(lane) || lane === pid) continue;
    if (alive(lane, isAlive)) others.push(lane);
    else rmSync(join(path, name), { force: true });
  }
  return others;
}

/**
 * Runs `restart` once no other lane is live and this lane holds the restart lock. `stillNeeded` is
 * asked again under the lock, because another lane may have renewed the license meanwhile.
 */
export function withExclusiveRestart(directory, stillNeeded, restart, options = {}) {
  const settings = { pid: process.pid, isAlive: processAlive, pollMs: 30_000, log: console.log };
  Object.assign(settings, options);
  return attemptRestart({ directory, stillNeeded, restart, settings }, false);
}

/** One attempt; while other lanes run, it waits and tries again (recursion keeps awaits out of loops). */
async function attemptRestart(context, announced) {
  const { directory, stillNeeded, restart, settings } = context;
  const lock = join(directory, RESTART_LOCK);
  const others = otherLiveLanes(directory, settings.pid, settings.isAlive);
  if (others.length === 0 && acquire(lock, settings.pid, settings.isAlive))
    return restartUnderLock(lock, stillNeeded, restart);
  if (!announced)
    settings.log(JSON.stringify({ operation: "jira-lab-license-wait", otherLanes: others.length }));
  await delay(settings.pollMs);
  return attemptRestart(context, true);
}

async function restartUnderLock(lock, stillNeeded, restart) {
  try {
    return (await stillNeeded()) ? await restart() : undefined;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Takes the restart lock; a lock left by a process that no longer exists is reclaimed. */
function acquire(lock, pid, isAlive) {
  try {
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner"), String(pid), { mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (!abandoned(lock, isAlive)) return false;
    rmSync(lock, { recursive: true, force: true });
    return false;
  }
}

function abandoned(lock, isAlive) {
  const owner = lockOwner(lock);
  if (Number.isSafeInteger(owner)) return !alive(owner, isAlive);
  try {
    return Date.now() - statSync(lock).mtimeMs > UNOWNED_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

function lockOwner(lock) {
  try {
    return Number(readFileSync(join(lock, "owner"), "utf8"));
  } catch {
    return Number.NaN;
  }
}
