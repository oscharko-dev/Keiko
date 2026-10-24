import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeSnapshot } from "@oscharko-dev/keiko-contracts";
import {
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";
import {
  createApprovalMutation,
  createFollowUpMutation,
  createLifecycleMutation,
  createRecoveryAcknowledgementMutation,
  createResearchRevokeMutation,
  createRetryMutation,
  createRunBoundMutation,
  createStartMutation,
  mutationResultMatchesCurrentTruth,
  type CodingWorkbenchMutationCommand,
} from "./coding-workbench-runtime-mutations";

const apiMocks = vi.hoisted(() => ({
  startCodingWorkbenchRuntime: vi.fn(),
  decideCodingWorkbenchRuntimeApproval: vi.fn(),
  stopCodingWorkbenchRuntime: vi.fn(),
  takeOverCodingWorkbenchRuntime: vi.fn(),
  retryCodingWorkbenchRuntime: vi.fn(),
  acknowledgeCodingWorkbenchRuntimeRecovery: vi.fn(),
  pauseCodingWorkbenchRuntime: vi.fn(),
  resumeCodingWorkbenchRuntime: vi.fn(),
  submitCodingWorkbenchRuntimeFollowUp: vi.fn(),
  revokeCodingWorkbenchRuntimeResearchGrant: vi.fn(),
}));

vi.mock("./coding-workbench-runtime-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coding-workbench-runtime-api")>()),
  ...apiMocks,
}));

const UPDATED_AT = "2026-07-13T12:00:00.000Z";

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "running",
    revision: 4,
    updatedAt: UPDATED_AT,
    runId: "run-1",
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function stateWithRun(
  run: CodingWorkbenchRuntimeSnapshot | null,
  overrides: Partial<CodingWorkbenchRuntimeState> = {},
): CodingWorkbenchRuntimeState {
  return {
    ...createInitialCodingWorkbenchRuntimeState(),
    run: { status: "ready", value: run, error: null },
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset().mockResolvedValue(snapshot());
});

describe("mutationResultMatchesCurrentTruth", () => {
  function command(
    overrides: Partial<CodingWorkbenchMutationCommand>,
  ): CodingWorkbenchMutationCommand {
    return {
      requestId: "request-1",
      mayInstallNewRun: false,
      run: () => Promise.resolve(snapshot()),
      ...overrides,
    };
  }

  it("only installs unbound results when the command may install a new run", () => {
    expect(
      mutationResultMatchesCurrentTruth(command({ mayInstallNewRun: true }), null, snapshot()),
    ).toBe(true);
    expect(
      mutationResultMatchesCurrentTruth(command({ mayInstallNewRun: false }), null, snapshot()),
    ).toBe(false);
  });

  it("rejects results when the live truth moved away from the expected revision", () => {
    const bound = command({ expected: { runId: "run-1", revision: 4 } });
    expect(mutationResultMatchesCurrentTruth(bound, snapshot({ revision: 5 }), snapshot())).toBe(
      false,
    );
    expect(mutationResultMatchesCurrentTruth(bound, snapshot({ runId: "run-2" }), snapshot())).toBe(
      false,
    );
    expect(mutationResultMatchesCurrentTruth(bound, null, snapshot())).toBe(false);
  });

  it("binds a matching result to the expected run unless a new run may be installed", () => {
    const bound = command({ expected: { runId: "run-1", revision: 4 } });
    expect(mutationResultMatchesCurrentTruth(bound, snapshot(), snapshot())).toBe(true);
    expect(mutationResultMatchesCurrentTruth(bound, snapshot(), snapshot({ runId: "run-2" }))).toBe(
      false,
    );
    expect(
      mutationResultMatchesCurrentTruth(
        command({ expected: { runId: "run-1", revision: 4 }, mayInstallNewRun: true }),
        snapshot(),
        snapshot({ runId: "run-2" }),
      ),
    ).toBe(true);
  });
});

