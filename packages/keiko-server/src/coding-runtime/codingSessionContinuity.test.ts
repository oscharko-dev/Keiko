import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createCodingSessionContinuity,
  createStateCodingSessionContinuity,
  recordSessionContinuity,
  retainedSessionRoot,
  sessionRetentionEnabled,
  type ContinuityIntent,
} from "./codingSessionContinuity.js";
import { retainedSessionKey } from "./opencodeSessionRetention.js";

const RUN = "run-continuity-0001";
const RESUME: ContinuityIntent = { kind: "resume", taskId: "task-secret-id" };

function service(): ReturnType<typeof createCodingSessionContinuity> {
  return createCodingSessionContinuity({ taskOfRun: () => undefined });
}

describe("the continuity declaration between the orchestrator and the composition", () => {
  it("hands a declaration to the composition once", () => {
    const continuity = service();

    continuity.declare(RUN, RESUME);

    expect(continuity.take(RUN)).toEqual(RESUME);
    expect(continuity.take(RUN)).toBeUndefined();
  });

  it("keeps declarations of different runs apart and takes nothing for a run that declared none", () => {
    const continuity = service();
    continuity.declare("run-a-000001", RESUME);
    continuity.declare("run-b-000001", {
      kind: "fork",
      sourceTaskId: "t",
      boundary: { kind: "end" },
    });

    expect(continuity.take("run-c-000001")).toBeUndefined();
    expect(continuity.take("run-b-000001")).toMatchObject({ kind: "fork" });
    expect(continuity.take("run-a-000001")).toEqual(RESUME);
  });

  it("settles what happened for the orchestrator to read, and forgets a run", () => {
    const continuity = service();
    expect(continuity.outcome(RUN)).toBeUndefined();

    continuity.settle(RUN, { kind: "fresh", reason: "version-changed" });
    expect(continuity.outcome(RUN)).toEqual({ kind: "fresh", reason: "version-changed" });
    continuity.settle(RUN, { kind: "resumed" });
    expect(continuity.outcome(RUN)).toEqual({ kind: "resumed" });

    continuity.declare(RUN, RESUME);
    continuity.forget(RUN);
    expect(continuity.take(RUN)).toBeUndefined();
    expect(continuity.outcome(RUN)).toBeUndefined();
  });

  it("bounds what a run that never launched can leave behind", () => {
    const continuity = service();
    for (let index = 0; index < 20; index += 1) {
      continuity.declare(`run-${String(index).padStart(6, "0")}`, RESUME);
      continuity.settle(`run-${String(index).padStart(6, "0")}`, { kind: "resumed" });
    }

    expect(continuity.take("run-000000")).toBeUndefined();
    expect(continuity.outcome("run-000003")).toBeUndefined();
    expect(continuity.take("run-000019")).toEqual(RESUME);
    expect(continuity.outcome("run-000019")).toEqual({ kind: "resumed" });
  });

  it("exposes the store and the run-to-task lookup it was given", () => {
    const continuity = createCodingSessionContinuity({ taskOfRun: (runId) => `task-of-${runId}` });

    expect(continuity.store).toBeUndefined();
    expect(continuity.taskOfRun("run-x")).toBe("task-of-run-x");
  });
});

describe("the session retention setting", () => {
  it.each([
    [undefined, true],
    ["on", true],
    ["off", false],
    ["ON", false],
    ["", false],
    ["1", false],
    ["true", false],
  ])("reads %j as enabled=%s and fails closed on anything it does not know", (value, enabled) => {
    expect(sessionRetentionEnabled(value)).toBe(enabled);
  });
});

