// Two lab lanes (one per model) may share one Jira and its work project. A journey that writes
// there grades the issues that are new since its turn began, so it must not see the other lane's
// writes: on 2026-11-01 Gemma's S06 counted two epics Qwen's S05 wrote at the same moment as its
// own template violations. Journeys that write the work project therefore run one at a time across
// lanes. S13 comments on the shared RPT-1 and counts the new comments there, so it is serialized as
// well. Journeys that write no shared issue (they read RPT or answer from the lane's own Pod and
// templates) stay parallel. Waiting lanes are served first come, first served: a lane that releases
// the lock and asks again for its next journey queues behind a lane already waiting (2026-11-01: the
// Gemma lane took the lock nine times in a row while the Qwen lane polled, which waited 50 minutes).
//
// Exclusive ownership is decided by one atomic step, never by "observe the holder dead, then remove
// its lock": two lanes that both observed the same dead holder could otherwise each remove what the
// other had just acquired, so a lane woken late deleted the live lane's lock and (through the reset)
// its issues. The lock is a numbered generation, `work-project.lock.<n>`, published by renaming a
// fully written staging directory onto the name (a rename onto a non-empty directory fails, so
// exactly one lane wins a generation). A holder is never removed: a lane takes over by publishing
// the NEXT generation, which a lane working from an outdated observation can never win, and a
// holder releases by leaving a marker. Generations below the newest are dropped afterwards, and a
// publication that finds a newer generation (it re-created a dropped one) withdraws itself.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Journeys that write no shared Jira issue: they never take the lock. */
const LANE_LOCAL_JOURNEYS = new Set(["S02", "S03", "S04", "S10", "S11", "S12"]);
/** Journeys that write a shared issue outside REQ: serialized, but REQ is left as it is. */
const OUTSIDE_WORK_PROJECT = new Set(["S13"]);

const LOCK = "work-project.lock";
const OWNER = "owner.json";
const RELEASED = "released";
const QUEUE = "work-project.queue";
const GENERATION = /^work-project\.lock\.(\d{12})$/;
let ticketSequence = 0;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function ownerAlive(lock) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(lock, OWNER), "utf8"));
  } catch {
    // Between mkdir and the owner write the holder is alive by construction.
    return true;
  }
  return Number.isInteger(owner?.pid) && processAlive(owner.pid);
}

function released(lock) {
  try {
    readFileSync(join(lock, RELEASED));
    return true;
  } catch {
    return false;
  }
}

