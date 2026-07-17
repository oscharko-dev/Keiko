/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
import { describe, expect, it, vi } from "vitest";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import {
  createCodingRuntimeOrchestrator,
  type CodingRuntimeOrchestratorResult,
} from "./codingRuntimeOrchestrator.js";

function successfulSnapshot(result: CodingRuntimeOrchestratorResult) {
  if (!result.ok) throw new Error(`expected success, received ${result.failureCode}`);
  return result.snapshot;
}

function rowFor(
  rows: ReadonlyMap<string, CodingRuntimeSnapshot>,
  id: string,
): CodingRuntimeSnapshot {
  const row = rows.get(id);
  if (!row) throw new Error(`missing fixture row: ${id}`);
  return row;
}

function fixture() {
  const rows = new Map<string, CodingRuntimeSnapshot>();
  const listPrunableSettled = vi.fn((): readonly string[] => []);
  const deletePruned = vi.fn();
  const store: CodingRuntimeSnapshotStore = {
    create: (row) => (rows.set(row.runId, row), row),
    transition: (id, change) => {
      const current = rowFor(rows, id);
      const next = { ...current, ...change } as CodingRuntimeSnapshot;
      rows.set(id, next);
      return next;
    },
    get: (id) => rows.get(id),
    listRecentActive: () => [...rows.values()].filter((r) => !r.terminalAt),
    listAll: () => [...rows.values()],
    markNonterminalRecoveryRequired: (at) => {
      const changed: string[] = [];
      for (const [id, row] of rows)
        if (!row.terminalAt && row.state !== "recovery-required") {
          rows.set(id, {
            ...row,
            state: "recovery-required",
            revision: row.revision + 1,
            updatedAt: at,
            failureCode: "recovery-required",
          });
          changed.push(id);
        }
      return changed;
    },
    acknowledgeRecovery: (id, at) => {
      const row = rowFor(rows, id);
      const next = { ...row, recoveryAcknowledgedAt: at };
      rows.set(id, next);
      return next;
    },
    releaseRecoveryForRetry: (id, at) => {
      const row = rowFor(rows, id);
      const next = { ...row, terminalAt: at, updatedAt: at };
      rows.set(id, next);
      return next;
    },
    delete: (id) => void rows.delete(id),
    listPrunableSettled,
    deletePruned,
  };
  const manager = {
    start: vi.fn<CodingRuntimeManager["start"]>((request) => ({
      ok: true,
      runId: request.runId,
      status: "ready",
    })),
    stop: vi.fn<CodingRuntimeManager["stop"]>(() =>
      Promise.resolve({ ok: true, status: "stopped" }),
    ),
    takeover: vi.fn<CodingRuntimeManager["takeover"]>(() =>
      Promise.resolve({
        ok: true,
        status: "stopped",
      }),
    ),
    health: vi.fn<CodingRuntimeManager["health"]>(() => ({ status: "stopped" })),
    issueApproval: vi.fn<CodingRuntimeManager["issueApproval"]>(() => ({
      ok: true,
      approval: {} as never,
      approvalDigest: "d",
      expiresAtMs: 1,
    })),
    pause: vi.fn<CodingRuntimeManager["pause"]>(() => ({ ok: true, paused: true })),
    resume: vi.fn<CodingRuntimeManager["resume"]>(() => ({ ok: true, paused: false })),
    reconcile: vi.fn<CodingRuntimeManager["reconcile"]>(() =>
      Promise.resolve({
        ok: true,
        status: "stopped",
      }),
    ),
  };
  const eventHub = { publish: vi.fn(() => ({ ok: true })), deleteRuns: vi.fn() };
  const evidence = { observe: vi.fn(), settle: vi.fn(() => "evidence"), deletePruned: vi.fn() };
  const approvalAuthority = { issue: manager.issueApproval };
  const dispatch = vi.fn<CodingRuntimeTaskDispatcher["dispatch"]>(() =>
    Promise.resolve({
      ok: true as const,
      completion: Promise.resolve("succeeded" as const),
    }),
  );
  const taskDispatcher = {
    dispatch,
    abort: vi.fn(() => Promise.resolve(true)),
  } satisfies CodingRuntimeTaskDispatcher;
  const launchResolver = {
    resolve: vi.fn(() => ({
      taskRef: "task-1",
      treeBindingId: "tree",
      adapterKind: "codex-cli",
      runtimeSource: "codex-cli-adapter",
      modelSource: "keiko-model-gateway",
      effectiveMode: "supervised-coding",
      executablePath: "/bin/runtime",
      managedRoot: "/managed",
      gatewayUrl: "http://127.0.0.1",
      modelProfileId: "profile",
      args: [],
      inheritedEnvAllowlist: [],
      shutdownTimeoutMs: 1,
      startTimeoutMs: 1,
    })),
  };
  const questionPort = {
    list: vi.fn<CodingRuntimeQuestionPort["list"]>(() => Promise.resolve({ questions: [] })),
    answer: vi.fn(() => Promise.resolve(true)),
    reject: vi.fn(() => Promise.resolve(true)),
  } satisfies CodingRuntimeQuestionPort;
  const orchestrator = createCodingRuntimeOrchestrator({
    manager: manager,
    approvalAuthority,
    eventHub: eventHub as never,
    snapshots: store,
    evidence,
    workspaceLifecycle: {
      getActive: () => ({
        instance: { workspaceId: "workspace-1" },
        binding: { activeRoot: "/workspace" },
      }),
    } as never,
    launchResolver: launchResolver as never,
    taskDispatcher,
    questionPort,
    serverPrincipal: () => "server",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newRunId: () => `run-${String(rows.size + 1)}`,
  });
  return {
    orchestrator,
    manager,
    approvalAuthority,
    rows,
    evidence,
    eventHub,
    launchResolver,
    taskDispatcher,
    questionPort,
    listPrunableSettled,
    deletePruned,
  };
}

