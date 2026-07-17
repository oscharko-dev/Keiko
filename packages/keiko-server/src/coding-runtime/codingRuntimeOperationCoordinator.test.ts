import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";

import { CodingRuntimeOperationCoordinator } from "./codingRuntimeOperationCoordinator.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeQuestionPort } from "./codingRuntimeQuestionPort.js";
import type { CodingRuntimeSnapshot } from "./codingRuntimeSnapshotStore.js";
import type { CodingRuntimeTaskDispatcher } from "./productionCodingRuntimeHost.js";

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
    questionPort: input.port ?? questionPort(),
    manager: manager(
      input.stop ?? vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
    ),
  });
}

function followUp(requestId = "req-1"): Record<string, unknown> {
  return { requestId, expectedRevision: 3, taskIntent: "Continue the bounded task" };
}

describe("CodingRuntimeOperationCoordinator", () => {
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
});
