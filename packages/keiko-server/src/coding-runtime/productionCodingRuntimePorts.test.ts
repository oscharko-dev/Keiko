import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Local port fixtures are contextually typed. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexRuntimeControl } from "./codexRuntimeComposition.js";
import type { OpenCodeRunPort } from "./opencodeRuntimeComposition.js";
import type { PromptInputsRequest } from "./opencodePromptInputs.js";
import type { CodingRuntimeManager } from "./codingRuntimeManager.js";
import type { CodingRuntimeAuthorityService } from "./runtimeAuthorityService.js";
import type { ServerDiagnosticRecord } from "../diagnostics-log.js";
import type { GitChangeSnapshotService } from "../gitChangeSnapshotService.js";
import {
  GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
  type GitChangeSnapshot,
} from "@oscharko-dev/keiko-contracts/runtime/git-change-snapshot";
import type { GitDeliveryDescriptionAuthorityPort } from "../gitDelivery/runBoundAuthority.js";
import type { PrDescriptionArtifact } from "@oscharko-dev/keiko-contracts/runtime/pr-description";
import type { PrDescription } from "@oscharko-dev/keiko-model-gateway";
import type { WorkbenchDescriptionScope } from "./codingRuntimeDescriptionJobStore.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import {
  createCodexRuntimeTurnPort,
  createOpenCodeRuntimeTurnPort,
  createProductionRuntimeManager,
  createProductionRuntimeOperationGuard,
  createProductionRuntimeTaskDispatcher,
  createProductionWorkbenchDescriptionDispatcher,
  renderInitialTurnContext,
  type ProductionRuntimeRunRecord,
  type ProductionWorkbenchArtifactRetention,
  type ProductionWorkbenchDescriptionDeps,
} from "./productionCodingRuntimePorts.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

