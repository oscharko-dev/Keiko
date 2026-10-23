import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";

import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeOrchestratorResult } from "./codingRuntimeOrchestratorTypes.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import { CodingRuntimeQuestionAnswerRejectedError } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";
import { createProductionRuntimeQuestionPort } from "./productionCodingRuntimeQuestionPort.js";
import { createProductionRuntimeOperationGuard } from "./productionCodingRuntimePorts.js";
import { type ServerLogSink } from "@oscharko-dev/keiko-activity-log";

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
    deliver: vi.fn(() => Promise.resolve({ ok: true as const })),
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
  // Overridable so a test can drive a PAUSED current snapshot through a controllable resume
  // outcome; every other fixture leaves this at its always-succeeding default, which a running
  // snapshot never even reaches (submitFollowUp only consults it while paused).
  readonly resumePaused?: (
    current: CodingRuntimeSnapshot,
  ) => Promise<CodingRuntimeOrchestratorResult>;
  readonly advanceRevision?: (
    current: CodingRuntimeSnapshot,
    eventKind?: string,
  ) => CodingRuntimeOrchestratorResult;
}): CodingRuntimeOperationCoordinator {
  return new CodingRuntimeOperationCoordinator({
    current: input.current ?? ((): CodingRuntimeSnapshot => runningSnapshot()),
    serial: (work) => work(),
    advanceRevision:
      input.advanceRevision ??
      ((): CodingRuntimeOrchestratorResult => ({ ok: true, snapshot: publicSnapshot() })),
    // A follow-up into a pause resumes the run first (#3452, run 16); these fixtures dispatch
    // against a running snapshot, so the resume is never reached.
    resumePaused:
      input.resumePaused ??
      ((): Promise<CodingRuntimeOrchestratorResult> =>
        Promise.resolve({ ok: true, snapshot: publicSnapshot() })),
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
  // #3452: a follow-up into a paused run resumes it first, through this injected port, before the
  // replacement is dispatched. These three pin the coordinator's own contract for that call,
  // independent of what the orchestrator's real resumePausedForFollowUp decides.
  it("resumes a paused current snapshot through the injected resumePaused, exactly once, before dispatch", async () => {
    const order: string[] = [];
    const resumePaused = vi.fn((): Promise<CodingRuntimeOrchestratorResult> => {
      order.push("resumePaused");
      return Promise.resolve({ ok: true, snapshot: publicSnapshot() });
    });
    const taskDispatcher = dispatcher({
      replace: vi.fn(() => {
        order.push("replace");
        return Promise.resolve({
          ok: true as const,
          completion: Promise.resolve("succeeded" as const),
        });
      }),
    });
    const subject = coordinator({
      taskDispatcher,
      current: () => ({ ...runningSnapshot(), state: "paused" }),
      resumePaused,
    });

    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });

    expect(resumePaused).toHaveBeenCalledOnce();
    expect(order).toEqual(["resumePaused", "replace"]);
  });

  it("releases the reservation and answers with the refusal, dispatching nothing, when resumePaused refuses", async () => {
    let state: CodingRuntimeSnapshot["state"] = "paused";
    const resumePaused = vi.fn((): Promise<CodingRuntimeOrchestratorResult> =>
      Promise.resolve({ ok: false, failureCode: "invalid-intent" }),
    );
    const taskDispatcher = dispatcher();
    const subject = coordinator({
      taskDispatcher,
      current: () => ({ ...runningSnapshot(), state }),
      resumePaused,
    });

    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(resumePaused).toHaveBeenCalledOnce();
    expect(taskDispatcher.dispatch).not.toHaveBeenCalled();
    expect(taskDispatcher.replace).not.toHaveBeenCalled();

    // The SAME request id is admitted once the run is no longer paused, proving the refusal
    // released the replay reservation instead of leaving it permanently pending.
    state = "running";
    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });
    expect(resumePaused).toHaveBeenCalledOnce();
  });

  it("never calls resumePaused for a running current snapshot", async () => {
    const resumePaused = vi.fn((): Promise<CodingRuntimeOrchestratorResult> =>
      Promise.resolve({ ok: true, snapshot: publicSnapshot() }),
    );
    const subject = coordinator({ resumePaused });

    await expect(subject.submitFollowUp("run-1", followUp())).resolves.toMatchObject({ ok: true });

    expect(resumePaused).not.toHaveBeenCalled();
  });

  // CodeRabbit review, PR #3452: the resume moves the revision N -> N+1 and the follow-up's own
  // advance N+1 -> N+2. A replay record committed at the ADMISSION revision N is evicted by the next
  // reserve at N+2 (N + 1 < N + 2), so the same requestId would dispatch a second replacement task.
  it("still refuses the same requestId after a paused follow-up resumed the run and advanced it", async () => {
    let live: CodingRuntimeSnapshot = { ...runningSnapshot(), state: "paused", revision: 3 };
    const resumePaused = vi.fn((): Promise<CodingRuntimeOrchestratorResult> => {
      live = { ...live, state: "running", revision: 4 };
      return Promise.resolve({ ok: true, snapshot: publicSnapshot() });
    });
    const taskDispatcher = dispatcher();
    const subject = coordinator({ current: () => live, resumePaused, taskDispatcher });

    await expect(subject.submitFollowUp("run-1", followUp("req-1", 3))).resolves.toMatchObject({
      ok: true,
    });
    live = { ...live, revision: 5 };
    await expect(subject.submitFollowUp("run-1", followUp("req-1", 5))).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });

    expect(taskDispatcher.replace).toHaveBeenCalledOnce();
    expect(taskDispatcher.dispatch).not.toHaveBeenCalled();
  });

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

  it("restores a predecessor settlement when its paused-turn replacement is rejected", async () => {
    let resolveInitial: ((outcome: "failed") => void) | undefined;
    const settleTask = vi.fn();
    const taskDispatcher = dispatcher({
      dispatch: () =>
        Promise.resolve({
          ok: true,
          completion: new Promise<"failed">((resolve) => {
            resolveInitial = resolve;
          }),
        }),
      replace: vi.fn(async () => {
        resolveInitial?.("failed");
        await Promise.resolve();
        return { ok: false as const };
      }),
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

    await expect(
      subject.submitFollowUp("run-1", followUp(), "request-correlation-id-1"),
    ).resolves.toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });

    expect(settleTask).toHaveBeenCalledExactlyOnceWith("run-1", "failed");
    expect(taskDispatcher.replace).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "request-correlation-id-1" }),
    );
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
      extra: {
        completeness: "complete",
        loss: "none",
        runId: "run-1",
        expectedRevision: 22,
        currentRevision: 23,
      },
    });
    const rebound = activityLog.events.find(
      (event) => event.op === "coding-runtime.question.list-revision-rebound",
    );
    if (rebound === undefined) throw new Error("expected question.list-revision-rebound line");
    expect(
      expectActivityLogProof(
        "coding-runtime.question.list-revision-rebound.emitted-line",
        formatActivityLogProofLine(rebound),
      ),
    ).toMatchObject({ runId: "run-1", expectedRevision: 22, currentRevision: 23 });
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

  it.each(["missing-run", "missing-port", "revoked", "runtime-refusal"])(
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
                    answer: () => Promise.resolve(false),
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

  it.each(["list", "answer", "reject"] as const)(
    "persists request-correlated %s failures through the production question guard",
    async (operation) => {
      const activityLog = createBufferedServerLogSink();
      const fail = (): Promise<never> => Promise.reject(new Error("PRIVATE_PROTOCOL_BODY"));
      const port = createProductionRuntimeQuestionPort(
        new Map([
          [
            "run-1",
            {
              questionPort: questionPort({ list: fail, answer: fail, reject: fail }),
              operationGuard: createProductionRuntimeOperationGuard("run-1", () => true),
            },
          ],
        ]),
      );
      const subject = coordinator({ port, activityLog });
      const request = { requestId: "request-1", expectedRevision: 3 };
      const correlationId = "request-question-transport";
      const result =
        operation === "list"
          ? subject.listQuestions("run-1", request, correlationId)
          : operation === "answer"
            ? subject.answerQuestion(
                "run-1",
                { ...request, questionId: "que_1", answers: [["Yes"]] },
                correlationId,
              )
            : subject.rejectQuestion("run-1", { ...request, questionId: "que_1" }, correlationId);
      await expect(result).resolves.toEqual({
        ok: false,
        failureCode: "authority-resolution-failed",
      });
      expect(activityLog.events).toHaveLength(1);
      const event = activityLog.events[0];
      if (event === undefined) throw new Error("Expected the transport failure event");
      const line = formatActivityLogProofLine(event);
      const proof =
        operation === "list"
          ? expectActivityLogProof("coding-runtime.question.list-failed.emitted-line", line)
          : expectActivityLogProof(
              "coding-runtime.question.authority-resolution-failed.emitted-line",
              line,
            );
      expect(proof).toMatchObject({
        correlationId,
        runId: "run-1",
        operation,
        errorKind: "internal",
      });
      expect(line).not.toContain("PRIVATE_PROTOCOL_BODY");
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
    if (event === undefined) throw new Error("expected authority-resolution-failed line");
    expect(
      expectActivityLogProof(
        "coding-runtime.question.authority-resolution-failed.emitted-line",
        formatActivityLogProofLine(event),
      ),
    ).toMatchObject({ runId: "run-1", operation: "answer" });
    expect(event).toMatchObject({
      level: "warn",
      op: "coding-runtime.question.authority-resolution-failed",
      // "run-1" is shorter than the 8-character correlation-id floor, so it fails closed to the
      // sanctioned UNKNOWN_CORRELATION_ID marker rather than being used verbatim (AGENTS.md §8: "the
      // only sanctioned fallback ... never an ad-hoc string, never a silently missing id"). A
      // production run id (`run-<decimal projection of a UUID>`) is well past that floor and is
      // used as-is; see the reject test below.
      correlationId: "unknown-correlation-id",
      // Transport failures use the registry's closed, content-free failure vocabulary.
      errorKind: "internal",
    });
    expect(event.extra).toMatchObject({ runId: "run-1", operation: "answer" });
    expect(Array.isArray(event.extra?.frames)).toBe(true);
    expect(Array.isArray(event.extra?.causeChain)).toBe(true);
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
        errorKind: "internal",
        extra: { runId: "run-1", operation: "follow-up" },
      },
    ]);
    const [followUpFailure] = activityLog.events;
    if (followUpFailure === undefined) throw new Error("expected follow-up.dispatch-failed line");
    expect(
      expectActivityLogProof(
        "coding-runtime.follow-up.dispatch-failed.emitted-line",
        formatActivityLogProofLine(followUpFailure),
      ),
    ).toMatchObject({ runId: "run-1", operation: "follow-up" });
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
    const [listFailure] = activityLog.events;
    if (listFailure === undefined) throw new Error("expected question.list-failed line");
    expect(
      expectActivityLogProof(
        "coding-runtime.question.list-failed.emitted-line",
        formatActivityLogProofLine(listFailure),
      ),
    ).toMatchObject({ runId: "run-1", operation: "list" });
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
    const [initialTurnDispatchFailure] = activityLog.events;
    if (initialTurnDispatchFailure === undefined) {
      throw new Error("expected initial-turn.dispatch-failed line");
    }
    expect(
      expectActivityLogProof(
        "coding-runtime.initial-turn.dispatch-failed.emitted-line",
        formatActivityLogProofLine(initialTurnDispatchFailure),
      ),
    ).toMatchObject({ runId: "run-1", operation: "initial-turn-dispatch" });
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
    const stopFailure = activityLog.events[1];
    if (stopFailure === undefined) throw new Error("expected initial-turn.stop-failed line");
    expect(
      expectActivityLogProof(
        "coding-runtime.initial-turn.stop-failed.emitted-line",
        formatActivityLogProofLine(stopFailure),
      ),
    ).toMatchObject({ runId: "run-1", operation: "initial-turn-stop" });
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
      resumePaused: (): Promise<CodingRuntimeOrchestratorResult> =>
        Promise.resolve({ ok: true, snapshot: { ...publicSnapshot(), revision } }),
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

