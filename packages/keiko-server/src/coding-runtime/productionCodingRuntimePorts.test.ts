/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local port fixtures are contextually typed. */
import { describe, expect, it, vi } from "vitest";

import type { CodexRuntimeControl } from "./codexRuntimeComposition.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import {
  createCodexRuntimeTurnPort,
  createOpenCodeRuntimeTurnPort,
  createProductionRuntimeManager,
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
      replyPermission: () => Promise.resolve(false),
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

  // #2386 regression: question listing is a read — it must stay repeatable at an unchanged
  // revision (background refreshes re-list on runtime events) without consuming the
  // one-turn-per-revision slot a concurrent operator mutation (pause/answer/follow-up) needs.
  it("keeps read reservations repeatable while mutations still consume the revision", () => {
    const guard = createProductionRuntimeOperationGuard("run-reads", () => true);
    const read = (requestId: string, expectedRevision: number) =>
      guard.reserve({ runId: "run-reads", requestId, expectedRevision }, "read");
    const first = read("read-1", 3);
    expect(first?.commit()).toBe(true);
    const second = read("read-2", 3);
    expect(second?.commit()).toBe(true);
    // Replay of a committed read id stays rejected.
    expect(read("read-1", 3)).toBeUndefined();

    const mutation = guard.reserve({
      runId: "run-reads",
      requestId: "mutation-1",
      expectedRevision: 3,
    });
    expect(mutation?.commit()).toBe(true);
    // The mutation consumed revision 3: stale reads and stale mutations both stay rejected.
    expect(read("read-3", 3)).toBeUndefined();
    expect(
      guard.reserve({ runId: "run-reads", requestId: "mutation-2", expectedRevision: 3 }),
    ).toBeUndefined();
    const advanced = read("read-4", 4);
    expect(advanced?.commit()).toBe(true);
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

describe("production runtime singleton manager", () => {
  function fakeManager(
    overrides: Partial<CodingRuntimeManager> = {},
  ): CodingRuntimeManager & { readonly start: ReturnType<typeof vi.fn> } {
    return {
      start: vi.fn(() =>
        Promise.resolve({ ok: true as const, runId: "run-1", status: "ready" as const }),
      ),
      issueApproval: vi.fn(() => ({
        ok: false as const,
        failureCode: "runtime-stopped" as const,
        retryable: false as const,
      })),
      stop: vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
      takeover: vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
      reconcile: vi.fn(() => Promise.resolve({ ok: true as const, status: "stopped" as const })),
      health: vi.fn(() => ({ status: "running" as const })),
      result: vi.fn(() => undefined),
      ...overrides,
    } as CodingRuntimeManager & { readonly start: ReturnType<typeof vi.fn> };
  }

  function fakeAuthority(): CodingRuntimeAuthorityService & {
    readonly transition: ReturnType<typeof vi.fn>;
    readonly abandonUnlaunched: ReturnType<typeof vi.fn>;
    readonly pause: ReturnType<typeof vi.fn>;
    readonly resume: ReturnType<typeof vi.fn>;
  } {
    return {
      transition: vi.fn(() => true),
      abandonUnlaunched: vi.fn(() => true),
      pause: vi.fn(() => ({ ok: true, effectiveMode: "supervised-coding" as const })),
      resume: vi.fn((_runId: string, requestedMode: string) => ({
        ok: true,
        effectiveMode: requestedMode,
      })),
    } as unknown as CodingRuntimeAuthorityService & {
      readonly transition: ReturnType<typeof vi.fn>;
      readonly abandonUnlaunched: ReturnType<typeof vi.fn>;
      readonly pause: ReturnType<typeof vi.fn>;
      readonly resume: ReturnType<typeof vi.fn>;
    };
  }

  function managedRecord(
    runId: string,
    manager: CodingRuntimeManager,
  ): ProductionRuntimeRunRecord & { readonly dispose: ReturnType<typeof vi.fn> } {
    return {
      ...record(runId, {
        submitTurn: () => Promise.resolve(true),
        abortTurn: () => Promise.resolve(true),
        waitForTerminal: () => Promise.resolve("succeeded" as const),
      }),
      manager,
      dispose: vi.fn(() => undefined),
    };
  }

  it("marks the run authority ready and running after a successful launch", async () => {
    const inner = fakeManager();
    const authority = fakeAuthority();
    const runs = new Map([["run-1", managedRecord("run-1", inner)]]);
    const manager = createProductionRuntimeManager(runs, authority);

    await expect(manager.start(launch("run-1"))).resolves.toMatchObject({ ok: true });
    expect(authority.transition.mock.calls).toEqual([
      ["run-1", "ready", expect.any(String)],
      ["run-1", "running", expect.any(String)],
    ]);
    expect(manager.health()).toEqual({ status: "running" });
  });

  it("rejects a start for an unknown run or while another run is active", async () => {
    const inner = fakeManager();
    const runs = new Map([["run-1", managedRecord("run-1", inner)]]);
    const manager = createProductionRuntimeManager(runs, fakeAuthority());

    await expect(manager.start(launch("run-9"))).resolves.toMatchObject({
      ok: false,
      failureCode: "runtime-run-mismatch",
    });
    await manager.start(launch("run-1"));
    await expect(manager.start(launch("run-1"))).resolves.toMatchObject({
      ok: false,
      failureCode: "runtime-run-mismatch",
    });
  });

  it("abandons unlaunched authority and disposes the record after a dead launch failure", async () => {
    const inner = fakeManager({
      start: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          failureCode: "qualification-missing" as const,
          retryable: false as const,
        }),
      ),
      health: vi.fn(() => ({ status: "stopped" as const })),
    });
    const authority = fakeAuthority();
    const failed = managedRecord("run-1", inner);
    const runs = new Map([["run-1", failed]]);
    const manager = createProductionRuntimeManager(runs, authority);

    await expect(manager.start(launch("run-1"))).resolves.toMatchObject({ ok: false });
    expect(authority.abandonUnlaunched.mock.calls).toEqual([["run-1", expect.any(String)]]);
    expect(failed.dispose).toHaveBeenCalledTimes(1);
    expect(failed.controller.signal.aborted).toBe(true);
    expect(runs.size).toBe(0);
    expect(manager.health()).toEqual({ status: "stopped" });
  });

  it("releases a runtime that stopped itself before admitting the next run", async () => {
    let firstStatus: "ready" | "stopped" = "ready";
    const first = fakeManager({
      health: vi.fn(() =>
        firstStatus === "stopped"
          ? { status: "stopped" as const }
          : { status: "ready" as const, activeRunId: "run-1" },
      ),
    });
    const authority = fakeAuthority();
    const stopped = managedRecord("run-1", first);
    const runs = new Map([["run-1", stopped]]);
    const manager = createProductionRuntimeManager(runs, authority);

    await expect(manager.start(launch("run-1"))).resolves.toMatchObject({ ok: true });
    firstStatus = "stopped";
    stopped.controller.abort();
    const next = fakeManager({
      start: vi.fn(() =>
        Promise.resolve({ ok: true as const, runId: "run-2", status: "ready" as const }),
      ),
    });
    runs.set("run-2", managedRecord("run-2", next));

    await expect(manager.start(launch("run-2"))).resolves.toMatchObject({
      ok: true,
      runId: "run-2",
    });
    expect(stopped.dispose).toHaveBeenCalledOnce();
    expect(runs.has("run-1")).toBe(false);
    expect(next.start).toHaveBeenCalledWith(launch("run-2"));
    expect(authority.abandonUnlaunched).not.toHaveBeenCalled();
  });

  it("routes stop, takeover and reconcile only to the live run and cleans it up", async () => {
    const takeover = vi.fn(() =>
      Promise.resolve({ ok: true as const, status: "stopped" as const }),
    );
    const inner = fakeManager({ takeover });
    const cleaned = managedRecord("run-1", inner);
    const runs = new Map([["run-1", cleaned]]);
    const manager = createProductionRuntimeManager(runs, fakeAuthority());

    await expect(manager.stop("run-1")).resolves.toMatchObject({
      ok: false,
      failureCode: "runtime-run-mismatch",
    });

    await manager.start(launch("run-1"));
    await expect(manager.takeover("run-1")).resolves.toEqual({ ok: true, status: "stopped" });
    expect(takeover).toHaveBeenCalledWith("run-1");
    expect(cleaned.dispose).toHaveBeenCalledTimes(1);
    expect(runs.size).toBe(0);
    await expect(manager.reconcile("run-1")).resolves.toMatchObject({
      ok: false,
      failureCode: "runtime-run-mismatch",
    });
  });

  it("retains a body-free terminal result after the runtime slot is cleared", async () => {
    const terminal = {
      status: "succeeded" as const,
      exitCode: null,
      output: { byteCount: 4, lineCount: 1, sha256: "a".repeat(64), truncated: false },
      error: { byteCount: 0, lineCount: 0, sha256: "b".repeat(64), truncated: false },
    };
    const inner = fakeManager({ result: vi.fn(() => terminal) });
    const runs = new Map([["run-1", managedRecord("run-1", inner)]]);
    const manager = createProductionRuntimeManager(runs, fakeAuthority());
    await manager.start(launch("run-1"));

    await expect(manager.stop("run-1", "succeeded")).resolves.toEqual({
      ok: true,
      status: "stopped",
    });
    expect(runs.size).toBe(0);
    expect(manager.result("run-1")).toEqual(terminal);
  });

  it("fails approvals closed without a live run and delegates them to the live run", async () => {
    const approval = {
      ok: false as const,
      failureCode: "runtime-run-mismatch" as const,
      retryable: false as const,
    };
    const inner = fakeManager({ issueApproval: vi.fn(() => approval) });
    const runs = new Map([["run-1", managedRecord("run-1", inner)]]);
    const manager = createProductionRuntimeManager(runs, fakeAuthority());

    expect(manager.issueApproval({} as never)).toMatchObject({
      failureCode: "runtime-stopped",
    });
    await manager.start(launch("run-1"));
    expect(manager.issueApproval({} as never)).toBe(approval);
  });

  function launch(runId: string): Parameters<CodingRuntimeManager["start"]>[0] {
    return { runId } as Parameters<CodingRuntimeManager["start"]>[0];
  }
});

