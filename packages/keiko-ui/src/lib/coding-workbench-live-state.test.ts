import { describe, expect, it } from "vitest";
import type {
  CodingWorkbenchRuntimeReadiness,
  CodingWorkbenchRuntimeSnapshot,
  CodingWorkbenchRuntimeSseEvent,
  CodingWorkbenchSidecarGatewayResult,
  GatewayVerificationState,
} from "@oscharko-dev/keiko-contracts";
import {
  codingWorkbenchRuntimeReducer,
  codingWorkbenchSourceFromManaged,
  createInitialCodingWorkbenchRuntimeState,
  NO_CODING_WORKBENCH_PROMPT_INPUTS,
  offeredCodingWorkbenchAgents,
  offeredCodingWorkbenchPromptInputs,
  type CodingWorkbenchPairingState,
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

function statusEvent(
  sequence: number,
  state: CodingWorkbenchRuntimeSnapshot["state"],
  revision: number,
): CodingWorkbenchRuntimeSseEvent {
  return {
    schemaVersion: "1",
    cursor: `cursor-${String(sequence)}`,
    sequence,
    occurredAt: UPDATED_AT,
    kind: "status",
    runId: "run-1",
    state,
    revision,
  };
}

function readiness(
  selectableAgents: CodingWorkbenchRuntimeReadiness["selectableAgents"] = ["build"],
): CodingWorkbenchRuntimeReadiness {
  return {
    schemaVersion: "1",
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "supervised-coding",
    runtimeAvailable: true,
    selectableAgents,
  };
}

// `pairing: null` deliberately leaves the boot pairing dimension unconfirmed, mirroring a window
// whose honest workspaces read has not resolved yet.
function readyState(
  switching = false,
  pairing: CodingWorkbenchPairingState | null = "paired",
): CodingWorkbenchRuntimeState {
  let state = createInitialCodingWorkbenchRuntimeState();
  state = codingWorkbenchRuntimeReducer(state, {
    kind: "source-set",
    source: {
      runtimePreference: "managed-gateway",
      modelSource: "keiko-model-gateway",
      runtimeSource: "keiko-sidecar",
      available: true,
      verification: "verified",
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
  state = codingWorkbenchRuntimeReducer(state, { kind: "runtime-set", readiness: readiness() });
  state = codingWorkbenchRuntimeReducer(state, {
    kind: "select-model",
    modelId: "verified-fixture-model",
  });
  if (pairing === null) return state;
  return codingWorkbenchRuntimeReducer(state, { kind: "pairing-set", pairing });
}

function managedProfile(
  verification: GatewayVerificationState,
): CodingWorkbenchSidecarGatewayResult {
  return {
    status: "available",
    profileId: "coding-safe-openai-compatible",
    modelAlias: "model-redacted",
    localEndpointPath: "/api/coding-sidecar/gateway",
    supportsStreaming: false,
    supportsToolCalling: true,
    runMetadata: {
      maxPromptTokens: 128_000,
      maxOutputTokens: 4_096,
      maxInputMessages: 64,
      maxRequestBytes: 64_000,
    },
    verification,
  };
}

function startableStateWithSource(
  verification: GatewayVerificationState,
): CodingWorkbenchRuntimeState {
  let state = codingWorkbenchRuntimeReducer(readyState(false), {
    kind: "source-set",
    source: codingWorkbenchSourceFromManaged(managedProfile(verification)),
  });
  state = codingWorkbenchRuntimeReducer(state, {
    kind: "run-set",
    snapshot: snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }),
  });
  return state;
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
    const streamable = codingWorkbenchRuntimeReducer(createInitialCodingWorkbenchRuntimeState(), {
      kind: "run-set",
      snapshot: snapshot({ runId: "run-1", state: "running" }),
    });
    const withEvent = codingWorkbenchRuntimeReducer(
      codingWorkbenchRuntimeReducer(streamable, {
        kind: "events-received",
        events: [event(1)],
      }),
      { kind: "stream-set", stream: { runId: "run-1", cursor: "cursor-1", connected: true } },
    );
    expect(withEvent.stream.status).toBe("ready");

    const next = codingWorkbenchRuntimeReducer(withEvent, {
      kind: "run-set",
      snapshot: snapshot({ runId: "run-2", revision: 1 }),
    });

    expect(next.events).toEqual([]);
    expect(next.stream).toMatchObject({ status: "idle", value: null });
  });

  it("clears stale stream failures once the current run reaches terminal server truth", () => {
    let state = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "run-set",
      snapshot: snapshot({
        state: "running",
        pendingPermission: undefined,
      }),
    });
    state = codingWorkbenchRuntimeReducer(state, {
      kind: "resource-failed",
      resource: "stream",
      status: "error",
      error: { code: "STREAM_UNAVAILABLE", message: "stream unavailable", retryable: true },
    });
    expect(state.stream.status).toBe("error");

    const terminal = codingWorkbenchRuntimeReducer(state, {
      kind: "run-set",
      snapshot: snapshot({
        state: "succeeded",
        revision: 5,
        pendingPermission: undefined,
      }),
    });

    expect(terminal.run.value).toMatchObject({ runId: "run-1", state: "succeeded", revision: 5 });
    expect(terminal.stream).toMatchObject({ status: "idle", value: null, error: null });
  });

  it("ignores late stream failures after the streamable run has already settled", () => {
    const settled = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "run-set",
      snapshot: snapshot({
        state: "succeeded",
        revision: 5,
        pendingPermission: undefined,
      }),
    });

    const lateError = codingWorkbenchRuntimeReducer(settled, {
      kind: "resource-failed",
      resource: "stream",
      status: "error",
      error: { code: "STREAM_UNAVAILABLE", message: "stream unavailable", retryable: true },
    });

    expect(lateError).toBe(settled);
    expect(lateError.stream).toMatchObject({ status: "idle", value: null, error: null });
  });

  it("ignores late stream readiness after the streamable run has already settled", () => {
    const settled = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "run-set",
      snapshot: snapshot({
        state: "succeeded",
        revision: 5,
        pendingPermission: undefined,
      }),
    });

    const lateReady = codingWorkbenchRuntimeReducer(settled, {
      kind: "stream-set",
      stream: { runId: "run-1", cursor: "cursor-late", connected: true },
    });

    expect(lateReady.stream).toMatchObject({ status: "idle", value: null, error: null });
  });

  it.each(["succeeded", "failed", "cancelled", "taken-over"] as const)(
    "retains an SSE-observed %s run when global runtime status returns to idle",
    (terminalState): void => {
      let state = codingWorkbenchRuntimeReducer(readyState(), {
        kind: "run-set",
        snapshot: snapshot({
          state: "running",
          pendingPermission: undefined,
        }),
      });
      state = codingWorkbenchRuntimeReducer(state, {
        kind: "events-received",
        events: [statusEvent(1, terminalState, 5)],
      });
      expect(state.run.value).toMatchObject({ state: terminalState, revision: 5 });
      state = codingWorkbenchRuntimeReducer(state, {
        kind: "resource-loading",
        resource: "run",
      });

      const next = codingWorkbenchRuntimeReducer(state, {
        kind: "run-set",
        snapshot: snapshot({
          state: "idle",
          revision: 0,
          runId: undefined,
          pendingPermission: undefined,
        }),
      });

      expect(next.run).toMatchObject({
        status: "ready",
        value: { runId: "run-1", state: terminalState, revision: 5 },
      });
      expect(next.events).toEqual([statusEvent(1, terminalState, 5)]);
      expect(next.canStart).toBe(true);

      const replaced = codingWorkbenchRuntimeReducer(next, {
        kind: "run-set",
        snapshot: snapshot({
          state: "starting",
          revision: 1,
          runId: "run-2",
          pendingPermission: undefined,
        }),
      });
      expect(replaced.run.value).toMatchObject({ runId: "run-2", state: "starting", revision: 1 });
      expect(replaced.events).toEqual([]);
    },
  );

  it("removes recovery acknowledgement when an SSE event settles the run", (): void => {
    let state = codingWorkbenchRuntimeReducer(readyState(), {
      kind: "run-set",
      snapshot: snapshot({
        state: "recovery-required",
        revision: 6,
        recoveryAcknowledged: true,
        pendingPermission: undefined,
      }),
    });

    state = codingWorkbenchRuntimeReducer(state, {
      kind: "events-received",
      events: [statusEvent(1, "cancelled", 7)],
    });

    expect(state.run.value).toMatchObject({ state: "cancelled", revision: 7 });
    expect(state.run.value).not.toHaveProperty("recoveryAcknowledged");
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
    // #3390: the composer's single "Start coding run" action — not only the recovery panel's
    // separate Retry button — must become reachable once the server has recorded the
    // acknowledgement, or an operator who used the primary control after a restart sends no
    // request at all and has no way to launch a replacement run short of wiping local state.
    expect(acknowledged.canStart).toBe(true);
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

describe("app-session pairing readiness (release-audit F-08/RG-12)", () => {
  function startable(pairing: CodingWorkbenchPairingState | null): CodingWorkbenchRuntimeState {
    return codingWorkbenchRuntimeReducer(readyState(false, pairing), {
      kind: "run-set",
      snapshot: snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }),
    });
  }

  it("admits Start only for a confirmed paired browser session", () => {
    expect(startable(null).canStart).toBe(false);
    expect(startable("unknown").canStart).toBe(false);
    expect(startable("unpaired").canStart).toBe(false);
    expect(startable("paired").canStart).toBe(true);
  });

  it("admits recovery Retry only for a confirmed paired browser session", () => {
    const recovery = (pairing: CodingWorkbenchPairingState): CodingWorkbenchRuntimeState =>
      codingWorkbenchRuntimeReducer(readyState(false, pairing), {
        kind: "run-set",
        snapshot: snapshot({
          state: "recovery-required",
          revision: 7,
          failureCode: "recovery-required",
          recoveryAcknowledged: true,
          pendingPermission: undefined,
        }),
      });
    expect(recovery("unknown").canRetry).toBe(false);
    expect(recovery("unpaired").canRetry).toBe(false);
    expect(recovery("paired").canRetry).toBe(true);
  });

  it("keeps the state identity when the pairing dimension does not change", () => {
    const state = readyState(false, "paired");
    expect(codingWorkbenchRuntimeReducer(state, { kind: "pairing-set", pairing: "paired" })).toBe(
      state,
    );
  });
});

