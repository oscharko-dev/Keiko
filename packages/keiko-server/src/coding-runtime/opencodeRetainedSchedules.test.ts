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
 * #4271, #4546 (ADR-0137 D10): the scheduled wakes a retained session carries, as rows of the
 * producer's `automation` table — what retention admits, the consent ledger it records, and the
 * pause/resume/delete edits made through the store.
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
  readonly trigger?: string;
  readonly action?: string;
  readonly next_due_at?: number | null;
  readonly retry_at?: number | null;
  readonly run_count?: number;
  readonly failures?: number;
  readonly expires_at?: number | null;
  readonly state?: string | null;
  readonly event_position?: string | null;
  readonly last_output?: string | null;
}

const PROMPT = "SECRET-SCHEDULED-PROMPT";

/** The action the runtime stores for a prompt automation: into the creating session. */
function promptAction(prompt: string = PROMPT, session: string = SESSION_ID): string {
  return JSON.stringify({ type: "prompt", prompt, to: { session } });
}

function schedule(id: string, overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id,
    session_id: SESSION_ID,
    status: "active",
    name: "Check the build",
    trigger: JSON.stringify({ type: "every", every: "30 minutes" }),
    action: promptAction(),
    next_due_at: NOW + 60_000,
    retry_at: null,
    run_count: 0,
    failures: 0,
    expires_at: null,
    state: null,
    event_position: null,
    last_output: null,
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
      `INSERT INTO automation (id, session_id, status, name, trigger, action, next_due_at,
         retry_at, run_count, failures, expires_at, state, event_position, last_output,
         time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      ...[row.session_id, row.status, row.name, row.trigger, row.action].map(orNull),
      ...[row.next_due_at, row.retry_at].map(orNull),
      row.run_count ?? 0,
      row.failures ?? 0,
      ...[row.expires_at, row.state, row.event_position, row.last_output].map(orNull),
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
      retain(f, f.source([schedule("aut_a"), schedule("aut_b")]), "supervised-coding"),
    ).toMatchObject({
      ok: true,
    });

    expect(manifest(f).scheduleModes).toEqual({
      aut_a: "supervised-coding",
      aut_b: "supervised-coding",
    });
    // The ledger names ids and modes only, never what a schedule does.
    expect(JSON.stringify(manifest(f))).not.toContain("SECRET-SCHEDULED-PROMPT");
  });

  it("records the narrowest mode when the run's mode is absent", () => {
    const f = fixture();

    expect(retain(f, f.source([schedule("aut_a")]))).toMatchObject({ ok: true });

    expect(manifest(f).scheduleModes).toEqual({ aut_a: "governed-assist" });
  });

  it("keeps the narrower of the recorded and the new mode, and records a new id with the new one", () => {
    const f = fixture();
    expect(retain(f, f.source([schedule("aut_a")]), "supervised-coding")).toMatchObject({
      ok: true,
    });

    f.clock.value += 1_000;
    expect(
      retain(f, f.source([schedule("aut_a"), schedule("aut_b")]), "autonomous-delivery"),
    ).toMatchObject({ ok: true });
    expect(manifest(f).scheduleModes).toEqual({
      aut_a: "supervised-coding",
      aut_b: "autonomous-delivery",
    });

    f.clock.value += 1_000;
    expect(
      retain(f, f.source([schedule("aut_a"), schedule("aut_b")]), "governed-assist"),
    ).toMatchObject({ ok: true });
    expect(manifest(f).scheduleModes).toEqual({
      aut_a: "governed-assist",
      aut_b: "governed-assist",
    });
  });

  it("writes no ledger for a session without schedules", () => {
    const f = fixture();

    expect(retain(f, f.source([]), "autonomous-delivery")).toMatchObject({ ok: true });

    expect(manifest(f)).not.toHaveProperty("scheduleModes");
  });

  it("drops the scheduler's lease row, and only that kv row", () => {
    const f = fixture();

    expect(retain(f, f.source([schedule("aut_a")], ["automation:leader"]))).toMatchObject({
      ok: true,
    });
    expect(retainedRows(f, "SELECT key FROM kv")).toEqual([]);

    expect(retain(f, f.source([schedule("aut_a")], ["automation:leader", "other"]))).toEqual({
      ok: false,
      reason: "schema-unknown",
      check: "kv-rows",
    });
  });

  it.each([
    ["of another session", schedule("aut_a", { session_id: "ses_other" })],
    ["of no session", schedule("aut_a", { session_id: null })],
    // #4546: only a prompt into the session itself, on a time, an interval or a cron, is a wake.
    [
      "running a shell command",
      schedule("aut_a", { action: JSON.stringify({ type: "shell", command: "id" }) }),
    ],
    [
      "running a Code Mode program",
      schedule("aut_a", { action: JSON.stringify({ type: "code", code: "return" }) }),
    ],
    [
      "watching an MCP server",
      schedule("aut_a", { trigger: JSON.stringify({ type: "event", server: "s", event: "e" }) }),
    ],
    ["with a trigger the runtime has not got", schedule("aut_a", { trigger: "not json" })],
    ["prompting another session", schedule("aut_a", { action: promptAction(PROMPT, "ses_other") })],
    [
      "starting a subagent each run",
      schedule("aut_a", {
        action: JSON.stringify({ type: "prompt", prompt: PROMPT, to: { subagent: "build" } }),
      }),
    ],
    ["carrying code state", schedule("aut_a", { state: "{}" })],
    ["carrying an event cursor", schedule("aut_a", { event_position: '{"agent":"build"}' })],
    ["with an oversized output", schedule("aut_a", { last_output: "o".repeat(1_025) })],
    ["with a status the runtime does not write", schedule("aut_a", { status: "running" })],
    ["with an id outside the runtime's alphabet", schedule("aut_a-b")],
    ["with an empty id suffix", schedule("aut_")],
    ["with an overlong id", schedule(`aut_${"a".repeat(65)}`)],
    [
      "with an oversized action",
      schedule("aut_a", {
        action: promptAction("x".repeat(RETAINED_SCHEDULE_ACTION_MAX_CHARS)),
      }),
    ],
    [
      "with an oversized name",
      schedule("aut_a", { name: "n".repeat(RETAINED_SCHEDULE_NAME_MAX_CHARS + 1) }),
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
      schedule(`aut_${String(index)}`),
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
        schedule("aut_a", { retry_at: NOW + 120_000, run_count: 2, failures: 1 }),
        schedule("aut_b", {
          status: "paused",
          name: null,
          trigger: JSON.stringify({ type: "at", at: NOW }),
          action: promptAction(""),
        }),
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
          id: "aut_a",
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
          id: "aut_b",
          status: "paused",
          cadence: "at",
          cadenceText: new Date(NOW).toISOString(),
          runCount: 0,
          failures: 0,
          consentMode: "supervised-coding",
        },
      ],
    });
    expect(retainedScheduleCount(f.store, TASK)).toBe(2);
  });

  // #4546: an entry retained under OpenCode 2.2.5 is never opened by the runtime Keiko runs now, so
  // its schedules can never wake the task; the Workbench shows each one the ledger names as removed.
  it("lists the schedules of an entry retained under a previous runtime as removed, without their content", () => {
    const f = fixture();
    retain(f, f.source([schedule("aut_a")]), "supervised-coding");
    const path = join(f.root, "retained", retainedSessionKey(TASK), "manifest.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...manifest(f),
        runtimeVersion: "2.2.5",
        scheduleModes: { sch_old: "supervised-coding", sch_older: "autonomous-delivery" },
      }),
    );

    expect(listRetainedSchedules(f.store, TASK)?.schedules).toEqual([
      {
        id: "sch_old",
        status: "removed",
        cadence: "other",
        runCount: 0,
        failures: 0,
        consentMode: "supervised-coding",
      },
      {
        id: "sch_older",
        status: "removed",
        cadence: "other",
        runCount: 0,
        failures: 0,
        consentMode: "autonomous-delivery",
      },
    ]);
    // The copy's own rows (`aut_a`) are never read under another runtime: only the ledger shows.
    expect(JSON.stringify(listRetainedSchedules(f.store, TASK))).not.toContain("aut_a");
    expect(JSON.stringify(listRetainedSchedules(f.store, TASK))).not.toContain(PROMPT);
    expect(controlRetainedSchedule(f.store, TASK, "sch_old", "delete", NOW)).toEqual(
      controlRetainedSchedule(f.store, TASK, "aut_missing", "delete", NOW),
    );
    expect(controlRetainedSchedule(f.store, TASK, "sch_old", "delete", NOW)).toMatchObject({
      ok: false,
    });
  });

  it("lists nothing as removed for an entry of a previous runtime without a schedule ledger", () => {
    const f = fixture();
    retain(f, f.source([schedule("aut_a")]), "supervised-coding");
    const path = join(f.root, "retained", retainedSessionKey(TASK), "manifest.json");
    const { scheduleModes: _dropped, ...rest } = manifest(f);
    writeFileSync(path, JSON.stringify({ ...rest, runtimeVersion: "2.2.5" }));

    expect(listRetainedSchedules(f.store, TASK)?.schedules).toEqual([]);
  });

  it("lists a current entry from its rows, never a ledger id without a row as removed", () => {
    const f = fixture();
    retain(f, f.source([schedule("aut_a")]), "supervised-coding");
    const path = join(f.root, "retained", retainedSessionKey(TASK), "manifest.json");
    const current = manifest(f) as { readonly scheduleModes?: Record<string, string> };
    writeFileSync(
      path,
      JSON.stringify({
        ...current,
        scheduleModes: { ...current.scheduleModes, aut_gone: "supervised-coding" },
      }),
    );

    const listed = listRetainedSchedules(f.store, TASK)?.schedules ?? [];
    expect(listed.map((entry) => [entry.id, entry.status])).toEqual([["aut_a", "active"]]);
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
    retain(f, f.source([schedule("aut_a")]));
    const database = join(f.root, "retained", retainedSessionKey(TASK), "opencode.db");
    const bytes = readFileSync(database);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    writeFileSync(database, bytes);

    expect(listRetainedSchedules(f.store, TASK)).toBeUndefined();
  });

  it("names the task ids whose entries are whole", () => {
    const f = fixture();
    expect(f.store.listTaskIds()).toEqual([]);
    retain(f, f.source([schedule("aut_a")]));
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
      f.source([schedule("aut_a", { failures: 2, retry_at: NOW + 999 })]),
      "supervised-coding",
    );

    expect(control(f, "aut_a", "pause")).toEqual({ ok: true, status: "paused" });
    expect(control(f, "aut_a", "pause")).toEqual({ ok: false, reason: "not-applicable" });
    expect(control(f, "aut_a", "resume")).toEqual({ ok: true, status: "active" });
    expect(control(f, "aut_a", "resume")).toEqual({ ok: false, reason: "not-applicable" });

    expect(retainedRows(f, "SELECT status, failures, retry_at FROM automation")).toEqual([
      { status: "active", failures: 0, retry_at: null },
    ]);
    // An edit keeps the ledger: it never widens the consent a schedule was held under.
    expect(manifest(f).scheduleModes).toEqual({ aut_a: "supervised-coding" });
  });

  it.each([["whose expiry has passed", { expires_at: NOW - 1 }]] as const)(
    "resumes a schedule %s as done",
    (_name, overrides) => {
      const f = fixture();
      retain(f, f.source([schedule("aut_a", { status: "paused", ...overrides })]));

      expect(control(f, "aut_a", "resume")).toEqual({ ok: true, status: "done" });
    },
  );

  it("deletes a schedule and drops it from the ledger", () => {
    const f = fixture();
    retain(f, f.source([schedule("aut_a"), schedule("aut_b")]), "autonomous-delivery");

    expect(control(f, "aut_a", "delete")).toEqual({ ok: true, status: "deleted" });

    expect(retainedRows(f, "SELECT id FROM automation")).toEqual([{ id: "aut_b" }]);
    expect(manifest(f).scheduleModes).toEqual({ aut_b: "autonomous-delivery" });
    expect(control(f, "aut_b", "delete")).toEqual({ ok: true, status: "deleted" });
    expect(manifest(f)).not.toHaveProperty("scheduleModes");
  });

  it("refuses an unknown schedule and a task without an entry", () => {
    const f = fixture();
    expect(control(f, "aut_a", "delete")).toEqual({ ok: false, reason: "no-retained-state" });

    retain(f, f.source([schedule("aut_a")]));
    expect(control(f, "aut_zz", "pause")).toEqual({ ok: false, reason: "not-found" });
  });
});