const start = {
  requestId: "request-1",
  taskIntent: "fix the bounded issue",
  requestedMode: "supervised-coding",
} as const;

describe("CodingRuntimeOrchestrator", () => {
  it("dispatches transient initial intent after launch and exposes a running run", async () => {
    const f = fixture();

    const result = await f.orchestrator.start(start);

    expect(successfulSnapshot(result).state).toBe("running");
    expect(f.taskDispatcher.dispatch).toHaveBeenCalledWith({
      runId: "run-1",
      requestId: start.requestId,
      expectedRevision: 2,
      taskIntent: start.taskIntent,
    });
    expect(JSON.stringify([...f.rows.values()])).not.toContain(start.taskIntent);
  });

  it("serializes follow-ups by run, revision, and one-use request id", async () => {
    const f = fixture();
    await f.orchestrator.start(start);

    const request = {
      requestId: "follow-up-1",
      expectedRevision: 3,
      taskIntent: "continue bounded work",
    };
    const [first, raced] = await Promise.all([
      f.orchestrator.submitFollowUp("run-1", request),
      f.orchestrator.submitFollowUp("run-1", { ...request, requestId: "follow-up-race" }),
    ]);

    expect(successfulSnapshot(first).revision).toBe(4);
    expect(raced).toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(await f.orchestrator.submitFollowUp("run-1", request)).toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(
      await f.orchestrator.submitFollowUp("stale-run", {
        ...request,
        requestId: "follow-up-stale",
        expectedRevision: 4,
      }),
    ).toEqual({ ok: false, failureCode: "invalid-intent" });
  });

  it("allows a new follow-up request at the unchanged revision after adapter refusal", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.taskDispatcher.dispatch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, completion: Promise.resolve("succeeded") });

    await expect(
      f.orchestrator.submitFollowUp("run-1", {
        requestId: "follow-up-refused",
        expectedRevision: 3,
        taskIntent: "first bounded retry",
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(f.orchestrator.status().revision).toBe(3);
    await expect(
      f.orchestrator.submitFollowUp("run-1", {
        requestId: "follow-up-retry",
        expectedRevision: 3,
        taskIntent: "second bounded retry",
      }),
    ).resolves.toMatchObject({ ok: true, snapshot: { revision: 4 } });
  });

  it("serializes transient questions without retaining their content", async () => {
    const f = fixture();
    f.questionPort.list.mockResolvedValueOnce({
      questions: [
        {
          id: "que_1",
          questions: [{ question: "Private?", header: "Private", options: [] }],
        },
      ],
    });
    await f.orchestrator.start(start);

    // Listing is a read: the revision must stay stable so background question refreshes never
    // race a concurrent operator action (pause/answer/follow-up) into a revision conflict.
    const listed = await f.orchestrator.listQuestions("run-1", {
      requestId: "question-list-1",
      expectedRevision: 3,
    });
    expect(listed).toMatchObject({ ok: true, snapshot: { revision: 3 } });
    expect(JSON.stringify([...f.rows.values()])).not.toContain("Private?");
    expect(
      await f.orchestrator.answerQuestion("run-1", {
        requestId: "question-answer-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Continue"]],
      }),
    ).toMatchObject({ ok: true, snapshot: { revision: 4 } });
    expect(
      await f.orchestrator.rejectQuestion("run-1", {
        requestId: "question-answer-1",
        expectedRevision: 4,
        questionId: "que_1",
      }),
    ).toEqual({ ok: false, failureCode: "invalid-intent" });
  });

  it("allows question retries at unchanged revisions after adapter refusal", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.questionPort.list.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ questions: [] });

    await expect(
      f.orchestrator.listQuestions("run-1", {
        requestId: "question-list-refused",
        expectedRevision: 3,
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(f.orchestrator.status().revision).toBe(3);
    await expect(
      f.orchestrator.listQuestions("run-1", {
        requestId: "question-list-retry",
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({ ok: true, snapshot: { revision: 3 } });

    f.questionPort.answer.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const answer = (requestId: string) =>
      f.orchestrator.answerQuestion("run-1", {
        requestId,
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Continue"]],
      });
    await expect(answer("question-answer-refused")).resolves.toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });
    expect(f.orchestrator.status().revision).toBe(3);
    await expect(answer("question-answer-retry")).resolves.toMatchObject({
      ok: true,
      snapshot: { revision: 4 },
    });
  });

  it("requires recovery when a rejected first turn cannot prove runtime stop", async () => {
    const f = fixture();
    f.taskDispatcher.dispatch.mockResolvedValueOnce({ ok: false });
    f.manager.stop.mockResolvedValueOnce({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });

    expect(successfulSnapshot(await f.orchestrator.start(start))).toMatchObject({
      state: "recovery-required",
      failureCode: "recovery-required",
    });
  });

  it("enforces one active slot and never persists task intent", async () => {
    const f = fixture();
    expect((await f.orchestrator.start(start)).ok).toBe(true);
    expect(await f.orchestrator.start(start)).toEqual({
      ok: false,
      failureCode: "active-run-conflict",
    });
    expect(JSON.stringify([...f.rows.values()])).not.toContain(start.taskIntent);
  });

  it("binds approval to its pending revision and consumes it once", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-0",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-1",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "permission-1",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt: "2026-01-01T00:01:00.000Z",
      },
    });
    expect(
      (
        await f.orchestrator.decideApproval("run-1", {
          requestId: "permission-1",
          decision: "approved",
          expectedRevision: 4,
        })
      ).ok,
    ).toBe(true);
    expect(
      await f.orchestrator.decideApproval("run-1", {
        requestId: "permission-1",
        decision: "approved",
        expectedRevision: 4,
      }),
    ).toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(f.approvalAuthority.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        requestId: "permission-1",
        actionKind: "file-edit",
        approvedByUserId: "server",
        ttlMs: 60_000,
      }),
    );
  });

  it("rejects stale route/body pairs and keeps a failed approval pending", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    expect(await f.orchestrator.stop("other", { requestId: "run-1" })).toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(f.orchestrator.getSnapshot("run-1")?.runId).toBe("run-1");
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "task",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "permission",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "permission-2",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt: "2026-01-01T00:01:00.000Z",
      },
    });
    f.approvalAuthority.issue.mockReturnValueOnce({
      ok: false,
      failureCode: "runtime-stopped",
      retryable: false,
    });
    expect(
      await f.orchestrator.decideApproval("run-1", {
        requestId: "permission-2",
        decision: "approved",
        expectedRevision: 4,
      }),
    ).toMatchObject({ ok: true, snapshot: { state: "failed", failureCode: "runtime-failed" } });
    expect(f.orchestrator.getSnapshot("run-1")?.state).toBe("failed");
  });

  it("requires recovery acknowledgement before fresh retry and records a predecessor", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.startupReconcile();
    expect(await f.orchestrator.retry("run-1", start)).toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    await f.orchestrator.acknowledgeRecovery("run-1", { requestId: "run-1", acknowledged: true });
    await f.orchestrator.retry("run-1", {
      ...start,
      requestId: "request-2",
      runtimePreference: "codex-subscription",
    });
    expect(f.rows.get("run-2")?.predecessorRunId).toBe("run-1");
    expect(f.launchResolver.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimePreference: "codex-subscription" }),
    );
  });

  it("keeps a stop-failure recovery slot addressable until acknowledgement and fresh retry", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.manager.stop.mockResolvedValueOnce({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });
    expect(
      successfulSnapshot(await f.orchestrator.stop("run-1", { requestId: "run-1" })).state,
    ).toBe("recovery-required");
    expect(
      await f.orchestrator.acknowledgeRecovery("run-1", { requestId: "run-1", acknowledged: true }),
    ).toMatchObject({ ok: true });
    expect(
      successfulSnapshot(await f.orchestrator.retry("run-1", { ...start, requestId: "request-3" }))
        .runId,
    ).toBe("run-2");
    expect(f.rows.get("run-2")?.predecessorRunId).toBe("run-1");
  });

  it("recovers startup state without replay and supports stop/takeover settlement", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.startupReconcile();
    expect(f.manager.start).toHaveBeenCalledTimes(1);
    expect(f.orchestrator.snapshot().state).toBe("recovery-required");
    const g = fixture();
    await g.orchestrator.start(start);
    expect(
      successfulSnapshot(await g.orchestrator.takeover("run-1", { requestId: "run-1" })).state,
    ).toBe("taken-over");
    await g.orchestrator.start(start);
    expect(
      successfulSnapshot(await g.orchestrator.stop("run-2", { requestId: "run-2" })).state,
    ).toBe("cancelled");
    expect(g.evidence.settle).toHaveBeenCalled();
  });

  it("contains rejected host lifecycle promises as recovery-required", async () => {
    const startFailure = fixture();
    startFailure.manager.start.mockRejectedValueOnce(new Error("private host failure"));
    expect(successfulSnapshot(await startFailure.orchestrator.start(start)).state).toBe(
      "recovery-required",
    );
    expect(startFailure.manager.reconcile).toHaveBeenCalledWith("run-1");

    const stopFailure = fixture();
    await stopFailure.orchestrator.start(start);
    stopFailure.manager.stop.mockRejectedValueOnce(new Error("private stop failure"));
    expect(
      successfulSnapshot(await stopFailure.orchestrator.stop("run-1", { requestId: "run-1" }))
        .state,
    ).toBe("recovery-required");

    const mismatched = fixture();
    mismatched.manager.start.mockResolvedValueOnce({
      ok: true,
      runId: "run-foreign",
      status: "ready",
    });
    expect(successfulSnapshot(await mismatched.orchestrator.start(start)).state).toBe(
      "recovery-required",
    );
    expect(mismatched.manager.reconcile).toHaveBeenCalledWith("run-foreign");
  });

  it("contains a throwing central approval authority and terminates the waiting runtime", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "task-authority-failure",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "permission-authority-failure",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "permission-3",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt: "2026-01-01T00:01:00.000Z",
      },
    });
    f.approvalAuthority.issue.mockImplementationOnce(() => {
      throw new Error("central approval unavailable");
    });

    const result = await f.orchestrator.decideApproval("run-1", {
      requestId: "permission-3",
      decision: "approved",
      expectedRevision: 4,
    });

    expect(successfulSnapshot(result)).toMatchObject({
      state: "failed",
      failureCode: "authority-resolution-failed",
    });
    expect(f.manager.stop).toHaveBeenCalledWith("run-1");
  });

  it("moves to recovery when event admission fails and deletes evidence for pruned runs", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.eventHub.publish.mockReturnValueOnce({ ok: false });
    expect(
      successfulSnapshot(
        await f.orchestrator.ingest({
          schemaVersion: "1",
          eventId: "event-pressure",
          runId: "run-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          kind: "observation-streamed",
        }),
      ).state,
    ).toBe("recovery-required");

    f.listPrunableSettled.mockReturnValueOnce(["run-old"]);
    f.orchestrator.startupReconcileNow();
    expect(f.evidence.deletePruned).toHaveBeenCalledWith(["run-old"]);
    expect(f.eventHub.deleteRuns).toHaveBeenCalledWith(["run-old"]);
    expect(f.deletePruned).toHaveBeenCalledWith(["run-old"]);
  });

  it("keeps prunable snapshot ids discoverable when auxiliary retention cleanup fails", () => {
    const f = fixture();
    f.listPrunableSettled.mockReturnValue(["run-old"]);
    f.evidence.deletePruned.mockImplementationOnce(() => {
      throw new Error("evidence cleanup unavailable");
    });

    expect(() => {
      f.orchestrator.startupReconcileNow();
    }).toThrow("evidence cleanup unavailable");
    expect(f.deletePruned).not.toHaveBeenCalled();

    f.orchestrator.startupReconcileNow();
    expect(f.evidence.deletePruned).toHaveBeenLastCalledWith(["run-old"]);
    expect(f.deletePruned).toHaveBeenCalledWith(["run-old"]);
  });
});

