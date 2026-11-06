import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { SCHEDULER_HOLD_OWNER, SCHEDULER_LEASE_KEY } from "./opencodeScheduleLease.js";
import {
  holdRunScheduler,
  startScheduledWakeTurn,
  type ScheduledWakeRun,
} from "./opencodeScheduledWakeTurn.js";

/**
 * #4271 (ADR-0137 D10): the wake run's turn hands the scheduler lease to the runtime and takes it
 * back once the due schedule has fired, or cancels the turn when it never does.
 */

const SESSION = "ses_1";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  readonly run: ScheduledWakeRun & { ready: boolean };
  readonly database: string;
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly cancelled: { count: number };
  readonly clock: { value: number };
}

function harness(options: { readonly scheduler?: boolean } = {}): Harness {
  const runRoot = mkdtempSync(join(tmpdir(), "keiko-wake-turn-"));
  roots.push(runRoot);
  mkdirSync(join(runRoot, "state"));
  const database = join(runRoot, "state", "opencode.db");
  const db = new DatabaseSync(database);
  try {
    db.exec("CREATE TABLE session_v2 (id TEXT)");
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
  const cancelled = { count: 0 };
  const run = {
    runId: "run-wake-1",
    runRoot,
    sessionId: SESSION,
    ready: true,
    runtimeAdapter: {
      cancelTurn: () => {
        cancelled.count += 1;
      },
    },
  };
  return {
    run,
    database,
    sink: createBufferedServerLogSink(),
    cancelled,
    clock: { value: 0 },
  };
}

function exec(path: string, sql: string, ...parameters: (string | number | null)[]): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(sql).run(...parameters);
  } finally {
    db.close();
  }
}

function leaseOwner(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(SCHEDULER_LEASE_KEY) as
      { readonly value: string } | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(row.value) as { owner: string; until: number });
  } finally {
    db.close();
  }
}

function lines(h: Harness): readonly Record<string, unknown>[] {
  // The sink stamps completeness and loss on every line; the assertions are about the rest.
  return h.sink.events.map((event) => {
    const { completeness: _completeness, loss: _loss, ...fields } = event.extra ?? {};
    return fields;
  });
}

/** A sleep the test drives: each call waits until the test lets it pass. */
function drivenSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly next: () => Promise<void>;
} {
  const waiting: (() => void)[] = [];
  let arrived: (() => void) | undefined;
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        arrived?.();
      }),
    next: async () => {
      if (waiting.length === 0) {
        await new Promise<void>((resolve) => {
          arrived = resolve;
        });
      }
      waiting.shift()?.();
      await Promise.resolve();
    },
  };
}

