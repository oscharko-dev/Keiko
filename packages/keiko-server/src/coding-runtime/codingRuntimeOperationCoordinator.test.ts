import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeOrchestratorResult } from "./codingRuntimeOrchestratorTypes.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";

type CodingRuntimePublicSnapshot = Extract<
  CodingRuntimeOrchestratorResult,
  { readonly ok: true }
>["snapshot"];

const AT = "2026-07-13T12:00:00.000Z";
const DIGEST = "a".repeat(64);

function runningSnapshot(): CodingRuntimeSnapshot {
  return {
    schemaVersion: "1",
    runId: "run-1",
    state: "running",
    revision: 3,
    requestedMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: AT,
    updatedAt: AT,
    taskDigest: DIGEST,
    workspaceDigest: DIGEST,
    operatorDigest: DIGEST,
    authorityDigest: DIGEST,
    bindingDigest: DIGEST,
    provenanceDigest: DIGEST,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  };
}

function publicSnapshot(): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 4,
    updatedAt: AT,
    runId: "run-1",
  };
}

function questionPort(
  overrides: Partial<CodingRuntimeQuestionPort> = {},
): CodingRuntimeQuestionPort {
  return {
    list: vi.fn(() => Promise.resolve({ questions: [] })),
    answer: vi.fn(() => Promise.resolve(true)),
    reject: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function dispatcher(
  overrides: Partial<CodingRuntimeTaskDispatcher> = {},
): CodingRuntimeTaskDispatcher {
  return {
    dispatch: vi.fn(() =>
      Promise.resolve({ ok: true as const, completion: Promise.resolve("succeeded" as const) }),
    ),
    abort: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function manager(stop: CodingRuntimeManager["stop"]): CodingRuntimeManager {
  return {
    start: vi.fn(),
    issueApproval: vi.fn(),
    stop,
    takeover: vi.fn(),
    reconcile: vi.fn(),
    health: vi.fn(() => ({ status: "running" as const })),
  } as unknown as CodingRuntimeManager;
}

function coordinator(input: {
  readonly taskDispatcher?: CodingRuntimeTaskDispatcher;
  readonly port?: CodingRuntimeQuestionPort;
  readonly stop?: CodingRuntimeManager["stop"];
  readonly settleTask?: (runId: string, outcome: "cancelled" | "failed" | "succeeded") => void;
}): CodingRuntimeOperationCoordinator {
  return new CodingRuntimeOperationCoordinator({
    current: () => runningSnapshot(),
    serial: (work) => work(),
    advanceRevision: () => ({ ok: true, snapshot: publicSnapshot() }),
    publicSnapshot: (current) => ({
      schemaVersion: "1",
      state: current.state,
      revision: current.revision,
      updatedAt: current.updatedAt,
      runId: current.runId,
    }),
    taskDispatcher: input.taskDispatcher ?? dispatcher(),
    settleTask: input.settleTask ?? vi.fn(),
    questionPort: input.port ?? questionPort(),
    manager: manager(
      input.stop ?? vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
    ),
  });
}

function followUp(requestId = "req-1", expectedRevision = 3): Record<string, unknown> {
  return { requestId, expectedRevision, taskIntent: "Continue the bounded task" };
}

describe("CodingRuntimeOperationCoordinator", () => {
  it("KEIKO-0722: exhausting the per-run replay cap yields replay-cap-exhausted, not invalid-intent", async () => {
    const taskDispatcher = dispatcher();
    const subject = coordinator({ taskDispatcher });
    // Fill the 512-slot replay-dedup budget with unique request ids on the same run.
    for (let i = 0; i < 512; i += 1) {
      const result = await subject.submitFollowUp("run-1", followUp(`req-${String(i)}`));
      expect(result).toMatchObject({ ok: true });
    }
    // The 513th unique request id must not be classified as an ordinary invalid-intent
    // rejection; it must carry the distinct replay-cap-exhausted failure code.
    await expect(subject.submitFollowUp("run-1", followUp("req-513"))).resolves.toEqual({
      ok: false,
      failureCode: "replay-cap-exhausted",
    });
  });

  it("dispatches a valid follow-up exactly once per request id", async () => {
    const taskDispatcher = dispatcher();
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toEqual({
      ok: true,
      snapshot: publicSnapshot(),
    });
    // Replay of the committed request id must fail closed without a second dispatch.
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("reports successful and rejected task completions to the lifecycle owner", async () => {
    const settleTask = vi.fn();
    let resolveCompletion: ((outcome: "cancelled" | "failed" | "succeeded") => void) | undefined;
    const completion = new Promise<"cancelled" | "failed" | "succeeded">((resolve) => {
      resolveCompletion = resolve;
    });
    const subject = coordinator({
      settleTask,
      taskDispatcher: dispatcher({
        dispatch: () => Promise.resolve({ ok: true, completion }),
      }),
    });
    await subject.submitFollowUp("run-1", followUp());
    resolveCompletion?.("succeeded");
    await vi.waitFor(() => {
      expect(settleTask).toHaveBeenCalledWith("run-1", "succeeded");
    });

    const rejected = coordinator({
      settleTask,
      taskDispatcher: dispatcher({
        dispatch: () => Promise.resolve({ ok: true, completion: Promise.reject(new Error()) }),
      }),
    });
    await rejected.submitFollowUp("run-1", followUp("req-2"));
    await vi.waitFor(() => {
      expect(settleTask).toHaveBeenCalledWith("run-1", "failed");
    });
  });

  it("fails closed when the task dispatcher throws and frees the request id", async () => {
    let calls = 0;
    const taskDispatcher = dispatcher({
      dispatch: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("dispatch backend offline"));
        return Promise.resolve({
          ok: true as const,
          completion: Promise.resolve("succeeded" as const),
        });
      },
    });
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });
    // A released reservation keeps the id usable for a retry.
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when the question surface throws while listing", async () => {
    const subject = coordinator({
      port: questionPort({ list: () => Promise.reject(new Error("protocol failure")) }),
    });
    await expect(
      subject.listQuestions("run-1", { requestId: "req-1", expectedRevision: 3 }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
  });

  it("rejects malformed answers before touching the question surface", async () => {
    const port = questionPort();
    const subject = coordinator({ port });
    await expect(
      subject.answerQuestion("run-1", {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: "not-a-list",
      }),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(port.answer).not.toHaveBeenCalled();
  });

  it("answers a question with the requestId/expectedRevision/questionId binding folded into the contract parse (KEIKO-0411)", async () => {
    // prepareAnswer() admits the WHOLE body through parseCodingWorkbenchRuntimeQuestionAnswerRequest
    // -- the one shape definition for requestId/expectedRevision/questionId/answers (epic #3384
    // defect A) -- then only checks run-state, revision-match, and reserves the replay slot. This
    // proves the happy path still calls the port with exactly the fields the contract validated.
    const port = questionPort();
    const subject = coordinator({ port });
    await expect(
      subject.answerQuestion("run-1", {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Continue"]],
      }),
    ).resolves.toEqual({ ok: true, snapshot: publicSnapshot() });
    expect(port.answer).toHaveBeenCalledWith({
      runId: "run-1",
      requestId: "req-1",
      expectedRevision: 3,
      questionId: "que_1",
      answers: [["Continue"]],
    });
  });

  it("reports a runtime-refused answer as question-answer-rejected and leaves its request id retryable", async () => {
    let calls = 0;
    const port = questionPort({
      answer: () => Promise.resolve(++calls > 1),
    });
    const subject = coordinator({ port });
    const answer = {
      requestId: "req-answer-retry",
      expectedRevision: 3,
      questionId: "que_1",
      answers: [["Continue"]],
    };

    await expect(subject.answerQuestion("run-1", answer)).resolves.toEqual({
      ok: false,
      failureCode: "question-answer-rejected",
    });
    await expect(subject.answerQuestion("run-1", answer)).resolves.toMatchObject({ ok: true });
  });

  it("fails closed when answering throws and routes rejections to the reject surface", async () => {
    const port = questionPort({
      answer: () => Promise.reject(new Error("protocol failure")),
    });
    const subject = coordinator({ port });
    await expect(
      subject.answerQuestion("run-1", {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Yes"]],
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    await expect(
      subject.rejectQuestion("run-1", {
        requestId: "req-2",
        expectedRevision: 3,
        questionId: "que_1",
      }),
    ).resolves.toEqual({ ok: true, snapshot: publicSnapshot() });
    expect(port.reject).toHaveBeenCalledWith({
      runId: "run-1",
      requestId: "req-2",
      expectedRevision: 3,
      questionId: "que_1",
    });
  });

  it("stops the run when the initial turn cannot be dispatched", async () => {
    const stop = vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const }));
    const subject = coordinator({
      taskDispatcher: dispatcher({
        dispatch: () => Promise.reject(new Error("dispatch backend offline")),
      }),
      stop,
    });
    await expect(
      subject.startInitialTurn({
        runId: "run-1",
        requestId: "req-1",
        expectedRevision: 3,
        taskIntent: "Investigate",
      }),
    ).resolves.toBe("failed");
    expect(stop).toHaveBeenCalledWith("run-1");
  });

  it("requires recovery when the failed initial turn cannot even be stopped", async () => {
    const subject = coordinator({
      taskDispatcher: dispatcher({ dispatch: () => Promise.reject(new Error("offline")) }),
      stop: vi.fn(() => Promise.reject(new Error("stop backend offline"))),
    });
    await expect(
      subject.startInitialTurn({
        runId: "run-1",
        requestId: "req-1",
        expectedRevision: 3,
        taskIntent: "Investigate",
      }),
    ).resolves.toBe("recovery-required");
  });

  it("clears replay state per run so a fresh run can reuse request ids", async () => {
    const subject = coordinator({});
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });
    subject.clear("run-1");
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });
  });

  // #2906: the fixed `coordinator()` fixture above always reports revision 3, so it cannot
  // exercise eviction (nothing ever supersedes a committed id). This one tracks a REAL advancing
  // revision, one bump per successful mutation, so 512 prior requests actually leave the live
  // revision far ahead of every one of them.
  function statefulCoordinator(): {
    readonly subject: CodingRuntimeOperationCoordinator;
    readonly revision: () => number;
  } {
    let revision = 3;
    const subject = new CodingRuntimeOperationCoordinator({
      current: (): CodingRuntimeSnapshot => ({ ...runningSnapshot(), revision }),
      serial: <T>(work: () => Promise<T>): Promise<T> => work(),
      advanceRevision: (current): CodingRuntimeOrchestratorResult => {
        revision = current.revision + 1;
        return { ok: true, snapshot: { ...publicSnapshot(), revision } };
      },
      publicSnapshot: (current): CodingRuntimePublicSnapshot => ({
        schemaVersion: "1",
        state: current.state,
        revision: current.revision,
        updatedAt: current.updatedAt,
        runId: current.runId,
      }),
      taskDispatcher: dispatcher(),
      settleTask: vi.fn(),
      questionPort: questionPort(),
      manager: manager(
        vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
      ),
    });
    return { subject, revision: () => revision };
  }

  it("#2906: evicts replay ids superseded by the live revision, so 512 prior requests never permanently lock a live run", async () => {
    const { subject, revision } = statefulCoordinator();

    for (let i = 0; i < 512; i += 1) {
      const result = await subject.submitFollowUp(
        "run-1",
        followUp(`req-${String(i)}`, revision()),
      );
      expect(result).toMatchObject({ ok: true });
    }

    // Every one of the 512 committed ids is now bound to a revision strictly behind the live one
    // (the run advances by exactly one revision per successful operation): a fresh, distinct
    // request must be admitted instead of being denied on a cap that would otherwise never shrink.
    const freshRevision = revision();
    const fresh = await subject.submitFollowUp("run-1", followUp("req-fresh", freshRevision));
    expect(fresh).toMatchObject({ ok: true });

    // An immediate duplicate submission of that SAME request id, at the SAME expectedRevision it
    // was just admitted at, must still be denied: eviction frees capacity, it never re-admits an
    // actual replay of a request that was just accepted.
    const duplicate = await subject.submitFollowUp("run-1", followUp("req-fresh", freshRevision));
    expect(duplicate).toEqual({ ok: false, failureCode: "invalid-intent" });
  });

  it("#2906: listQuestions never commits a replay-cap slot, so polling cannot lock out real operations", async () => {
    const port = questionPort();
    const subject = coordinator({ port });

    for (let i = 0; i < 600; i += 1) {
      const result = await subject.listQuestions("run-1", {
        requestId: `poll-${String(i)}`,
        expectedRevision: 3,
      });
      expect(result).toMatchObject({ ok: true });
    }

    // None of the 600 reads should have occupied a slot in the 512-entry replay cap: a genuine
    // mutating operation must still be admitted.
    await expect(subject.submitFollowUp("run-1", followUp("req-mutate"))).resolves.toMatchObject({
      ok: true,
    });
  });
});