// #3401: `createProductionWorkbenchDescriptionDispatcher` composes #3398's real
// `PrDescription.generatePrDescription` core. Every other describe block in this file exercises
// Codex/OpenCode ports and never touches the Model Gateway, so mocking it here is scoped to this
// one suite (see the "generated" happy-path test) without disturbing the rest of the file.
const generatePrDescriptionMock = vi.hoisted(() => vi.fn());
vi.mock("@oscharko-dev/keiko-model-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oscharko-dev/keiko-model-gateway")>();
  return {
    ...actual,
    PrDescription: { ...actual.PrDescription, generatePrDescription: generatePrDescriptionMock },
  };
});

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

  describe("primary agent (#3897)", () => {
    function openCodeRunPort(
      submitTask: OpenCodeRunPort["submitTask"],
      selectableAgents?: OpenCodeRunPort["selectableAgents"],
    ): OpenCodeRunPort {
      return {
        submitTask,
        ...(selectableAgents === undefined ? {} : { selectableAgents }),
        abortTask: () => Promise.resolve(true),
        waitForTerminal: () => Promise.resolve(true),
        listQuestions: () => Promise.resolve([]),
        answerQuestion: () => Promise.resolve(false),
        rejectQuestion: () => Promise.resolve(false),
        replyPermission: () => Promise.resolve(false),
      };
    }

    it("hands the requested agent to the run-bound turn and none for a plain turn", async () => {
      const submitTask = vi.fn<OpenCodeRunPort["submitTask"]>(() => Promise.resolve(true));
      const runs = new Map<string, ProductionRuntimeRunRecord>([
        [
          "run-agent",
          record(
            "run-agent",
            createOpenCodeRuntimeTurnPort(openCodeRunPort(submitTask, ["build", "plan"])),
          ),
        ],
      ]);
      const dispatcher = createProductionRuntimeTaskDispatcher(runs);

      await expect(
        dispatcher.dispatch({
          ...operation("run-agent", "initial-1", 1, "plan it"),
          agent: "plan",
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        dispatcher.dispatch(operation("run-agent", "follow-up-1", 2, "build it")),
      ).resolves.toMatchObject({ ok: true });

      expect(submitTask.mock.calls).toEqual([
        ["run-agent", "plan it", undefined, "plan"],
        ["run-agent", "build it", undefined, undefined],
      ]);
    });

    it("refuses an agent the run's port does not offer before the adapter is reached", async () => {
      const records: ServerDiagnosticRecord[] = [];
      const submitTask = vi.fn<OpenCodeRunPort["submitTask"]>(() => Promise.resolve(true));
      const dispatcher = createProductionRuntimeTaskDispatcher(
        new Map([
          [
            "run-mapped",
            record("run-mapped", createOpenCodeRuntimeTurnPort(openCodeRunPort(submitTask))),
          ],
        ]),
        { record: (diagnostic): void => void records.push(diagnostic) },
      );

      await expect(
        dispatcher.dispatch({
          ...operation("run-mapped", "follow-up-plan", 1, "private plan task"),
          agent: "plan",
        }),
      ).resolves.toEqual({ ok: false, reason: "agent-unsupported" });
      expect(submitTask).not.toHaveBeenCalled();
      expect(records).toEqual([
        expect.objectContaining({
          correlationId: "run-mapped",
          operation: "coding-runtime.task-dispatch",
          code: "stage=dispatch:reason=agent-unsupported",
        }),
      ]);
      expect(JSON.stringify(records)).not.toContain("private plan task");
      // The refusal released its reservation: the same revision still admits a plain turn.
      await expect(
        dispatcher.dispatch(operation("run-mapped", "follow-up-build", 1, "build it")),
      ).resolves.toMatchObject({ ok: true });
      // The default agent is every run's baseline, so naming it needs no capability.
      await expect(
        dispatcher.dispatch({
          ...operation("run-mapped", "follow-up-build-2", 2, "build again"),
          agent: "build",
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it("refuses an unsupported agent on a replacement without interrupting the predecessor", async () => {
      const abortTurn = vi.fn(() => Promise.resolve(true));
      const submitTurn = vi.fn(() => Promise.resolve(true));
      const dispatcher = createProductionRuntimeTaskDispatcher(
        new Map([
          [
            "run-replace-agent",
            record("run-replace-agent", {
              submitTurn,
              abortTurn,
              waitForTerminal: () => Promise.resolve("succeeded" as const),
            }),
          ],
        ]),
      );
      if (dispatcher.replace === undefined) throw new Error("replace dispatcher is unavailable");

      await expect(
        dispatcher.replace({
          ...operation("run-replace-agent", "follow-up-1", 2, "plan instead"),
          agent: "plan",
        }),
      ).resolves.toEqual({ ok: false, reason: "agent-unsupported" });
      expect(abortTurn).not.toHaveBeenCalled();
      expect(submitTurn).not.toHaveBeenCalled();
    });

    it("hands a replacement's agent to the turn once the predecessor settled", async () => {
      const submitTurn = vi.fn<ProductionRuntimeRunRecord["turnPort"]["submitTurn"]>(() =>
        Promise.resolve(true),
      );
      const dispatcher = createProductionRuntimeTaskDispatcher(
        new Map([
          [
            "run-replace-agent",
            record("run-replace-agent", {
              submitTurn,
              selectableAgents: ["build", "plan"],
              abortTurn: () => Promise.resolve(true),
              waitForTerminal: () => Promise.resolve("succeeded" as const),
            }),
          ],
        ]),
      );
      if (dispatcher.replace === undefined) throw new Error("replace dispatcher is unavailable");

      await expect(
        dispatcher.replace({
          ...operation("run-replace-agent", "follow-up-1", 2, "plan instead"),
          agent: "plan",
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(submitTurn).toHaveBeenCalledWith(
        "run-replace-agent",
        "plan instead",
        undefined,
        "plan",
      );
    });

    it("keeps a Codex run on its single agent: refuses plan and ignores the default", async () => {
      const startThread = vi.fn(() => Promise.resolve({ ok: true as const, threadId: "thread-1" }));
      const startTurn = vi
        .fn<CodexRuntimeControl["startTurn"]>()
        .mockResolvedValue({ ok: true, turnId: "turn-1" });
      const control = codexControl({
        startThread,
        startTurn,
        statuses: new Map([["turn-1", "completed" as const]]),
      });
      const dispatcher = createProductionRuntimeTaskDispatcher(
        new Map([["run-codex", record("run-codex", createCodexRuntimeTurnPort(control))]]),
      );

      await expect(
        dispatcher.dispatch({ ...operation("run-codex", "plan-1", 1, "plan"), agent: "plan" }),
      ).resolves.toEqual({ ok: false, reason: "agent-unsupported" });
      expect(startThread).not.toHaveBeenCalled();
      await expect(
        dispatcher.dispatch({ ...operation("run-codex", "build-1", 1, "build"), agent: "build" }),
      ).resolves.toMatchObject({ ok: true });
      expect(startTurn.mock.calls.map((call) => call.slice(0, 3))).toEqual([
        ["run-codex", "thread-1", "build"],
      ]);
    });
  });

  // ADR-0137 D10: a prompt's inputs beyond its text (a message that joins the running turn, files it
  // references) are admitted by the run's own port before anything is reserved, interrupted or sent.
  describe("prompt inputs (ADR-0137 D10)", () => {
    const FILE = { uri: "file:///work/space/src/app.ts", name: "app.ts" };
    const ADMITTED = { files: [FILE], fileBytes: 10, referenceCount: 1 };

    function inputsPort(
      overrides: Partial<ProductionRuntimeRunRecord["turnPort"]> = {},
    ): ProductionRuntimeRunRecord["turnPort"] {
      return {
        submitTurn: vi.fn(() => Promise.resolve(true)),
        abortTurn: vi.fn(() => Promise.resolve(true)),
        waitForTerminal: () => Promise.resolve("succeeded" as const),
        admitPromptInputs: vi.fn((_runId: string, request: PromptInputsRequest) => ({
          ok: true as const,
          inputs: { ...ADMITTED, delivery: request.delivery },
        })),
        deliverPrompt: vi.fn(() => Promise.resolve(true)),
        ...overrides,
      };
    }

    function deliverer(
      turnPort: ProductionRuntimeRunRecord["turnPort"],
      options: {
        readonly live?: () => boolean;
        readonly diagnostics?: ServerDiagnosticRecord[];
      } = {},
    ) {
      const controller = new AbortController();
      const run: ProductionRuntimeRunRecord = {
        turnPort,
        controller,
        operationGuard: createProductionRuntimeOperationGuard(
          "run-1",
          options.live ?? (() => true),
        ),
      };
      const diagnostics = options.diagnostics;
      const dispatcher = createProductionRuntimeTaskDispatcher(
        new Map([["run-1", run]]),
        diagnostics === undefined
          ? undefined
          : { record: (diagnostic): void => void diagnostics.push(diagnostic) },
      );
      const deliver = dispatcher.deliver;
      if (deliver === undefined) throw new Error("deliver dispatcher is unavailable");
      return { dispatcher, deliver, controller };
    }

    const steer = (requestId = "steer-1", expectedRevision = 4) => ({
      ...operation("run-1", requestId, expectedRevision, "also cover the empty case"),
      delivery: "steer" as const,
      references: [{ path: "src/app.ts" }],
      correlationId: "corr-0123456789",
    });

    it("admits a delivery through the run's port, sends the admitted inputs and starts no turn", async () => {
      const turnPort = inputsPort();
      const { deliver } = deliverer(turnPort);

      await expect(deliver(steer())).resolves.toEqual({ ok: true });

      expect(turnPort.admitPromptInputs).toHaveBeenCalledExactlyOnceWith("run-1", {
        delivery: "steer",
        references: [{ path: "src/app.ts" }],
        correlationId: "corr-0123456789",
      });
      expect(turnPort.deliverPrompt).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        "also cover the empty case",
        { ...ADMITTED, delivery: "steer" },
      );
      expect(turnPort.submitTurn).not.toHaveBeenCalled();
      expect(turnPort.abortTurn).not.toHaveBeenCalled();
    });

    it("consumes the revision once: a second delivery at the same revision is not admitted", async () => {
      const turnPort = inputsPort();
      const { deliver } = deliverer(turnPort);
      await expect(deliver(steer("steer-1", 4))).resolves.toEqual({ ok: true });
      await expect(deliver(steer("steer-2", 4))).resolves.toEqual({ ok: false });
      await expect(deliver(steer("steer-1", 5))).resolves.toEqual({ ok: false });
      await expect(deliver(steer("steer-3", 5))).resolves.toEqual({ ok: true });
      expect(turnPort.deliverPrompt).toHaveBeenCalledTimes(2);
    });

    it("revalidates the live authority before every delivery: an expired envelope delivers nothing", async () => {
      let live = true;
      const turnPort = inputsPort();
      const { deliver } = deliverer(turnPort, { live: () => live });
      live = false;
      await expect(deliver(steer())).resolves.toEqual({ ok: false });
      expect(turnPort.deliverPrompt).not.toHaveBeenCalled();
      live = true;
      await expect(deliver(steer())).resolves.toEqual({ ok: true });
    });

    it("refuses a delivery to a stopped run and to an unknown run", async () => {
      const turnPort = inputsPort();
      const { dispatcher, deliver, controller } = deliverer(turnPort);
      controller.abort();
      await expect(deliver(steer())).resolves.toEqual({ ok: false });
      await expect(dispatcher.deliver?.({ ...steer(), runId: "run-other" })).resolves.toEqual({
        ok: false,
      });
      expect(turnPort.admitPromptInputs).not.toHaveBeenCalled();
      expect(turnPort.deliverPrompt).not.toHaveBeenCalled();
    });

    it("refuses a delivery the run's port cannot take as the request's own fault, reserving nothing", async () => {
      const records: ServerDiagnosticRecord[] = [];
      const { deliver } = deliverer(
        inputsPort({ admitPromptInputs: undefined, deliverPrompt: undefined }),
        { diagnostics: records },
      );
      await expect(deliver(steer())).resolves.toEqual({ ok: false, reason: "inputs-refused" });
      expect(records).toEqual([
        expect.objectContaining({
          correlationId: "corr-0123456789",
          operation: "coding-runtime.task-dispatch",
          code: "stage=dispatch:reason=inputs-refused",
        }),
      ]);
      expect(JSON.stringify(records)).not.toContain("also cover the empty case");
    });

    it("refuses a delivery whose admission fails, before the guard or the adapter is reached", async () => {
      const deliverPrompt = vi.fn(() => Promise.resolve(true));
      let admit: ProductionRuntimeRunRecord["turnPort"]["admitPromptInputs"] = () => ({
        ok: false as const,
        reason: "turn-not-running" as const,
      });
      const turnPort = inputsPort({
        admitPromptInputs: (runId, request) =>
          admit?.(runId, request) ?? { ok: false, reason: "run-unavailable" },
        deliverPrompt,
      });
      const { deliver } = deliverer(turnPort);
      await expect(deliver(steer())).resolves.toEqual({ ok: false, reason: "inputs-refused" });
      expect(deliverPrompt).not.toHaveBeenCalled();
      // Nothing was reserved: the same revision still admits a delivery once the port accepts it.
      admit = inputsPort().admitPromptInputs;
      await expect(deliver(steer())).resolves.toEqual({ ok: true });
    });

    it("never accepts a plain turn as a delivery or a delivery as a turn", async () => {
      const turnPort = inputsPort();
      const { dispatcher, deliver } = deliverer(turnPort);
      await expect(
        deliver({ ...operation("run-1", "plain-1", 4, "no delivery named") }),
      ).resolves.toEqual({ ok: false, reason: "inputs-refused" });
      await expect(dispatcher.dispatch(steer("steer-as-turn", 4))).resolves.toEqual({
        ok: false,
        reason: "inputs-refused",
      });
      await expect(dispatcher.replace?.(steer("steer-as-replace", 4))).resolves.toEqual({
        ok: false,
        reason: "inputs-refused",
      });
      expect(turnPort.deliverPrompt).not.toHaveBeenCalled();
      expect(turnPort.submitTurn).not.toHaveBeenCalled();
      expect(turnPort.abortTurn).not.toHaveBeenCalled();
    });

    it("releases the reservation when the adapter does not take the message", async () => {
      const records: ServerDiagnosticRecord[] = [];
      let accept = false;
      const turnPort = inputsPort({ deliverPrompt: vi.fn(() => Promise.resolve(accept)) });
      const { deliver } = deliverer(turnPort, { diagnostics: records });
      await expect(deliver(steer())).resolves.toEqual({ ok: false });
      expect(records).toEqual([
        expect.objectContaining({ code: "stage=dispatch:reason=adapter-rejected" }),
      ]);
      accept = true;
      await expect(deliver(steer("steer-1", 4))).resolves.toEqual({ ok: true });
    });

    it("answers a thrown delivery with a body-free diagnostic and frees the reservation", async () => {
      const records: ServerDiagnosticRecord[] = [];
      let fail = true;
      const turnPort = inputsPort({
        deliverPrompt: vi.fn(() =>
          fail ? Promise.reject(new Error("PRIVATE-DELIVERY-FAILURE")) : Promise.resolve(true),
        ),
      });
      const { deliver } = deliverer(turnPort, { diagnostics: records });
      await expect(deliver(steer())).resolves.toEqual({ ok: false });
      expect(records).toEqual([
        expect.objectContaining({ code: "stage=dispatch:reason=exception" }),
      ]);
      expect(JSON.stringify(records)).not.toContain("PRIVATE-DELIVERY-FAILURE");
      fail = false;
      await expect(deliver(steer())).resolves.toEqual({ ok: true });
    });

    it("hands the admitted references to the turn a follow-up starts, as one more argument", async () => {
      const turnPort = inputsPort({ selectableAgents: ["build", "plan"] });
      const { dispatcher } = deliverer(turnPort);
      await expect(
        dispatcher.dispatch({
          ...operation("run-1", "follow-up-1", 4, "look at the file"),
          references: [{ path: "src/app.ts" }],
          correlationId: "corr-0123456789",
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(turnPort.admitPromptInputs).toHaveBeenCalledExactlyOnceWith("run-1", {
        delivery: undefined,
        references: [{ path: "src/app.ts" }],
        correlationId: "corr-0123456789",
      });
      expect(turnPort.submitTurn).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        "look at the file",
        undefined,
        undefined,
        { ...ADMITTED, delivery: undefined },
      );
    });

    it("asks the port nothing for a prompt that carries no inputs", async () => {
      const turnPort = inputsPort();
      const { dispatcher } = deliverer(turnPort);
      await dispatcher.dispatch(operation("run-1", "plain-1", 4, "plain"));
      expect(turnPort.admitPromptInputs).not.toHaveBeenCalled();
      expect(turnPort.submitTurn).toHaveBeenCalledExactlyOnceWith(
        "run-1",
        "plain",
        undefined,
        undefined,
      );
    });

    it("refuses referenced files on a port that takes none, before interrupting a paused turn", async () => {
      const turnPort = inputsPort({ admitPromptInputs: undefined, deliverPrompt: undefined });
      const { dispatcher } = deliverer(turnPort);
      const references = [{ path: "src/app.ts" }];
      await expect(
        dispatcher.dispatch({ ...operation("run-1", "f-1", 4, "t"), references }),
      ).resolves.toEqual({ ok: false, reason: "inputs-refused" });
      await expect(
        dispatcher.replace?.({ ...operation("run-1", "f-2", 4, "t"), references }),
      ).resolves.toEqual({ ok: false, reason: "inputs-refused" });
      expect(turnPort.abortTurn).not.toHaveBeenCalled();
      expect(turnPort.submitTurn).not.toHaveBeenCalled();
    });

    it("admits the references of a replacement before it interrupts the predecessor", async () => {
      const order: string[] = [];
      const turnPort = inputsPort({
        admitPromptInputs: vi.fn(() => {
          order.push("admit");
          return { ok: true as const, inputs: ADMITTED };
        }),
        abortTurn: vi.fn(() => {
          order.push("abort");
          return Promise.resolve(true);
        }),
        submitTurn: vi.fn(() => {
          order.push("submit");
          return Promise.resolve(true);
        }),
      });
      const { dispatcher } = deliverer(turnPort);
      await expect(
        dispatcher.replace?.({
          ...operation("run-1", "replace-1", 4, "again"),
          references: [{ path: "src/app.ts" }],
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(order).toEqual(["admit", "abort", "submit"]);
      expect(turnPort.submitTurn).toHaveBeenCalledWith(
        "run-1",
        "again",
        undefined,
        undefined,
        ADMITTED,
      );
    });

    it("forwards a profile's prompt inputs from the OpenCode run port, and none from one without them", () => {
      const deliverPrompt = vi.fn(() => Promise.resolve(true));
      const admitPromptInputs = vi.fn(() => ({ ok: true as const, inputs: ADMITTED }));
      const base: OpenCodeRunPort = {
        submitTask: () => Promise.resolve(true),
        abortTask: () => Promise.resolve(true),
        waitForTerminal: () => Promise.resolve(true),
        listQuestions: () => Promise.resolve([]),
        answerQuestion: () => Promise.resolve(false),
        rejectQuestion: () => Promise.resolve(false),
        replyPermission: () => Promise.resolve(false),
      };
      expect(createOpenCodeRuntimeTurnPort(base).admitPromptInputs).toBeUndefined();
      expect(createOpenCodeRuntimeTurnPort(base).deliverPrompt).toBeUndefined();
      const port = createOpenCodeRuntimeTurnPort({ ...base, admitPromptInputs, deliverPrompt });
      expect(port.admitPromptInputs).toBe(admitPromptInputs);
      expect(port.deliverPrompt).toBe(deliverPrompt);
    });
  });

  it("interrupts an active turn before replacing it and releases a rejected attempt", async () => {
    const controller = new AbortController();
    const abortTurn = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const waitForTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error("private terminal failure"))
      .mockResolvedValueOnce("cancelled" as const)
      .mockResolvedValue("succeeded" as const);
    const submitTurn = vi.fn(() => Promise.resolve(true));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-replace",
          {
            controller,
            operationGuard: createProductionRuntimeOperationGuard("run-replace", () => true),
            turnPort: {
              submitTurn,
              abortTurn,
              waitForTerminal,
            },
          },
        ],
      ]),
    );
    const request = operation("run-replace", "follow-up-1", 2, "operator correction");
    if (dispatcher.replace === undefined) throw new Error("replace dispatcher is unavailable");

    await expect(dispatcher.replace(request)).resolves.toEqual({ ok: false });
    await expect(dispatcher.replace(request)).resolves.toEqual({ ok: false });
    await expect(dispatcher.replace(request)).resolves.toMatchObject({ ok: true });
    expect(abortTurn).toHaveBeenCalledTimes(3);
    expect(waitForTerminal).toHaveBeenCalledTimes(3);
    expect(waitForTerminal.mock.invocationCallOrder[1]).toBeLessThan(
      submitTurn.mock.invocationCallOrder[0] ?? 0,
    );
    expect(controller.signal.aborted).toBe(false);
  });

  it("refuses a replacement when the run stops during predecessor settlement", async () => {
    const controller = new AbortController();
    const submitTurn = vi.fn(() => Promise.resolve(true));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-replace",
          {
            controller,
            operationGuard: createProductionRuntimeOperationGuard("run-replace", () => true),
            turnPort: {
              submitTurn,
              abortTurn: () => Promise.resolve(true),
              waitForTerminal: () => {
                controller.abort();
                return Promise.resolve("cancelled" as const);
              },
            },
          },
        ],
      ]),
    );
    const request = operation("run-replace", "follow-up-1", 2, "operator correction");
    if (dispatcher.replace === undefined) throw new Error("replace dispatcher is unavailable");

    await expect(dispatcher.replace(request)).resolves.toEqual({ ok: false });
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it("logs correlated body-free start and terminal outcomes for replacement", async () => {
    const sink = createBufferedServerLogSink();
    const diagnostics: ServerDiagnosticRecord[] = [];
    const abortTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("private interrupt failure"))
      .mockResolvedValueOnce(true);
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-replace",
          record("run-replace", {
            submitTurn: () => Promise.resolve(true),
            abortTurn,
            waitForTerminal: () => Promise.resolve("cancelled" as const),
          }),
        ],
      ]),
      { record: (diagnostic): void => void diagnostics.push(diagnostic) },
    );
    const request = {
      ...operation("run-replace", "follow-up-1", 2, "private operator correction"),
      correlationId: "request-correlation-id-1",
    };
    if (dispatcher.replace === undefined) throw new Error("replace dispatcher is unavailable");
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      await expect(dispatcher.replace(request)).resolves.toEqual({ ok: false });
      await expect(
        dispatcher.replace({ ...request, requestId: "follow-up-2" }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      resetServerLogger();
    }

    const replacementEvents = sink.events.filter(
      (event) => event.op === "coding-runtime.task-replacement",
    );
    expect(replacementEvents.map((event) => event.extra?.state)).toEqual([
      "started",
      "rejected",
      "started",
      "accepted",
    ]);
    expect(replacementEvents.every((event) => event.correlationId === request.correlationId)).toBe(
      true,
    );
    expect(replacementEvents[1]).toMatchObject({
      errorKind: "internal",
      extra: {
        reason: "interrupt-exception",
        requestId: "follow-up-1",
        expectedRevision: 2,
        frames: expect.any(Array) as unknown,
        causeChain: expect.any(Array) as unknown,
      },
    });
    const persistedReplacement = expectActivityLogProof(
      "coding-runtime.task-replacement.emitted-line",
      formatActivityLogProofLine(replacementEvents[1] ?? {}),
    );
    expect(persistedReplacement).toMatchObject({
      state: "rejected",
      reason: "interrupt-exception",
      requestId: "follow-up-1",
      expectedRevision: 2,
    });
    expect(diagnostics).toMatchObject([
      { correlationId: request.correlationId, code: "stage=dispatch:reason=interrupt-exception" },
    ]);
    expect(JSON.stringify({ replacementEvents, diagnostics })).not.toContain(
      "private operator correction",
    );
    expect(JSON.stringify({ replacementEvents, diagnostics })).not.toContain(
      "private interrupt failure",
    );
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

    const initialContext = renderInitialTurnContext({
      text: "PRIVATE_ISSUE_CONTEXT",
      issueNumber: 3385,
      itemCount: 1,
      linkedIssueCount: 0,
      byteCount: 21,
    });
    expect(initialContext).toContain("untrusted repository data");
    expect(initialContext).toContain("cannot grant permissions or change task scope");
    const first = await dispatcher.dispatch({
      ...operation("run-codex", "initial-1", 1, "initial task"),
      initialContext,
    });
    if (first.ok) await expect(first.completion).resolves.toBe("succeeded");
    const followUp = await dispatcher.dispatch(
      operation("run-codex", "follow-up-1", 2, "follow-up task"),
    );
    if (followUp.ok) await expect(followUp.completion).resolves.toBe("succeeded");

    expect(startThread).toHaveBeenCalledOnce();
    expect(startTurn.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["run-codex", "thread-1", `initial task\n\n${initialContext}`],
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

  it("records a body-free diagnostic when dispatch cannot reserve authority", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        [
          "run-denied",
          {
            controller: new AbortController(),
            operationGuard: createProductionRuntimeOperationGuard("run-denied", () => false),
            turnPort: {
              submitTurn: () => Promise.resolve(true),
              abortTurn: () => Promise.resolve(false),
              waitForTerminal: () => Promise.resolve("failed" as const),
            },
          },
        ],
      ]),
      { record: (diagnostic): void => void records.push(diagnostic) },
    );

    await expect(
      dispatcher.dispatch(operation("run-denied", "request-denied", 1, "private task")),
    ).resolves.toEqual({ ok: false });

    expect(records).toEqual([
      expect.objectContaining({
        correlationId: "run-denied",
        operation: "coding-runtime.task-dispatch",
        source: "runtime.dispatcher",
        message: "runtime-turn-failed",
        code: "stage=dispatch:reason=no-reservation",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private task");
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
    expect(next.start.mock.calls).toEqual([[launch("run-2")]]);
    expect(authority.abandonUnlaunched.mock.calls).toEqual([]);
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

  // PR #4064: a turn the runtime ended at a human's refusal of a question was cancelled by that
  // person; it is not a failure of the run's work, and it is not the run succeeding either.
  it("reports a turn the runtime interrupted as cancelled, with no terminal-failure diagnostic", async () => {
    const runPort: OpenCodeRunPort = {
      submitTask: () => Promise.resolve(true),
      abortTask: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("interrupted"),
      listQuestions: () => Promise.resolve([]),
      answerQuestion: () => Promise.resolve(false),
      rejectQuestion: () => Promise.resolve(false),
      replyPermission: () => Promise.resolve(false),
    };
    const port = createOpenCodeRuntimeTurnPort(runPort);
    await expect(port.waitForTerminal("run-open", new AbortController().signal)).resolves.toBe(
      "cancelled",
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
    let settleMutation: ((idle: "idle-succeeded" | "idle-failed" | "not-idle") => void) | undefined;
    const mutationSettlement = new Promise<"idle-succeeded" | "idle-failed" | "not-idle">(
      (resolve) => {
        settleMutation = resolve;
      },
    );
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

    settleMutation?.("idle-succeeded");
    await expect(dispatched.completion).resolves.toBe("succeeded");
  });

  // Epic #3384 cascade: a REFUSED edit that never reached the commit boundary (no live Workbench
  // bridge) used to fail the whole run under "pending-mutations-unsettled" even though nothing was
  // pending. The coordinator now distinguishes "idle but a CLAIMED mutation failed" from "never
  // went idle at all" (codingRuntimeEditorMutationLeaseCoordinator.ts), and this dispatcher must
  // report each under its own closed reason.
  it("reports mutation-failed (not pending-mutations-unsettled) when the coordinator went idle but the latest claimed mutation failed", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const run = record("run-open", {
      submitTurn: () => Promise.resolve(true),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded" as const),
    });
    const waitForPendingMutations = vi.fn(() => Promise.resolve("idle-failed" as const));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-open", { ...run, waitForPendingMutations }]]),
      { record: (diagnostic): void => void records.push(diagnostic) },
    );

    const dispatched = await dispatcher.dispatch(operation("run-open", "req-1", 1, "task"));
    if (!dispatched.ok) throw new Error("expected accepted task");
    await expect(dispatched.completion).resolves.toBe("failed");
    expect(records).toContainEqual(
      expect.objectContaining({
        correlationId: "run-open",
        code: "stage=dispatch:reason=mutation-failed",
      }),
    );
  });

  it("reports pending-mutations-unsettled only when the coordinator never went idle", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const run = record("run-open", {
      submitTurn: () => Promise.resolve(true),
      abortTurn: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve("succeeded" as const),
    });
    const waitForPendingMutations = vi.fn(() => Promise.resolve("not-idle" as const));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-open", { ...run, waitForPendingMutations }]]),
      { record: (diagnostic): void => void records.push(diagnostic) },
    );

    const dispatched = await dispatcher.dispatch(operation("run-open", "req-1", 1, "task"));
    if (!dispatched.ok) throw new Error("expected accepted task");
    await expect(dispatched.completion).resolves.toBe("failed");
    expect(records).toContainEqual(
      expect.objectContaining({
        correlationId: "run-open",
        code: "stage=dispatch:reason=pending-mutations-unsettled",
      }),
    );
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

describe("createProductionWorkbenchDescriptionDispatcher (#3401)", () => {
  beforeEach(() => {
    generatePrDescriptionMock.mockReset();
  });
  const REMOTE = "d".repeat(64);
  const BASE_SHA = "1".repeat(40);
  const HEAD_SHA = "2".repeat(40);
  const BASE_REF = "dev";
  const HEAD_REF = "feature/x";
  const SCOPE: WorkbenchDescriptionScope = {
    runId: "run-1",
    remoteDigest: REMOTE,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    acceptedMode: "supervised-coding",
    baseRef: BASE_REF,
    headRef: HEAD_REF,
  };
  const PR_SCOPE: WorkbenchDescriptionScope = {
    ...SCOPE,
    applicationTarget: {
      projectId: "/workspace",
      ownerAndRepo: "octo/repo",
      prNumber: 17,
    },
  };

  function snapshotFixture(overrides: Partial<GitChangeSnapshot> = {}): GitChangeSnapshot {
    return {
      schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
      repositoryId: "repo_fixture",
      remoteDigest: REMOTE,
      baseRef: "dev",
      baseSha: BASE_SHA,
      headRef: "feature/x",
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      capturedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z",
      outcome: "complete",
      limits: {
        maxFiles: 400,
        maxHunksPerFile: 256,
        maxPatchBytes: 262144,
        maxTotalBytes: 2097152,
      },
      completeness: {
        totalFiles: 1,
        files: 1,
        hunks: 1,
        bytes: 16,
        omittedFiles: 0,
        omittedHunks: 0,
        truncatedFiles: 0,
        kinds: {
          add: 1,
          modify: 0,
          delete: 0,
          rename: 0,
          copy: 0,
          "mode-change": 0,
          binary: 0,
          submodule: 0,
        },
        omissions: [],
      },
      entries: [],
      localDivergence: { stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0 },
      snapshotDigest: "a".repeat(64),
      ...overrides,
    };
  }

  function fakeSnapshots(
    capture: GitChangeSnapshotService["capture"] = () =>
      Promise.reject(new Error("unexpected capture")),
  ): GitChangeSnapshotService {
    return {
      capture,
      read: () => undefined,
      recheck: () => Promise.reject(new Error("unexpected recheck")),
      close: () => undefined,
    };
  }

  function admittingPort(): GitDeliveryDescriptionAuthorityPort {
    return {
      current: () => ({
        scope: {
          remoteDigest: REMOTE,
          pr: { baseRef: BASE_REF, headRef: HEAD_REF },
          snapshotDigest: "a".repeat(64),
        },
        effectiveMode: "supervised-coding",
        expiresAt: "2026-01-01T00:10:00.000Z",
      }),
    };
  }

  function denyingPort(): GitDeliveryDescriptionAuthorityPort {
    return { current: () => undefined };
  }

  // #3400/#3401 final-audit F1: a port that CAN tell a record for this exact scope existed and has
  // since passed its `expiresAt`, distinct from `denyingPort()` above which reports no record ever
  // having existed for the scope.
  function expiredPort(): GitDeliveryDescriptionAuthorityPort {
    return { current: () => undefined, expired: () => true };
  }

  function fakeDeps(
    overrides: Partial<ProductionWorkbenchDescriptionDeps> = {},
  ): ProductionWorkbenchDescriptionDeps {
    return {
      activeWorkspaceRoot: () => "/workspace",
      snapshots: fakeSnapshots(),
      generation: undefined,
      descriptionAuthority: undefined,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("reports generation-unavailable and never captures a snapshot without an active workspace", async () => {
    const capture = vi.fn(() => Promise.resolve({ snapshot: snapshotFixture() }));
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({ activeWorkspaceRoot: () => undefined, snapshots: fakeSnapshots(capture) }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({ reason: "generation-unavailable" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("maps a failed snapshot capture to provider-failed", async () => {
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: fakeSnapshots(() =>
          Promise.resolve({
            snapshot: {
              schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
              repositoryId: "repo_fixture",
              capturedAt: "2026-01-01T00:00:00.000Z",
              outcome: "failed",
              reason: "git-error",
              errorKind: "internal",
            },
          }),
        ),
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({ reason: "provider-failed" });
  });

  it("maps an unavailable snapshot capture to generation-unavailable", async () => {
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: fakeSnapshots(() =>
          Promise.resolve({
            snapshot: {
              schemaVersion: GIT_CHANGE_SNAPSHOT_SCHEMA_VERSION,
              repositoryId: "repo_fixture",
              capturedAt: "2026-01-01T00:00:00.000Z",
              outcome: "unavailable",
              reason: "missing-ref",
            },
          }),
        ),
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({ reason: "generation-unavailable" });
  });

  it("treats a captured remote digest that no longer matches the scope as generation-unavailable", async () => {
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: fakeSnapshots(() =>
          Promise.resolve({
            reference: "ref-1",
            snapshot: snapshotFixture({ remoteDigest: "f".repeat(64) }),
          }),
        ),
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({ reason: "generation-unavailable" });
  });

  it("denies model egress and never calls the Model Gateway when no description authority admits the scope", async () => {
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: fakeSnapshots(() =>
          Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
        ),
        descriptionAuthority: denyingPort(),
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({ reason: "model-egress-denied" });
    expect(generatePrDescriptionMock).not.toHaveBeenCalled();
  });

  // #3400/#3401 final-audit F1: before the read-port discriminant existed, `authorizeGitDelivery
  // ModelEgress` collapsed an expired record and an absent one into the SAME `undefined`, so this
  // dispatcher could only ever report `model-egress-denied` here — never the more specific
  // `authority-expired` reason `WORKBENCH_DESCRIPTION_REASON_STATES` already carries. This is the
  // failing-before case for that mapping, plus its body-free activity-log line.
  it("reports authority-expired (not model-egress-denied) when the port reports a past record", async () => {
    const sink = createBufferedServerLogSink();
    setServerLogger(createServerLogger({ sink, level: "info" }));
    try {
      const dispatcher = createProductionWorkbenchDescriptionDispatcher(
        fakeDeps({
          snapshots: fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          descriptionAuthority: expiredPort(),
        }),
      );
      const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
      expect(outcome).toEqual({ reason: "authority-expired" });
      expect(generatePrDescriptionMock).not.toHaveBeenCalled();
      expect(sink.events).toContainEqual(
        expect.objectContaining({
          category: "security",
          op: "pr-description.workbench.egress.denied",
          errorKind: "authority-denied",
          extra: {
            completeness: "complete",
            loss: "none",
            reason: "authority-expired",
          },
        }),
      );
      const deniedLine = sink.events.find(
        (event) => event.op === "pr-description.workbench.egress.denied",
      );
      const persisted = expectActivityLogProof(
        "pr-description.workbench.egress.denied.emitted-line",
        formatActivityLogProofLine(deniedLine ?? {}),
      );
      expect(persisted).toMatchObject({ reason: "authority-expired" });
    } finally {
      resetServerLogger();
    }
  });

  it("reports generation-unavailable when admitted but no model profile is configured", async () => {
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: {
          ...fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          recheck: () => Promise.resolve({ state: "current", snapshot: snapshotFixture() }),
        },
        descriptionAuthority: admittingPort(),
        generation: undefined,
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({ reason: "generation-unavailable" });
    expect(generatePrDescriptionMock).not.toHaveBeenCalled();
  });

  it("mints the description authority for the exact captured scope before checking admission", async () => {
    const mint = vi.fn();
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: fakeSnapshots(() =>
          Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
        ),
        descriptionAuthority: denyingPort(),
        mintDescriptionAuthority: mint,
      }),
    );
    await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(mint).toHaveBeenCalledExactlyOnceWith({
      scope: {
        remoteDigest: REMOTE,
        pr: { baseRef: BASE_REF, headRef: HEAD_REF },
        snapshotDigest: "a".repeat(64),
      },
      requestedMode: "supervised-coding",
      nowIso: "2026-01-01T00:00:00.000Z",
      correlationId: "run-1",
    });
  });

  it("does not mint when the accepted mode is unavailable", async () => {
    const mint = vi.fn();
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: fakeSnapshots(() =>
          Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
        ),
        descriptionAuthority: denyingPort(),
        mintDescriptionAuthority: mint,
      }),
    );
    const unknownModeScope: WorkbenchDescriptionScope = {
      runId: SCOPE.runId,
      remoteDigest: SCOPE.remoteDigest,
      baseSha: SCOPE.baseSha,
      headSha: SCOPE.headSha,
    };

    await expect(
      dispatcher.generate(unknownModeScope, new AbortController().signal),
    ).resolves.toEqual({ reason: "model-egress-denied" });
    expect(mint).not.toHaveBeenCalled();
    expect(generatePrDescriptionMock).not.toHaveBeenCalled();
  });

  function generatedDescription(): Extract<
    PrDescription.PrDescriptionGenerationResult,
    { readonly status: "generated" }
  > {
    const artifact: PrDescriptionArtifact = {
      schemaVersion: "1",
      renderingVersion: "1",
      binding: { ...snapshotFixture(), snapshotDigest: "a".repeat(64) },
      language: "en",
      outcome: "complete",
      reason: "none",
      coverage: {
        snapshot: snapshotFixture().completeness,
        suppliedEvidenceCount: 0,
        processedEvidenceCount: 0,
        omittedEvidenceCount: 0,
      },
      candidate: { summary: [], keyChanges: [], risks: [], reviewerFocus: [] },
      markdown: "Summary",
      artifactDigest: "b".repeat(64),
    };
    return {
      status: "generated",
      artifact,
    };
  }

  it.each(["stale", "authority-expired"] as const)(
    "discards a generated draft when the post-model check is %s",
    async (state) => {
      let returned = false;
      generatePrDescriptionMock.mockImplementationOnce(() => {
        returned = true;
        return Promise.resolve(generatedDescription());
      });
      const dispatcher = createProductionWorkbenchDescriptionDispatcher(
        fakeDeps({
          snapshots: {
            ...fakeSnapshots(() =>
              Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
            ),
            recheck: () => Promise.resolve({ state: state === "stale" ? "stale" : "current" }),
          },
          descriptionAuthority: {
            current: (...args) =>
              returned && state === "authority-expired"
                ? undefined
                : admittingPort().current(...args),
            expired: () => returned && state === "authority-expired",
          },
          generation: {
            gateway: { chat: vi.fn() },
            config: {} as PrDescription.PrDescriptionDeps["config"],
            log: { write: () => undefined },
          },
        }),
      );
      expect(await dispatcher.generate(SCOPE, new AbortController().signal)).toEqual({
        reason: state === "stale" ? "stale-snapshot" : "authority-expired",
      });
      expect(generatePrDescriptionMock).toHaveBeenCalledOnce();
    },
  );

  it.each(["stale-snapshot", "authority-expired"] as const)(
    "stops additional model calls when a per-call recheck reports %s",
    async (reason) => {
      const gatewayChat = vi.fn(() => Promise.resolve({} as never));
      let recheckCount = 0;
      let authorityReadCount = 0;
      generatePrDescriptionMock.mockImplementationOnce(
        async (
          request: PrDescription.PrDescriptionRequest,
          generation: PrDescription.PrDescriptionDeps,
        ): Promise<PrDescription.PrDescriptionGenerationResult> => {
          const signal = request.signal ?? new AbortController().signal;
          const gatewayRequest = {} as Parameters<typeof generation.gateway.chat>[0];
          for (let remainingCalls = 2; remainingCalls > 0; remainingCalls -= 1) {
            if (!(await generation.revalidateAuthority(request.authority, signal))) {
              return { status: "unavailable", reason: "authority-denied" };
            }
            await generation.gateway.chat(gatewayRequest);
          }
          return generatedDescription();
        },
      );
      const dispatcher = createProductionWorkbenchDescriptionDispatcher(
        fakeDeps({
          snapshots: {
            ...fakeSnapshots(() =>
              Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
            ),
            recheck: () => {
              recheckCount += 1;
              const state = reason === "stale-snapshot" && recheckCount === 2 ? "stale" : "current";
              return Promise.resolve({ state, snapshot: snapshotFixture() });
            },
          },
          descriptionAuthority:
            reason === "authority-expired"
              ? {
                  current: (...args) => {
                    authorityReadCount += 1;
                    return authorityReadCount < 3 ? admittingPort().current(...args) : undefined;
                  },
                  expired: () => authorityReadCount >= 3,
                }
              : admittingPort(),
          generation: {
            gateway: { chat: gatewayChat },
            config: {} as PrDescription.PrDescriptionDeps["config"],
            log: { write: () => undefined },
          },
        }),
      );

      await expect(dispatcher.generate(SCOPE, new AbortController().signal)).resolves.toEqual({
        reason,
      });
      expect(gatewayChat).toHaveBeenCalledOnce();
      expect(recheckCount).toBe(2);
    },
  );

  it("generates through the Model Gateway core once admitted and maps a complete artifact", async () => {
    const generated = generatedDescription();
    generatePrDescriptionMock.mockResolvedValueOnce(generated);
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: {
          ...fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          recheck: () => Promise.resolve({ state: "current", snapshot: snapshotFixture() }),
        },
        descriptionAuthority: admittingPort(),
        generation: {
          gateway: { chat: vi.fn() },
          config: {} as PrDescription.PrDescriptionDeps["config"],
          log: { write: () => undefined },
        },
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toEqual({
      reason: "generated",
      snapshotDigest: "a".repeat(64),
      draftDigest: "b".repeat(64),
      artifactOutcome: "complete",
    });
    expect(generatePrDescriptionMock).toHaveBeenCalledOnce();
  });

  // F56 (Coding Workbench run 24): a fallback stood in for a model answer that was refused as unsafe
  // or invalid output, and the status said the model had been unavailable.
  it.each([
    ["unsafe-model-output", "fallback-output-refused"],
    ["invalid-model-output", "fallback-output-refused"],
    ["model-unavailable", "fallback-generated"],
  ] as const)("names a fallback whose model answer was %s as %s", async (reason, expected) => {
    const generated = generatedDescription();
    generatePrDescriptionMock.mockResolvedValueOnce({
      ...generated,
      artifact: { ...generated.artifact, outcome: "fallback", reason },
    });
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: {
          ...fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          recheck: () => Promise.resolve({ state: "current", snapshot: snapshotFixture() }),
        },
        descriptionAuthority: admittingPort(),
        generation: {
          gateway: { chat: vi.fn() },
          config: {} as PrDescription.PrDescriptionDeps["config"],
          log: { write: () => undefined },
        },
      }),
    );
    const outcome = await dispatcher.generate(SCOPE, new AbortController().signal);
    expect(outcome).toMatchObject({ reason: expected, artifactOutcome: "fallback" });
  });

  it("retains the exact generated artifact once and exposes that same proposal", async () => {
    const generated = generatedDescription();
    generatePrDescriptionMock.mockResolvedValueOnce(generated);
    let retainedSignal: AbortSignal | undefined;
    const retain: ProductionWorkbenchArtifactRetention["retain"] = vi.fn(
      (
        _scope: WorkbenchDescriptionScope,
        _artifact: PrDescriptionArtifact,
        signal: AbortSignal,
      ) => {
        retainedSignal = signal;
        return Promise.resolve("pr-description-1");
      },
    );
    const hasProposal = vi.fn(() => true);
    const reviewDraft = vi.fn(() => undefined);
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: {
          ...fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          recheck: () => Promise.resolve({ state: "current", snapshot: snapshotFixture() }),
        },
        descriptionAuthority: admittingPort(),
        generation: {
          gateway: { chat: vi.fn() },
          config: {} as PrDescription.PrDescriptionDeps["config"],
          log: { write: () => undefined },
        },
        artifactRetention: { retain, hasProposal, reviewDraft },
      }),
    );
    const controller = new AbortController();

    await expect(dispatcher.generate(PR_SCOPE, controller.signal)).resolves.toMatchObject({
      reason: "generated",
      proposalId: "pr-description-1",
    });
    expect(retain).toHaveBeenCalledExactlyOnceWith(PR_SCOPE, generated.artifact, retainedSignal);
    // Epic #3384 closeout ("retained HTTP review remains blocked by a cached operation
    // AbortSignal"): retain() must never receive the run's OWN dispatch signal verbatim — that
    // signal is later aborted independently of this artifact's retained lifecycle (supersede or
    // eventual run pruning in codingRuntimeOrchestrator.ts), and gets baked into the retained
    // proposal's PrDescriptionContext for the full life of the proposal (deps.ts's
    // workbenchDescriptionContextProvider / prDescriptionService.ts's held()). Aborting the
    // dispatch controller AFTER retention must never reach the signal retain() was given.
    expect(retainedSignal).not.toBe(controller.signal);
    expect(retainedSignal?.aborted).toBe(false);
    controller.abort();
    expect(retainedSignal?.aborted).toBe(false);
    expect(dispatcher.hasProposal(PR_SCOPE, "pr-description-1", "a".repeat(64))).toBe(true);
    expect(hasProposal).toHaveBeenCalledExactlyOnceWith(
      PR_SCOPE,
      "pr-description-1",
      "a".repeat(64),
    );
    expect(generatePrDescriptionMock).toHaveBeenCalledOnce();
  });

  it("retains a generic generated artifact without inventing a PR target", async () => {
    const generated = generatedDescription();
    generatePrDescriptionMock.mockResolvedValueOnce(generated);
    let retainedSignal: AbortSignal | undefined;
    const retain: ProductionWorkbenchArtifactRetention["retain"] = vi.fn(
      (
        _scope: WorkbenchDescriptionScope,
        _artifact: PrDescriptionArtifact,
        signal: AbortSignal,
      ) => {
        retainedSignal = signal;
        return Promise.resolve("draft-description-1");
      },
    );
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: {
          ...fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          recheck: () => Promise.resolve({ state: "current", snapshot: snapshotFixture() }),
        },
        descriptionAuthority: admittingPort(),
        generation: {
          gateway: { chat: vi.fn() },
          config: {} as PrDescription.PrDescriptionDeps["config"],
          log: { write: () => undefined },
        },
        artifactRetention: {
          retain,
          hasProposal: () => true,
          reviewDraft: () => undefined,
        },
      }),
    );
    const controller = new AbortController();

    await expect(dispatcher.generate(SCOPE, controller.signal)).resolves.toMatchObject({
      reason: "generated",
      proposalId: "draft-description-1",
    });
    expect(retain).toHaveBeenCalledExactlyOnceWith(SCOPE, generated.artifact, retainedSignal);
    // Same decoupling requirement as the PR-targeted case above: a draft retention must also
    // survive the run's dispatch signal being aborted after the artifact is already retained.
    expect(retainedSignal).not.toBe(controller.signal);
    expect(retainedSignal?.aborted).toBe(false);
    controller.abort();
    expect(retainedSignal?.aborted).toBe(false);
    expect(SCOPE.applicationTarget).toBeUndefined();
  });

  it("fails closed when a PR-targeted artifact cannot be retained", async () => {
    generatePrDescriptionMock.mockResolvedValueOnce(generatedDescription());
    const dispatcher = createProductionWorkbenchDescriptionDispatcher(
      fakeDeps({
        snapshots: {
          ...fakeSnapshots(() =>
            Promise.resolve({ reference: "ref-1", snapshot: snapshotFixture() }),
          ),
          recheck: () => Promise.resolve({ state: "current", snapshot: snapshotFixture() }),
        },
        descriptionAuthority: admittingPort(),
        generation: {
          gateway: { chat: vi.fn() },
          config: {} as PrDescription.PrDescriptionDeps["config"],
          log: { write: () => undefined },
        },
      }),
    );

    await expect(dispatcher.generate(PR_SCOPE, new AbortController().signal)).resolves.toEqual({
      reason: "generation-unavailable",
    });
  });
});

