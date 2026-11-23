import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { UNADMITTED_AUTOMATION_PREDICATE } from "./opencodeAutomationRows.js";

/**
 * Keiko's hold on the pinned runtime's scheduler (#4271, ADR-0137 D10).
 *
 * OpenCode 2.3.1 and later elect one scheduler per database through a lease row in `kv`
 * (`automation:leader` = `{ owner, until }`; the 2.2.5 schedules used `schedule:leader`). A process
 * takes the lease only when the row is absent, names itself, or has lapsed, and a process that is
 * not the leader fires nothing; it looks again at least every 30 seconds. Keiko writes its own,
 * unexpiring lease into every native run's private database, so the runtime never fires an
 * automation inside a run a human started. Only the wake run Keiko starts at an automation's due
 * time releases it, after its turn is armed, and takes it back as soon as the automation has
 * fired, so the run fires what was due and nothing after it.
 *
 * Every write is a short, immediate transaction with a busy timeout against the runtime's own
 * writer; a write that cannot complete throws, and the caller fails closed.
 */

export const SCHEDULER_LEASE_KEY = "automation:leader";
export const SCHEDULER_HOLD_OWNER = "keiko.schedule-hold";
/** The producer's table of automations (`schedule` before 2.3.1). */
const AUTOMATION_TABLE = "automation";
/** The latest instant a JavaScript date can name: a hold never lapses on its own. */
const HOLD_UNTIL_MS = 8_640_000_000_000_000;
const BUSY_TIMEOUT_MS = 5_000;

/** What the wake run reads about the session's automations in its live database. */
export interface ScheduleFireState {
  /** The sum of every automation's `run_count`: it grows by one for each fired slot. */
  readonly runCount: number;
  /** Rows Keiko never admits: see `UNADMITTED_AUTOMATION_PREDICATE`. */
  readonly unadmitted: number;
  /** Active rows of the session. */
  readonly active: number;
}

function openWritable(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  return database;
}

function hasTable(database: DatabaseSync, name: string): boolean {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function immediate(database: DatabaseSync, write: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    write();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function writeLease(path: string, untilMs: number, onlyOwnHold: boolean): boolean {
  // Opening a missing file would create an empty database: a run without one has no scheduler.
  if (!existsSync(path)) return false;
  const database = openWritable(path);
  try {
    if (!hasTable(database, "kv") || !hasTable(database, AUTOMATION_TABLE)) return false;
    const now = Date.now();
    const value = JSON.stringify({ owner: SCHEDULER_HOLD_OWNER, until: untilMs });
    immediate(database, () => {
      if (onlyOwnHold) {
        database
          .prepare(
            "UPDATE kv SET value = ?, time_updated = ? WHERE key = ? AND json_extract(value, '$.owner') = ?",
          )
          .run(value, now, SCHEDULER_LEASE_KEY, SCHEDULER_HOLD_OWNER);
        return;
      }
      // Replaces any lease, the runtime's own included: its next claim then fails and it stops
      // leading, because a lease of another owner that has not lapsed is never taken over.
      database
        .prepare(
          "INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, time_updated = excluded.time_updated",
        )
        .run(SCHEDULER_LEASE_KEY, value, now, now);
    });
    return true;
  } finally {
    database.close();
  }
}

/**
 * Writes Keiko's unexpiring lease. `false` when there is no database or it has no scheduler (a
 * runtime version without automations); a database that cannot be written throws.
 */
export function holdSchedulerLease(path: string): boolean {
  return writeLease(path, HOLD_UNTIL_MS, false);
}

/** Lets Keiko's own lease lapse, so the runtime may take it at its next look. */
export function releaseSchedulerLease(path: string): boolean {
  return writeLease(path, 0, true);
}

/** A fork never inherits its source task's automations: they wake the source, not the fork. */
export function removeInheritedSchedules(path: string): number {
  if (!existsSync(path)) return 0;
  const database = openWritable(path);
  try {
    if (!hasTable(database, AUTOMATION_TABLE)) return 0;
    let removed = 0;
    immediate(database, () => {
      removed = Number(database.prepare(`DELETE FROM ${AUTOMATION_TABLE}`).run().changes);
    });
    return removed;
  } finally {
    database.close();
  }
}

function count(database: DatabaseSync, sql: string, ...parameters: string[]): number {
  const row = database.prepare(sql).get(...parameters) as { readonly n?: unknown } | undefined;
  const value = row?.n;
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Reads the session's automation counters from the live database, read-only. */
export function readScheduleFireState(path: string, sessionId: string): ScheduleFireState {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
    if (!hasTable(database, AUTOMATION_TABLE)) return { runCount: 0, unadmitted: 0, active: 0 };
    return {
      runCount: count(database, `SELECT COALESCE(SUM(run_count), 0) AS n FROM ${AUTOMATION_TABLE}`),
      unadmitted: count(
        database,
        `SELECT COUNT(*) AS n FROM ${AUTOMATION_TABLE} WHERE ${UNADMITTED_AUTOMATION_PREDICATE}`,
        sessionId,
        sessionId,
      ),
      active: count(
        database,
        `SELECT COUNT(*) AS n FROM ${AUTOMATION_TABLE} WHERE session_id = ? AND status = 'active'`,
        sessionId,
      ),
    };
  } finally {
    database.close();
  }
}
