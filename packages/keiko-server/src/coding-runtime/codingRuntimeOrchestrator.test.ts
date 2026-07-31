/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local test fixture callbacks are contextually typed. */
import { describe, expect, it, vi } from "vitest";
import type {
  CodingRuntimeSnapshot,
  CodingRuntimeSnapshotStore,
} from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import {
  createCodingSafeActivityProjection,
  type CodingSafeActivityProjection,
} from "./codingSafeActivityProjection.js";
import type {
  CodingRuntimeTaskDispatcher,
  CodingRuntimeTaskOutcome,
} from "./productionCodingRuntimeHost.js";
import {
  createCodingRuntimeOrchestrator,
  MAX_APPROVAL_CHALLENGE_TTL_MS,
  type CodingRuntimeOrchestratorResult,
} from "./codingRuntimeOrchestrator.js";
import { createPendingResearchApprovals } from "./researchApprovalIssuance.js";
import { createResearchGrantRegistry } from "./researchGrantRegistry.js";
import type { AuxiliaryResearchScopeV1 } from "@oscharko-dev/keiko-contracts";

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

function fixture(activityProjection?: CodingSafeActivityProjection, clock?: () => Date) {
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
    pendingApprovalReview: vi.fn<CodingRuntimeManager["pendingApprovalReview"]>(() => undefined),
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
      completion: new Promise<"succeeded">(() => undefined),
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
  const permissionPort = { resolve: vi.fn(() => Promise.resolve(true)) };
  const safeActivityProjection = activityProjection ?? fakeSafeActivityProjection();
  const researchGrants = createResearchGrantRegistry();
  const pendingResearchApprovals = createPendingResearchApprovals();
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
    permissionPort,
    safeActivityProjection,
    serverPrincipal: () => "server",
    researchGrants,
    pendingResearchApprovals,
    now: clock ?? ((): Date => new Date("2026-01-01T00:00:00.000Z")),
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
    permissionPort,
    safeActivityProjection,
    researchGrants,
    pendingResearchApprovals,
    listPrunableSettled,
    deletePruned,
  };
}

function fakeSafeActivityProjection(): CodingSafeActivityProjection {
  return {
    open: vi.fn(),
    ingest: vi.fn(() => true),
    recordDrop: vi.fn(),
    recordDrops: vi.fn(),
    purge: vi.fn(),
    purgeAll: vi.fn(),
    markUnavailable: vi.fn(),
    currentContent: vi.fn(() => null),
    subscribeContent: vi.fn(() => ({ admitted: true, detach: vi.fn() })),
  };
}

const FIXTURE_NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");

function researchScope(
  grantId: string,
  domains: readonly string[],
  expiresAt = "2026-01-01T00:05:00.000Z",
): AuxiliaryResearchScopeV1 {
  return {
    grantId: grantId as AuxiliaryResearchScopeV1["grantId"],
    domains,
    expiresAt,
    queryTextDigest: { outcome: "known", value: "a".repeat(64) },
  };
}

const start = {
  requestId: "request-1",
  taskIntent: "fix the bounded issue",
  requestedMode: "supervised-coding",
} as const;

