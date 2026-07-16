import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  CODING_WORKBENCH_RUNTIME_STATE_NAMES,
  isLegalCodingWorkbenchRuntimeTransition,
  validateCodingWorkbenchRuntimeAuthorityEnvelope,
  validateCodingWorkbenchRuntimeAdapterStartRequest,
  validateCodingWorkbenchRuntimeAuthorityFacts,
  validateCodingWorkbenchRuntimeIntent,
  validateCodingWorkbenchRuntimeMintConfirmation,
  validateCodingWorkbenchRuntimeState,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchRuntimeAuthorityEnvelope,
} from "./index.js";

const DIGEST = "a".repeat(64);

function authority(): CodingWorkbenchAuthorityEnvelope {
  return {
    schemaVersion: "1",
    runId: "run-1",
    localUser: "operator-1",
    taskRefs: ["task-1"],
    workspace: { workspaceId: "workspace-1", rootLabel: "workspace", rootDigest: DIGEST },
    branch: {
      baseRef: "dev",
      headRef: "issue/2252",
      allowDetachedHead: false,
      allowedPrefixes: ["issue/"],
    },
    requestedMode: "supervised-coding",
    deploymentCeiling: "autonomous-delivery",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: CODING_WORKBENCH_ACTION_CLASSES,
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 60_000,
      requirePerCommandApproval: false,
    },
    networkPolicy: { mode: "deny-all", allowLoopback: false, connectorScopes: [] },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 10,
      maxPromptTokens: 10_000,
      maxPatchBytes: 65_536,
    },
    expiresAt: "2026-07-11T13:00:00.000Z",
    approvalProofDigest: DIGEST,
  };
}

function runtimeAuthority(): CodingWorkbenchRuntimeAuthorityEnvelope {
  return {
    schemaVersion: "1",
    authority: authority(),
    binding: {
      taskId: "task-1",
      projectId: "project-1",
      projectDigest: DIGEST,
      workspaceId: "workspace-1",
      workspaceRootDigest: DIGEST,
      branchRef: "issue/2252",
      branchHeadDigest: DIGEST,
    },
    intentDigest: DIGEST,
    nonceDigest: DIGEST,
    issuedAt: "2026-07-11T12:00:00.000Z",
  };
}

