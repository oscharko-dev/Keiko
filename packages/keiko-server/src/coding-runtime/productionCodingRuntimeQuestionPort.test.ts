import { describe, expect, it, vi } from "vitest";

import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";
import { createProductionRuntimeOperationGuard } from "./productionCodingRuntimePorts.js";
import {
  createOpenCodeRuntimeQuestionPort,
  createProductionRuntimeQuestionPort,
} from "./productionCodingRuntimeQuestionPort.js";
import type { CodingRuntimeRunOperation } from "./productionCodingRuntimeHost.js";

describe("production coding runtime question port", () => {
  it("projects only questions owned by the active run and rejects stale runs", async () => {
    const openCode = createOpenCodeRuntimeQuestionPort({
      ...unusedRunPort(),
      listQuestions: () =>
        Promise.resolve([
          {
            id: "que_1",
            sessionID: "ses_1",
            questions: [
              {
                question: "Continue?",
                header: "Action",
                options: [{ label: "Yes", description: "Continue the run." }],
              },
            ],
          },
        ]),
      answerQuestion: (_runId, questionId) => Promise.resolve(questionId === "que_1"),
      rejectQuestion: (_runId, questionId) => Promise.resolve(questionId === "que_1"),
    });
    const port = createProductionRuntimeQuestionPort(
      new Map([
        [
          "run-1",
          {
            questionPort: openCode,
            operationGuard: createProductionRuntimeOperationGuard("run-1", () => true),
          },
        ],
      ]),
    );

    await expect(port.list(operation("run-1", "list-1", 1))).resolves.toMatchObject({
      questions: [{ id: "que_1" }],
    });
    await expect(
      port.answer({
        ...operation("run-1", "answer-1", 2),
        questionId: "que_1",
        answers: [["Yes"]],
      }),
    ).resolves.toBe(true);
    await expect(
      port.reject({ ...operation("run-1", "reject-1", 3), questionId: "que_1" }),
    ).resolves.toBe(true);
    await expect(port.list(operation("stale-run", "list-stale", 4))).resolves.toBeUndefined();
    await expect(
      port.answer({
        ...operation("stale-run", "answer-stale", 4),
        questionId: "que_1",
        answers: [["Yes"]],
      }),
    ).resolves.toBe(false);
  });

  it("rejects replay, stale revision, and revoked or drifted live authority before access", async () => {
    let live = false;
    const list = vi.fn(() => Promise.resolve({ questions: [] }));
    const port = createProductionRuntimeQuestionPort(
      new Map([
        [
          "run-guarded",
          {
            questionPort: {
              list,
              answer: (): Promise<boolean> => Promise.resolve(true),
              reject: (): Promise<boolean> => Promise.resolve(true),
            },
            operationGuard: createProductionRuntimeOperationGuard("run-guarded", () => live),
          },
        ],
      ]),
    );
    const denied = operation("run-guarded", "question-denied", 1);
    await expect(port.list(denied)).resolves.toBeUndefined();
    live = true;
    await expect(port.list(denied)).resolves.toEqual({ questions: [] });
    // Replay of a committed request id stays rejected.
    await expect(port.list(denied)).resolves.toBeUndefined();
    // #2386: listing is a read — a fresh request id at the unchanged revision stays listable so
    // background refreshes never exhaust the one-turn-per-revision mutation slot.
    await expect(port.list(operation("run-guarded", "question-again", 1))).resolves.toEqual({
      questions: [],
    });
    await expect(port.list(operation("run-guarded", "question-live", 2))).resolves.toEqual({
      questions: [],
    });
    // A mutation consumes the revision slot: reads at or below it are rejected as stale.
    await expect(
      port.answer({
        ...operation("run-guarded", "answer-live", 2),
        questionId: "que_1",
        answers: [],
      }),
    ).resolves.toBe(true);
    await expect(port.list(operation("run-guarded", "question-stale", 2))).resolves.toBeUndefined();
    await expect(port.list(operation("run-guarded", "question-next", 3))).resolves.toEqual({
      questions: [],
    });
    expect(list).toHaveBeenCalledTimes(4);
  });
});

function operation(
  runId: string,
  requestId: string,
  expectedRevision: number,
): CodingRuntimeRunOperation {
  return { runId, requestId, expectedRevision };
}

function unusedRunPort(): OpenCodeRunPort {
  return {
    submitTask: () => Promise.resolve(false),
    abortTask: () => Promise.resolve(false),
    waitForTerminal: () => Promise.resolve(false),
    listQuestions: () => Promise.resolve([]),
    answerQuestion: () => Promise.resolve(false),
    rejectQuestion: () => Promise.resolve(false),
    replyPermission: () => Promise.resolve(false),
  };
}

describe("production coding runtime question port fail-closed branches", () => {
  function guardedRuns(
    questionPort:
      | {
          list: () => Promise<{ questions: [] } | undefined>;
          answer: () => Promise<boolean>;
          reject: () => Promise<boolean>;
        }
      | undefined,
  ): Parameters<typeof createProductionRuntimeQuestionPort>[0] {
    return new Map([
      [
        "run-1",
        {
          questionPort,
          operationGuard: createProductionRuntimeOperationGuard("run-1", () => true),
        },
      ],
    ]);
  }

  it("releases the reservation when the run has no question surface", async () => {
    const port = createProductionRuntimeQuestionPort(guardedRuns(undefined));
    await expect(port.list(operation("run-1", "list-1", 1))).resolves.toBeUndefined();
    await expect(
      port.answer({ ...operation("run-1", "answer-1", 2), questionId: "que_1", answers: [["a"]] }),
    ).resolves.toBe(false);
    // A released reservation must not burn the request id: the same ids stay usable.
    const withPort = createProductionRuntimeQuestionPort(
      guardedRuns({
        list: () => Promise.resolve({ questions: [] }),
        answer: () => Promise.resolve(true),
        reject: () => Promise.resolve(true),
      }),
    );
    await expect(withPort.list(operation("run-1", "list-1", 1))).resolves.toEqual({
      questions: [],
    });
  });

  it("fails closed when the underlying question surface throws", async () => {
    const port = createProductionRuntimeQuestionPort(
      guardedRuns({
        list: () => Promise.reject(new Error("runtime protocol failure")),
        answer: () => Promise.reject(new Error("runtime protocol failure")),
        reject: () => Promise.reject(new Error("runtime protocol failure")),
      }),
    );
    await expect(port.list(operation("run-1", "list-1", 1))).resolves.toBeUndefined();
    await expect(
      port.answer({ ...operation("run-1", "answer-1", 2), questionId: "que_1", answers: [["a"]] }),
    ).resolves.toBe(false);
    await expect(
      port.reject({ ...operation("run-1", "reject-1", 3), questionId: "que_1" }),
    ).resolves.toBe(false);
  });

  it("returns nothing when the runtime reports no listable questions", async () => {
    const port = createProductionRuntimeQuestionPort(
      guardedRuns({
        list: () => Promise.resolve(undefined),
        answer: () => Promise.resolve(false),
        reject: () => Promise.resolve(false),
      }),
    );
    await expect(port.list(operation("run-1", "list-1", 1))).resolves.toBeUndefined();
    await expect(
      port.reject({ ...operation("run-1", "reject-1", 2), questionId: "que_1" }),
    ).resolves.toBe(false);
  });
});
