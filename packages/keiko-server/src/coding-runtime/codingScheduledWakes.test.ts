import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { CodingWorkbenchMode } from "@oscharko-dev/keiko-contracts";
import { CODING_WORKBENCH_MODES } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench";
import { ACTIVITY_LOG_OPERATION_REGISTRY } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  CodingScheduledWakes,
  MAX_MISSES,
  MIN_WAKE_INTERVAL_MS,
  narrowerMode,
  scheduleDigest,
  type ScheduledWakeBlock,
  type ScheduledWakePlan,
  type ScheduledWakeStart,
} from "./codingScheduledWakes.js";
import { OPENCODE_PERSISTENCE_SCHEMAS } from "./opencodePersistenceContract.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  createRetainedSessionStore,
  retainedSessionKey,
  type RetainedSessionStore,
} from "./opencodeSessionRetention.js";

/**
 * #4271 (ADR-0137 D10, owner decision 2026-11-06 "Keiko weckt die Aufgabe"): the service that
 * continues a task when one of its retained schedules is due, against a real retention store and a
 * scripted orchestrator host.
 */

const SESSION_ID = "ses_retained_1";
const WORKSPACE = "/work/space";
const VERSION = OPENCODE_PINNED_VERSION;
const NOW = 1_800_000_000_000;
const WORKSPACE_KEY = createHash("sha256").update("workspace").digest("hex");
const TASK = "task-1";
const PROMPT = "SECRET-SCHEDULED-PROMPT";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Row {
  readonly id: string;
  readonly status?: string;
  readonly dueAt?: number;
  readonly runCount?: number;
}

