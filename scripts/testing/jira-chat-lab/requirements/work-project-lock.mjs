// Two lab lanes (one per model) may share one Jira and its work project. A journey that writes
// there grades the issues that are new since its turn began, so it must not see the other lane's
// writes: on 2026-11-01 Gemma's S06 counted two epics Qwen's S05 wrote at the same moment as its
// own template violations. Journeys that write the work project therefore run one at a time across
// lanes; the report journeys read their own seeded project and stay parallel.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Journeys that only read the seeded report project (S13 comments there, never in REQ). */
const REPORT_PROJECT_JOURNEYS = new Set(["S10", "S11", "S12", "S13"]);

const LOCK = "work-project.lock";
const OWNER = "owner.json";

function ownerAlive(lock) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(join(lock, OWNER), "utf8"));
  } catch {
    // Between mkdir and the owner write the holder is alive by construction.
    return true;
  }
  if (!Number.isInteger(owner?.pid)) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
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
 * Runs `run` alone among the lanes sharing `directory` unless the journey reads only RPT.
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
  { pollMs = 5_000, log, onWait } = {},
) {
  if (REPORT_PROJECT_JOURNEYS.has(id)) return run();
  const lock = join(directory, LOCK);
  let waitedMs = 0;
  while (!tryAcquire(lock, id)) {
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
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
