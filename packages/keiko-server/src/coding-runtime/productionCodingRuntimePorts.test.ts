/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local port fixtures are contextually typed. */
import { describe, expect, it, vi } from "vitest";

import type { CodexRuntimeControl } from "./codexRuntimeComposition.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";
import {
  createCodexRuntimeTurnPort,
  createOpenCodeRuntimeTurnPort,
  createProductionRuntimeOperationGuard,
  createProductionRuntimeTaskDispatcher,
  type ProductionRuntimeRunRecord,
} from "./productionCodingRuntimePorts.js";

describe("production coding runtime turn ports", () => {
  it("submits initial and follow-up OpenCode turns through the run-bound port", async () => {
    const submitted: string[] = [];
    const runPort: OpenCodeRunPort = {
      submitTask: (_runId, text) => {
        submitted.push(text);
        return Promise.resolve(true);
      },
      abortTask: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve(true),
      listQuestions: () => Promise.resolve([]),
      answerQuestion: () => Promise.resolve(false),
      rejectQuestion: () => Promise.resolve(false),
    };
    const runs = new Map<string, ProductionRuntimeRunRecord>([
      ["run-open", record("run-open", createOpenCodeRuntimeTurnPort(runPort))],
    ]);
    const dispatcher = createProductionRuntimeTaskDispatcher(runs);

    const first = await dispatcher.dispatch(operation("run-open", "initial-1", 1, "initial task"));
    expect(first.ok).toBe(true);
    if (first.ok) await expect(first.completion).resolves.toBe("succeeded");
    const followUp = await dispatcher.dispatch(
      operation("run-open", "follow-up-1", 2, "follow-up task"),
    );
    expect(followUp.ok).toBe(true);
    if (followUp.ok) await expect(followUp.completion).resolves.toBe("succeeded");
    expect(submitted).toEqual(["initial task", "follow-up task"]);
    await expect(
      dispatcher.dispatch(operation("stale-run", "stale-1", 3, "private task")),
    ).resolves.toEqual({ ok: false });
  });

  it("reuses one Codex thread for initial and follow-up turns", async () => {
    const startThread = vi.fn(() => Promise.resolve({ ok: true as const, threadId: "thread-1" }));
    const startTurn = vi
      .fn<CodexRuntimeControl["startTurn"]>()
      .mockResolvedValueOnce({ ok: true, turnId: "turn-1" })
      .mockResolvedValueOnce({ ok: true, turnId: "turn-2" });
    const statuses = new Map([
      ["turn-1", "completed" as const],
      ["turn-2", "completed" as const],
    ]);
    const control = codexControl({ startThread, startTurn, statuses });
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-codex", record("run-codex", createCodexRuntimeTurnPort(control))]]),
    );

    const first = await dispatcher.dispatch(operation("run-codex", "initial-1", 1, "initial task"));
    if (first.ok) await expect(first.completion).resolves.toBe("succeeded");
    const followUp = await dispatcher.dispatch(
      operation("run-codex", "follow-up-1", 2, "follow-up task"),
    );
    if (followUp.ok) await expect(followUp.completion).resolves.toBe("succeeded");

    expect(startThread).toHaveBeenCalledOnce();
    expect(startTurn.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["run-codex", "thread-1", "initial task"],
      ["run-codex", "thread-1", "follow-up task"],
    ]);
  });

  it("denies stale revision, replay, and failed live authority before adapter access", async () => {
    let live = false;
    const submitTurn = vi.fn(() => Promise.resolve(true));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-guarded",
          {
            controller: new AbortController(),
            operationGuard: createProductionRuntimeOperationGuard("run-guarded", () => live),
            turnPort: {
              submitTurn,
              abortTurn: () => Promise.resolve(true),
              waitForTerminal: () => Promise.resolve("succeeded" as const),
            },
          },
        ],
      ]),
    );
    const denied = operation("run-guarded", "request-denied", 1, "private task");
    await expect(dispatcher.dispatch(denied)).resolves.toEqual({ ok: false });
    live = true;
    await expect(dispatcher.dispatch(denied)).resolves.toMatchObject({ ok: true });
    await expect(dispatcher.dispatch(denied)).resolves.toEqual({ ok: false });
    await expect(
      dispatcher.dispatch(operation("run-guarded", "request-stale", 1, "private task")),
    ).resolves.toEqual({ ok: false });
    await expect(
      dispatcher.dispatch(operation("run-guarded", "request-live", 2, "private task")),
    ).resolves.toMatchObject({ ok: true });
    expect(submitTurn).toHaveBeenCalledTimes(2);
  });

  it("aborts the run signal even when backend interruption rejects", async () => {
    const controller = new AbortController();
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-failed-abort",
          {
            controller,
            operationGuard: createProductionRuntimeOperationGuard("run-failed-abort", () => true),
            turnPort: {
              submitTurn: () => Promise.resolve(true),
              abortTurn: () => Promise.reject(new Error("private backend failure")),
              waitForTerminal: () => Promise.resolve("failed" as const),
            },
          },
        ],
      ]),
    );

    await expect(
      dispatcher.abort({ runId: "run-failed-abort", requestId: "abort-1", expectedRevision: 1 }),
    ).resolves.toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it("releases a rejected adapter attempt for retry at the unchanged revision", async () => {
    const submitTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("private adapter failure"))
      .mockResolvedValueOnce(true);
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-rejected-turn",
          record("run-rejected-turn", {
            submitTurn,
            abortTurn: () => Promise.resolve(true),
            waitForTerminal: () => Promise.resolve("failed" as const),
          }),
        ],
      ]),
    );

    await expect(
      dispatcher.dispatch(operation("run-rejected-turn", "turn-1", 1, "private task")),
    ).resolves.toEqual({ ok: false });
    await expect(
      dispatcher.dispatch(operation("run-rejected-turn", "turn-2", 1, "private task")),
    ).resolves.toMatchObject({ ok: true });
  });

  it("holds one pending reservation while an accepted adapter attempt is unresolved", async () => {
    let accept: ((value: boolean) => void) | undefined;
    const submitTurn = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-pending",
          record("run-pending", {
            submitTurn,
            abortTurn: () => Promise.resolve(true),
            waitForTerminal: () => Promise.resolve("succeeded" as const),
          }),
        ],
      ]),
    );

    const first = dispatcher.dispatch(operation("run-pending", "turn-first", 1, "private task"));
    await expect(
      dispatcher.dispatch(operation("run-pending", "turn-raced", 1, "private task")),
    ).resolves.toEqual({ ok: false });
    accept?.(true);
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(submitTurn).toHaveBeenCalledOnce();
  });
});

