import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";

import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";
import {
  controlRetainedSchedule,
  listRetainedSchedules,
  retainedScheduleCount,
} from "./opencodeRetainedSchedules.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  createRetainedSessionStore,
  RETAINED_SCHEDULE_ACTION_MAX_CHARS,
  RETAINED_SCHEDULE_MAX,
  RETAINED_SCHEDULE_NAME_MAX_CHARS,
  retainedSessionKey,
  type RetainedSessionStore,
} from "./opencodeSessionRetention.js";

/**
 * #4271 (ADR-0137 D10): the schedules a retained session carries — what retention admits, the
 * consent ledger it records, and the pause/resume/delete edits made through the store.
 */

const SESSION_ID = "ses_retained_1";
const WORKSPACE = "/work/space";
const VERSION = OPENCODE_PINNED_VERSION;
const NOW = 1_800_000_000_000;
const WORKSPACE_KEY = createHash("sha256").update("workspace").digest("hex");
const TASK = "task-1";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ScheduleRow {
  readonly id: string;
  readonly session_id?: string | null;
  readonly status?: string;
  readonly name?: string | null;
  readonly when?: string;
  readonly action?: string;
  readonly next_due_at?: number | null;
  readonly retry_at?: number | null;
  readonly run_count?: number;
  readonly failures?: number;
  readonly ends_at?: number | null;
  readonly remaining_runs?: number | null;
  readonly check?: string | null;
  readonly state?: string | null;
}

function schedule(id: string, overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id,
    session_id: SESSION_ID,
    status: "active",
    name: "Check the build",
    when: JSON.stringify({ type: "every", every: "30 minutes" }),
    action: JSON.stringify({ type: "prompt", prompt: "SECRET-SCHEDULED-PROMPT" }),
    next_due_at: NOW + 60_000,
    retry_at: null,
    run_count: 0,
    failures: 0,
    ends_at: null,
    remaining_runs: null,
    check: null,
    state: null,
    ...overrides,
  };
}

function writeDatabase(
  path: string,
  rows: readonly ScheduleRow[],
  kv: readonly string[] = [],
): void {
  const database = new DatabaseSync(path);
  try {
    for (const [table, columns] of Object.entries(OPENCODE_PERSISTENCE_SCHEMAS[VERSION] ?? {})) {
      database.exec(`CREATE TABLE "${table}" (${columns.map((name) => `"${name}"`).join(", ")})`);
    }
    database
      .prepare("INSERT INTO session_v2 (id, directory, version) VALUES (?, ?, ?)")
      .run(SESSION_ID, WORKSPACE, VERSION);
    database
      .prepare("INSERT INTO session_message (id, session_id, data) VALUES (?, ?, ?)")
      .run("msg_1", SESSION_ID, "SECRET-CONVERSATION");
    for (const [index, row] of rows.entries()) insertSchedule(database, row, index);
    for (const key of kv) {
      database
        .prepare("INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, 1, 1)")
        .run(key, JSON.stringify({ owner: "keiko.schedule-hold", until: 1 }));
    }
  } finally {
    database.close();
  }
}