describe("turn revert admission (B3, S04)", () => {
  type RevertTurn = NonNullable<ProductionRuntimeRunRecord["turnPort"]["revertTurn"]>;
  type RevertState = NonNullable<ProductionRuntimeRunRecord["turnPort"]["revertState"]>;

  const APPLIED = { ok: true, fileCount: 2, additions: 3, deletions: 1 } as const;

  function revertRecord(
    runId: string,
    port: { readonly revertTurn?: RevertTurn; readonly revertState?: RevertState },
    live: () => boolean = () => true,
  ): ProductionRuntimeRunRecord {
    return {
      controller: new AbortController(),
      operationGuard: createProductionRuntimeOperationGuard(runId, live),
      turnPort: {
        submitTurn: () => Promise.resolve(true),
        abortTurn: () => Promise.resolve(true),
        waitForTerminal: () => Promise.resolve("succeeded" as const),
        ...port,
      },
    };
  }

  function revertRequest(
    runId: string,
    requestId: string,
    expectedRevision: number,
    action: "restore" | "undo" = "undo",
  ) {
    return { runId, requestId, expectedRevision, action, correlationId: "corr-revert-0001" };
  }

  it("hands the action and the request's correlation id to the run's turn port", async () => {
    const revertTurn = vi.fn<RevertTurn>(() => Promise.resolve(APPLIED));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-r", revertRecord("run-r", { revertTurn })]]),
    );

    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual(APPLIED);

    expect(revertTurn).toHaveBeenCalledExactlyOnceWith("run-r", "undo", "corr-revert-0001");
  });

  it("revalidates the live authority first: an expired envelope reverts nothing", async () => {
    let live = false;
    const revertTurn = vi.fn<RevertTurn>(() => Promise.resolve(APPLIED));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-r", revertRecord("run-r", { revertTurn }, () => live)]]),
    );

    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual({
      ok: false,
      reason: "not-admitted",
    });
    expect(revertTurn).not.toHaveBeenCalled();

    // Refused before the reservation committed: the same request id is admitted once authority is live.
    live = true;
    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual(APPLIED);
  });

  it("consumes the revision and the request id once", async () => {
    const revertTurn = vi.fn<RevertTurn>(() => Promise.resolve(APPLIED));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-r", revertRecord("run-r", { revertTurn })]]),
    );

    await dispatcher.revert?.(revertRequest("run-r", "req-1", 4));

    for (const replay of [
      revertRequest("run-r", "req-1", 5),
      revertRequest("run-r", "req-2", 4),
      revertRequest("run-r", "req-3", 3),
    ]) {
      await expect(dispatcher.revert?.(replay)).resolves.toEqual({
        ok: false,
        reason: "not-admitted",
      });
    }
    await expect(
      dispatcher.revert?.(revertRequest("run-r", "req-4", 5, "restore")),
    ).resolves.toEqual(APPLIED);
    expect(revertTurn).toHaveBeenCalledTimes(2);
  });

  it("refuses an unknown run, a stopped run and a runtime that cannot revert", async () => {
    const revertTurn = vi.fn<RevertTurn>(() => Promise.resolve(APPLIED));
    const stopped = revertRecord("run-stopped", { revertTurn });
    stopped.controller.abort();
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        ["run-stopped", stopped],
        ["run-codex", revertRecord("run-codex", {})],
      ]),
    );

    await expect(dispatcher.revert?.(revertRequest("run-missing", "req-1", 4))).resolves.toEqual({
      ok: false,
      reason: "run-unavailable",
    });
    await expect(dispatcher.revert?.(revertRequest("run-stopped", "req-1", 4))).resolves.toEqual({
      ok: false,
      reason: "run-unavailable",
    });
    await expect(dispatcher.revert?.(revertRequest("run-codex", "req-1", 4))).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(revertTurn).not.toHaveBeenCalled();
  });

  it("releases the reservation when the port refuses, so the same revision can be retried", async () => {
    let answer: Awaited<ReturnType<RevertTurn>> = { ok: false, reason: "interrupt-failed" };
    const revertTurn = vi.fn<RevertTurn>(() => Promise.resolve(answer));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-r", revertRecord("run-r", { revertTurn })]]),
    );

    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual({
      ok: false,
      reason: "interrupt-failed",
    });

    answer = APPLIED;
    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual(APPLIED);
  });

  it("answers a throwing port with a body-free diagnostic and frees the reservation", async () => {
    const records: ServerDiagnosticRecord[] = [];
    const revertTurn = vi.fn<RevertTurn>(() => Promise.reject(new Error("private failure text")));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([["run-r", revertRecord("run-r", { revertTurn })]]),
      { record: (diagnostic): void => void records.push(diagnostic) },
    );

    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual({
      ok: false,
      reason: "revert-failed",
    });

    expect(records).toEqual([
      expect.objectContaining({
        operation: "coding-runtime.task-dispatch",
        code: "stage=dispatch:reason=exception",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private failure text");
    revertTurn.mockImplementation(() => Promise.resolve(APPLIED));
    await expect(dispatcher.revert?.(revertRequest("run-r", "req-1", 4))).resolves.toEqual(APPLIED);
  });

  it("reads the counts through the run's port and reports none for an unknown run or a port without them", async () => {
    const state = { staged: false, fileCount: 1, additions: 2, deletions: 0 };
    const revertState = vi.fn<RevertState>(() => Promise.resolve(state));
    const dispatcher = createProductionRuntimeTaskDispatcher(
      new Map([
        ["run-r", revertRecord("run-r", { revertState })],
        ["run-codex", revertRecord("run-codex", {})],
      ]),
    );

    await expect(dispatcher.revertState?.("run-r")).resolves.toEqual(state);
    await expect(dispatcher.revertState?.("run-codex")).resolves.toBeUndefined();
    await expect(dispatcher.revertState?.("run-missing")).resolves.toBeUndefined();
    expect(revertState).toHaveBeenCalledExactlyOnceWith("run-r");
  });

  it("exposes revert on the OpenCode turn port only when the run port offers it", () => {
    const base: OpenCodeRunPort = {
      submitTask: () => Promise.resolve(true),
      abortTask: () => Promise.resolve(true),
      waitForTerminal: () => Promise.resolve(true),
      listQuestions: () => Promise.resolve([]),
      answerQuestion: () => Promise.resolve(false),
      rejectQuestion: () => Promise.resolve(false),
      replyPermission: () => Promise.resolve(false),
    };
    const revertTurn: NonNullable<OpenCodeRunPort["revertTurn"]> = () => Promise.resolve(APPLIED);
    const revertState: NonNullable<OpenCodeRunPort["revertState"]> = () =>
      Promise.resolve(undefined);

    expect(createOpenCodeRuntimeTurnPort(base).revertTurn).toBeUndefined();
    expect(createOpenCodeRuntimeTurnPort(base).revertState).toBeUndefined();
    expect(createOpenCodeRuntimeTurnPort({ ...base, revertTurn }).revertTurn).toBeUndefined();
    const offered = createOpenCodeRuntimeTurnPort({ ...base, revertTurn, revertState });
    expect(offered.revertTurn).toBe(revertTurn);
    expect(offered.revertState).toBe(revertState);
  });
});
