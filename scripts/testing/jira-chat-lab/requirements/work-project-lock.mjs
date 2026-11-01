// Two lab lanes (one per model) may share one Jira and its work project. A journey that writes
// there grades the issues that are new since its turn began, so it must not see the other lane's
// writes: on 2026-11-01 Gemma's S06 counted two epics Qwen's S05 wrote at the same moment as its
// own template violations. Journeys that write the work project therefore run one at a time across
// lanes. S13 comments on the shared RPT-1 and counts the new comments there, so it is serialized as
// well. Journeys that write no shared issue (they read RPT or answer from the lane's own Pod and
// templates) stay parallel. Waiting lanes are served first come, first served: a lane that releases
// the lock and asks again for its next journey queues behind a lane already waiting (2026-11-01: the
// Gemma lane took the lock nine times in a row while the Qwen lane polled, which waited 50 minutes).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Journeys that write no shared Jira issue: they never take the lock. */
const LANE_LOCAL_JOURNEYS = new Set(["S02", "S03", "S04", "S10", "S11", "S12", "S15", "S16"]);
/** Journeys that write a shared issue outside REQ: serialized, but REQ is left as it is. */
const OUTSIDE_WORK_PROJECT = new Set(["S13"]);

const LOCK = "work-project.lock";
const OWNER = "owner.json";
const QUEUE = "work-project.queue";
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

function tryAcquire(lock, id) {
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (ownerAlive(lock)) return false;
    // A lane that died holding the lock must not block the other lane for good.
    rmSync(lock, { recursive: true, force: true });
    return tryAcquire(lock, id);
  }
  writeFileSync(join(lock, OWNER), JSON.stringify({ pid: process.pid, id }), { mode: 0o600 });
  return true;
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
  const lock = join(directory, LOCK);
  await acquire(lock, join(directory, QUEUE), id, { pollMs, log, onWait });
  try {
    if (!OUTSIDE_WORK_PROJECT.has(id)) await prepare?.();
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Polls until this lane holds the lock, keeping the waiting lane's session alive meanwhile. */
async function acquire(lock, queue, id, { pollMs, log, onWait }) {
  const ticket = enqueue(queue);
  try {
    await waitForTurn(lock, queue, ticket, id, { pollMs, log, onWait });
  } finally {
    rmSync(join(queue, ticket), { force: true });
  }
}

async function waitForTurn(lock, queue, ticket, id, { pollMs, log, onWait }) {
  let waitedMs = 0;
  while (!(servedNext(queue, ticket) && tryAcquire(lock, id))) {
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
  if (waitedMs > 0) log?.({ operation: "requirements-work-lock", id, state: "acquired", waitedMs });
}