describe("turn port terminal semantics", () => {
  it("maps OpenCode abort and non-terminal outcomes onto the shared contract", async () => {
    const abortTask = vi.fn(() => Promise.resolve(true));
    let terminal = false;
    const runPort: OpenCodeRunPort = {
      submitTask: () => Promise.resolve(true),
      abortTask,
      waitForTerminal: () => Promise.resolve(terminal),
      listQuestions: () => Promise.resolve([]),
      answerQuestion: () => Promise.resolve(false),
      rejectQuestion: () => Promise.resolve(false),
      replyPermission: () => Promise.resolve(false),
    };
    const port = createOpenCodeRuntimeTurnPort(runPort);

    await expect(port.abortTurn("run-open")).resolves.toBe(true);
    expect(abortTask).toHaveBeenCalledWith("run-open");

    const live = new AbortController();
    await expect(port.waitForTerminal("run-open", live.signal)).resolves.toBe("failed");
    live.abort();
    await expect(port.waitForTerminal("run-open", live.signal)).resolves.toBe("cancelled");
    terminal = true;
    await expect(port.waitForTerminal("run-open", new AbortController().signal)).resolves.toBe(
      "succeeded",
    );
  });

  it("fails a Codex terminal wait without a submitted turn and aborts only a live turn", async () => {
    const interruptTurn = vi.fn(() => Promise.resolve({ ok: true as const }));
    const control = codexControl({
      startThread: () => Promise.resolve({ ok: true, threadId: "thread-1" }),
      startTurn: () => Promise.resolve({ ok: true, turnId: "turn-1" }),
      statuses: new Map([["turn-1", "interrupted" as const]]),
    });
    const port = createCodexRuntimeTurnPort({ ...control, interruptTurn });

    await expect(port.waitForTerminal("run-codex", new AbortController().signal)).resolves.toBe(
      "failed",
    );
    await expect(port.abortTurn("run-codex")).resolves.toBe(false);

    await expect(port.submitTurn("run-codex", "task")).resolves.toBe(true);
    await expect(port.abortTurn("run-codex")).resolves.toBe(true);
    expect(interruptTurn).toHaveBeenCalledWith("run-codex", "thread-1", "turn-1", {
      timeoutMs: 30_000,
    });
    await expect(port.waitForTerminal("run-codex", new AbortController().signal)).resolves.toBe(
      "cancelled",
    );
  });

  it("maps failed Codex terminal statuses and polls until abort", async () => {
    const failedControl = codexControl({
      startThread: () => Promise.resolve({ ok: true, threadId: "thread-1" }),
      startTurn: () => Promise.resolve({ ok: true, turnId: "turn-1" }),
      statuses: new Map([["turn-1", "failed" as const]]),
    });
    const failedPort = createCodexRuntimeTurnPort(failedControl);
    await failedPort.submitTurn("run-codex", "task");
    await expect(
      failedPort.waitForTerminal("run-codex", new AbortController().signal),
    ).resolves.toBe("failed");

    const pendingControl = codexControl({
      startThread: () => Promise.resolve({ ok: true, threadId: "thread-1" }),
      startTurn: () => Promise.resolve({ ok: true, turnId: "turn-1" }),
      statuses: new Map(),
    });
    const pendingPort = createCodexRuntimeTurnPort(pendingControl);
    await pendingPort.submitTurn("run-codex", "task");
    const controller = new AbortController();
    const pending = pendingPort.waitForTerminal("run-codex", controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 30);
    await expect(pending).resolves.toBe("cancelled");
  });

  it("releases a declined submit for retry and reports an unprovable terminal as failed", async () => {
    let accept = false;
    const runs = new Map<string, ProductionRuntimeRunRecord>([
      [
        "run-open",
        record("run-open", {
          submitTurn: () => Promise.resolve(accept),
          abortTurn: () => Promise.resolve(true),
          waitForTerminal: () => Promise.reject(new Error("stream torn down")),
        }),
      ],
    ]);
    const dispatcher = createProductionRuntimeTaskDispatcher(runs);

    await expect(dispatcher.dispatch(operation("run-open", "req-1", 1, "task"))).resolves.toEqual({
      ok: false,
    });
    accept = true;
    const retried = await dispatcher.dispatch(operation("run-open", "req-1", 1, "task"));
    expect(retried.ok).toBe(true);
    if (retried.ok) await expect(retried.completion).resolves.toBe("failed");
  });

  it("keeps a successful turn live until its pending editor mutation is terminal", async () => {
    let settleMutation: ((settled: boolean) => void) | undefined;
    const mutationSettlement = new Promise<boolean>((resolve) => {
      settleMutation = resolve;
    });
    const run = record("run-open", {
      submitTurn: () => Promise.resolve(true),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded" as const),
    });
    const waitForPendingMutations = vi.fn(() => mutationSettlement);
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-open", { ...run, waitForPendingMutations }]]),
    );

    const dispatched = await dispatcher.dispatch(operation("run-open", "req-1", 1, "task"));
    if (!dispatched.ok) throw new Error("expected accepted task");
    let terminal = false;
    void dispatched.completion.then(() => {
      terminal = true;
    });
    await vi.waitFor(() => {
      expect(waitForPendingMutations).toHaveBeenCalledOnce();
    });
    expect(terminal).toBe(false);

    settleMutation?.(true);
    await expect(dispatched.completion).resolves.toBe("succeeded");
  });

  it("aborts a task only when the adapter accepts the interruption", async () => {
    let accept = false;
    const runs = new Map<string, ProductionRuntimeRunRecord>([
      [
        "run-open",
        record("run-open", {
          submitTurn: () => Promise.resolve(true),
          abortTurn: () => Promise.resolve(accept),
          waitForTerminal: () => Promise.resolve("succeeded" as const),
        }),
      ],
    ]);
    const dispatcher = createProductionRuntimeTaskDispatcher(runs);

    await expect(dispatcher.abort(operation("run-open", "req-1", 1, "task"))).resolves.toBe(false);
    expect(runs.get("run-open")?.controller.signal.aborted).toBe(true);
    await expect(dispatcher.abort(operation("missing", "req-2", 2, "task"))).resolves.toBe(false);

    const acceptedRuns = new Map<string, ProductionRuntimeRunRecord>([
      [
        "run-open",
        record("run-open", {
          submitTurn: () => Promise.resolve(true),
          abortTurn: () => Promise.resolve(true),
          waitForTerminal: () => Promise.resolve("cancelled" as const),
        }),
      ],
    ]);
    accept = true;
    const acceptedDispatcher = createProductionRuntimeTaskDispatcher(acceptedRuns);
    await expect(acceptedDispatcher.abort(operation("run-open", "req-1", 1, "task"))).resolves.toBe(
      true,
    );
    expect(acceptedRuns.get("run-open")?.controller.signal.aborted).toBe(true);
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