describe("CodingRuntimeOrchestrator", () => {
  it("reaps the managed runtime and settles a completed task exactly once", async () => {
    const f = fixture();
    let resolveCompletion: ((outcome: "succeeded") => void) | undefined;
    const completion = new Promise<"succeeded">((resolve) => {
      resolveCompletion = resolve;
    });
    f.taskDispatcher.dispatch.mockResolvedValueOnce({ ok: true, completion });

    expect(successfulSnapshot(await f.orchestrator.start(start)).state).toBe("running");
    resolveCompletion?.("succeeded");

    await vi.waitFor(() => {
      expect(f.orchestrator.getSnapshot("run-1")?.state).toBe("succeeded");
    });
    expect(f.manager.stop).toHaveBeenCalledOnce();
    expect(f.evidence.settle).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", state: "succeeded" }),
    );
  });

  it.each(["succeeded", "failed"] satisfies readonly CodingRuntimeTaskOutcome[])(
    "retains bounded protected activity after a naturally %s task",
    async (outcome) => {
      const projection = createCodingSafeActivityProjection({ now: () => FIXTURE_NOW_MS });
      const f = fixture(projection);
      let resolveCompletion: ((settled: CodingRuntimeTaskOutcome) => void) | undefined;
      const completion = new Promise<CodingRuntimeTaskOutcome>((resolve) => {
        resolveCompletion = resolve;
      });
      f.taskDispatcher.dispatch.mockResolvedValueOnce({ ok: true, completion });

      await f.orchestrator.start(start);
      projection.open({
        runId: "run-1",
        workspaceId: "workspace-1",
        authorityExpiresAt: "2026-01-01T01:00:00.000Z",
        workspaceIsCurrent: () => true,
      });
      projection.ingest("run-1", {
        kind: "message",
        messageId: "msg-user",
        role: "user",
        occurredAt: "2026-01-01T00:00:00.001Z",
      });
      projection.ingest("run-1", {
        kind: "message",
        messageId: "msg-assistant",
        role: "assistant",
        parentMessageId: "msg-user",
        occurredAt: "2026-01-01T00:00:00.002Z",
      });
      projection.ingest("run-1", {
        kind: "text",
        messageId: "msg-assistant",
        text: "TERMINAL_RESULT_CANARY_2828",
        occurredAt: "2026-01-01T00:00:00.003Z",
      });
      resolveCompletion?.(outcome);

      await vi.waitFor(() => {
        expect(f.orchestrator.getSnapshot("run-1")?.state).toBe(outcome);
      });
      expect(projection.currentContent()).toMatchObject({
        feed: { availability: "available", runId: "run-1" },
      });
      expect(JSON.stringify(projection.currentContent())).toContain("TERMINAL_RESULT_CANARY_2828");
    },
  );

  it("fails closed when a task fails or its runtime cannot be reaped", async () => {
    const failed = fixture();
    failed.taskDispatcher.dispatch.mockResolvedValueOnce({
      ok: true,
      completion: Promise.resolve("failed"),
    });
    await failed.orchestrator.start(start);
    await vi.waitFor(() => {
      expect(failed.orchestrator.getSnapshot("run-1")).toMatchObject({
        state: "failed",
        failureCode: "runtime-failed",
      });
    });

    const unreaped = fixture();
    unreaped.manager.stop.mockResolvedValueOnce({
      ok: false,
      failureCode: "runtime-reap-unproven",
      retryable: false,
    });
    unreaped.taskDispatcher.dispatch.mockResolvedValueOnce({
      ok: true,
      completion: Promise.resolve("succeeded"),
    });
    await unreaped.orchestrator.start(start);
    await vi.waitFor(() => {
      expect(unreaped.orchestrator.getSnapshot("run-1")).toMatchObject({
        state: "recovery-required",
        failureCode: "recovery-required",
      });
    });
  });

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
    expect(f.permissionPort.resolve).toHaveBeenCalledWith({
      runId: "run-1",
      requestId: "permission-1",
      decision: "approved",
    });
  });

  it("#2802: serves the approval review only for the live, unconsumed challenge", async () => {
    const f = fixture();
    const review = {
      requestId: "permission-1",
      paths: ["src/a.ts"],
      pathsTruncated: false,
      fileCount: 1,
      addedLines: 4,
      deletedLines: 2,
    } as const;
    f.manager.pendingApprovalReview.mockImplementation((runId, requestId) =>
      runId === "run-1" && requestId === "permission-1" ? review : undefined,
    );
    await f.orchestrator.start(start);
    // Before the ask lands there is no decision to review, so there is nothing to project.
    expect(f.orchestrator.pendingApprovalReview("run-1")).toBeUndefined();
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

    expect(f.orchestrator.pendingApprovalReview("run-1")).toEqual(review);
    // A foreign run id can never read the live run's review.
    expect(f.orchestrator.pendingApprovalReview("run-9")).toBeUndefined();

    await f.orchestrator.decideApproval("run-1", {
      requestId: "permission-1",
      decision: "approved",
      expectedRevision: 4,
    });

    // Once the decision is taken the run is no longer awaiting approval: the review closes with it.
    expect(f.orchestrator.pendingApprovalReview("run-1")).toBeUndefined();
  });

  it("fails closed and stops when the managed runtime cannot settle the exact permission", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "task-permission-failure",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "permission-failure",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "permission-failure",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt: "2026-01-01T00:01:00.000Z",
      },
    });
    f.permissionPort.resolve.mockResolvedValueOnce(false);

    expect(
      await f.orchestrator.decideApproval("run-1", {
        requestId: "permission-failure",
        decision: "approved",
        expectedRevision: 4,
      }),
    ).toMatchObject({
      ok: true,
      snapshot: { state: "failed", failureCode: "authority-resolution-failed" },
    });
    expect(f.manager.stop).toHaveBeenCalledWith("run-1");
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

  // 0.3.0 release audit: a retry used to settle the acknowledged recovery row and clear the active
  // slot BEFORE the fresh start was admitted. A start that never reached the ledger (the authority
  // mint still refuses while the predecessor's process tree is unreaped) therefore left the
  // orchestrator with no active run at all, so `snapshot()` fell back to the unbound idle
  // projection and the workbench offered "Ready to start" for a runtime whose every start is 403.
  it("keeps the recovery slot when a retry never reaches the ledger", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.startupReconcile();
    await f.orchestrator.acknowledgeRecovery("run-1", { requestId: "run-1", acknowledged: true });
    f.launchResolver.resolve.mockImplementationOnce(() => {
      throw new Error("active-run-conflict");
    });

    expect(await f.orchestrator.retry("run-1", { ...start, requestId: "request-2" })).toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });

    expect(f.orchestrator.snapshot()).toMatchObject({
      runId: "run-1",
      state: "recovery-required",
      recoveryAcknowledged: true,
    });
    expect(f.rows.get("run-1")?.terminalAt).toBeUndefined();
    expect(f.safeActivityProjection.purge).not.toHaveBeenCalledWith("run-1", "stop");
    // The slot stays retryable: once the tree is reaped the very next retry is admitted.
    expect(
      successfulSnapshot(await f.orchestrator.retry("run-1", { ...start, requestId: "request-3" }))
        .runId,
    ).toBe("run-2");
    expect(f.rows.get("run-1")?.terminalAt).toBe("2026-01-01T00:00:00.000Z");
  });

  // 0.3.0 release audit: `cancelled` is legal only from `starting`/`stopping`, so an ingested
  // runtime-stopped event from a LIVE state was rejected with `invalid-intent` and produced no
  // transition, no evidence, and no SSE frame. A dead runtime kept presenting as `running` until
  // the separate 30-minute task-settlement wait expired.
  it.each(["ready", "running", "awaiting-approval", "paused"] as const)(
    "terminates a run whose runtime exits while it is %s",
    async (state) => {
      const f = fixture();
      await f.orchestrator.start(start);
      f.rows.set("run-1", { ...rowFor(f.rows, "run-1"), state });

      const stopped = await f.orchestrator.ingest({
        schemaVersion: "1",
        eventId: "event-exit",
        runId: "run-1",
        occurredAt: "2026-01-01T00:00:00.000Z",
        kind: "runtime-stopped",
      });

      expect(successfulSnapshot(stopped)).toMatchObject({
        state: "failed",
        failureCode: "runtime-failed",
      });
      expect(f.evidence.settle).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", state: "failed", failureCode: "runtime-failed" }),
      );
    },
  );

  it("still cancels a run whose runtime exits during an operator-initiated stop", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.rows.set("run-1", { ...rowFor(f.rows, "run-1"), state: "stopping" });

    expect(
      successfulSnapshot(
        await f.orchestrator.ingest({
          schemaVersion: "1",
          eventId: "event-exit-stopping",
          runId: "run-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          kind: "runtime-stopped",
        }),
      ).state,
    ).toBe("cancelled");
  });

  it("recovers startup state without replay and supports stop/takeover settlement", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.startupReconcile();
    expect(f.manager.start).toHaveBeenCalledTimes(1);
    expect(f.orchestrator.snapshot().state).toBe("recovery-required");
    expect(f.safeActivityProjection.markUnavailable).toHaveBeenCalledWith("run-1");
    const g = fixture();
    await g.orchestrator.start(start);
    expect(
      successfulSnapshot(await g.orchestrator.takeover("run-1", { requestId: "run-1" })).state,
    ).toBe("taken-over");
    expect(g.safeActivityProjection.purge).toHaveBeenCalledWith("run-1", "takeover");
    await g.orchestrator.start(start);
    expect(
      successfulSnapshot(await g.orchestrator.stop("run-2", { requestId: "run-2" })).state,
    ).toBe("cancelled");
    expect(g.safeActivityProjection.purge).toHaveBeenCalledWith("run-2", "stop");
    expect(g.evidence.settle).toHaveBeenCalled();
  });

  it("replaces retained activity with unavailable state during crash recovery", async () => {
    const projection = createCodingSafeActivityProjection({
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const f = fixture(projection);
    await f.orchestrator.start(start);
    projection.open({
      runId: "run-1",
      workspaceId: "workspace-1",
      authorityExpiresAt: "2026-01-01T01:00:00.000Z",
      workspaceIsCurrent: () => true,
    });
    projection.ingest("run-1", {
      kind: "message",
      messageId: "msg_user",
      role: "user",
      occurredAt: "2026-01-01T00:00:00.001Z",
    });
    projection.ingest("run-1", {
      kind: "text",
      messageId: "msg_user",
      text: "RESTART_CANARY_2479",
      occurredAt: "2026-01-01T00:00:00.002Z",
    });

    await f.orchestrator.startupReconcile();

    expect(projection.currentContent()).toMatchObject({
      feed: { availability: "unavailable", runId: "run-1" },
    });
    expect(JSON.stringify(projection.currentContent())).not.toContain("RESTART_CANARY_2479");
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

describe("CodingRuntimeOrchestrator research grants (#2387)", () => {
  async function grantedFixture() {
    const f = fixture();
    await f.orchestrator.start(start);
    f.researchGrants.register(
      "run-1",
      researchScope("research-grant-1", ["docs.example.org"]),
      "approved query",
      "c".repeat(64),
      FIXTURE_NOW_MS,
    );
    return f;
  }

  it("projects the live research grant only onto the authenticated-channel source", async () => {
    const f = await grantedFixture();

    const snapshot = f.orchestrator.snapshot();

    expect(f.orchestrator.researchGrant("run-1")).toEqual({
      grantId: "research-grant-1",
      domains: ["docs.example.org"],
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
    // The general snapshot cannot carry the host, bound digest, or sanitized query.
    expect(JSON.stringify(snapshot)).not.toContain("docs.example.org");
    expect(JSON.stringify(snapshot)).not.toContain("approved query");
    expect(JSON.stringify(snapshot)).not.toContain("a".repeat(64));
  });

  it("#2387: projects the pending ask's host and request line for operator review", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.pendingResearchApprovals.request({
      runId: "run-1",
      url: new URL("https://docs.example.org/guide/streams?topic=backpressure"),
      taskId: "task-1",
      workspaceId: "workspace-1",
      nowMs: FIXTURE_NOW_MS,
    });

    expect(f.orchestrator.pendingResearchAsk("run-1")).toEqual({
      requestId: "research-approval-1",
      host: "docs.example.org",
      requestLine: "/guide/streams topic=backpressure",
      expiresAt: "2026-01-01T00:02:00.000Z",
    });
    // The reviewable detail is for the AUTHENTICATED channel only; the public snapshot stays free
    // of the host, the path, and the query.
    expect(JSON.stringify(f.orchestrator.snapshot())).not.toContain("docs.example.org");
    expect(JSON.stringify(f.orchestrator.snapshot())).not.toContain("backpressure");
  });

  it("#2387: has no reviewable ask for another run, or with nothing pending", async () => {
    const f = fixture();
    await f.orchestrator.start(start);
    f.pendingResearchApprovals.request({
      runId: "run-1",
      url: new URL("https://docs.example.org/guide"),
      taskId: "task-1",
      workspaceId: "workspace-1",
      nowMs: FIXTURE_NOW_MS,
    });

    expect(f.orchestrator.pendingResearchAsk("run-other")).toBeUndefined();
    expect(fixture().orchestrator.pendingResearchAsk("run-1")).toBeUndefined();
  });

  it("aggregates several live grants into one sorted, deduplicated projection", async () => {
    const f = await grantedFixture();
    f.researchGrants.register(
      "run-1",
      researchScope("research-grant-2", ["api.example.net"], "2026-01-01T00:04:00.000Z"),
      undefined,
      "d".repeat(64),
      FIXTURE_NOW_MS,
    );

    expect(f.orchestrator.researchGrant("run-1")).toEqual({
      grantId: "research-grant-2",
      domains: ["api.example.net", "docs.example.org"],
      expiresAt: "2026-01-01T00:05:00.000Z",
    });
  });

  it("revokes the grant with a revision bump and a grant-absent snapshot", async () => {
    const f = await grantedFixture();
    const before = f.orchestrator.snapshot();

    const revoked = await f.orchestrator.revokeResearch("run-1", {
      requestId: "revoke-1",
      expectedRevision: before.revision,
      grantId: "research-grant-1",
    });

    const snapshot = successfulSnapshot(revoked);
    expect(snapshot.revision).toBe(before.revision + 1);
    expect(f.orchestrator.researchGrant("run-1")).toBeUndefined();
    expect(f.researchGrants.activeGrants("run-1", FIXTURE_NOW_MS)).toEqual([]);
  });

  it("fails a stale-revision revoke closed and keeps the grant live", async () => {
    const f = await grantedFixture();
    const before = f.orchestrator.snapshot();

    const stale = await f.orchestrator.revokeResearch("run-1", {
      requestId: "revoke-stale",
      expectedRevision: before.revision - 1,
      grantId: "research-grant-1",
    });

    expect(stale).toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(f.orchestrator.researchGrant("run-1")).toBeDefined();
  });

  it("fails a revoke naming an unknown grant id closed", async () => {
    const f = await grantedFixture();
    const before = f.orchestrator.snapshot();

    const forged = await f.orchestrator.revokeResearch("run-1", {
      requestId: "revoke-forged",
      expectedRevision: before.revision,
      grantId: "not-a-live-grant",
    });

    expect(forged).toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(f.orchestrator.researchGrant("run-1")).toBeDefined();
  });

  it("fails a revoke against a non-current run closed", async () => {
    const f = await grantedFixture();

    const wrongRun = await f.orchestrator.revokeResearch("run-9", {
      requestId: "revoke-wrong-run",
      expectedRevision: 0,
      grantId: "research-grant-1",
    });

    expect(wrongRun).toEqual({ ok: false, failureCode: "invalid-intent" });
  });

  it("never projects a grant on a terminal snapshot", async () => {
    const f = await grantedFixture();

    await f.orchestrator.stop("run-1", { requestId: "run-1" });

    // The registry entry may briefly outlive the transition; the projection boundary
    // still refuses to show internet reach on a settled run.
    const settled = f.orchestrator.getSnapshot("run-1");
    expect(settled?.state).toBe("cancelled");
    expect(f.orchestrator.researchGrant("run-1")).toBeUndefined();
  });
});

// Issue #2637 — the trust classification an accepted research read asserts has to survive the
// projection, or the timeline shows a fetch that succeeded and nothing about what it took in. The
// #2387 normalized outcome rides the same seam and was equally undelivered before this.
describe("auxiliary event facts reach the SSE frame", () => {
  async function runningFixture(): Promise<ReturnType<typeof fixture>> {
    const f = fixture();
    await f.orchestrator.start(start);
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-aux-0",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    return f;
  }

  it("forwards the untrusted classification and the outcome of an accepted research read", async () => {
    const f = await runningFixture();

    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-aux-1",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:01.000Z",
      kind: "research-performed",
      auxiliaryOutcome: "accepted",
      contentTrust: "untrusted",
      byteCount: 2048,
    });

    expect(f.eventHub.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "runtime-event",
        eventKind: "research-performed",
        auxiliaryOutcome: "accepted",
        contentTrust: "untrusted",
      }),
    );
    // The frame stays content-free: the byte count is budget evidence, not an SSE field.
    expect(f.eventHub.publish).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ byteCount: 2048 }),
    );
  });

  it("omits the classification for an event that carries none", async () => {
    const f = await runningFixture();

    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "event-aux-2",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:02.000Z",
      kind: "research-performed",
      auxiliaryOutcome: "limit-reached",
    });

    expect(f.eventHub.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ auxiliaryOutcome: "limit-reached" }),
    );
    expect(f.eventHub.publish).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ contentTrust: "untrusted" }),
    );
  });
});