describe("Coding Workbench runtime contracts", () => {
  it("accepts the minimal start intent and rejects every client-authored authority field", () => {
    const intent = {
      schemaVersion: "1",
      requestId: "request-1",
      command: "start",
      taskIntent: "Investigate the failing unit test",
      requestedMode: "supervised-coding",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeIntent(intent)).toEqual({ ok: true, value: intent });
    for (const key of [
      "path",
      "argv",
      "endpoint",
      "environment",
      "credential",
      "deploymentCeiling",
      "actionClasses",
      "budget",
      "projectRoot",
    ]) {
      expect(validateCodingWorkbenchRuntimeIntent({ ...intent, [key]: "forged" })).toMatchObject({
        ok: false,
      });
    }
  });

  it("keeps lifecycle commands closed and run-bound", () => {
    expect(
      validateCodingWorkbenchRuntimeIntent({
        schemaVersion: "1",
        requestId: "r",
        command: "stop",
        runId: "run-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeIntent({
        schemaVersion: "1",
        requestId: "r",
        command: "pause",
        runId: "run-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeIntent({ schemaVersion: "1", requestId: "r", command: "stop" }),
    ).toMatchObject({ ok: false });
  });

  it("defines all twelve states and only explicit transitions", () => {
    expect(CODING_WORKBENCH_RUNTIME_STATE_NAMES).toHaveLength(12);
    expect(isLegalCodingWorkbenchRuntimeTransition("idle", "starting")).toBe(true);
    expect(isLegalCodingWorkbenchRuntimeTransition("running", "idle")).toBe(false);
    expect(isLegalCodingWorkbenchRuntimeTransition("taken-over", "idle")).toBe(true);
  });

  it("validates the server-owned binding and rejects content-bearing or mismatched fields", () => {
    expect(validateCodingWorkbenchRuntimeAuthorityEnvelope(runtimeAuthority())).toMatchObject({
      ok: true,
    });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), prompt: "secret" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({
        ...runtimeAuthority(),
        binding: { ...runtimeAuthority().binding, workspaceRootDigest: "b".repeat(64) },
      }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    ["task", { binding: { ...runtimeAuthority().binding, taskId: "other" } }],
    ["workspace", { binding: { ...runtimeAuthority().binding, workspaceId: "other" } }],
    ["root", { binding: { ...runtimeAuthority().binding, workspaceRootDigest: "b".repeat(64) } }],
    ["branch", { binding: { ...runtimeAuthority().binding, branchRef: "other" } }],
  ])("rejects a %s correlation mismatch", (_axis, override) => {
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), ...override }),
    ).toMatchObject({ ok: false });
  });

  it("validates exact-key state, confirmation, adapter request, and live facts", () => {
    const state = {
      schemaVersion: "1",
      state: "idle",
      revision: 0,
      updatedAt: "2026-07-11T12:00:00.000Z",
    };
    expect(validateCodingWorkbenchRuntimeState(state)).toMatchObject({ ok: true });
    expect(validateCodingWorkbenchRuntimeState({ ...state, revision: -1 })).toMatchObject({
      ok: false,
    });
    expect(validateCodingWorkbenchRuntimeState({ ...state, updatedAt: "bad" })).toMatchObject({
      ok: false,
    });
    expect(validateCodingWorkbenchRuntimeState({ ...state, prompt: "content" })).toMatchObject({
      ok: false,
    });
    const confirmation = {
      approvalId: "approval",
      approvalToken: "token",
      taskId: "task-1",
      operatorId: "operator-1",
      intentDigest: DIGEST,
      expiresAt: "2026-07-11T13:00:00.000Z",
    };
    expect(validateCodingWorkbenchRuntimeMintConfirmation(confirmation)).toMatchObject({
      ok: true,
    });
    expect(
      validateCodingWorkbenchRuntimeMintConfirmation({ ...confirmation, rawPrompt: "content" }),
    ).toMatchObject({ ok: false });
    const adapter = {
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      delegationId: "d-1",
      idempotencyKey: "i-1",
      binding: runtimeAuthority().binding,
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeAdapterStartRequest(adapter)).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeAdapterStartRequest({ ...adapter, argv: [] }),
    ).toMatchObject({ ok: false });
    const facts = {
      binding: runtimeAuthority().binding,
      actionClasses: [],
      connectorScopes: [],
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      budgetDigest: DIGEST,
      commandPolicyDigest: DIGEST,
      networkPolicyDigest: DIGEST,
      gatesDigest: DIGEST,
      branchConstraintsDigest: DIGEST,
      modelProfileDigest: DIGEST,
    };
    expect(validateCodingWorkbenchRuntimeAuthorityFacts(facts)).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts, response: "content" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts, actionClasses: ["shell-root"] }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts, connectorScopes: ["secrets.read"] }),
    ).toMatchObject({ ok: false });
  });

  it("enforces state-dependent binding and closed optional fields", () => {
    const active = {
      schemaVersion: "1",
      state: "running",
      revision: 1,
      updatedAt: "2026-07-11T12:00:00.000Z",
      runId: "run-1",
      taskId: "task-1",
      workspaceId: "workspace-1",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeState(active)).toMatchObject({ ok: true });
    expect(validateCodingWorkbenchRuntimeState({ ...active, runId: undefined })).toMatchObject({
      ok: false,
    });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, runtimeSource: "unknown" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, failureCode: "raw-error" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, failureCode: "runtime-failed" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, updatedAt: "2026-07-11 12:00:00" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, updatedAt: "2026-02-30T12:00:00.000Z" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({ ...active, state: "failed", failureCode: undefined }),
    ).toMatchObject({ ok: false });
    expect(validateCodingWorkbenchRuntimeState({ ...active, state: "idle" })).toMatchObject({
      ok: false,
    });
    expect(
      validateCodingWorkbenchRuntimeState({
        schemaVersion: "1",
        state: "recovery-required",
        revision: 1,
        updatedAt: "2026-07-11T12:00:00.000Z",
        failureCode: "recovery-required",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeState({
        ...active,
        state: "recovery-required",
        failureCode: "recovery-required",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeState({
        ...active,
        state: "recovery-required",
        taskId: undefined,
        failureCode: "recovery-required",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("Coding Workbench runtime contract failure branches", () => {
  function facts(): Record<string, unknown> {
    return {
      binding: runtimeAuthority().binding,
      actionClasses: [],
      connectorScopes: [],
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      budgetDigest: DIGEST,
      commandPolicyDigest: DIGEST,
      networkPolicyDigest: DIGEST,
      gatesDigest: DIGEST,
      branchConstraintsDigest: DIGEST,
      modelProfileDigest: DIGEST,
    };
  }

  function adapter(): Record<string, unknown> {
    return {
      authorityRef: { runId: "run-1", envelopeDigest: DIGEST },
      delegationId: "d-1",
      idempotencyKey: "i-1",
      binding: runtimeAuthority().binding,
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
  }

  it("rejects a foreign schema version on every runtime surface", () => {
    expect(
      validateCodingWorkbenchRuntimeIntent({
        schemaVersion: "2",
        requestId: "r",
        command: "stop",
        runId: "run-1",
      }),
    ).toMatchObject({ ok: false, errors: ["schemaVersion is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), schemaVersion: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeState({
        schemaVersion: "0",
        state: "idle",
        revision: 0,
        updatedAt: "2026-07-11T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, errors: ["schemaVersion is invalid"] });
  });

  it("rejects a bounded-overflow or empty start task intent", () => {
    const start = {
      schemaVersion: "1",
      requestId: "r",
      command: "start",
      taskIntent: "x".repeat(65_537),
      requestedMode: "supervised-coding",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeIntent(start)).toMatchObject({
      ok: false,
      errors: ["taskIntent must be a bounded non-empty string"],
    });
    expect(validateCodingWorkbenchRuntimeIntent({ ...start, taskIntent: "" })).toMatchObject({
      ok: false,
    });
  });

  it("rejects non-array authority scopes and unknown sources on live facts", () => {
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), actionClasses: "all" }),
    ).toMatchObject({ ok: false, errors: ["authority scopes must be arrays"] });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), runtimeSource: "external" }),
    ).toMatchObject({ ok: false, errors: ["runtimeSource is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeAuthorityFacts({ ...facts(), modelSource: "external" }),
    ).toMatchObject({ ok: false, errors: ["modelSource is invalid"] });
  });

  it("rejects unknown sources on the adapter start request", () => {
    expect(
      validateCodingWorkbenchRuntimeAdapterStartRequest({ ...adapter(), runtimeSource: "shell" }),
    ).toMatchObject({ ok: false, errors: ["runtimeSource is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeAdapterStartRequest({ ...adapter(), modelSource: "shell" }),
    ).toMatchObject({ ok: false, errors: ["modelSource is invalid"] });
  });

  it("fails closed on a non-object binding, malformed digests, and malformed instants", () => {
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({ ...runtimeAuthority(), binding: "b" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({
        ...runtimeAuthority(),
        intentDigest: "A".repeat(64),
      }),
    ).toMatchObject({
      ok: false,
      errors: ["intentDigest must be a 64-character lowercase hex digest"],
    });
    expect(
      validateCodingWorkbenchRuntimeAuthorityEnvelope({
        ...runtimeAuthority(),
        issuedAt: "not-a-date",
      }),
    ).toMatchObject({ ok: false, errors: ["issuedAt must be an ISO instant"] });
  });

  it("rejects empty optional identity fields and unknown model sources on runtime state", () => {
    const active = {
      schemaVersion: "1",
      state: "running",
      revision: 1,
      updatedAt: "2026-07-11T12:00:00.000Z",
      runId: "run-1",
      taskId: "task-1",
      workspaceId: "workspace-1",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    const emptyTask = validateCodingWorkbenchRuntimeState({ ...active, taskId: "" });
    expect(emptyTask.ok).toBe(false);
    if (!emptyTask.ok) expect(emptyTask.errors).toContain("taskId must be a non-empty string");
    expect(validateCodingWorkbenchRuntimeState({ ...active, modelSource: "other" })).toMatchObject({
      ok: false,
      errors: ["modelSource is invalid"],
    });
  });
});