describe("primary agent selection (#3897)", () => {
  const offering = (state: CodingWorkbenchRuntimeState): CodingWorkbenchRuntimeState =>
    codingWorkbenchRuntimeReducer(state, {
      kind: "runtime-set",
      readiness: readiness(["build", "plan"]),
    });

  it("starts on the default agent and offers only it until readiness says otherwise", () => {
    const initial = createInitialCodingWorkbenchRuntimeState();
    expect(initial).toMatchObject({ agent: "build", selectableAgents: ["build"] });
    expect(offeredCodingWorkbenchAgents(initial)).toEqual(["build"]);
    expect(codingWorkbenchRuntimeReducer(initial, { kind: "select-agent", agent: "plan" })).toBe(
      initial,
    );
  });

  it("records the agents readiness offers and lets the operator select one of them", () => {
    const offered = offering(readyState());
    expect(offeredCodingWorkbenchAgents(offered)).toEqual(["build", "plan"]);
    const planned = codingWorkbenchRuntimeReducer(offered, { kind: "select-agent", agent: "plan" });
    expect(planned.agent).toBe("plan");
    expect(codingWorkbenchRuntimeReducer(planned, { kind: "select-agent", agent: "plan" })).toBe(
      planned,
    );
    expect(
      codingWorkbenchRuntimeReducer(planned, { kind: "select-agent", agent: "build" }).agent,
    ).toBe("build");
  });

  // #3903 AC1: a custom primary agent is selectable only where the server offers plan.
  it("selects a custom primary agent only where the server runs OpenCode's own agents", () => {
    const initial = createInitialCodingWorkbenchRuntimeState();
    expect(
      codingWorkbenchRuntimeReducer(initial, { kind: "select-agent", agent: "reviewer" }),
    ).toBe(initial);
    const offered = offering(readyState());
    const custom = codingWorkbenchRuntimeReducer(offered, {
      kind: "select-agent",
      agent: "reviewer",
    });
    expect(custom.agent).toBe("reviewer");
    for (const reserved of ["general", "Plan"])
      expect(
        codingWorkbenchRuntimeReducer(offered, { kind: "select-agent", agent: reserved }).agent,
      ).toBe("build");
  });

  it("keeps the offered agents and the selection while a mode change reloads readiness", () => {
    const planned = codingWorkbenchRuntimeReducer(offering(readyState()), {
      kind: "select-agent",
      agent: "plan",
    });
    const reloading = codingWorkbenchRuntimeReducer(planned, {
      kind: "select-mode",
      mode: "governed-assist",
    });
    expect(reloading.runtime).toMatchObject({ status: "idle", value: null });
    expect(reloading.agent).toBe("plan");
    expect(offeredCodingWorkbenchAgents(reloading)).toEqual(["build", "plan"]);
  });

  it("falls back to the default agent when readiness stops offering the selected one", () => {
    const planned = codingWorkbenchRuntimeReducer(offering(readyState()), {
      kind: "select-agent",
      agent: "plan",
    });
    const narrowed = codingWorkbenchRuntimeReducer(planned, {
      kind: "runtime-set",
      readiness: readiness(["build"]),
    });
    expect(narrowed.agent).toBe("build");
    expect(offeredCodingWorkbenchAgents(narrowed)).toEqual(["build"]);
  });

  it("offers only the default agent for a source that has no agent concept", () => {
    const planned = codingWorkbenchRuntimeReducer(offering(readyState()), {
      kind: "select-agent",
      agent: "plan",
    });
    const codex = codingWorkbenchRuntimeReducer(planned, {
      kind: "select-runtime-preference",
      preference: "codex-subscription",
    });
    expect(codex.agent).toBe("build");
    expect(offeredCodingWorkbenchAgents(codex)).toEqual(["build"]);
    expect(codingWorkbenchRuntimeReducer(codex, { kind: "select-agent", agent: "plan" })).toBe(
      codex,
    );
    const managed = codingWorkbenchRuntimeReducer(codex, {
      kind: "select-runtime-preference",
      preference: "managed-gateway",
    });
    expect(offeredCodingWorkbenchAgents(managed)).toEqual(["build", "plan"]);
  });
});

