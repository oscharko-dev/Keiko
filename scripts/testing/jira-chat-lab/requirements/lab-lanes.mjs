// Parallel scorecard lanes share one Jira laboratory (#4174). A lane that restarts Jira to renew
// the test license would break every other lane's running turn, so each lane records whether it is
// using Jira ("active") or only waiting for a usable license ("waiting"). A restart waits until no
// other lane is active and it holds the restart lock; becoming active takes the same lock, so a lane
// can never start using Jira while another one restarts it. Waiting lanes never block each other:
// the first to take the lock renews, the others find the license renewed under the lock.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LANES = "lanes";
const RESTART_LOCK = "license-restart.lock";
const WAITING = "waiting";
const ACTIVE = "active";
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

function defaults(options) {
  const settings = { pid: process.pid, isAlive: processAlive, pollMs: 30_000, log: console.log };
  Object.assign(settings, options);
  return settings;
}

function writeState(directory, pid, state) {
  writeFileSync(join(lanesDirectory(directory), String(pid)), `${state}\n`, { mode: 0o600 });
}

/** Registers this process as a lane that does not use Jira yet, until it exits. */
export function registerLane(directory, pid = process.pid) {
  writeState(directory, pid, WAITING);
  const release = () => rmSync(join(lanesDirectory(directory), String(pid)), { force: true });
  process.once("exit", release);
  return release;
}

/** Only a lane that says it is waiting is waiting; anything else may be mid-turn on Jira. */
function laneWaiting(path) {
  try {
    return readFileSync(path, "utf8").trim() === WAITING;
  } catch {
    return false;
  }
}

/** Live lanes other than `pid` that use Jira; files of processes that no longer exist are removed. */
export function otherActiveLanes(directory, pid = process.pid, isAlive = processAlive) {
  const path = lanesDirectory(directory);
  const others = [];
  for (const name of readdirSync(path)) {
    const lane = Number(name);
    if (!Number.isSafeInteger(lane) || lane === pid) continue;
    if (!alive(lane, isAlive)) rmSync(join(path, name), { force: true });
    else if (!laneWaiting(join(path, name))) others.push(lane);
  }
  return others;
}

/**
 * Marks this lane as using Jira. It takes the restart lock for that moment, so it waits while
 * another lane restarts Jira and no restart can begin after it has checked the license.
 */
export function enterActive(directory, options = {}) {
  const settings = defaults(options);
  return untilLocked(join(directory, RESTART_LOCK), settings, () => {
    writeState(directory, settings.pid, ACTIVE);
  });
}

/**
 * Runs `restart` once no other lane is active and this lane holds the restart lock. This lane
 * counts as waiting meanwhile. `stillNeeded` is asked again under the lock and on every wait,
 * because another lane may have renewed the license in the meantime; then nothing is restarted.
 */
export function withExclusiveRestart(directory, stillNeeded, restart, options = {}) {
  const settings = defaults(options);
  writeState(directory, settings.pid, WAITING);
  return attemptRestart({ directory, stillNeeded, restart, settings }, false);
}

/** One attempt; while other lanes run, it waits and tries again (recursion keeps awaits out of loops). */
async function attemptRestart(context, announced) {
  const { directory, stillNeeded, restart, settings } = context;
  const lock = join(directory, RESTART_LOCK);
  const others = otherActiveLanes(directory, settings.pid, settings.isAlive);
  if (others.length === 0 && acquire(lock, settings.pid, settings.isAlive))
    return releasing(lock, async () => ((await stillNeeded()) ? restart() : undefined));
  // Another lane may already have renewed the license and gone on using Jira.
  if (!(await stillNeeded())) return undefined;
  if (!announced)
    settings.log(JSON.stringify({ operation: "jira-lab-license-wait", otherLanes: others.length }));
  await delay(settings.pollMs);
  return attemptRestart(context, true);
}

async function releasing(lock, action) {
  try {
    return await action();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function untilLocked(lock, settings, action) {
  if (acquire(lock, settings.pid, settings.isAlive)) return releasing(lock, action);
  await delay(settings.pollMs);
  return untilLocked(lock, settings, action);
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