/** The generations on disk, oldest first. */
function generations(directory) {
  return readdirSync(directory)
    .map((name) => GENERATION.exec(name)?.[1])
    .filter((digits) => digits !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

function generationPath(directory, generation) {
  return join(directory, `${LOCK}.${String(generation).padStart(12, "0")}`);
}

/** The lock a lane still holds: the newest generation, or the unnumbered lock of an older runner. */
function heldBy(directory) {
  const legacy = join(directory, LOCK);
  const newest = generations(directory).at(-1);
  if (newest !== undefined) {
    const lock = generationPath(directory, newest);
    if (!released(lock) && ownerAlive(lock)) return lock;
  }
  try {
    readdirSync(legacy);
  } catch {
    return undefined;
  }
  return ownerAlive(legacy) ? legacy : undefined;
}

/** True while a lane that is still running holds the work project lock in `directory`. */
export function workProjectLockHeld(directory) {
  return heldBy(directory) !== undefined;
}

/** A ticket name sorts by arrival: zero-padded time, then the process and its own sequence. */
function enqueue(queue) {
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  ticketSequence += 1;
  const time = String(Date.now()).padStart(15, "0");
  const ticket = `${time}-${String(process.pid).padStart(10, "0")}-${String(ticketSequence).padStart(9, "0")}`;
  writeFileSync(join(queue, ticket), "", { mode: 0o600 });
  return ticket;
}

/** True when no live lane queued before `ticket`; tickets of lanes that died are dropped. */
function servedNext(queue, ticket) {
  for (const name of readdirSync(queue).sort()) {
    if (name === ticket) return true;
    const pid = Number(name.split("-")[1]);
    if (processAlive(pid)) return false;
    rmSync(join(queue, name), { force: true });
  }
  return false;
}

/** Publishes generation `generation` with its owner already written, or reports it taken. */
function publish(directory, generation, id) {
  const staging = join(
    directory,
    `.${LOCK}.staging-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(staging, { mode: 0o700 });
  writeFileSync(join(staging, OWNER), JSON.stringify({ pid: process.pid, id }), { mode: 0o600 });
  try {
    renameSync(staging, generationPath(directory, generation));
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
    throw error;
  }
}

/** Takes the lock when nobody alive holds it; never removes a holder, so it cannot unseat a live one. */
function tryAcquire(directory, id) {
  if (heldBy(directory) !== undefined) return false;
  const newest = generations(directory).at(-1) ?? 0;
  const generation = newest + 1;
  if (!publish(directory, generation, id)) return false;
  if (generations(directory).at(-1) !== generation) {
    // A dropped older generation was re-created from an outdated observation: not the newest, not held.
    rmSync(generationPath(directory, generation), { recursive: true, force: true });
    return false;
  }
  for (const older of generations(directory)) {
    if (older < generation)
      rmSync(generationPath(directory, older), { recursive: true, force: true });
  }
  return generation;
}

function release(directory, generation) {
  writeFileSync(join(generationPath(directory, generation), RELEASED), "", { mode: 0o600 });
}

/**
 * Runs `run` alone among the lanes sharing `directory` unless the journey writes no shared issue.
 *
 * `prepare` runs once the lock is held, before `run`, and only for a journey that writes the work
 * project: the runner empties REQ there, so every creation journey starts from the seeded state.
 *
 * `onWait` runs after every poll while the lock is held elsewhere. A lane waits as long as the other
 * lane's journey takes, and its paired app session expires after 30 idle minutes: on 2026-11-01 the
 * Qwen lane waited 30.4 minutes, then every journey failed its first request with 404. The journey
 * runner passes an authenticated read that keeps the session alive; a failed keep-alive is logged
 * and the wait goes on, so the journey itself reports any session it then finds gone.
 */
export async function withWorkProjectLock(
  directory,
  id,
  run,
  { pollMs = 5_000, log, onWait, prepare } = {},
) {
  if (LANE_LOCAL_JOURNEYS.has(id)) return run();
  const generation = await acquire(directory, id, { pollMs, log, onWait });
  try {
    if (!OUTSIDE_WORK_PROJECT.has(id)) await prepare?.();
    return await run();
  } finally {
    release(directory, generation);
  }
}

/** Polls until this lane holds the lock, keeping the waiting lane's session alive meanwhile. */
async function acquire(directory, id, { pollMs, log, onWait }) {
  const queue = join(directory, QUEUE);
  const ticket = enqueue(queue);
  try {
    return await waitForTurn(directory, queue, ticket, id, { pollMs, log, onWait });
  } finally {
    rmSync(join(queue, ticket), { force: true });
  }
}

async function waitForTurn(directory, queue, ticket, id, { pollMs, log, onWait }) {
  let waitedMs = 0;
  for (;;) {
    const generation = servedNext(queue, ticket) ? tryAcquire(directory, id) : false;
    if (generation) {
      if (waitedMs > 0) {
        log?.({ operation: "requirements-work-lock", id, state: "acquired", waitedMs });
      }
      return generation;
    }
    if (waitedMs === 0) log?.({ operation: "requirements-work-lock", id, state: "waiting" });
    await delay(pollMs); // NOSONAR typescript:S9382 -- polling another process's lock is sequential by nature
    waitedMs += pollMs;
    await Promise.resolve(onWait?.()).catch((error) => {
      log?.({
        operation: "requirements-work-lock",
        id,
        state: "keepalive-failed",
        error: String(error?.message),
      });
    });
  }
}
