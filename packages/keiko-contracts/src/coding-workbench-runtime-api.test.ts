import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS,
  CODING_WORKBENCH_RUNTIME_PREFERENCES,
  CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeReadinessRequest,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeRetryRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeReadiness,
  validateCodingWorkbenchRuntimeSseEvent,
} from "./index.js";

const AT = "2026-07-13T12:00:00.000Z";

describe("Coding Workbench runtime API contracts", () => {
  it("accepts browser start intent only and rejects forged runtime authority", () => {
    const start = {
      requestId: "request-1",
      taskIntent: "Investigate the failing unit test",
      requestedMode: "supervised-coding",
      runtimePreference: "managed-gateway",
    };

    expect(parseCodingWorkbenchRuntimeStartRequest(start)).toEqual({ ok: true, value: start });
    expect(parseCodingWorkbenchRuntimeRetryRequest(start)).toEqual({ ok: true, value: start });
    expect(parseCodingWorkbenchRuntimeStartRequest({ ...start, taskIntent: "" })).toMatchObject({
      ok: false,
    });
    expect(
      parseCodingWorkbenchRuntimeStartRequest({
        ...start,
        runtimePreference: "keiko-model-gateway",
      }),
    ).toMatchObject({ ok: false });
    for (const field of [
      "root",
      "path",
      "projectRoot",
      "argv",
      "environment",
      "endpoint",
      "credentials",
      "authorityEnvelope",
      "capabilities",
      "budget",
      "deploymentCeiling",
      "modelSource",
      "runtimeSource",
      "profileId",
    ]) {
      expect(
        parseCodingWorkbenchRuntimeStartRequest({ ...start, [field]: "forged" }),
      ).toMatchObject({
        ok: false,
      });
    }
  });

  it("keeps approval decisions and run controls closed", () => {
    expect(CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS).toEqual(["approved", "denied"]);
    expect(CODING_WORKBENCH_RUNTIME_PREFERENCES).toEqual(["managed-gateway", "codex-subscription"]);
    expect(
      parseCodingWorkbenchRuntimeApprovalDecisionRequest({
        requestId: "permission-1",
        expectedRevision: 3,
        decision: "approved",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseCodingWorkbenchRuntimeApprovalDecisionRequest({
        requestId: "permission-1",
        expectedRevision: 3,
        decision: "approve-all",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseCodingWorkbenchRuntimeApprovalDecisionRequest({
        requestId: "permission-1",
        expectedRevision: 3,
        decision: "denied",
        reason: "unbounded browser text is forbidden",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseCodingWorkbenchRuntimeApprovalDecisionRequest({
        requestId: "permission-1",
        expectedRevision: -1,
        decision: "denied",
      }),
    ).toMatchObject({ ok: false });

    expect(parseCodingWorkbenchRuntimeStopRequest({ requestId: "request-3" })).toMatchObject({
      ok: true,
    });
    expect(parseCodingWorkbenchRuntimeTakeoverRequest({ requestId: "request-3" })).toMatchObject({
      ok: true,
    });
    expect(
      parseCodingWorkbenchRuntimeTakeoverRequest({
        requestId: "request-3",
        runId: "forged-path-value",
      }),
    ).toMatchObject({ ok: false });
    expect(parseCodingWorkbenchRuntimeStopRequest({ requestId: "../forged" })).toMatchObject({
      ok: false,
    });
  });

  it("accepts only a literal recovery acknowledgement", () => {
    const acknowledgement = {
      requestId: "request-4",
      acknowledged: true,
    };
    expect(parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest(acknowledgement)).toEqual({
      ok: true,
      value: acknowledgement,
    });
    expect(
      parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest({
        ...acknowledgement,
        acknowledged: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest({
        ...acknowledgement,
        processId: 123,
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts only a content-free requested mode for runtime readiness", () => {
    const request = { requestedMode: "supervised-coding" };
    expect(parseCodingWorkbenchRuntimeReadinessRequest(request)).toEqual({
      ok: true,
      value: request,
    });
    for (const field of ["endpoint", "workspaceRoot", "authority", "profileId"]) {
      expect(
        parseCodingWorkbenchRuntimeReadinessRequest({ ...request, [field]: "forged" }),
      ).toMatchObject({ ok: false });
    }
  });

  it("validates server-owned readiness as the fail-closed effective mode projection", () => {
    const readiness = {
      schemaVersion: "1",
      requestedMode: "supervised-coding",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      runtimeAvailable: true,
    };
    expect(validateCodingWorkbenchRuntimeReadiness(readiness)).toEqual({
      ok: true,
      value: readiness,
    });
    expect(
      validateCodingWorkbenchRuntimeReadiness({
        ...readiness,
        effectiveMode: "supervised-coding",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeReadiness({ ...readiness, runtimeAvailable: "yes" }),
    ).toMatchObject({ ok: false });
  });

  it("projects a content-free runtime snapshot with no authority details", () => {
    const snapshot = {
      schemaVersion: "1",
      state: "running",
      revision: 2,
      updatedAt: AT,
      runId: "run-1",
      requestedMode: "supervised-coding",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
    for (const field of [
      "taskIntent",
      "prompt",
      "response",
      "workspaceRoot",
      "authority",
      "budget",
    ]) {
      expect(
        validateCodingWorkbenchRuntimeSnapshot({ ...snapshot, [field]: "content" }),
      ).toMatchObject({
        ok: false,
      });
    }
  });

  it("binds pending permission to awaiting-approval snapshots only", () => {
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
    };
    const awaiting = {
      schemaVersion: "1",
      state: "awaiting-approval",
      revision: 3,
      updatedAt: AT,
      runId: "run-1",
      pendingPermission,
    };
    expect(validateCodingWorkbenchRuntimeSnapshot(awaiting)).toEqual({ ok: true, value: awaiting });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({ ...awaiting, pendingPermission: undefined }),
    ).toMatchObject({ ok: false });
    expect(validateCodingWorkbenchRuntimeSnapshot({ ...awaiting, state: "running" })).toMatchObject(
      { ok: false },
    );
    expect(
      validateCodingWorkbenchRuntimeSnapshot({
        ...awaiting,
        pendingPermission: { ...pendingPermission, prompt: "secret" },
      }),
    ).toMatchObject({ ok: false });
  });

  it("projects recovery acknowledgement only as durable recovery-required server truth", () => {
    const recovery = {
      schemaVersion: "1",
      state: "recovery-required",
      revision: 4,
      updatedAt: AT,
      runId: "run-1",
      failureCode: "recovery-required",
      recoveryAcknowledged: true,
    };
    expect(validateCodingWorkbenchRuntimeSnapshot(recovery)).toEqual({
      ok: true,
      value: recovery,
    });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({ ...recovery, recoveryAcknowledged: false }),
    ).toMatchObject({ ok: false });
    expect(validateCodingWorkbenchRuntimeSnapshot({ ...recovery, state: "running" })).toMatchObject(
      { ok: false },
    );
  });

  it("bounds SSE projections and permits no model, process, or workspace content", () => {
    expect(CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS).toEqual(["status", "runtime-event"]);
    const event = {
      schemaVersion: "1",
      cursor: "cursor-1",
      sequence: 1,
      occurredAt: AT,
      kind: "runtime-event",
      runId: "run-1",
      state: "awaiting-approval",
      revision: 3,
      eventKind: "permission-requested",
    };
    expect(validateCodingWorkbenchRuntimeSseEvent(event)).toEqual({ ok: true, value: event });
    const { eventKind: _eventKind, ...statusFields } = event;
    void _eventKind;
    const status = { ...statusFields, kind: "status" as const };
    expect(validateCodingWorkbenchRuntimeSseEvent(status)).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeSseEvent({ ...status, eventKind: "runtime-started" }),
    ).toMatchObject({ ok: false });
    expect(validateCodingWorkbenchRuntimeSseEvent({ ...event, sequence: -1 })).toMatchObject({
      ok: false,
    });
    expect(
      validateCodingWorkbenchRuntimeSseEvent({ ...event, cursor: "cursor with spaces" }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeSseEvent({ ...event, cursor: "a".repeat(129) }),
    ).toMatchObject({ ok: false });
    for (const field of ["message", "prompt", "response", "diff", "argv", "workspaceRoot"]) {
      expect(
        validateCodingWorkbenchRuntimeSseEvent({ ...event, [field]: "content" }),
      ).toMatchObject({
        ok: false,
      });
    }
  });
});
