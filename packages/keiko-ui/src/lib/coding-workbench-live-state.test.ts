import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeReadiness,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
} from "@oscharko-dev/keiko-contracts";
import {
  codingWorkbenchRuntimeReducer,
  createInitialCodingWorkbenchRuntimeState,
  type CodingWorkbenchRuntimeState,
} from "./coding-workbench-live-state";

const UPDATED_AT = "2026-07-13T12:00:00.000Z";

function snapshot(
  overrides: Partial<CodingWorkbenchRuntimeSnapshot> = {},
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state: "awaiting-approval",
    revision: 4,
    updatedAt: UPDATED_AT,
    runId: "run-1",
    pendingPermission: {
      requestId: "permission-old",
      kind: "delivery-substrate",
      actionClass: "delivery-substrate",
      reasonCode: "approval-required",
      actionKind: "push",
      scopeLabel: "workspace-scope",
      risk: "high",
      policyReason: "approval-required",
      expiresAt: "2026-07-13T12:05:00.000Z",
    },
    ...overrides,
  } as CodingWorkbenchRuntimeSnapshot;
}

function event(sequence: number): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `cursor-${String(sequence)}`,
    sequence,
    occurredAt: UPDATED_AT,
    kind: "runtime-event",
    runId: "run-1",
    state: "awaiting-approval",
    revision: 4,
    eventKind: "permission-requested",
  };
}

function readiness(): CodingWorkbenchRuntimeReadiness {
  return {
    schemaVersion: "1",
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "supervised-coding",
    runtimeAvailable: true,
  };
}

function readyState(switching = false): CodingWorkbenchRuntimeState {
  let state = createInitialCodingWorkbenchRuntimeState();
  state = codingWorkbenchRuntimeReducer(state, {
    kind: "source-set",
    source: {
      runtimePreference: "managed-gateway",
      modelSource: "keiko-model-gateway",
      runtimeSource: "keiko-sidecar",
      available: true,
    },
  });
  state = codingWorkbenchRuntimeReducer(state, {
    kind: "workspace-set",
    workspace: {
      workspaceId: "workspace-1",
      taskId: "task-1",
      taskBranch: "issue/2257",
      health: "healthy",
      switching,
    },
  });
  return codingWorkbenchRuntimeReducer(state, { kind: "runtime-set", readiness: readiness() });
}