describe("the continuity service over a state directory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stateDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "keiko-continuity-state-"));
    dirs.push(dir);
    return dir;
  }

  it("keeps its retained entries beside the runs' private state, inside the state directory", () => {
    expect(retainedSessionRoot("/state")).toBe(
      join("/state", "coding-runtime", "retained-sessions"),
    );
  });

  it.each([
    [undefined, true],
    ["on", true],
    ["off", false],
    ["unknown", false],
  ])("offers a store when KEIKO_CODING_SESSION_RETENTION is %j: %s", (retention, offered) => {
    const service = createStateCodingSessionContinuity({
      stateDir: stateDir(),
      retention,
      history: undefined,
      activityLog: undefined,
    });

    expect(service.store !== undefined).toBe(offered);
  });

  it("finds the task of a run through Coding History, and none without it", () => {
    const history = {
      get: (): unknown => undefined,
      forRun: (runId: string): { readonly id: string } | undefined =>
        runId === "run-known-1" ? { id: "task-known" } : undefined,
    };
    const withHistory = createStateCodingSessionContinuity({
      stateDir: stateDir(),
      retention: undefined,
      history,
      activityLog: undefined,
    });
    const without = createStateCodingSessionContinuity({
      stateDir: stateDir(),
      retention: undefined,
      history: undefined,
      activityLog: undefined,
    });

    expect(withHistory.taskOfRun("run-known-1")).toBe("task-known");
    expect(withHistory.taskOfRun("run-other-1")).toBeUndefined();
    expect(without.taskOfRun("run-known-1")).toBeUndefined();
  });

  it("removes what the state directory holds that is not a usable entry, once at startup, and says how much", () => {
    const dir = stateDir();
    const entry = join(retainedSessionRoot(dir), retainedSessionKey("task-without-manifest"));
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "manifest.json"), "{}");
    const log = createBufferedServerLogSink();

    const service = createStateCodingSessionContinuity({
      stateDir: dir,
      retention: undefined,
      history: { get: () => ({}), forRun: () => undefined },
      activityLog: log,
    });

    expect(service.store).toBeDefined();
    expect(existsSync(entry)).toBe(false);
    const [event] = log.events;
    expect(event).toMatchObject({
      op: "coding-runtime.session-continuity",
      extra: { action: "prune", outcome: "pruned", prunedCount: 1, entryCount: 0 },
    });
    expectActivityLogProof(
      "coding-runtime.session-continuity.emitted-line",
      formatActivityLogProofLine(event ?? {}),
    );
  });

  it("writes nothing at startup when there was nothing to remove", () => {
    const log = createBufferedServerLogSink();

    createStateCodingSessionContinuity({
      stateDir: stateDir(),
      retention: undefined,
      history: undefined,
      activityLog: log,
    });

    expect(log.events).toEqual([]);
  });
});

describe("the session continuity line", () => {
  function written(
    write: (log: ReturnType<typeof createBufferedServerLogSink>) => void,
  ): Record<string, unknown> {
    const log = createBufferedServerLogSink();
    write(log);
    const [event] = log.events.filter((entry) => entry.op === "coding-runtime.session-continuity");
    if (event === undefined) throw new Error("no continuity line was written");
    return expectActivityLogProof(
      "coding-runtime.session-continuity.emitted-line",
      formatActivityLogProofLine(event),
    );
  }

  it("records a retention with counts and byte sizes under the run's correlation", () => {
    const line = written((log) => {
      recordSessionContinuity(log, {
        runId: RUN,
        action: "retain",
        outcome: "retained",
        taskId: "task-secret-id",
        databaseBytes: 4096,
        messageCount: 12,
        entryCount: 3,
        prunedCount: 1,
      });
    });

    expect(line).toMatchObject({
      correlationId: RUN,
      runId: RUN,
      action: "retain",
      outcome: "retained",
      taskDigest: retainedSessionKey("task-secret-id"),
      databaseBytes: 4096,
      messageCount: 12,
      entryCount: 3,
      prunedCount: 1,
    });
    expect(line.level).not.toBe("warn");
    expect(JSON.stringify(line)).not.toContain("task-secret-id");
  });

  it("records a fork with the digest of its source and its boundary, never an id", () => {
    const line = written((log) => {
      recordSessionContinuity(log, {
        runId: RUN,
        action: "fork",
        outcome: "forked",
        taskId: "forked-task-id",
        sourceTaskId: "source-task-id",
        boundary: "turn",
        messageCount: 7,
        ageMs: 1500,
      });
    });

    expect(line).toMatchObject({
      action: "fork",
      outcome: "forked",
      taskDigest: retainedSessionKey("forked-task-id"),
      sourceTaskDigest: retainedSessionKey("source-task-id"),
      boundary: "turn",
      messageCount: 7,
      ageMs: 1500,
    });
    expect(JSON.stringify(line)).not.toContain("source-task-id");
    expect(JSON.stringify(line)).not.toContain("forked-task-id");
  });

  it("records a refusal as a warning with its closed reason", () => {
    const line = written((log) => {
      recordSessionContinuity(log, {
        runId: RUN,
        action: "resume",
        outcome: "refused",
        reason: "grant-present",
        taskId: "task-secret-id",
      });
    });

    expect(line).toMatchObject({
      level: "warn",
      errorKind: "validation-failed",
      outcome: "refused",
      reason: "grant-present",
    });
  });

  it("records a failure with its error kind, Keiko frames and cause chain", () => {
    const line = written((log) => {
      recordSessionContinuity(log, {
        runId: RUN,
        action: "retain",
        outcome: "failed",
        reason: "copy-failed",
        error: new Error("disk full at /secret/path", { cause: new TypeError("inner") }),
      });
    });

    expect(line).toMatchObject({ level: "warn", errorKind: "internal", reason: "copy-failed" });
    expect(Array.isArray(line.frames)).toBe(true);
    expect(Array.isArray(line.causeChain)).toBe(true);
    expect(JSON.stringify(line)).not.toContain("/secret/path");
  });

  it("falls back to the sanctioned correlation id for a run id the log cannot carry", () => {
    const line = written((log) => {
      recordSessionContinuity(log, {
        runId: "x",
        action: "prune",
        outcome: "pruned",
        prunedCount: 2,
        entryCount: 1,
      });
    });

    expect(line.correlationId).toBe("unknown-correlation-id");
  });
});