// Release-audit P0 (second half): the approval challenge lifetime arrived from the runtime CHILD as
// `permissionRequest.expiresAt`, was accepted for any future instant, and was handed straight to the
// authority mint as `ttlMs`. A child process must never choose its own security lifetime, so the
// orchestrator — the trust boundary between the untrusted child event and the server-owned authority
// — clamps it. One clamped instant feeds the challenge expiry, the operator-visible deadline, and
// the minted TTL, so the approval card can never show a deadline the server does not enforce. The
// expectations import the production ceiling instead of restating it.
describe("approval challenge lifetime ceiling", () => {
  const CHILD_REQUESTED_LIFETIME_MS = 24 * 60 * 60 * 1_000;

  async function awaitingApproval(clock?: () => Date, expiresAt = "2026-01-02T00:00:00.000Z") {
    const f = fixture(undefined, clock);
    await f.orchestrator.start(start);
    await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "task",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "task-submitted",
    });
    const ingested = await f.orchestrator.ingest({
      schemaVersion: "1",
      eventId: "permission",
      runId: "run-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      kind: "permission-requested",
      permissionRequest: {
        requestId: "permission-1",
        kind: "workspace-write",
        actionClass: "workspace-write",
        reasonCode: "approval-required",
        actionKind: "file-edit",
        expiresAt,
      },
    });
    return { f, ingested };
  }

  it("clamps a child-supplied lifetime in the operator-visible deadline and the minted TTL alike", async () => {
    const { f, ingested } = await awaitingApproval();
    const ceiling = new Date(FIXTURE_NOW_MS + MAX_APPROVAL_CHALLENGE_TTL_MS).toISOString();

    expect(successfulSnapshot(ingested)).toMatchObject({
      state: "awaiting-approval",
      pendingPermission: { requestId: "permission-1", expiresAt: ceiling },
    });
    expect(f.orchestrator.getSnapshot("run-1")?.pendingPermission?.expiresAt).toBe(ceiling);

    expect(
      (
        await f.orchestrator.decideApproval("run-1", {
          requestId: "permission-1",
          decision: "approved",
          expectedRevision: 4,
        })
      ).ok,
    ).toBe(true);
    expect(f.approvalAuthority.issue).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: MAX_APPROVAL_CHALLENGE_TTL_MS }),
    );
    // The child asked for a whole day; no issued authority carries that lifetime anywhere.
    expect(MAX_APPROVAL_CHALLENGE_TTL_MS).toBeLessThan(CHILD_REQUESTED_LIFETIME_MS);
  });

  it("expires the clamped challenge at the server ceiling even though the child asked for longer", async () => {
    let nowMs = FIXTURE_NOW_MS;
    const { f } = await awaitingApproval(() => new Date(nowMs));

    nowMs = FIXTURE_NOW_MS + MAX_APPROVAL_CHALLENGE_TTL_MS + 1;

    expect(
      await f.orchestrator.decideApproval("run-1", {
        requestId: "permission-1",
        decision: "approved",
        expectedRevision: 4,
      }),
    ).toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(f.approvalAuthority.issue).not.toHaveBeenCalled();
  });

  it("leaves a child lifetime below the ceiling exactly as asked", async () => {
    const { f, ingested } = await awaitingApproval(undefined, "2026-01-01T00:01:00.000Z");

    expect(successfulSnapshot(ingested)).toMatchObject({
      pendingPermission: { expiresAt: "2026-01-01T00:01:00.000Z" },
    });
    await f.orchestrator.decideApproval("run-1", {
      requestId: "permission-1",
      decision: "approved",
      expectedRevision: 4,
    });
    expect(f.approvalAuthority.issue).toHaveBeenCalledWith(
      expect.objectContaining({ ttlMs: 60_000 }),
    );
  });

  it.each([
    ["a non-numeric instant", "not-a-date"],
    ["an empty instant", ""],
    ["an already elapsed instant", "2025-12-31T23:59:59.000Z"],
    ["the current instant", "2026-01-01T00:00:00.000Z"],
  ])("refuses %s as an approval challenge lifetime", async (_label, expiresAt) => {
    const { f, ingested } = await awaitingApproval(undefined, expiresAt);

    expect(ingested).toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(f.orchestrator.getSnapshot("run-1")?.state).not.toBe("awaiting-approval");
  });
});