describe("mode selection, setup plans, and mutation failures", () => {
  it("stores model and reasoning selections while resetting stale effort on model changes", () => {
    const modelSelected = codingWorkbenchRuntimeReducer(
      { ...readyState(), reasoningEffort: "high" },
      { kind: "select-model", modelId: "gpt-5.4" },
    );
    expect(modelSelected).toMatchObject({ selectedModelId: "gpt-5.4", reasoningEffort: null });

    const effortSelected = codingWorkbenchRuntimeReducer(modelSelected, {
      kind: "select-reasoning-effort",
      effort: "medium",
    });
    expect(effortSelected.reasoningEffort).toBe("medium");
  });

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

  // F-01: `sourceReady` (and therefore Start) used to be satisfied by a configured sidecar profile
  // alone, so a gateway the product had just failed to reach still presented a startable source.
  it("stops treating a source as ready when its last probe failed", () => {
    const failed = startableStateWithSource("failed");

    expect(failed.source.value).toMatchObject({ available: true, verification: "failed" });
    expect(failed.canStart).toBe(false);
  });

  it("keeps an unprobed source startable but labelled unverified, and a verified one ready", () => {
    // Absence of evidence must not gate the product behind an optional readiness check — it has to
    // be visible in the projection instead, which is what the source row renders.
    const unverified = startableStateWithSource("unverified");
    expect(unverified.source.value?.verification).toBe("unverified");
    expect(unverified.canStart).toBe(true);

    const verified = startableStateWithSource("verified");
    expect(verified.source.value?.verification).toBe("verified");
    expect(verified.canStart).toBe(true);
  });

  it("carries the probe outcome from the sidecar profile into the source projection", () => {
    expect(codingWorkbenchSourceFromManaged(managedProfile("partial"))).toMatchObject({
      available: true,
      verification: "partial",
    });
    expect(
      codingWorkbenchSourceFromManaged({ status: "unavailable", reason: "missing-credentials" }),
    ).toMatchObject({ available: false, verification: "unverified" });
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

it("keeps the actual managed-gateway Start projection closed when its model selection clears", () => {
  const ready = codingWorkbenchRuntimeReducer(readyState(false), {
    kind: "run-set",
    snapshot: snapshot({ state: "idle", runId: undefined, pendingPermission: undefined }),
  });
  const selected = codingWorkbenchRuntimeReducer(ready, {
    kind: "select-model",
    modelId: "verified-model",
  });
  expect(selected.canStart).toBe(true);
  const cleared = codingWorkbenchRuntimeReducer(selected, {
    kind: "select-model",
    modelId: null,
  });
  expect(cleared.canStart).toBe(false);
});

// ADR-0137 D10: the prompt inputs the composer offers are what the server's readiness read said the
// composed runtime can do, kept across a mode change and never widened by the browser.
describe("prompt inputs the server offers", () => {
  const withPromptInputs = (
    state: CodingWorkbenchRuntimeState,
    promptInputs?: CodingWorkbenchRuntimeReadiness["promptInputs"],
  ): CodingWorkbenchRuntimeState =>
    codingWorkbenchRuntimeReducer(state, {
      kind: "runtime-set",
      readiness: { ...readiness(), ...(promptInputs === undefined ? {} : { promptInputs }) },
    });

  it("starts with neither input and offers neither until readiness says otherwise", () => {
    const initial = createInitialCodingWorkbenchRuntimeState();
    expect(initial.promptInputs).toEqual({ delivery: false, references: false });
    expect(offeredCodingWorkbenchPromptInputs(initial)).toBe(NO_CODING_WORKBENCH_PROMPT_INPUTS);
  });

  it("records what readiness offers", () => {
    const offered = withPromptInputs(readyState(), { delivery: true, references: true });
    expect(offered.promptInputs).toEqual({ delivery: true, references: true });
    expect(offeredCodingWorkbenchPromptInputs(offered)).toEqual({
      delivery: true,
      references: true,
    });
    const partial = withPromptInputs(readyState(), { delivery: true, references: false });
    expect(offeredCodingWorkbenchPromptInputs(partial)).toEqual({
      delivery: true,
      references: false,
    });
  });

  it("reads a readiness that states nothing as none, and a narrowing as a narrowing", () => {
    const offered = withPromptInputs(readyState(), { delivery: true, references: true });
    expect(withPromptInputs(offered).promptInputs).toEqual({ delivery: false, references: false });
    expect(withPromptInputs(offered, { delivery: false, references: false }).promptInputs).toEqual({
      delivery: false,
      references: false,
    });
  });

  it("keeps the offer while a mode change reloads readiness", () => {
    const offered = withPromptInputs(readyState(), { delivery: true, references: true });
    const reloading = codingWorkbenchRuntimeReducer(offered, {
      kind: "select-mode",
      mode: "governed-assist",
    });
    expect(reloading.runtime).toMatchObject({ status: "idle", value: null });
    expect(offeredCodingWorkbenchPromptInputs(reloading)).toEqual({
      delivery: true,
      references: true,
    });
  });

  // The slash command menu is a prompt input of its own (ADR-0137 D10): an older server never states
  // it, which reads as not offered, and the Codex source never gets it.
  it("records the slash command offer beside the other inputs and reads its absence as none", () => {
    const withCommands = withPromptInputs(readyState(), {
      delivery: true,
      references: true,
      commands: true,
    });
    expect(offeredCodingWorkbenchPromptInputs(withCommands).commands).toBe(true);
    const without = withPromptInputs(readyState(), { delivery: true, references: true });
    expect(offeredCodingWorkbenchPromptInputs(without).commands).not.toBe(true);
    const narrowed = withPromptInputs(withCommands, {
      delivery: true,
      references: true,
      commands: false,
    });
    expect(offeredCodingWorkbenchPromptInputs(narrowed).commands).toBe(false);
    expect(withPromptInputs(withCommands).promptInputs.commands).not.toBe(true);
    const codex = { ...withCommands, runtimePreference: "codex-subscription" as const };
    expect(offeredCodingWorkbenchPromptInputs(codex).commands).not.toBe(true);
  });

  it("offers neither input to a Codex subscription run, whatever the managed runtime reported", () => {
    const offered = withPromptInputs(readyState(), { delivery: true, references: true });
    const codex = { ...offered, runtimePreference: "codex-subscription" as const };
    expect(offeredCodingWorkbenchPromptInputs(codex)).toEqual({
      delivery: false,
      references: false,
    });
  });
});