describe("createStartMutation", () => {
  it("preserves the accepted issue intent and digest through the production start client", async () => {
    const issue = {
      issueRef: "https://github.com/owner/repo/issues/42",
      expectedIssueBindingDigest: "a".repeat(64),
    };
    const mutation = createStartMutation(
      "implement the issue",
      stateWithRun(null, { canStart: true }),
      { issue, projectMemoryEnabled: true },
    );
    await mutation.run();
    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ ...issue, issuePurpose: "context" }),
    );
  });

  it("refuses to start while the runtime readiness gate is closed", () => {
    expect(() =>
      createStartMutation("task", stateWithRun(null), { projectMemoryEnabled: true }),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("starts a new run with the requested mode and preference", async () => {
    const state = stateWithRun(null, { canStart: true });
    const mutation = createStartMutation("add a regression test", state, {
      projectMemoryEnabled: true,
    });
    expect(mutation.mayInstallNewRun).toBe(true);
    expect(mutation.expected).toBeUndefined();
    await mutation.run();
    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenCalledWith({
      requestId: mutation.requestId,
      taskIntent: "add a regression test",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
      projectMemory: { enabled: true },
    });
  });

  it("can disable project memory for the next run without sending browser-authored scopes", async () => {
    const state = stateWithRun(null, { canStart: true });
    const mutation = createStartMutation("inspect the repository", state, {
      projectMemoryEnabled: false,
    });

    await mutation.run();

    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenCalledWith({
      requestId: mutation.requestId,
      taskIntent: "inspect the repository",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
      projectMemory: { enabled: false },
    });
  });

  it("does not leak stale gateway model settings into a Codex subscription start", async () => {
    const state = stateWithRun(null, {
      canStart: true,
      runtimePreference: "codex-subscription",
      selectedModelId: "stale-model",
      reasoningEffort: "high",
    });
    const mutation = createStartMutation("inspect the repository", state, {
      projectMemoryEnabled: true,
    });

    await mutation.run();

    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenCalledWith({
      requestId: mutation.requestId,
      taskIntent: "inspect the repository",
      requestedMode: "supervised-coding",
      runtimePreference: "codex-subscription",
      projectMemory: { enabled: true },
    });
  });

  it("sends the selected model settings for the managed gateway", async () => {
    const state = stateWithRun(null, {
      canStart: true,
      selectedModelId: "coding-model",
      reasoningEffort: "high",
    });
    const mutation = createStartMutation("inspect the repository", state, {
      projectMemoryEnabled: true,
    });

    await mutation.run();

    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "coding-model", reasoningEffort: "high" }),
    );
  });
});

describe("createApprovalMutation", () => {
  const pendingPermission = {
    requestId: "permission-1",
    kind: "delivery-substrate",
    actionClass: "delivery-substrate",
    reasonCode: "approval-required",
    actionKind: "push",
    scopeLabel: "workspace-scope",
    risk: "high",
    policyReason: "approval-required",
    expiresAt: "2026-07-13T12:05:00.000Z",
  } as const;

  it("requires a live awaiting-approval snapshot with a pending permission", () => {
    expect(() => createApprovalMutation("approved", stateWithRun(snapshot()))).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });

  it("binds the decision to the permission request and the current revision", async () => {
    const run = snapshot({ state: "awaiting-approval", pendingPermission });
    const mutation = createApprovalMutation("denied", stateWithRun(run));
    expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
    await mutation.run();
    expect(apiMocks.decideCodingWorkbenchRuntimeApproval).toHaveBeenCalledWith("run-1", {
      requestId: "permission-1",
      expectedRevision: 4,
      decision: "denied",
    });
  });
});

describe("createRunBoundMutation", () => {
  it("requires a current run", () => {
    expect(() => createRunBoundMutation("stop", stateWithRun(null))).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });

  it("routes stop and takeover to their run-bound endpoints", async () => {
    await createRunBoundMutation("stop", stateWithRun(snapshot())).run();
    expect(apiMocks.stopCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
    });

    await createRunBoundMutation("takeover", stateWithRun(snapshot())).run();
    expect(apiMocks.takeOverCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
    });
  });
});