function sourceDatabase(path: string, rows: readonly Row[]): void {
  const database = new DatabaseSync(path);
  try {
    for (const [table, columns] of Object.entries(OPENCODE_PERSISTENCE_SCHEMAS[VERSION] ?? {})) {
      database.exec(`CREATE TABLE "${table}" (${columns.map((name) => `"${name}"`).join(", ")})`);
    }
    database
      .prepare("INSERT INTO session_v2 (id, directory, version) VALUES (?, ?, ?)")
      .run(SESSION_ID, WORKSPACE, VERSION);
    for (const [index, row] of rows.entries()) {
      database
        .prepare(
          `INSERT INTO schedule (id, session_id, status, name, "when", action, next_due_at, run_count,
             failures, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          row.id,
          SESSION_ID,
          row.status ?? "active",
          "Check the build",
          JSON.stringify({ type: "every", every: "30 minutes" }),
          JSON.stringify({ type: "prompt", prompt: PROMPT }),
          row.dueAt ?? NOW,
          row.runCount ?? 0,
          index,
          index,
        );
    }
  } finally {
    database.close();
  }
}

interface Harness {
  readonly store: RetainedSessionStore;
  readonly clock: { value: number };
  readonly sink: ReturnType<typeof createBufferedServerLogSink>;
  readonly starts: ScheduledWakePlan[];
  readonly state: {
    block: ScheduledWakeBlock | undefined;
    admitted: boolean;
    owned: boolean;
    live: string | undefined;
    next: ScheduledWakeStart;
  };
  readonly wakes: CodingScheduledWakes;
  retain(rows: readonly Row[], mode?: CodingWorkbenchMode): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "keiko-scheduled-wakes-"));
  roots.push(root);
  mkdirSync(join(root, "run"));
  const clock = { value: NOW };
  const store = createRetainedSessionStore({
    root: join(root, "retained"),
    now: () => clock.value,
  });
  const sink = createBufferedServerLogSink();
  const starts: ScheduledWakePlan[] = [];
  const state: Harness["state"] = {
    block: undefined,
    admitted: true,
    owned: true,
    live: undefined,
    next: { ok: true, runId: "run-wake-1", mode: "supervised-coding" },
  };
  let sources = 0;
  const wakes = new CodingScheduledWakes({
    store: () => store,
    activityLog: sink,
    now: () => clock.value,
    host: {
      blocked: () => state.block,
      taskAdmitted: () => state.admitted,
      taskOwned: () => state.owned,
      liveTaskId: () => state.live,
      start: (plan) => {
        starts.push(plan);
        return Promise.resolve(state.next);
      },
      serial: (work) => Promise.resolve(work()),
    },
  });
  return {
    store,
    clock,
    sink,
    starts,
    state,
    wakes,
    retain(rows, mode = "supervised-coding") {
      sources += 1;
      const path = join(root, "run", `opencode-${String(sources)}.db`);
      sourceDatabase(path, rows);
      const result = store.retain({
        binding: {
          taskId: TASK,
          workspaceKey: WORKSPACE_KEY,
          runtimeVersion: VERSION,
          maxInputTokens: 24_000,
        },
        sessionId: SESSION_ID,
        directory: WORKSPACE,
        sourceDatabase: path,
        scheduleConsentMode: mode,
      });
      expect(result).toMatchObject({ ok: true });
    },
  };
}

function lines(
  h: Harness,
  op: string,
): readonly (Record<string, unknown> & { readonly correlationId?: string })[] {
  return h.sink.events
    .filter((event) => event.op === op)
    .map((event) => {
      // The sink stamps completeness and loss on every line; the assertions are about the rest.
      const { completeness: _completeness, loss: _loss, ...fields } = event.extra ?? {};
      return { ...fields, correlationId: event.correlationId };
    });
}

function wakeOutcomes(h: Harness): readonly unknown[] {
  return lines(h, "coding-runtime.schedule.wake").map((line) => line.outcome);
}

describe("waking a task when its schedule is due", () => {
  it("starts nothing before a schedule is due", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW + 60_000 }]);

    await h.wakes.tick();

    expect(h.starts).toEqual([]);
    expect(h.sink.events).toEqual([]);
  });

  it("starts the earliest due schedule's wake with its prompt and consent, and records it", async () => {
    const h = harness();
    h.retain([
      { id: "sch_late", dueAt: NOW - 1_000 },
      { id: "sch_early", dueAt: NOW - 5_000 },
    ]);

    await h.wakes.tick();

    expect(h.starts).toEqual([
      { taskId: TASK, scheduleId: "sch_early", intent: PROMPT, consentMode: "supervised-coding" },
    ]);
    const [started] = lines(h, "coding-runtime.schedule.wake");
    expect(started).toEqual({
      outcome: "started",
      taskDigest: retainedSessionKey(TASK),
      scheduleDigest: scheduleDigest("sch_early"),
      runId: "run-wake-1",
      mode: "supervised-coding",
      dueLagMs: 5_000,
      correlationId: "run-wake-1",
    });
    expectActivityLogProof(
      "coding-runtime.schedule.wake.emitted-line",
      formatActivityLogProofLine(h.sink.events[0] ?? {}),
    );
    // The schedule's id and prompt never enter the log: the id only as a digest.
    expect(JSON.stringify(h.sink.events)).not.toContain(PROMPT);
    expect(JSON.stringify(h.sink.events)).not.toContain("sch_early");
  });

  it.each([
    ["a run holds the slot", { block: "run-active" }, "run-active"],
    ["the undo window is open", { block: "undo-window" }, "run-active"],
    ["the task's workspace is not active", { admitted: false }, "workspace-inactive"],
  ] as const)("waits while %s, and records the wait once", async (_name, state, wait) => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    Object.assign(h.state, state);

    await h.wakes.tick();
    await h.wakes.tick();

    expect(h.starts).toEqual([]);
    expect(lines(h, "coding-runtime.schedule.wake")).toEqual([
      expect.objectContaining({ outcome: "waiting", wait }),
    ]);
    expect(lines(h, "coding-runtime.schedule.wake")[0]?.correlationId).toMatch(
      /^schedule-[0-9a-f]{32}$/u,
    );
    expect(h.wakes.list(TASK, "corr-list-1")).toMatchObject({
      ok: true,
      schedules: [{ id: "sch_a", wait }],
    });
  });

  it("starts nothing and records nothing while Keiko shuts down", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    h.state.block = "shutting-down";

    await h.wakes.tick();

    expect(h.starts).toEqual([]);
    expect(h.sink.events).toEqual([]);
  });

  it("settles a wake as fired once its run's retained entry shows the schedule ran", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    await h.wakes.tick();

    // The wake run is still running: its entry is the old one, so nothing else starts.
    h.clock.value += 1_000;
    await h.wakes.tick();
    expect(wakeOutcomes(h)).toEqual(["started"]);

    h.clock.value += 1_000;
    h.retain([{ id: "sch_a", dueAt: NOW + 1_800_000, runCount: 1 }]);
    await h.wakes.tick();

    expect(wakeOutcomes(h)).toEqual(["started", "fired"]);
    expect(lines(h, "coding-runtime.schedule.wake")[1]).toMatchObject({
      firedCount: 1,
      runId: "run-wake-1",
      correlationId: "run-wake-1",
    });
    expect(h.starts).toHaveLength(1);
  });

  it("counts a wake whose schedule did not fire as a miss and pauses the schedule after the last", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);

    for (let attempt = 1; attempt <= MAX_MISSES; attempt += 1) {
      await h.wakes.tick();
      expect(h.starts).toHaveLength(attempt);
      // The run settled without firing: the entry is newer, the run count unchanged.
      h.clock.value += 1_000;
      h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
      await h.wakes.tick();
      // Backoff and the minimum interval keep the next attempt away until they pass.
      h.clock.value += 4 * 3_600_000;
    }

    // After a miss the same look finds the schedule backing off, and records that wait.
    expect(wakeOutcomes(h)).toEqual([
      "started",
      "missed",
      "waiting",
      "started",
      "missed",
      "waiting",
      "started",
      "auto-paused",
    ]);
    expect(lines(h, "coding-runtime.schedule.control")).toEqual([
      expect.objectContaining({
        action: "pause",
        outcome: "changed",
        initiator: "missed-wakes",
        status: "paused",
      }),
    ]);
    expect(h.wakes.list(TASK, "corr-list-2")).toMatchObject({
      ok: true,
      schedules: [{ id: "sch_a", status: "paused" }],
    });
    await h.wakes.tick();
    expect(h.starts).toHaveLength(MAX_MISSES);
  });

  it("backs off after a miss and waits the minimum interval between a task's wakes", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    h.state.next = { ok: false, refusal: "start-failed" };

    await h.wakes.tick();
    expect(wakeOutcomes(h)).toEqual(["refused", "missed"]);

    h.state.next = { ok: true, runId: "run-wake-2", mode: "governed-assist" };
    h.clock.value += MIN_WAKE_INTERVAL_MS - 1;
    await h.wakes.tick();
    expect(h.starts).toHaveLength(1);
    expect(wakeOutcomes(h).at(-1)).toBe("waiting");

    h.clock.value += 60_001;
    await h.wakes.tick();
    expect(h.starts).toHaveLength(2);
  });

  it("does not count a start that lost the slot to another run as a miss", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    h.state.next = { ok: false, refusal: "active-run-conflict" };

    await h.wakes.tick();

    expect(wakeOutcomes(h)).toEqual(["refused"]);
    expect(lines(h, "coding-runtime.schedule.wake")[0]).toMatchObject({
      refusal: "active-run-conflict",
    });
  });

  it("records a lost retention when the wake run never leaves its entry", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    await h.wakes.tick();

    h.clock.value += 600_001;
    await h.wakes.tick();

    expect(wakeOutcomes(h).slice(0, 2)).toEqual(["started", "retain-lost"]);
  });

  it("records a removed schedule when the wake run deleted it", async () => {
    const h = harness();
    h.retain([
      { id: "sch_a", dueAt: NOW - 1 },
      { id: "sch_b", dueAt: NOW + 3_600_000 },
    ]);
    await h.wakes.tick();

    h.clock.value += 1_000;
    h.retain([{ id: "sch_b", dueAt: NOW + 3_600_000 }]);
    await h.wakes.tick();

    expect(wakeOutcomes(h)).toEqual(["started", "removed"]);
  });

  it("records a look that fails, and looks again at the next tick", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    h.state.next = { ok: true, runId: "run-wake-3", mode: "governed-assist" };
    const failing = new CodingScheduledWakes({
      store: () => h.store,
      activityLog: h.sink,
      now: () => h.clock.value,
      host: {
        blocked: () => undefined,
        taskAdmitted: () => {
          throw new Error("store fault");
        },
        taskOwned: () => true,
        liveTaskId: () => undefined,
        start: () => Promise.resolve(h.state.next),
        serial: (work) => Promise.resolve(work()),
      },
    });

    await failing.tick();

    expect(lines(h, "coding-runtime.schedule.wake")).toEqual([
      expect.objectContaining({ outcome: "failed", causeChain: expect.any(Array) as unknown }),
    ]);
    expect(h.sink.events[0]).toMatchObject({ level: "warn", errorKind: "internal" });
  });

  it("stops looking once stopped", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    h.wakes.start();
    h.wakes.stop();
    h.wakes.start();

    await h.wakes.tick();

    expect(h.starts).toEqual([]);
  });
});

describe("listing and controlling a task's schedules", () => {
  it("lists a task's schedules without their prompt", () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW + 60_000, runCount: 2 }]);

    const listed = h.wakes.list(TASK, "corr-list-3");

    expect(listed).toEqual({
      ok: true,
      schedules: [
        {
          id: "sch_a",
          name: "Check the build",
          status: "active",
          cadence: "every",
          cadenceText: "30 minutes",
          dueAt: new Date(NOW + 60_000).toISOString(),
          runCount: 2,
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain(PROMPT);
    expect(lines(h, "coding-runtime.schedule.control")).toEqual([
      {
        action: "list",
        outcome: "listed",
        initiator: "human",
        taskDigest: retainedSessionKey(TASK),
        scheduleCount: 1,
        correlationId: "corr-list-3",
      },
    ]);
    expectActivityLogProof(
      "coding-runtime.schedule.control.emitted-line",
      formatActivityLogProofLine(h.sink.events[0] ?? {}),
    );
  });

  it("lists nothing for a task that is not the operator's", () => {
    const h = harness();
    h.retain([{ id: "sch_a" }]);
    h.state.owned = false;

    expect(h.wakes.list(TASK, "corr-list-4")).toEqual({ ok: false, reason: "not-found" });
  });

  it("pauses, resumes and deletes a schedule, and records each change", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW + 60_000 }]);

    await expect(h.wakes.control(TASK, "sch_a", "pause", "corr-c-1")).resolves.toEqual({
      ok: true,
      status: "paused",
    });
    await expect(h.wakes.control(TASK, "sch_a", "pause", "corr-c-2")).resolves.toEqual({
      ok: false,
      reason: "not-applicable",
    });
    await expect(h.wakes.control(TASK, "sch_a", "resume", "corr-c-3")).resolves.toEqual({
      ok: true,
      status: "active",
    });
    await expect(h.wakes.control(TASK, "sch_a", "delete", "corr-c-4")).resolves.toEqual({
      ok: true,
      status: "deleted",
    });

    expect(
      lines(h, "coding-runtime.schedule.control").map((line) => [
        line.action,
        line.outcome,
        line.status ?? line.reason,
        line.correlationId,
      ]),
    ).toEqual([
      ["pause", "changed", "paused", "corr-c-1"],
      ["pause", "refused", "not-applicable", "corr-c-2"],
      ["resume", "changed", "active", "corr-c-3"],
      ["delete", "changed", "deleted", "corr-c-4"],
    ]);
  });

  it("refuses a change while the task's run is live or its wake is pending", async () => {
    const h = harness();
    h.retain([{ id: "sch_a", dueAt: NOW - 1 }]);
    h.state.live = TASK;
    await expect(h.wakes.control(TASK, "sch_a", "pause", "corr-c-5")).resolves.toEqual({
      ok: false,
      reason: "run-active",
    });

    h.state.live = undefined;
    await h.wakes.tick();
    await expect(h.wakes.control(TASK, "sch_a", "delete", "corr-c-6")).resolves.toEqual({
      ok: false,
      reason: "run-active",
    });
  });

  it("records a change that fails as failed and unavailable", async () => {
    const h = harness();
    h.retain([{ id: "sch_a" }]);
    const failing = new CodingScheduledWakes({
      store: () => h.store,
      activityLog: h.sink,
      host: {
        blocked: () => undefined,
        taskAdmitted: () => true,
        taskOwned: () => true,
        liveTaskId: () => undefined,
        start: () => Promise.resolve(h.state.next),
        serial: () => Promise.reject(new Error("lane fault")),
      },
    });

    await expect(failing.control(TASK, "sch_a", "pause", "corr-c-7")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(lines(h, "coding-runtime.schedule.control")).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "unavailable" }),
    ]);
    expect(h.sink.events[0]).toMatchObject({ level: "warn", errorKind: "internal" });
  });
});

describe("the narrower mode", () => {
  it.each([
    ["governed-assist", "autonomous-delivery", "governed-assist"],
    ["autonomous-delivery", "supervised-coding", "supervised-coding"],
    ["supervised-coding", "supervised-coding", "supervised-coding"],
  ] as const)("of %s and %s is %s", (left, right, expected) => {
    expect(narrowerMode(left, right)).toBe(expected);
  });
});

describe("the wake line's registered vocabulary", () => {
  it("names every mode a wake can run in", () => {
    const registration = ACTIVITY_LOG_OPERATION_REGISTRY.find(
      (operation) => operation.op === "coding-runtime.schedule.wake",
    );
    const mode = registration?.fields.mode as { readonly values?: readonly string[] } | undefined;

    expect([...(mode?.values ?? [])].sort()).toEqual([...CODING_WORKBENCH_MODES].sort());
  });
});
