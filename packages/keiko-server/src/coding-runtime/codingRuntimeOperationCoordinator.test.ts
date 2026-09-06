import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeOrchestratorResult } from "./codingRuntimeOrchestratorTypes.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import { CodingRuntimeQuestionAnswerRejectedError } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import { createProductionRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";
import { createProductionRuntimeOperationGuard } from "./productionCodingRuntimePorts.js";
import { createBufferedServerLogSink, type ServerLogSink } from "../observability/server-log.js";

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
    replace: vi.fn(() =>
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
  readonly activityLog?: ServerLogSink;
  readonly current?: () => CodingRuntimeSnapshot | undefined;
}): CodingRuntimeOperationCoordinator {
  return new CodingRuntimeOperationCoordinator({
    current: input.current ?? ((): CodingRuntimeSnapshot => runningSnapshot()),
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
    activityLog: input.activityLog,
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

  it("replaces a paused turn and ignores the superseded turn settlement", async () => {
    let resolveInitial: ((outcome: "cancelled") => void) | undefined;
    let resolveReplacement: ((outcome: "succeeded") => void) | undefined;
    const settleTask = vi.fn();
    const taskDispatcher = dispatcher({
      dispatch: () =>
        Promise.resolve({
          ok: true,
          completion: new Promise<"cancelled">((resolve) => {
            resolveInitial = resolve;
          }),
        }),
      replace: vi.fn(() =>
        Promise.resolve({
          ok: true,
          completion: new Promise<"succeeded">((resolve) => {
            resolveReplacement = resolve;
          }),
        }),
      ),
    });
    const subject = coordinator({
      settleTask,
      taskDispatcher,
      current: () => ({ ...runningSnapshot(), state: "paused" }),
    });

    await subject.startInitialTurn({
      runId: "run-1",
      requestId: "initial-1",
      expectedRevision: 1,
      taskIntent: "Initial task",
    });
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });
    resolveInitial?.("cancelled");
    await Promise.resolve();
    expect(settleTask).not.toHaveBeenCalled();
    resolveReplacement?.("succeeded");
    await vi.waitFor(() => {
      expect(settleTask).toHaveBeenCalledWith("run-1", "succeeded");
    });
    expect(taskDispatcher.replace).toHaveBeenCalledOnce();
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

  it("lists questions after internal activity advances beyond the rendered revision", async () => {
    const activityLog = createBufferedServerLogSink();
    const list = vi.fn(() =>
      Promise.resolve({
        questions: [
          {
            id: "que_1",
            questions: [{ question: "private-question-sentinel", header: "Choice", options: [] }],
          },
        ],
      }),
    );
    const answer = vi.fn(() => Promise.resolve(true));
    const reject = vi.fn(() => Promise.resolve(true));
    const subject = coordinator({
      port: questionPort({ list, answer, reject }),
      current: () => ({ ...runningSnapshot(), revision: 23 }),
      activityLog,
    });

    await expect(
      subject.listQuestions(
        "run-1",
        { requestId: "question-list-stale", expectedRevision: 22 },
        "question-list-correlation",
      ),
    ).resolves.toMatchObject({ ok: true, snapshot: { revision: 23 } });
    expect(list).toHaveBeenCalledWith({
      runId: "run-1",
      requestId: "question-list-stale",
      expectedRevision: 23,
    });
    expect(activityLog.events).toContainEqual({
      category: "process",
      level: "info",
      op: "coding-runtime.question.list-revision-rebound",
      correlationId: "question-list-correlation",
      extra: { runId: "run-1", expectedRevision: 22, currentRevision: 23 },
    });
    expect(JSON.stringify(activityLog.events)).not.toContain("private-question-sentinel");
    await expect(
      subject.listQuestions("run-1", { requestId: "question-list-future", expectedRevision: 24 }),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });
    await expect(
      subject.answerQuestion("run-1", {
        requestId: "question-answer-stale",
        expectedRevision: 22,
        questionId: "que_1",
        answers: [["Continue"]],
      }),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });
    await expect(
      subject.rejectQuestion("run-1", {
        requestId: "question-reject-stale",
        expectedRevision: 22,
        questionId: "que_1",
      }),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(list).toHaveBeenCalledTimes(1);
    expect(answer).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it.each(["missing-run", "missing-port", "revoked", "runtime-refusal", "runtime-error"])(
    "preserves authority failure for a production question %s",
    async (condition) => {
      const runs = new Map([
        [
          "run-1",
          {
            questionPort:
              condition === "missing-port"
                ? undefined
                : questionPort({
                    answer: () =>
                      condition === "runtime-error"
                        ? Promise.reject(new Error("protocol unavailable"))
                        : Promise.resolve(false),
                  }),
            operationGuard: createProductionRuntimeOperationGuard(
              "run-1",
              () => condition !== "revoked",
            ),
          },
        ],
      ]);
      if (condition === "missing-run") runs.clear();
      const subject = coordinator({ port: createProductionRuntimeQuestionPort(runs) });
      await expect(
        subject.answerQuestion("run-1", {
          requestId: "req-valid-answer",
          expectedRevision: 3,
          questionId: "que_1",
          answers: [["Continue"]],
        }),
      ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    },
  );

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

  it("reports a typed incompatible answer as question-answer-rejected and leaves its request id retryable", async () => {
    let calls = 0;
    const port = questionPort({
      answer: () =>
        ++calls > 1
          ? Promise.resolve(true)
          : Promise.reject(new CodingRuntimeQuestionAnswerRejectedError()),
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

  // T50 (review, PR #3394): a non-validation exception on the answer/reject path used to be
  // discarded into the generic authority-resolution-failed outcome with nothing in the activity
  // log. It must now leave structured, body-free evidence -- errorKind, dist-anchored frames, and
  // the run as the correlation key -- behind on the existing activity log.
  it("logs structured evidence for a genuine transport failure on answer, not free text", async () => {
    const activityLog = createBufferedServerLogSink();
    const port = questionPort({
      answer: () => Promise.reject(new Error("protocol failure")),
    });
    const subject = coordinator({ port, activityLog });
    await expect(
      subject.answerQuestion("run-1", {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Yes"]],
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(activityLog.events).toHaveLength(1);
    const [event] = activityLog.events;
    expect(event).toMatchObject({
      level: "warn",
      op: "coding-runtime.question.authority-resolution-failed",
      // "run-1" is shorter than the 8-character correlation-id floor, so it fails closed to the
      // sanctioned UNKNOWN_CORRELATION_ID marker rather than being used verbatim (AGENTS.md §8: "the
      // only sanctioned fallback ... never an ad-hoc string, never a silently missing id"). A
      // production run id (`run-<decimal projection of a UUID>`) is well past that floor and is
      // used as-is; see the reject test below.
      correlationId: "unknown-correlation-id",
      // A plain `new Error(...)` classifies as the generic "Error" class (contentFreeErrorClass) --
      // asserted directly rather than via `expect.any(String)`, whose vitest/jest typings are `any`
      // and trip `@typescript-eslint/no-unsafe-assignment` when inlined into a typed object literal.
      errorKind: "Error",
    });
    expect(event?.extra).toMatchObject({ runId: "run-1", operation: "answer" });
    expect(Array.isArray(event?.extra?.frames)).toBe(true);
    expect(Array.isArray(event?.extra?.causeChain)).toBe(true);
    // Body-free: the underlying message text never reaches the log.
    expect(JSON.stringify(event)).not.toContain("protocol failure");
  });

  it("uses a well-formed run id verbatim as the correlation key", async () => {
    const activityLog = createBufferedServerLogSink();
    const longRunId = "run-340282366920938463463374607431768211455";
    const port = questionPort({
      answer: () => Promise.reject(new Error("protocol failure")),
    });
    const subject = coordinator({
      port,
      activityLog,
      current: (): CodingRuntimeSnapshot => ({ ...runningSnapshot(), runId: longRunId }),
    });
    await expect(
      subject.answerQuestion(longRunId, {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Yes"]],
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(activityLog.events).toMatchObject([{ correlationId: longRunId }]);
  });

  it("logs structured evidence for a genuine transport failure on reject", async () => {
    const activityLog = createBufferedServerLogSink();
    const port = questionPort({
      reject: () => Promise.reject(new Error("protocol failure")),
    });
    const subject = coordinator({ port, activityLog });
    await expect(
      subject.rejectQuestion("run-1", {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
      }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(activityLog.events).toMatchObject([
      { op: "coding-runtime.question.authority-resolution-failed", extra: { operation: "reject" } },
    ]);
  });

  // Review 3941746512 (P1 follow-up): submitFollowUp's dispatch catch, listQuestions's catch and
  // startInitialTurn's dispatch/stop catches discarded their raw error exactly like the
  // answer/reject path did before T50 -- same defect class (AGENTS.md §7), same fix: structured,
  // body-free evidence on the existing activity log instead of silence.
  it("logs structured evidence when a follow-up dispatch throws, not just answer/reject", async () => {
    const activityLog = createBufferedServerLogSink();
    const taskDispatcher = dispatcher({
      dispatch: () => Promise.reject(new Error("dispatch backend offline")),
    });
    const subject = coordinator({ taskDispatcher, activityLog });
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });
    expect(activityLog.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.follow-up.dispatch-failed",
        errorKind: "Error",
        extra: { runId: "run-1", operation: "follow-up" },
      },
    ]);
    expect(JSON.stringify(activityLog.events)).not.toContain("dispatch backend offline");
  });

  it("logs structured evidence when listing questions throws, not just answer/reject", async () => {
    const activityLog = createBufferedServerLogSink();
    const port = questionPort({ list: () => Promise.reject(new Error("protocol failure")) });
    const subject = coordinator({ port, activityLog });
    await expect(
      subject.listQuestions("run-1", { requestId: "req-1", expectedRevision: 3 }),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(activityLog.events).toMatchObject([
      {
        op: "coding-runtime.question.list-failed",
        extra: { runId: "run-1", operation: "list" },
      },
    ]);
  });

  it("logs structured evidence when the initial turn's own dispatch throws", async () => {
    const activityLog = createBufferedServerLogSink();
    const subject = coordinator({
      taskDispatcher: dispatcher({
        dispatch: () => Promise.reject(new Error("dispatch backend offline")),
      }),
      stop: vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
      activityLog,
    });
    await expect(
      subject.startInitialTurn({
        runId: "run-1",
        requestId: "req-1",
        expectedRevision: 3,
        taskIntent: "Investigate",
      }),
    ).resolves.toBe("failed");
    expect(activityLog.events).toMatchObject([
      {
        op: "coding-runtime.initial-turn.dispatch-failed",
        extra: { runId: "run-1", operation: "initial-turn-dispatch" },
      },
    ]);
  });

  it("logs structured evidence when the initial turn cannot even be stopped after a failed dispatch", async () => {
    const activityLog = createBufferedServerLogSink();
    const subject = coordinator({
      taskDispatcher: dispatcher({ dispatch: () => Promise.reject(new Error("offline")) }),
      stop: vi.fn(() => Promise.reject(new Error("stop backend offline"))),
      activityLog,
    });
    await expect(
      subject.startInitialTurn({
        runId: "run-1",
        requestId: "req-1",
        expectedRevision: 3,
        taskIntent: "Investigate",
      }),
    ).resolves.toBe("recovery-required");
    expect(activityLog.events).toMatchObject([
      { op: "coding-runtime.initial-turn.dispatch-failed" },
      {
        op: "coding-runtime.initial-turn.stop-failed",
        extra: { runId: "run-1", operation: "initial-turn-stop" },
      },
    ]);
  });

  // Review 3941746512: no per-request correlationId reached this coordinator at all -- every line
  // correlated by run id only. answerQuestion/rejectQuestion/listQuestions/submitFollowUp now
  // accept an optional correlationId (threaded from the HTTP route) and prefer it over the run id.
  it("prefers a supplied per-request correlationId over the run id as the log's correlation key", async () => {
    const activityLog = createBufferedServerLogSink();
    const port = questionPort({ answer: () => Promise.reject(new Error("protocol failure")) });
    const subject = coordinator({ port, activityLog });
    await expect(
      subject.answerQuestion(
        "run-1",
        { requestId: "req-1", expectedRevision: 3, questionId: "que_1", answers: [["Yes"]] },
        "request-correlation-id-1",
      ),
    ).resolves.toEqual({ ok: false, failureCode: "authority-resolution-failed" });
    expect(activityLog.events).toMatchObject([{ correlationId: "request-correlation-id-1" }]);
  });

  it("does not log the typed incompatible-answer rejection as a transport failure", async () => {
    const activityLog = createBufferedServerLogSink();
    const port = questionPort({
      answer: () => Promise.reject(new CodingRuntimeQuestionAnswerRejectedError()),
    });
    const subject = coordinator({ port, activityLog });
    await expect(
      subject.answerQuestion("run-1", {
        requestId: "req-1",
        expectedRevision: 3,
        questionId: "que_1",
        answers: [["Continue"]],
      }),
    ).resolves.toEqual({ ok: false, failureCode: "question-answer-rejected" });
    expect(activityLog.events).toHaveLength(0);
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