describe("Coding Workbench live state", () => {
  it("keeps Start disabled until workspace and a startable run snapshot are both ready", () => {
    expect(readyState(true).canStart).toBe(false);
    expect(readyState(false).canStart).toBe(false);
    const ready = codingWorkbenchRuntimeReducer(readyState(false), {
      kind: "run-set",
      snapshot: snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }),
    });
    expect(ready.canStart).toBe(true);
  });

  it("keeps Start disabled while run truth is loading, failed, or null", () => {
    const noRun = readyState(false);
    const loading = codingWorkbenchRuntimeReducer(noRun, {
      kind: "resource-loading",
      resource: "run",
    });
    const failed = codingWorkbenchRuntimeReducer(noRun, {
      kind: "resource-failed",
      resource: "run",
      status: "error",
      error: { code: "RUN_UNAVAILABLE", message: "Run status unavailable", retryable: true },
    });

    expect(noRun.run).toMatchObject({ status: "idle", value: null });
    expect(loading.run).toMatchObject({ status: "loading", value: null });
    expect(failed.run).toMatchObject({ status: "error", value: null });
    expect([noRun.canStart, loading.canStart, failed.canStart]).toEqual([false, false, false]);
  });

  it("does not let a stale snapshot restore a replaced approval", () => {
    let state = codingWorkbenchRuntimeReducer(createInitialCodingWorkbenchRuntimeState(), {
      kind: "run-set",
      snapshot: snapshot(),
    });
    state = codingWorkbenchRuntimeReducer(state, {
      kind: "run-set",
      snapshot: snapshot({
        revision: 3,
        pendingPermission: { ...snapshot().pendingPermission!, requestId: "permission-stale" },
      }),
    });
    expect(state.run.value?.pendingPermission?.requestId).toBe("permission-old");

    state = codingWorkbenchRuntimeReducer(state, {
      kind: "run-set",
      snapshot: snapshot({
        revision: 5,
        pendingPermission: { ...snapshot().pendingPermission!, requestId: "permission-new" },
      }),
    });
    expect(state.run.value?.pendingPermission?.requestId).toBe("permission-new");
    expect(state.run.value?.revision).toBe(5);
  });

  it("does not fabricate actionable approval truth from an SSE observation", () => {
    const initial = codingWorkbenchRuntimeReducer(createInitialCodingWorkbenchRuntimeState(), {
      kind: "run-set",
      snapshot: {
        schemaVersion: "1",
        state: "running",
        revision: 2,
        updatedAt: UPDATED_AT,
        runId: "run-1",
      },
    });
    const next = codingWorkbenchRuntimeReducer(initial, {
      kind: "events-received",
      events: [event(1)],
    });

    expect(next.events).toHaveLength(1);
    expect(next.run.value).toMatchObject({ state: "running", revision: 2 });
    expect(next.run.value?.pendingPermission).toBeUndefined();
  });

  it("resets timeline and stream state only when server truth changes to a different run", () => {
    const withEvent = codingWorkbenchRuntimeReducer(
      codingWorkbenchRuntimeReducer(createInitialCodingWorkbenchRuntimeState(), {
        kind: "events-received",
        events: [event(1)],
      }),
      { kind: "stream-set", stream: { runId: "run-1", cursor: "cursor-1", connected: true } },
    );

    const next = codingWorkbenchRuntimeReducer(withEvent, {
      kind: "run-set",
      snapshot: snapshot({ runId: "run-2", revision: 1 }),
    });

    expect(next.events).toEqual([]);
    expect(next.stream).toMatchObject({ status: "idle", value: null });
  });

  it("enables recovery Retry only after a server-confirmed acknowledgement", () => {
    const unacknowledged = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "run-set",
      snapshot: snapshot({
        state: "recovery-required",
        revision: 6,
        failureCode: "recovery-required",
        pendingPermission: undefined,
      }),
    });
    expect(unacknowledged.canStart).toBe(false);
    expect(unacknowledged.canRetry).toBe(false);

    const acknowledged = codingWorkbenchRuntimeReducer(unacknowledged, {
      kind: "run-set",
      snapshot: snapshot({
        state: "recovery-required",
        revision: 7,
        failureCode: "recovery-required",
        recoveryAcknowledged: true,
        pendingPermission: undefined,
      }),
    });
    expect(acknowledged.canRetry).toBe(true);
  });

  it("keeps independent resource errors scoped to their own recovery lane", () => {
    const state = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "resource-failed",
      resource: "source",
      status: "unavailable",
      error: { code: "SOURCE_UNAVAILABLE", message: "source unavailable", retryable: true },
    });

    expect(state.source).toMatchObject({ status: "unavailable", value: null });
    expect(state.workspace).toMatchObject({
      status: "ready",
      value: { workspaceId: "workspace-1" },
    });
    expect(state.runtime).toMatchObject({ status: "ready", value: { runtimeAvailable: true } });
    expect(state.canStart).toBe(false);
  });
});

describe("mode selection, setup plans, and mutation failures", () => {
  it("keeps the state identity when the requested mode does not change", () => {
    const state = readyState();
    expect(
      codingWorkbenchRuntimeReducer(state, { kind: "select-mode", mode: "supervised-coding" }),
    ).toBe(state);
  });

  it("resets runtime readiness when the requested mode changes", () => {
    const state = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "select-mode",
      mode: "governed-assist",
    });
    expect(state.requestedMode).toBe("governed-assist");
    expect(state.runtime).toMatchObject({ status: "idle", value: null });
    expect(state.canStart).toBe(false);
  });

  it("stores a server-approved codex setup plan as ready truth", () => {
    const state = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "codex-setup-set",
      plan: {
        schemaVersion: "1",
        profileId: "profile-1",
        method: "chatgpt-device-code",
        modelSource: "chatgpt-codex-subscription-profile",
        runtimeSource: "codex-cli-adapter",
        credentialStore: "auto",
        stateScope: "keiko-owned-state",
        stateRoot: "keiko-codex-runtime-state",
        usesGlobalCodexHome: false,
        commandLabel: "codex-login-device-auth",
        requiresSecretInput: false,
      },
    });
    expect(state.codexSetup).toMatchObject({
      status: "ready",
      value: { method: "chatgpt-device-code" },
      error: null,
    });
  });

  it("projects a failed mutation as a scoped retryable error", () => {
    const failed = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "mutation-failed",
      error: { code: "CODING_RUNTIME_INVALID_INTENT", message: "redacted", retryable: true },
    });
    expect(failed.mutation).toMatchObject({
      status: "error",
      error: { code: "CODING_RUNTIME_INVALID_INTENT" },
    });
    const recovered = codingWorkbenchRuntimeReducer(failed, { kind: "mutation-complete" });
    expect(recovered.mutation).toMatchObject({ status: "idle", error: null });
  });
});