function record(
  runId: string,
  turnPort: ProductionRuntimeRunRecord["turnPort"],
): ProductionRuntimeRunRecord {
  return {
    turnPort,
    controller: new AbortController(),
    operationGuard: createProductionRuntimeOperationGuard(runId, () => true),
  };
}

function operation(runId: string, requestId: string, expectedRevision: number, taskIntent: string) {
  return { runId, requestId, expectedRevision, taskIntent };
}

function codexControl(input: {
  readonly startThread: CodexRuntimeControl["startThread"];
  readonly startTurn: CodexRuntimeControl["startTurn"];
  readonly statuses: ReadonlyMap<string, "completed" | "failed" | "interrupted">;
}): CodexRuntimeControl {
  const unavailable = (): Promise<{ readonly ok: false; readonly code: "unavailable" }> =>
    Promise.resolve({ ok: false, code: "unavailable" });
  return {
    startBrowserLogin: unavailable,
    startDeviceLogin: unavailable,
    cancelLogin: unavailable,
    logout: unavailable,
    consumeNavigation: () => undefined,
    startThread: input.startThread,
    startTurn: input.startTurn,
    interruptTurn: () => Promise.resolve({ ok: true }),
    terminalStatus: (_runId, turnId) => input.statuses.get(turnId),
  };
}