describe("pause and resume (#2386 adversarial-review regressions)", () => {
  async function runningFixture(): Promise<ReturnType<typeof fixture>> {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-pause-0",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    return f;
  }

  it("propagates pause and resume to the manager admission gate", async () => {
    const f = await runningFixture();
    const paused = await f.orchestrator.pause("run-1", { requestId: "run-1" });
    expect(successfulSnapshot(paused).state).toBe("paused");
    expect(f.manager.pause).toHaveBeenCalledWith("run-1");
    const resumed = await f.orchestrator.resume("run-1", { requestId: "run-1" });
    expect(successfulSnapshot(resumed).state).toBe("running");
    expect(f.manager.resume).toHaveBeenCalledWith("run-1");
  });

  it("keeps a paused run paused when adapter events arrive", async () => {
    const f = await runningFixture();
    await f.orchestrator.pause("run-1", { requestId: "run-1" });
    const afterSubmit = await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-pause-1",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:01.000Z",
      kind: "task-submitted",
    });
    expect(successfulSnapshot(afterSubmit).state).toBe("paused");
    const afterPermission = await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-pause-2",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:02.000Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "permission-paused",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt: "2026-01-01T00:01:00.000Z",
      },
    });
    expect(successfulSnapshot(afterPermission).state).toBe("paused");
    const decided = await f.orchestrator.decideApproval("run-1", {
      requestId: "permission-paused",
      decision: "approved",
      expectedRevision: 5,
    });
    expect(decided.ok).toBe(false);
  });

  it("still terminates a paused run on a redacted runtime failure", async () => {
    const f = await runningFixture();
    await f.orchestrator.pause("run-1", { requestId: "run-1" });
    const failed = await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-pause-3",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:03.000Z",
      kind: "failure-redacted",
    });
    expect(successfulSnapshot(failed).state).toBe("failed");
  });

  it("allows an explicit stop of a paused run", async () => {
    const f = await runningFixture();
    await f.orchestrator.pause("run-1", { requestId: "run-1" });
    const stopped = await f.orchestrator.stop("run-1", { requestId: "run-1" });
    expect(stopped.ok).toBe(true);
    expect(f.manager.stop).toHaveBeenCalledWith("run-1");
  });
});