describe("createRetryMutation", () => {
  it("requires acknowledged recovery before retrying", () => {
    expect(() =>
      createRetryMutation("retry it", stateWithRun(snapshot(), { canRetry: false })),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("retries against the failed run with a fresh request id", async () => {
    const mutation = createRetryMutation("retry it", stateWithRun(snapshot(), { canRetry: true }));
    expect(mutation.mayInstallNewRun).toBe(true);
    expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
    await mutation.run();
    expect(apiMocks.retryCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: mutation.requestId,
      taskIntent: "retry it",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
    });
  });

  it("drops stale gateway model settings when retrying through a Codex subscription", async () => {
    const state = stateWithRun(snapshot(), {
      canRetry: true,
      runtimePreference: "codex-subscription",
      selectedModelId: "stale-model",
      reasoningEffort: "high",
    });
    const mutation = createRetryMutation("retry it", state);

    await mutation.run();

    expect(apiMocks.retryCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: mutation.requestId,
      taskIntent: "retry it",
      requestedMode: "supervised-coding",
      runtimePreference: "codex-subscription",
    });
  });
});

describe("createLifecycleMutation", () => {
  it("pauses only a running run and resumes only a paused run", () => {
    expect(() =>
      createLifecycleMutation("pause", stateWithRun(snapshot({ state: "paused" }))),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    expect(() =>
      createLifecycleMutation(
        "resume",
        stateWithRun(snapshot({ state: "running" })),
        "governed-assist",
      ),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("routes pause and resume to their run-bound endpoints", async () => {
    await createLifecycleMutation("pause", stateWithRun(snapshot({ state: "running" }))).run();
    expect(apiMocks.pauseCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
    });

    await createLifecycleMutation(
      "resume",
      stateWithRun(
        snapshot({
          state: "paused",
          requestedMode: "autonomous-delivery",
          effectiveMode: "autonomous-delivery",
        }),
      ),
      "supervised-coding",
    ).run();
    expect(apiMocks.resumeCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
      requestedMode: "supervised-coding",
    });
  });

  it("fails closed when resume would widen the server-confirmed effective mode", () => {
    const paused = stateWithRun(
      snapshot({
        state: "paused",
        requestedMode: "autonomous-delivery",
        effectiveMode: "supervised-coding",
      }),
    );
    expect(() => createLifecycleMutation("resume", paused, "autonomous-delivery")).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });
});

describe("createFollowUpMutation", () => {
  it("admits a follow-up only while the run is paused with a non-empty draft", () => {
    expect(() =>
      createFollowUpMutation("ping", stateWithRun(snapshot({ state: "running" }))),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    expect(() =>
      createFollowUpMutation("", stateWithRun(snapshot({ state: "paused" }))),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("submits a paused follow-up bound to the current revision", async () => {
    const mutation = createFollowUpMutation(
      "add a test",
      stateWithRun(snapshot({ state: "paused" })),
    );
    expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
    expect(mutation.mayInstallNewRun).toBe(false);
    await mutation.run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).toHaveBeenCalledWith("run-1", {
      requestId: mutation.requestId,
      expectedRevision: 4,
      taskIntent: "add a test",
    });
  });
});

describe("primary agent on the mutations (#3897)", () => {
  const offered = { selectableAgents: ["build", "plan"] } as const;

  it("sends the selected agent on start and retry only where the server offers a choice", async () => {
    for (const agent of ["plan", "build"] as const) {
      const started = createStartMutation(
        "outline the change",
        stateWithRun(null, { canStart: true, ...offered, agent }),
        { projectMemoryEnabled: true },
      );
      await started.run();
      expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({ agent }),
      );
      const retried = createRetryMutation(
        "outline the change",
        stateWithRun(snapshot(), { canRetry: true, ...offered, agent }),
      );
      await retried.run();
      expect(apiMocks.retryCodingWorkbenchRuntime).toHaveBeenLastCalledWith(
        "run-1",
        expect.objectContaining({ agent }),
      );
    }
  });

  it("omits the agent when only the default is offered, even if the selection says plan", async () => {
    const stale = { selectableAgents: ["build"], agent: "plan" } as const;
    await createStartMutation("task", stateWithRun(null, { canStart: true, ...stale }), {
      projectMemoryEnabled: true,
    }).run();
    expect(apiMocks.startCodingWorkbenchRuntime.mock.lastCall?.[0]).not.toHaveProperty("agent");
    await createRetryMutation("task", stateWithRun(snapshot(), { canRetry: true, ...stale })).run();
    expect(apiMocks.retryCodingWorkbenchRuntime.mock.lastCall?.[1]).not.toHaveProperty("agent");
    await createFollowUpMutation("task", stateWithRun(snapshot({ state: "paused" }), stale)).run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp.mock.lastCall?.[1]).not.toHaveProperty(
      "agent",
    );
  });

  it("never sends the selected agent for a source without an agent concept", async () => {
    const codex = { ...offered, agent: "plan", runtimePreference: "codex-subscription" } as const;
    await createStartMutation("task", stateWithRun(null, { canStart: true, ...codex }), {
      projectMemoryEnabled: true,
    }).run();
    expect(apiMocks.startCodingWorkbenchRuntime.mock.lastCall?.[0]).not.toHaveProperty("agent");
  });

  it("sends the agent with a follow-up, including a switch back to build", async () => {
    for (const agent of ["plan", "build"] as const) {
      const mutation = createFollowUpMutation(
        "now implement it",
        stateWithRun(snapshot({ state: "paused" }), { ...offered, agent }),
      );
      await mutation.run();
      expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith("run-1", {
        requestId: mutation.requestId,
        expectedRevision: 4,
        taskIntent: "now implement it",
        agent,
      });
    }
  });
});

describe("createResearchRevokeMutation", () => {
  const grant = { grantId: "grant-1", domains: ["nodejs.org"], expiresAt: UPDATED_AT } as const;

  it("requires a current run for the authenticated-channel grant", () => {
    expect(() => createResearchRevokeMutation(stateWithRun(null), grant)).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });

  it("posts a revision-bound revoke carrying the grant id", async () => {
    const mutation = createResearchRevokeMutation(stateWithRun(snapshot()), grant);
    expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
    expect(mutation.mayInstallNewRun).toBe(false);
    await mutation.run();
    expect(apiMocks.revokeCodingWorkbenchRuntimeResearchGrant).toHaveBeenCalledWith("run-1", {
      requestId: mutation.requestId,
      expectedRevision: 4,
      grantId: "grant-1",
    });
  });
});

describe("createRecoveryAcknowledgementMutation", () => {
  it("requires a recovery-required run", () => {
    expect(() => createRecoveryAcknowledgementMutation(stateWithRun(snapshot()))).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });

  it("acknowledges recovery bound to the current run and revision", async () => {
    const run = snapshot({ state: "recovery-required" });
    const mutation = createRecoveryAcknowledgementMutation(stateWithRun(run));
    expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
    await mutation.run();
    expect(apiMocks.acknowledgeCodingWorkbenchRuntimeRecovery).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
      acknowledged: true,
    });
  });
});

// ADR-0137 D10: a message sent while a turn runs and the workspace files a prompt references ride on
// the follow-up request; the browser authors the intent and the server decides.
describe("prompt inputs on the follow-up mutation", () => {
  const offered = { selectableAgents: ["build", "plan"], agent: "plan" } as const;

  it.each(["steer", "queue"] as const)(
    "sends a %s message to a running turn bound to the current revision, without an agent",
    async (delivery) => {
      const mutation = createFollowUpMutation(
        "also cover the empty case",
        stateWithRun(snapshot({ state: "running" }), offered),
        { delivery },
      );
      expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
      expect(mutation.mayInstallNewRun).toBe(false);
      await mutation.run();
      // The turn in flight keeps its agent: a delivery never names one, even where a choice exists.
      expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith("run-1", {
        requestId: mutation.requestId,
        expectedRevision: 4,
        taskIntent: "also cover the empty case",
        delivery,
      });
    },
  );

  it("admits a delivery only against a running run with a non-empty message", () => {
    for (const state of ["paused", "idle", "awaiting-approval", "succeeded", "stopping"] as const) {
      expect(() =>
        createFollowUpMutation("ping", stateWithRun(snapshot({ state })), { delivery: "steer" }),
      ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    }
    expect(() =>
      createFollowUpMutation("", stateWithRun(snapshot({ state: "running" })), {
        delivery: "queue",
      }),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    expect(() =>
      createFollowUpMutation("ping", stateWithRun(null), { delivery: "steer" }),
    ).toThrow();
  });

  it("keeps an ordinary follow-up to a paused run, whatever references it carries", async () => {
    expect(() =>
      createFollowUpMutation("ping", stateWithRun(snapshot({ state: "running" })), {
        references: [{ path: "src/app.ts" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    const mutation = createFollowUpMutation(
      "look at the file",
      stateWithRun(snapshot({ state: "paused" }), offered),
      { references: [{ path: "src/app.ts" }, { path: "docs/My Notes.md" }] },
    );
    await mutation.run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith("run-1", {
      requestId: mutation.requestId,
      expectedRevision: 4,
      taskIntent: "look at the file",
      agent: "plan",
      references: [{ path: "src/app.ts" }, { path: "docs/My Notes.md" }],
    });
  });

  it("sends the references of a delivery beside it, and omits an empty list", async () => {
    const running = stateWithRun(snapshot({ state: "running" }));
    await createFollowUpMutation("see @a.ts", running, {
      delivery: "steer",
      references: [{ path: "a.ts" }],
    }).run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp.mock.lastCall?.[1]).toMatchObject({
      delivery: "steer",
      references: [{ path: "a.ts" }],
    });
    await createFollowUpMutation("plain", running, { delivery: "queue", references: [] }).run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp.mock.lastCall?.[1]).not.toHaveProperty(
      "references",
    );
  });
});

// ADR-0137 D10: the first prompt carries the files it references with `@` exactly as a follow-up
// does, and a start or a follow-up may run as one of the runtime's slash commands, its text then
// being the command's arguments (and empty for a bare command).
describe("references and a slash command on the start mutation", () => {
  const ready = { canStart: true } as const;

  it("sends the first prompt's references and the command beside its text", async () => {
    const mutation = createStartMutation("the last commit", stateWithRun(null, ready), {
      projectMemoryEnabled: true,
      references: [{ path: "src/app.ts" }, { path: "docs/My Notes.md" }],
      command: { name: "review" },
    });
    expect(mutation.mayInstallNewRun).toBe(true);
    expect(mutation.expected).toBeUndefined();
    await mutation.run();
    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenLastCalledWith({
      requestId: mutation.requestId,
      taskIntent: "the last commit",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
      projectMemory: { enabled: true },
      references: [{ path: "src/app.ts" }, { path: "docs/My Notes.md" }],
      command: { name: "review" },
    });
  });

  it("starts a bare command with an empty text", async () => {
    const mutation = createStartMutation("", stateWithRun(null, ready), {
      projectMemoryEnabled: true,
      command: { name: "init" },
    });
    await mutation.run();
    const body = apiMocks.startCodingWorkbenchRuntime.mock.lastCall?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ taskIntent: "", command: { name: "init" } });
    expect(body).not.toHaveProperty("references");
  });

  it("keeps the ordinary start body exactly as it was, whatever empty inputs ride along", async () => {
    const plain = createStartMutation("fix it", stateWithRun(null, ready), {
      projectMemoryEnabled: true,
    });
    await plain.run();
    const empty = createStartMutation("fix it", stateWithRun(null, ready), {
      projectMemoryEnabled: true,
      references: [],
      command: undefined,
    });
    await empty.run();
    const [first, second] = apiMocks.startCodingWorkbenchRuntime.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    expect(second).toEqual({ ...first, requestId: empty.requestId });
    expect(second).not.toHaveProperty("references");
    expect(second).not.toHaveProperty("command");
  });

  it("sends references beside an accepted issue, but never a command beside one", async () => {
    const issue = {
      issueRef: "https://github.com/owner/repo/issues/42",
      expectedIssueBindingDigest: "a".repeat(64),
    };
    const withFiles = createStartMutation("implement it", stateWithRun(null, ready), {
      projectMemoryEnabled: true,
      issue,
      references: [{ path: "src/app.ts" }],
    });
    await withFiles.run();
    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({ ...issue, references: [{ path: "src/app.ts" }] }),
    );
    apiMocks.startCodingWorkbenchRuntime.mockClear();
    expect(() =>
      createStartMutation("implement it", stateWithRun(null, ready), {
        projectMemoryEnabled: true,
        issue,
        command: { name: "review" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    expect(apiMocks.startCodingWorkbenchRuntime).not.toHaveBeenCalled();
  });

  it("still refuses to start while the readiness gate is closed, command or not", () => {
    expect(() =>
      createStartMutation("", stateWithRun(null), {
        projectMemoryEnabled: true,
        command: { name: "init" },
      }),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("gives each mutation its own request id and keeps it when the same mutation runs again", async () => {
    const options = {
      projectMemoryEnabled: true,
      references: [{ path: "a.ts" }],
      command: { name: "review" },
    };
    const first = createStartMutation("x", stateWithRun(null, ready), options);
    const second = createStartMutation("x", stateWithRun(null, ready), options);
    expect(first.requestId).not.toBe(second.requestId);
    await first.run();
    await first.run();
    const calls = apiMocks.startCodingWorkbenchRuntime.mock.calls.map(
      (call) => (call[0] as { requestId: string }).requestId,
    );
    expect(calls).toEqual([first.requestId, first.requestId]);
  });
});

describe("a slash command on the follow-up mutation", () => {
  const paused = stateWithRun(snapshot({ state: "paused" }));

  it("sends the command with an empty text, bound to the current revision", async () => {
    const mutation = createFollowUpMutation("", paused, { command: { name: "review" } });
    expect(mutation.expected).toEqual({ runId: "run-1", revision: 4 });
    expect(mutation.mayInstallNewRun).toBe(false);
    await mutation.run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith("run-1", {
      requestId: mutation.requestId,
      expectedRevision: 4,
      taskIntent: "",
      command: { name: "review" },
    });
  });

  it("sends the command's arguments and the files they reference together with the agent", async () => {
    const offered = stateWithRun(snapshot({ state: "paused" }), {
      selectableAgents: ["build", "plan"],
      agent: "plan",
    });
    const mutation = createFollowUpMutation("branch main", offered, {
      command: { name: "review" },
      references: [{ path: "src/app.ts" }],
    });
    await mutation.run();
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).toHaveBeenLastCalledWith("run-1", {
      requestId: mutation.requestId,
      expectedRevision: 4,
      taskIntent: "branch main",
      agent: "plan",
      references: [{ path: "src/app.ts" }],
      command: { name: "review" },
    });
  });

  it("keeps an empty text refused for everything that is not a command", () => {
    expect(() => createFollowUpMutation("", paused)).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
    expect(() =>
      createFollowUpMutation("", paused, { references: [{ path: "a.ts" }] }),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("is admitted only against a paused run, and is never a delivery", () => {
    for (const state of ["running", "idle", "awaiting-approval", "succeeded"] as const) {
      expect(() =>
        createFollowUpMutation("", stateWithRun(snapshot({ state })), {
          command: { name: "init" },
        }),
      ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    }
    expect(() =>
      createFollowUpMutation("", stateWithRun(null), { command: { name: "init" } }),
    ).toThrow();
    for (const delivery of ["steer", "queue"] as const) {
      expect(() =>
        createFollowUpMutation("go", stateWithRun(snapshot({ state: "running" })), {
          delivery,
          command: { name: "init" },
        }),
      ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    }
    expect(apiMocks.submitCodingWorkbenchRuntimeFollowUp).not.toHaveBeenCalled();
  });
});