// ADR-0137 D10: a steering or queued message joins the turn that is running. It is admitted like
// any follow-up (the contract's exact body, the live revision, a single-use request id) but it
// starts, replaces and settles nothing.
describe("CodingRuntimeOperationCoordinator prompt inputs", () => {
  function delivery(
    delivery: "steer" | "queue" = "steer",
    extra: Record<string, unknown> = {},
    requestId = "req-1",
  ): Record<string, unknown> {
    return { ...followUp(requestId), delivery, ...extra };
  }

  it.each(["steer", "queue"] as const)(
    "delivers a %s message to the turn in flight and starts, replaces and settles nothing",
    async (mode) => {
      const taskDispatcher = dispatcher();
      const settleTask = vi.fn();
      const advanceRevision = vi.fn(
        (
          _current: CodingRuntimeSnapshot,
          _eventKind?: string,
        ): CodingRuntimeOrchestratorResult => ({
          ok: true,
          snapshot: publicSnapshot(),
        }),
      );
      const subject = coordinator({ taskDispatcher, settleTask, advanceRevision });

      await expect(
        subject.submitFollowUp("run-1", delivery(mode), "corr-0123456789"),
      ).resolves.toEqual({
        ok: true,
        snapshot: publicSnapshot(),
      });

      expect(taskDispatcher.deliver).toHaveBeenCalledExactlyOnceWith({
        runId: "run-1",
        requestId: "req-1",
        expectedRevision: 3,
        taskIntent: "Continue the bounded task",
        correlationId: "corr-0123456789",
        delivery: mode,
      });
      expect(taskDispatcher.dispatch).not.toHaveBeenCalled();
      expect(taskDispatcher.replace).not.toHaveBeenCalled();
      expect(settleTask).not.toHaveBeenCalled();
      // The revision advances with the task-submitted event, which is what admits the next message.
      expect(advanceRevision).toHaveBeenCalledOnce();
      expect(advanceRevision.mock.calls[0]?.[1]).toBe("task-submitted");
    },
  );

  it("hands the validated references to the delivery, never an absolute path or a URI", async () => {
    const taskDispatcher = dispatcher();
    const subject = coordinator({ taskDispatcher });
    const references = [{ path: "src/app.ts" }, { path: "docs/My Notes.md" }];
    await expect(
      subject.submitFollowUp("run-1", delivery("queue", { references })),
    ).resolves.toMatchObject({ ok: true });
    expect(taskDispatcher.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ delivery: "queue", references }),
    );
  });

  it("consumes the request id on delivery, so a replay is refused and dispatches nothing", async () => {
    const taskDispatcher = dispatcher();
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toMatchObject({ ok: true });
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.deliver).toHaveBeenCalledOnce();
  });

  it.each([
    ["an unknown delivery", { delivery: "interrupt" }],
    ["a null delivery", { delivery: null }],
    ["a delivery that names an agent", { agent: "plan" }],
    ["a stale revision", { expectedRevision: 2 }],
    ["a blank message", { taskIntent: "   " }],
    ["an unknown key", { files: [{ uri: "file:///etc/passwd" }] }],
    ["an absolute reference", { references: [{ path: "/etc/passwd" }] }],
    ["a parent reference", { references: [{ path: "../outside.txt" }] }],
    ["a URI reference", { references: [{ path: "file:///etc/passwd" }] }],
    ["an empty reference list", { references: [] }],
    ["a reference that carries a URI", { references: [{ path: "a.ts", uri: "file:///x" }] }],
    [
      "too many references",
      { references: Array.from({ length: 17 }, (_, i) => ({ path: `f${String(i)}.ts` })) },
    ],
  ])("refuses %s as an invalid intent before anything is delivered", async (_label, patch) => {
    const taskDispatcher = dispatcher();
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-1", delivery("steer", patch))).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.deliver).not.toHaveBeenCalled();
    // Nothing was reserved: the same request id still admits a well-formed message.
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toMatchObject({ ok: true });
  });

  it.each(["paused", "stopping", "succeeded", "failed", "cancelled", "awaiting-approval"] as const)(
    "refuses a delivery to a %s run without delivering, resuming or replacing",
    async (state) => {
      const taskDispatcher = dispatcher();
      const resumePaused = vi.fn((): Promise<CodingRuntimeOrchestratorResult> =>
        Promise.resolve({ ok: true, snapshot: publicSnapshot() }),
      );
      const subject = coordinator({
        taskDispatcher,
        resumePaused,
        current: () => ({ ...runningSnapshot(), state }),
      });
      await expect(subject.submitFollowUp("run-1", delivery())).resolves.toEqual({
        ok: false,
        failureCode: "invalid-intent",
      });
      expect(taskDispatcher.deliver).not.toHaveBeenCalled();
      expect(taskDispatcher.dispatch).not.toHaveBeenCalled();
      expect(taskDispatcher.replace).not.toHaveBeenCalled();
      expect(resumePaused).not.toHaveBeenCalled();
    },
  );

  it("refuses a delivery for another run than the live one", async () => {
    const taskDispatcher = dispatcher();
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-2", delivery())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.deliver).not.toHaveBeenCalled();
  });

  it("refuses as the request's own fault when the dispatcher cannot deliver, never falling back to a turn", async () => {
    const taskDispatcher = dispatcher({ deliver: undefined });
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.dispatch).not.toHaveBeenCalled();
    expect(taskDispatcher.replace).not.toHaveBeenCalled();
  });

  it("answers a refused delivery as an invalid intent and frees the request id", async () => {
    let refuse = true;
    const taskDispatcher = dispatcher({
      deliver: vi.fn(() =>
        Promise.resolve(
          refuse
            ? { ok: false as const, reason: "inputs-refused" as const }
            : { ok: true as const },
        ),
      ),
    });
    const subject = coordinator({ taskDispatcher });
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    refuse = false;
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toMatchObject({ ok: true });
  });

  it("answers an authority refusal as authority-resolution-failed and frees the request id", async () => {
    let refuse = true;
    const taskDispatcher = dispatcher({
      deliver: vi.fn(() =>
        Promise.resolve(refuse ? { ok: false as const } : { ok: true as const }),
      ),
    });
    const advanceRevision = vi.fn((): CodingRuntimeOrchestratorResult => ({
      ok: true,
      snapshot: publicSnapshot(),
    }));
    const subject = coordinator({ taskDispatcher, advanceRevision });
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });
    expect(advanceRevision).not.toHaveBeenCalled();
    refuse = false;
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toMatchObject({ ok: true });
  });

  it("logs a thrown delivery as structured evidence on the follow-up failure line and frees the request id", async () => {
    const activityLog = createBufferedServerLogSink();
    let fail = true;
    const taskDispatcher = dispatcher({
      deliver: vi.fn(() =>
        fail
          ? Promise.reject(new Error("delivery backend offline"))
          : Promise.resolve({ ok: true as const }),
      ),
    });
    const subject = coordinator({ taskDispatcher, activityLog });
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toEqual({
      ok: false,
      failureCode: "authority-resolution-failed",
    });
    expect(activityLog.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.follow-up.dispatch-failed",
        extra: { runId: "run-1", operation: "follow-up" },
      },
    ]);
    expect(JSON.stringify(activityLog.events)).not.toContain("delivery backend offline");
    fail = false;
    await expect(subject.submitFollowUp("run-1", delivery())).resolves.toMatchObject({ ok: true });
  });

  it("hands the references of an ordinary follow-up to the turn it starts, and to the replacement of a paused one", async () => {
    const references = [{ path: "src/app.ts" }];
    const running = dispatcher();
    await expect(
      coordinator({ taskDispatcher: running }).submitFollowUp("run-1", {
        ...followUp(),
        references,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(running.dispatch).toHaveBeenCalledWith(expect.objectContaining({ references }));
    expect(running.deliver).not.toHaveBeenCalled();

    const paused = dispatcher();
    await expect(
      coordinator({
        taskDispatcher: paused,
        current: () => ({ ...runningSnapshot(), state: "paused" }),
      }).submitFollowUp("run-1", { ...followUp(), references }),
    ).resolves.toMatchObject({ ok: true });
    expect(paused.replace).toHaveBeenCalledWith(expect.objectContaining({ references }));
  });

  it("keeps the historical follow-up request to the dispatcher byte for byte", async () => {
    const taskDispatcher = dispatcher();
    await coordinator({ taskDispatcher }).submitFollowUp("run-1", followUp());
    expect(taskDispatcher.dispatch).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      requestId: "req-1",
      expectedRevision: 3,
      taskIntent: "Continue the bounded task",
    });
  });

  it("turns a delivery to an ordinary refusal when the dispatcher answers an unsupported agent", async () => {
    const taskDispatcher = dispatcher({
      dispatch: () => Promise.resolve({ ok: false, reason: "inputs-refused" }),
    });
    await expect(
      coordinator({ taskDispatcher }).submitFollowUp("run-1", {
        ...followUp(),
        references: [{ path: "a.ts" }],
      }),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });
  });
});

