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
  it("refuses to start while the runtime readiness gate is closed", () => {
    expect(() => createStartMutation("task", stateWithRun(null))).toThrowError(
      expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }),
    );
  });

  it("starts a new run with the requested mode and preference", async () => {
    const state = stateWithRun(null, { canStart: true });
    const mutation = createStartMutation("add a regression test", state);
    expect(mutation.mayInstallNewRun).toBe(true);
    expect(mutation.expected).toBeUndefined();
    await mutation.run();
    expect(apiMocks.startCodingWorkbenchRuntime).toHaveBeenCalledWith({
      requestId: mutation.requestId,
      taskIntent: "add a regression test",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
    });
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
});

describe("createLifecycleMutation", () => {
  it("pauses only a running run and resumes only a paused run", () => {
    expect(() =>
      createLifecycleMutation("pause", stateWithRun(snapshot({ state: "paused" }))),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
    expect(() =>
      createLifecycleMutation("resume", stateWithRun(snapshot({ state: "running" }))),
    ).toThrowError(expect.objectContaining({ code: "CODING_RUNTIME_ACTION_UNAVAILABLE" }));
  });

  it("routes pause and resume to their run-bound endpoints", async () => {
    await createLifecycleMutation("pause", stateWithRun(snapshot({ state: "running" }))).run();
    expect(apiMocks.pauseCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
    });

    await createLifecycleMutation("resume", stateWithRun(snapshot({ state: "paused" }))).run();
    expect(apiMocks.resumeCodingWorkbenchRuntime).toHaveBeenCalledWith("run-1", {
      requestId: "run-1",
    });
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