async function settled(h: Harness, count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && h.sink.events.length < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("holding a run's scheduler", () => {
  it("writes Keiko's hold into the run's database and records it", () => {
    const h = harness();

    holdRunScheduler(h.sink, h.run, "hold");

    expect(leaseOwner(h.database)).toMatchObject({ owner: SCHEDULER_HOLD_OWNER });
    expect(lines(h)).toEqual([{ runId: "run-wake-1", action: "hold", outcome: "held" }]);
    expect(h.sink.events[0]?.correlationId).toBe("run-wake-1");
    expectActivityLogProof(
      "coding-runtime.schedule.lease.emitted-line",
      formatActivityLogProofLine(h.sink.events[0] ?? {}),
    );
  });

  it("records a runtime without a scheduler as absent", () => {
    const h = harness({ scheduler: false });

    holdRunScheduler(h.sink, h.run, "hold");

    expect(lines(h)).toEqual([{ runId: "run-wake-1", action: "hold", outcome: "absent" }]);
  });

  it("throws, and records the failure, when the hold cannot be written", () => {
    const h = harness();
    // A path that is not a database file cannot be opened.
    rmSync(h.database, { force: true });
    mkdirSync(h.database);

    expect(() => {
      holdRunScheduler(h.sink, h.run, "hold");
    }).toThrow();
    expect(lines(h)).toEqual([
      expect.objectContaining({
        action: "hold",
        outcome: "failed",
        causeChain: expect.any(Array) as unknown,
      }),
    ]);
    expect(h.sink.events[0]).toMatchObject({ level: "warn", errorKind: "internal" });
  });
});

describe("the wake run's turn", () => {
  it("releases the lease, and holds it again once the schedule fired", async () => {
    const h = harness();
    exec(h.database, "INSERT INTO schedule VALUES ('sch_a', ?, 'active', 2, NULL)", SESSION);
    holdRunScheduler(h.sink, h.run, "hold");
    const driven = drivenSleep();

    expect(
      startScheduledWakeTurn(h.run, {
        activityLog: h.sink,
        sleep: driven.sleep,
        now: () => h.clock.value,
      }),
    ).toBe(true);
    expect(leaseOwner(h.database)).toEqual({ owner: SCHEDULER_HOLD_OWNER, until: 0 });

    // The runtime takes the lapsed lease and fires the schedule.
    exec(
      h.database,
      "UPDATE kv SET value = ? WHERE key = ?",
      '{"owner":"runtime","until":1}',
      SCHEDULER_LEASE_KEY,
    );
    exec(h.database, "UPDATE schedule SET run_count = 3");
    h.clock.value = 2_500;
    await driven.next();
    await settled(h, 3);

    expect(lines(h).slice(1)).toEqual([
      { runId: "run-wake-1", action: "release", outcome: "released", activeScheduleCount: 1 },
      { runId: "run-wake-1", action: "rehold", outcome: "fired", firedCount: 1, waitMs: 2_500 },
    ]);
    expect(leaseOwner(h.database)).toMatchObject({ owner: SCHEDULER_HOLD_OWNER });
    expect(h.cancelled.count).toBe(0);
  });

  it("holds the lease again and cancels the turn when nothing fired in time", async () => {
    const h = harness();
    exec(h.database, "INSERT INTO schedule VALUES ('sch_a', ?, 'active', 0, NULL)", SESSION);
    const driven = drivenSleep();

    startScheduledWakeTurn(h.run, {
      activityLog: h.sink,
      sleep: driven.sleep,
      now: () => h.clock.value,
      fireWaitMs: 1_000,
    });
    h.clock.value = 1_000;
    await driven.next();
    await settled(h, 2);

    expect(lines(h)[1]).toEqual({
      runId: "run-wake-1",
      action: "rehold",
      outcome: "missed",
      waitMs: 1_000,
    });
    expect(h.sink.events[1]).toMatchObject({ level: "warn", errorKind: "validation-failed" });
    expect(leaseOwner(h.database)).toMatchObject({ owner: SCHEDULER_HOLD_OWNER });
    expect(h.cancelled.count).toBe(1);
  });

  it("records a run that closed before its schedule fired, and touches nothing", async () => {
    const h = harness();
    exec(h.database, "INSERT INTO schedule VALUES ('sch_a', ?, 'active', 0, NULL)", SESSION);
    const driven = drivenSleep();

    startScheduledWakeTurn(h.run, { activityLog: h.sink, sleep: driven.sleep });
    h.run.ready = false;
    await driven.next();
    await settled(h, 2);

    expect(lines(h)[1]).toMatchObject({
      action: "rehold",
      outcome: "absent",
      reason: "run-closed",
    });
    expect(h.cancelled.count).toBe(0);
  });

  it.each([
    [
      "a schedule of another session",
      "INSERT INTO schedule VALUES ('sch_b', 'ses_other', 'active', 0, NULL)",
      "unadmitted-rows",
    ],
    [
      "a schedule gated by a check",
      `INSERT INTO schedule VALUES ('sch_b', '${SESSION}', 'active', 0, '{"type":"shell"}')`,
      "unadmitted-rows",
    ],
    [
      "no active schedule",
      "INSERT INTO schedule VALUES ('sch_b', 'ses_1', 'paused', 0, NULL)",
      "no-active-schedule",
    ],
  ] as const)("keeps the lease and cancels the turn for %s", (_name, sql, reason) => {
    const h = harness();
    holdRunScheduler(h.sink, h.run, "hold");
    exec(h.database, sql);

    expect(startScheduledWakeTurn(h.run, { activityLog: h.sink })).toBe(false);

    expect(lines(h)[1]).toMatchObject({ action: "release", outcome: "refused", reason });
    expect(leaseOwner(h.database)).toMatchObject({ owner: SCHEDULER_HOLD_OWNER });
    expect(h.cancelled.count).toBe(1);
  });
});
