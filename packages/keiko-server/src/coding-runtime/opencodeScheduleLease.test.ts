import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  holdSchedulerLease,
  readScheduleFireState,
  releaseSchedulerLease,
  removeInheritedSchedules,
  SCHEDULER_HOLD_OWNER,
  SCHEDULER_LEASE_KEY,
} from "./opencodeScheduleLease.js";

/**
 * #4271 (ADR-0137 D10): Keiko's hold on the runtime's scheduler lease. `claimLeader` below is the
 * pinned runtime's claim, transcribed from OpenCode 2.2.5: it takes the lease only when the row is
 * absent, names itself, or has lapsed. The real runtime's behaviour is proven in the real-binary
 * suite; this pins the row Keiko writes against that rule.
 */

const SESSION = "ses_1";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(options: { readonly scheduler?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-schedule-lease-"));
  roots.push(root);
  const path = join(root, "opencode.db");
  const db = new DatabaseSync(path);
  try {
    if (options.scheduler !== false) {
      db.exec(
        "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, time_created INTEGER, time_updated INTEGER)",
      );
      db.exec(
        'CREATE TABLE schedule (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, run_count INTEGER, "check" TEXT)',
      );
    }
  } finally {
    db.close();
  }
  return path;
}

function claimLeader(path: string, owner: string, nowMs: number): boolean {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SCHEDULER_LEASE_KEY) as
      { readonly value: string } | undefined;
    const lease =
      row === undefined
        ? undefined
        : (JSON.parse(row.value) as { readonly owner: string; readonly until: number });
    if (lease !== undefined && lease.owner !== owner && lease.until > nowMs) return false;
    db.prepare(
      "INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, 0, 0) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(SCHEDULER_LEASE_KEY, JSON.stringify({ owner, until: nowMs + 60_000 }));
    return true;
  } finally {
    db.close();
  }
}

function lease(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SCHEDULER_LEASE_KEY) as
      { readonly value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value);
  } finally {
    db.close();
  }
}

function addSchedule(
  path: string,
  id: string,
  sessionId: string | null,
  status: string,
  runCount: number,
  check: string | null = null,
): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      'INSERT INTO schedule (id, session_id, status, run_count, "check") VALUES (?, ?, ?, ?, ?)',
    ).run(id, sessionId, status, runCount, check);
  } finally {
    db.close();
  }
}

describe("Keiko's scheduler hold", () => {
  it("keeps the runtime from claiming the lease until Keiko releases it", () => {
    const path = database();
    const now = Date.now();

    expect(holdSchedulerLease(path)).toBe(true);
    expect(lease(path)).toMatchObject({ owner: SCHEDULER_HOLD_OWNER });
    // A hold never lapses on its own: the runtime's claim fails however late it looks.
    expect(claimLeader(path, "runtime", now)).toBe(false);
    expect(claimLeader(path, "runtime", now + 365 * 24 * 3_600_000)).toBe(false);

    expect(releaseSchedulerLease(path)).toBe(true);
    expect(claimLeader(path, "runtime", now)).toBe(true);
  });

  it("takes the lease back from a runtime that leads", () => {
    const path = database();
    expect(claimLeader(path, "runtime", Date.now())).toBe(true);

    holdSchedulerLease(path);

    expect(lease(path)).toMatchObject({ owner: SCHEDULER_HOLD_OWNER });
    expect(claimLeader(path, "runtime", Date.now())).toBe(false);
  });

  it("releases only its own hold, never the runtime's lease", () => {
    const path = database();
    const now = Date.now();
    claimLeader(path, "runtime", now);

    releaseSchedulerLease(path);

    expect(lease(path)).toEqual({ owner: "runtime", until: now + 60_000 });
  });

  it("creates no database where there is none", () => {
    const path = join(database(), "..", "missing.db");

    expect(holdSchedulerLease(path)).toBe(false);
    expect(releaseSchedulerLease(path)).toBe(false);
    expect(removeInheritedSchedules(path)).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("reports a database without a scheduler as having nothing to hold", () => {
    const path = database({ scheduler: false });

    expect(holdSchedulerLease(path)).toBe(false);
    expect(releaseSchedulerLease(path)).toBe(false);
    expect(removeInheritedSchedules(path)).toBe(0);
    expect(readScheduleFireState(path, SESSION)).toEqual({ runCount: 0, unadmitted: 0, active: 0 });
  });
});

describe("reading the session's schedules", () => {
  it("sums run counts, counts active rows and the rows Keiko never admits", () => {
    const path = database();
    addSchedule(path, "sch_a", SESSION, "active", 2);
    addSchedule(path, "sch_b", SESSION, "paused", 1);
    addSchedule(path, "sch_c", "ses_other", "active", 0);
    addSchedule(path, "sch_d", null, "active", 0);
    addSchedule(path, "sch_e", SESSION, "active", 0, '{"type":"shell"}');

    expect(readScheduleFireState(path, SESSION)).toEqual({ runCount: 3, unadmitted: 3, active: 2 });
  });

  it("removes every inherited schedule from a fork's database", () => {
    const path = database();
    addSchedule(path, "sch_a", SESSION, "active", 0);
    addSchedule(path, "sch_b", SESSION, "paused", 0);

    expect(removeInheritedSchedules(path)).toBe(2);
    expect(readScheduleFireState(path, SESSION)).toEqual({ runCount: 0, unadmitted: 0, active: 0 });
  });
});