describe("CodingRuntimeOperationCoordinator turn revert", () => {
  type Outcome = "cancelled" | "failed" | "succeeded";
  type Revert = NonNullable<CodingRuntimeTaskDispatcher["revert"]>;

  function revertBody(
    action: unknown = "undo",
    requestId = "req-revert-1",
    expectedRevision = 3,
  ): Record<string, unknown> {
    return { requestId, expectedRevision, action };
  }

  function applied(): Awaited<ReturnType<Revert>> {
    return { ok: true, fileCount: 2, additions: 3, deletions: 1 };
  }

  function withRevert(revert: Revert): CodingRuntimeTaskDispatcher {
    return dispatcher({ revert: vi.fn(revert) });
  }

  it("dispatches an undo with the admitted revision, the action and the request's correlation id", async () => {
    const taskDispatcher = withRevert(() => Promise.resolve(applied()));
    const subject = coordinator({ taskDispatcher });

    await expect(
      subject.submitRevert("run-1", revertBody("undo"), "corr-revert-0001"),
    ).resolves.toEqual({ ok: true, snapshot: publicSnapshot() });

    expect(taskDispatcher.revert).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      requestId: "req-revert-1",
      expectedRevision: 3,
      action: "undo",
      correlationId: "corr-revert-0001",
    });
  });

  it.each(["running", "paused"] as const)(
    "admits an undo and a restore of a %s run",
    async (state) => {
      const taskDispatcher = withRevert(() => Promise.resolve(applied()));
      const subject = coordinator({
        taskDispatcher,
        current: () => ({ ...runningSnapshot(), state }),
      });

      await expect(
        subject.submitRevert("run-1", revertBody("undo", "req-a")),
      ).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        subject.submitRevert("run-1", revertBody("restore", "req-b")),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it.each([
    "starting",
    "ready",
    "awaiting-approval",
    "stopping",
    "succeeded",
    "failed",
    "cancelled",
    "recovery-required",
  ] as const)("refuses to revert a run that is %s, without dispatching", async (state) => {
    const taskDispatcher = withRevert(() => Promise.resolve(applied()));
    const subject = coordinator({
      taskDispatcher,
      current: () => ({ ...runningSnapshot(), state }),
    });

    await expect(subject.submitRevert("run-1", revertBody())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.revert).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown action", revertBody("commit")],
    ["a missing action", { requestId: "req-1", expectedRevision: 3 }],
    ["an extra key", { ...revertBody(), files: ["a.txt"] }],
    ["a stale revision", revertBody("undo", "req-1", 2)],
    ["a future revision", revertBody("undo", "req-1", 4)],
    ["an unsafe request id", revertBody("undo", "../req")],
    ["a non-object body", "undo"],
  ])("refuses %s without dispatching", async (_name, body) => {
    const taskDispatcher = withRevert(() => Promise.resolve(applied()));
    const subject = coordinator({ taskDispatcher });

    await expect(subject.submitRevert("run-1", body)).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.revert).not.toHaveBeenCalled();
  });

  it("refuses another run's id and a runtime that offers no revert", async () => {
    const withoutRevert = dispatcher();
    await expect(
      coordinator({ taskDispatcher: withoutRevert }).submitRevert("run-1", revertBody()),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });

    const taskDispatcher = withRevert(() => Promise.resolve(applied()));
    await expect(
      coordinator({ taskDispatcher }).submitRevert("run-2", revertBody()),
    ).resolves.toEqual({ ok: false, failureCode: "invalid-intent" });
    expect(taskDispatcher.revert).not.toHaveBeenCalled();
  });

  it("dispatches each request id once and fails closed on its replay", async () => {
    const taskDispatcher = withRevert(() => Promise.resolve(applied()));
    const subject = coordinator({ taskDispatcher });

    await expect(subject.submitRevert("run-1", revertBody())).resolves.toMatchObject({ ok: true });
    await expect(subject.submitRevert("run-1", revertBody())).resolves.toEqual({
      ok: false,
      failureCode: "invalid-intent",
    });
    expect(taskDispatcher.revert).toHaveBeenCalledOnce();
  });

  it.each([
    ["already-staged", "invalid-intent"],
    ["nothing-staged", "invalid-intent"],
    ["nothing-to-undo", "invalid-intent"],
    ["turn-boundary-missing", "invalid-intent"],
    ["unsupported", "invalid-intent"],
    ["workspace-changed", "invalid-intent"],
    ["not-admitted", "authority-resolution-failed"],
    ["interrupt-failed", "runtime-failed"],
    ["revert-failed", "runtime-failed"],
    ["run-unavailable", "runtime-failed"],
    ["turn-blocked", "runtime-failed"],
  ] as const)("answers the refusal %s as %s and releases the request id", async (reason, code) => {
    let answer: Awaited<ReturnType<Revert>> = { ok: false, reason };
    const taskDispatcher = withRevert(() => Promise.resolve(answer));
    const subject = coordinator({ taskDispatcher });

    await expect(subject.submitRevert("run-1", revertBody())).resolves.toEqual({
      ok: false,
      failureCode: code,
    });

    // The refusal released the reservation: the same request id is admitted once it can succeed.
    answer = applied();
    await expect(subject.submitRevert("run-1", revertBody())).resolves.toMatchObject({ ok: true });
  });

  it("keeps the run alive when an undo stops its turn: the cancelled outcome is dropped", async () => {
    const settleTask = vi.fn();
    let finishTurn: ((outcome: Outcome) => void) | undefined;
    const turn = new Promise<Outcome>((resolve) => {
      finishTurn = resolve;
    });
    const taskDispatcher = dispatcher({
      dispatch: () => Promise.resolve({ ok: true, completion: turn }),
      // The undo interrupts the turn in flight: its completion settles while the revert runs.
      revert: vi.fn(() => {
        finishTurn?.("cancelled");
        return Promise.resolve(applied());
      }),
    });
    const subject = coordinator({ settleTask, taskDispatcher });
    await subject.submitFollowUp("run-1", followUp());

    await expect(subject.submitRevert("run-1", revertBody("undo"))).resolves.toMatchObject({
      ok: true,
    });
    await turn;
    await Promise.resolve();

    expect(settleTask).not.toHaveBeenCalled();
  });

  it("settles the run with the interrupted turn's outcome when an undo stopped it and then failed", async () => {
    const settleTask = vi.fn();
    let finishTurn: ((outcome: Outcome) => void) | undefined;
    const turn = new Promise<Outcome>((resolve) => {
      finishTurn = resolve;
    });
    const taskDispatcher = dispatcher({
      dispatch: () => Promise.resolve({ ok: true, completion: turn }),
      revert: vi.fn(() => {
        finishTurn?.("cancelled");
        return Promise.resolve({ ok: false as const, reason: "revert-failed" as const });
      }),
    });
    const subject = coordinator({ settleTask, taskDispatcher });
    await subject.submitFollowUp("run-1", followUp());

    await expect(subject.submitRevert("run-1", revertBody("undo"))).resolves.toEqual({
      ok: false,
      failureCode: "runtime-failed",
    });

    await vi.waitFor(() => {
      expect(settleTask).toHaveBeenCalledExactlyOnceWith("run-1", "cancelled");
    });
  });

  it("does not reserve a task generation for a restore, which interrupts nothing", async () => {
    const settleTask = vi.fn();
    let finishTurn: ((outcome: Outcome) => void) | undefined;
    const turn = new Promise<Outcome>((resolve) => {
      finishTurn = resolve;
    });
    const taskDispatcher = dispatcher({
      dispatch: () => Promise.resolve({ ok: true, completion: turn }),
      revert: vi.fn(() => Promise.resolve(applied())),
    });
    const subject = coordinator({ settleTask, taskDispatcher });
    await subject.submitFollowUp("run-1", followUp());

    await subject.submitRevert("run-1", revertBody("restore"));
    finishTurn?.("succeeded");

    await vi.waitFor(() => {
      expect(settleTask).toHaveBeenCalledExactlyOnceWith("run-1", "succeeded");
    });
  });

  it("logs a throwing dispatcher as structured evidence and answers a runtime failure", async () => {
    const activityLog = createBufferedServerLogSink();
    const taskDispatcher = withRevert(() => Promise.reject(new Error("revert backend offline")));
    const subject = coordinator({ taskDispatcher, activityLog });

    await expect(subject.submitRevert("run-1", revertBody(), "corr-revert-0001")).resolves.toEqual({
      ok: false,
      failureCode: "runtime-failed",
    });

    expect(activityLog.events).toMatchObject([
      {
        level: "warn",
        op: "coding-runtime.revert.dispatch-failed",
        correlationId: "corr-revert-0001",
        errorKind: "internal",
        extra: { runId: "run-1", operation: "revert" },
      },
    ]);
    expect(Array.isArray(activityLog.events[0]?.extra?.frames)).toBe(true);
    expect(JSON.stringify(activityLog.events)).not.toContain("revert backend offline");
  });

  it("proves coding-runtime.revert.dispatch-failed through the registered formatter", async () => {
    const activityLog = createBufferedServerLogSink();
    const subject = coordinator({
      taskDispatcher: withRevert(() => Promise.reject(new Error("revert backend offline"))),
      activityLog,
    });
    await subject.submitRevert("run-1", revertBody());
    const [failure] = activityLog.events;
    if (failure === undefined) throw new Error("expected revert.dispatch-failed line");

    expect(
      expectActivityLogProof(
        "coding-runtime.revert.dispatch-failed.emitted-line",
        formatActivityLogProofLine(failure),
      ),
    ).toMatchObject({ runId: "run-1", operation: "revert" });
  });

  describe("state", () => {
    const state = { staged: false, fileCount: 2, additions: 3, deletions: 1 };

    it("reads the dispatcher's counts for a running or paused run only", async () => {
      const revertState = vi.fn(() => Promise.resolve(state));
      for (const live of ["running", "paused"] as const) {
        const subject = coordinator({
          taskDispatcher: dispatcher({ revertState }),
          current: () => ({ ...runningSnapshot(), state: live }),
        });
        await expect(subject.revertState("run-1")).resolves.toEqual(state);
      }
      for (const settled of ["succeeded", "awaiting-approval", "recovery-required"] as const) {
        const subject = coordinator({
          taskDispatcher: dispatcher({ revertState }),
          current: () => ({ ...runningSnapshot(), state: settled }),
        });
        await expect(subject.revertState("run-1")).resolves.toBeUndefined();
      }
      expect(revertState).toHaveBeenCalledTimes(2);
    });

    it("is absent for another run's id and for a runtime that offers none", async () => {
      const revertState = vi.fn(() => Promise.resolve(state));
      await expect(
        coordinator({ taskDispatcher: dispatcher({ revertState }) }).revertState("run-2"),
      ).resolves.toBeUndefined();
      expect(revertState).not.toHaveBeenCalled();
      await expect(coordinator({}).revertState("run-1")).resolves.toBeUndefined();
    });
  });
});
