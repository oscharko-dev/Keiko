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
  });
});