function insertSchedule(database: DatabaseSync, row: ScheduleRow, index: number): void {
  database
    .prepare(
      `INSERT INTO schedule (id, session_id, status, name, "when", action, next_due_at, retry_at,
         run_count, failures, ends_at, remaining_runs, "check", state, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      ...[row.session_id, row.status, row.name, row.when, row.action].map(orNull),
      ...[row.next_due_at, row.retry_at].map(orNull),
      row.run_count ?? 0,
      row.failures ?? 0,
      ...[row.ends_at, row.remaining_runs, row.check, row.state].map(orNull),
      index,
      index,
    );
}

function orNull(value: string | number | null | undefined): string | number | null {
  return value ?? null;
}

interface Fixture {
  readonly root: string;
  readonly store: RetainedSessionStore;
  readonly clock: { value: number };
  source(rows: readonly ScheduleRow[], kv?: readonly string[]): string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "keiko-retained-schedules-"));
  roots.push(root);
  mkdirSync(join(root, "run"), { recursive: true });
  const clock = { value: NOW };
  let sources = 0;
  return {
    root,
    clock,
    store: createRetainedSessionStore({
      root: join(root, "retained"),
      now: (): number => clock.value,
    }),
    source(rows, kv = []): string {
      sources += 1;
      const path = join(root, "run", `opencode-${String(sources)}.db`);
      writeDatabase(path, rows, kv);
      return path;
    },
  };
}

function retain(
  f: Fixture,
  sourceDatabase: string,
  scheduleConsentMode?: CodingWorkbenchMode,
): ReturnType<RetainedSessionStore["retain"]> {
  return f.store.retain({
    binding: {
      taskId: TASK,
      workspaceKey: WORKSPACE_KEY,
      runtimeVersion: VERSION,
      maxInputTokens: 24_000,
    },
    sessionId: SESSION_ID,
    directory: WORKSPACE,
    sourceDatabase,
    ...(scheduleConsentMode === undefined ? {} : { scheduleConsentMode }),
  });
}

function manifest(f: Fixture): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(f.root, "retained", retainedSessionKey(TASK), "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
}

function retainedRows(f: Fixture, sql: string): readonly Record<string, unknown>[] {
  const database = new DatabaseSync(
    join(f.root, "retained", retainedSessionKey(TASK), "opencode.db"),
    {
      readOnly: true,
    },
  );
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

describe("retaining a session's schedules", () => {
  it("admits the session's own schedules and records the run's mode in the ledger", () => {
    const f = fixture();

    expect(
      retain(f, f.source([schedule("sch_a"), schedule("sch_b")]), "supervised-coding"),
    ).toMatchObject({
      ok: true,
    });

    expect(manifest(f).scheduleModes).toEqual({
      sch_a: "supervised-coding",
      sch_b: "supervised-coding",
    });
    // The ledger names ids and modes only, never what a schedule does.
    expect(JSON.stringify(manifest(f))).not.toContain("SECRET-SCHEDULED-PROMPT");
  });

  it("records the narrowest mode when the run's mode is absent", () => {
    const f = fixture();

    expect(retain(f, f.source([schedule("sch_a")]))).toMatchObject({ ok: true });

    expect(manifest(f).scheduleModes).toEqual({ sch_a: "governed-assist" });
  });

  it("keeps the narrower of the recorded and the new mode, and records a new id with the new one", () => {
    const f = fixture();
    expect(retain(f, f.source([schedule("sch_a")]), "supervised-coding")).toMatchObject({
      ok: true,
    });

    f.clock.value += 1_000;
    expect(
      retain(f, f.source([schedule("sch_a"), schedule("sch_b")]), "autonomous-delivery"),
    ).toMatchObject({ ok: true });
    expect(manifest(f).scheduleModes).toEqual({
      sch_a: "supervised-coding",
      sch_b: "autonomous-delivery",
    });

    f.clock.value += 1_000;
    expect(
      retain(f, f.source([schedule("sch_a"), schedule("sch_b")]), "governed-assist"),
    ).toMatchObject({ ok: true });
    expect(manifest(f).scheduleModes).toEqual({
      sch_a: "governed-assist",
      sch_b: "governed-assist",
    });
  });

  it("writes no ledger for a session without schedules", () => {
    const f = fixture();

    expect(retain(f, f.source([]), "autonomous-delivery")).toMatchObject({ ok: true });

    expect(manifest(f)).not.toHaveProperty("scheduleModes");
  });

  it("drops the scheduler's lease row, and only that kv row", () => {
    const f = fixture();

    expect(retain(f, f.source([schedule("sch_a")], ["schedule:leader"]))).toMatchObject({
      ok: true,
    });
    expect(retainedRows(f, "SELECT key FROM kv")).toEqual([]);

    expect(retain(f, f.source([schedule("sch_a")], ["schedule:leader", "other"]))).toEqual({
      ok: false,
      reason: "schema-unknown",
      check: "kv-rows",
    });
  });

  it.each([
    ["of another session", schedule("sch_a", { session_id: "ses_other" })],
    ["of no session", schedule("sch_a", { session_id: null })],
    ["gated by a check", schedule("sch_a", { check: JSON.stringify({ type: "shell" }) })],
    ["carrying check state", schedule("sch_a", { state: "{}" })],
    ["with a status the runtime does not write", schedule("sch_a", { status: "running" })],
    ["with an id outside the runtime's alphabet", schedule("sch_a-b")],
    ["with an empty id suffix", schedule("sch_")],
    ["with an overlong id", schedule(`sch_${"a".repeat(65)}`)],
    [
      "with an oversized action",
      schedule("sch_a", {
        action: JSON.stringify({
          type: "prompt",
          prompt: "x".repeat(RETAINED_SCHEDULE_ACTION_MAX_CHARS),
        }),
      }),
    ],
    [
      "with an oversized name",
      schedule("sch_a", { name: "n".repeat(RETAINED_SCHEDULE_NAME_MAX_CHARS + 1) }),
    ],
  ] as const)("refuses a schedule %s", (_name, row) => {
    const f = fixture();

    expect(retain(f, f.source([row]), "autonomous-delivery")).toEqual({
      ok: false,
      reason: "schema-unknown",
      check: "schedule-rows",
    });
  });

  it("refuses more schedules than a ledger carries", () => {
    const f = fixture();
    const rows = Array.from({ length: RETAINED_SCHEDULE_MAX + 1 }, (_, index) =>
      schedule(`sch_${String(index)}`),
    );

    expect(retain(f, f.source(rows))).toEqual({
      ok: false,
      reason: "schema-unknown",
      check: "schedule-rows",
    });
    expect(retain(f, f.source(rows.slice(0, RETAINED_SCHEDULE_MAX)))).toMatchObject({ ok: true });
  });
});

describe("listing a task's retained schedules", () => {
  it("lists them with their cadence, due time and consent, and the server-side prompt", () => {
    const f = fixture();
    retain(
      f,
      f.source([
        schedule("sch_a", { retry_at: NOW + 120_000, run_count: 2, failures: 1 }),
        schedule("sch_b", {
          status: "paused",
          name: null,
          when: JSON.stringify({ type: "at", at: NOW }),
          action: JSON.stringify({ type: "command", command: "x" }),
        }),
        schedule("sch_c", { when: JSON.stringify({ type: "unknown" }) }),
      ]),
      "supervised-coding",
    );

    const listed = listRetainedSchedules(f.store, TASK);

    expect(listed).toEqual({
      taskId: TASK,
      sessionId: SESSION_ID,
      retainedAtMs: NOW,
      schedules: [
        {
          id: "sch_a",
          name: "Check the build",
          status: "active",
          cadence: "every",
          cadenceText: "30 minutes",
          dueAtMs: NOW + 120_000,
          runCount: 2,
          failures: 1,
          prompt: "SECRET-SCHEDULED-PROMPT",
          consentMode: "supervised-coding",
        },
        {
          id: "sch_b",
          status: "paused",
          cadence: "at",
          cadenceText: new Date(NOW).toISOString(),
          runCount: 0,
          failures: 0,
          consentMode: "supervised-coding",
        },
        {
          id: "sch_c",
          name: "Check the build",
          status: "active",
          cadence: "other",
          dueAtMs: NOW + 60_000,
          runCount: 0,
          failures: 0,
          prompt: "SECRET-SCHEDULED-PROMPT",
          consentMode: "supervised-coding",
        },
      ],
    });
    expect(retainedScheduleCount(f.store, TASK)).toBe(3);
  });

  it("returns nothing for a task without an entry, and no schedule for one without a ledger", () => {
    const f = fixture();
    expect(listRetainedSchedules(f.store, TASK)).toBeUndefined();
    expect(retainedScheduleCount(f.store, TASK)).toBe(0);

    retain(f, f.source([]));
    expect(listRetainedSchedules(f.store, TASK)?.schedules).toEqual([]);
    expect(retainedScheduleCount(f.store, TASK)).toBe(0);
  });

  it("refuses to read an entry whose database no longer matches its digest", () => {
    const f = fixture();
    retain(f, f.source([schedule("sch_a")]));
    const database = join(f.root, "retained", retainedSessionKey(TASK), "opencode.db");
    const bytes = readFileSync(database);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    writeFileSync(database, bytes);

    expect(listRetainedSchedules(f.store, TASK)).toBeUndefined();
  });

  it("names the task ids whose entries are whole", () => {
    const f = fixture();
    expect(f.store.listTaskIds()).toEqual([]);
    retain(f, f.source([schedule("sch_a")]));
    mkdirSync(join(f.root, "retained", "not-an-entry"));

    expect(f.store.listTaskIds()).toEqual([TASK]);
  });
});

describe("controlling a retained schedule", () => {
  function control(
    f: Fixture,
    id: string,
    action: "pause" | "resume" | "delete",
  ): ReturnType<typeof controlRetainedSchedule> {
    return controlRetainedSchedule(f.store, TASK, id, action, f.clock.value);
  }

  it("pauses an active schedule and resumes it with its failures and retry cleared", () => {
    const f = fixture();
    retain(
      f,
      f.source([schedule("sch_a", { failures: 2, retry_at: NOW + 999 })]),
      "supervised-coding",
    );

    expect(control(f, "sch_a", "pause")).toEqual({ ok: true, status: "paused" });
    expect(control(f, "sch_a", "pause")).toEqual({ ok: false, reason: "not-applicable" });
    expect(control(f, "sch_a", "resume")).toEqual({ ok: true, status: "active" });
    expect(control(f, "sch_a", "resume")).toEqual({ ok: false, reason: "not-applicable" });

    expect(retainedRows(f, "SELECT status, failures, retry_at FROM schedule")).toEqual([
      { status: "active", failures: 0, retry_at: null },
    ]);
    // An edit keeps the ledger: it never widens the consent a schedule was held under.
    expect(manifest(f).scheduleModes).toEqual({ sch_a: "supervised-coding" });
  });

  it.each([
    ["whose end has passed", { ends_at: NOW - 1 }],
    ["without a run left", { remaining_runs: 0 }],
  ] as const)("resumes a schedule %s as done", (_name, overrides) => {
    const f = fixture();
    retain(f, f.source([schedule("sch_a", { status: "paused", ...overrides })]));

    expect(control(f, "sch_a", "resume")).toEqual({ ok: true, status: "done" });
  });

  it("deletes a schedule and drops it from the ledger", () => {
    const f = fixture();
    retain(f, f.source([schedule("sch_a"), schedule("sch_b")]), "autonomous-delivery");

    expect(control(f, "sch_a", "delete")).toEqual({ ok: true, status: "deleted" });

    expect(retainedRows(f, "SELECT id FROM schedule")).toEqual([{ id: "sch_b" }]);
    expect(manifest(f).scheduleModes).toEqual({ sch_b: "autonomous-delivery" });
    expect(control(f, "sch_b", "delete")).toEqual({ ok: true, status: "deleted" });
    expect(manifest(f)).not.toHaveProperty("scheduleModes");
  });

  it("refuses an unknown schedule and a task without an entry", () => {
    const f = fixture();
    expect(control(f, "sch_a", "delete")).toEqual({ ok: false, reason: "no-retained-state" });

    retain(f, f.source([schedule("sch_a")]));
    expect(control(f, "sch_zz", "pause")).toEqual({ ok: false, reason: "not-found" });
  });
});
