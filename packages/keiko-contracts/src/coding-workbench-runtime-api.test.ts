import { describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS,
  CODING_WORKBENCH_RUNTIME_PREFERENCES,
  CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeReadinessRequest,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeResearchRevokeRequest,
  parseCodingWorkbenchRuntimeRetryRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeReadiness,
  validateCodingWorkbenchRuntimeSseEvent,
  validateCodingWorkbenchRuntimeStatus,
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
    // #2386: the server may confirm a NARROWER effective mode than the request/ceiling clamp —
    // the mode-change gate anchors it to the live run — but never a wider one.
    expect(
      validateCodingWorkbenchRuntimeReadiness({
        schemaVersion: "1",
        requestedMode: "autonomous-delivery",
        deploymentCeiling: "autonomous-delivery",
        effectiveMode: "supervised-coding",
        runtimeAvailable: true,
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeReadiness({ ...readiness, runtimeAvailable: "yes" }),
    ).toMatchObject({ ok: false });
  });

  it("binds the unavailable reason to the availability boolean in both directions", () => {
    const available = {
      schemaVersion: "1",
      requestedMode: "supervised-coding",
      deploymentCeiling: "governed-assist",
      effectiveMode: "governed-assist",
      runtimeAvailable: true,
    };
    const unavailable = {
      ...available,
      runtimeAvailable: false,
      runtimeUnavailableReason: "payload-missing",
    };
    expect(validateCodingWorkbenchRuntimeReadiness(unavailable)).toEqual({
      ok: true,
      value: unavailable,
    });
    expect(
      validateCodingWorkbenchRuntimeReadiness({ ...available, runtimeAvailable: false }),
    ).toEqual({
      ok: false,
      errors: ["runtimeUnavailableReason is required when the runtime is unavailable"],
    });
    expect(
      validateCodingWorkbenchRuntimeReadiness({
        ...available,
        runtimeUnavailableReason: "payload-missing",
      }),
    ).toEqual({
      ok: false,
      errors: ["runtimeUnavailableReason must be absent when the runtime is available"],
    });
    expect(
      validateCodingWorkbenchRuntimeReadiness({
        ...unavailable,
        runtimeUnavailableReason: "helper-exploded",
      }),
    ).toEqual({ ok: false, errors: ["runtimeUnavailableReason is invalid"] });
    for (const reason of CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS) {
      expect(
        validateCodingWorkbenchRuntimeReadiness({
          ...unavailable,
          runtimeUnavailableReason: reason,
        }),
      ).toMatchObject({ ok: true });
    }
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
    expect(validateCodingWorkbenchRuntimeStatus(snapshot)).toEqual({ ok: true, value: snapshot });
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

describe("Coding Workbench runtime API failure branches", () => {
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

  it("rejects non-record payloads with a single fail-closed error", () => {
    expect(parseCodingWorkbenchRuntimeStartRequest(null)).toEqual({
      ok: false,
      errors: ["start request must be an object"],
    });
    expect(parseCodingWorkbenchRuntimeReadinessRequest([])).toEqual({
      ok: false,
      errors: ["runtime readiness request must be an object"],
    });
    expect(validateCodingWorkbenchRuntimeSseEvent("event")).toEqual({
      ok: false,
      errors: ["runtime SSE event must be an object"],
    });
  });

  it("rejects unknown requested modes on start and readiness requests", () => {
    expect(
      parseCodingWorkbenchRuntimeStartRequest({
        requestId: "request-1",
        taskIntent: "Investigate",
        requestedMode: "root-access",
      }),
    ).toMatchObject({ ok: false, errors: ["requestedMode is invalid"] });
    expect(
      parseCodingWorkbenchRuntimeReadinessRequest({ requestedMode: "root-access" }),
    ).toMatchObject({ ok: false, errors: ["requestedMode is invalid"] });
  });

  it("rejects a foreign schema version on readiness and snapshot projections", () => {
    expect(
      validateCodingWorkbenchRuntimeReadiness({
        schemaVersion: "2",
        requestedMode: "supervised-coding",
        deploymentCeiling: "governed-assist",
        effectiveMode: "governed-assist",
        runtimeAvailable: true,
      }),
    ).toMatchObject({ ok: false, errors: ["schemaVersion is invalid"] });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({ ...snapshot, schemaVersion: "2" }),
    ).toMatchObject({ ok: false, errors: ["schemaVersion is invalid"] });
  });

  it("rejects unsafe snapshot revisions and unknown failure codes", () => {
    expect(validateCodingWorkbenchRuntimeSnapshot({ ...snapshot, revision: -1 })).toMatchObject({
      ok: false,
      errors: ["revision must be a non-negative safe integer"],
    });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({ ...snapshot, revision: Number.MAX_VALUE }),
    ).toMatchObject({ ok: false });
    const failed = validateCodingWorkbenchRuntimeSnapshot({
      ...snapshot,
      state: "failed",
      failureCode: "raw-stack-trace",
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errors).toContain("failureCode is invalid");
  });

  it("rejects malformed SSE schema versions, event kinds, instants, and failure codes", () => {
    const event = {
      schemaVersion: "1",
      cursor: "cursor-1",
      sequence: 1,
      occurredAt: AT,
      kind: "runtime-event",
      runId: "run-1",
      state: "running",
      revision: 3,
      eventKind: "task-submitted",
    };
    expect(validateCodingWorkbenchRuntimeSseEvent(event)).toMatchObject({ ok: true });
    expect(validateCodingWorkbenchRuntimeSseEvent({ ...event, schemaVersion: "0" })).toMatchObject({
      ok: false,
      errors: ["schemaVersion is invalid"],
    });
    expect(validateCodingWorkbenchRuntimeSseEvent({ ...event, eventKind: "bogus" })).toMatchObject({
      ok: false,
      errors: ["eventKind is invalid"],
    });
    expect(
      validateCodingWorkbenchRuntimeSseEvent({ ...event, occurredAt: "2026-02-30T12:00:00.000Z" }),
    ).toMatchObject({ ok: false, errors: ["occurredAt must be a strict UTC instant"] });
    expect(
      validateCodingWorkbenchRuntimeSseEvent({ ...event, failureCode: "raw-stack-trace" }),
    ).toMatchObject({ ok: false, errors: ["failureCode is invalid"] });
  });

  // #2637 (review #2646): the SSE boundary enforces the research/outcome binding, not just the field
  // type. Every invalid combination below would let the timeline misstate what a run took in.
  it("binds the #2637 contentTrust marker to an accepted research-performed frame", () => {
    const frame = (extra: Record<string, unknown>): Record<string, unknown> => ({
      schemaVersion: "1",
      cursor: "cursor-trust",
      sequence: 9,
      occurredAt: AT,
      kind: "runtime-event",
      runId: "run-1",
      state: "running",
      revision: 9,
      ...extra,
    });

    const accepted = frame({
      eventKind: "research-performed",
      auxiliaryOutcome: "accepted",
      contentTrust: "untrusted",
    });
    expect(validateCodingWorkbenchRuntimeSseEvent(accepted)).toEqual({ ok: true, value: accepted });

    const required = "contentTrust is required on an accepted research-performed frame";
    const forbidden = "contentTrust is only admissible on an accepted research-performed frame";

    // Accepted research WITHOUT the marker.
    expect(
      validateCodingWorkbenchRuntimeSseEvent(
        frame({ eventKind: "research-performed", auxiliaryOutcome: "accepted" }),
      ),
    ).toMatchObject({ ok: false, errors: [required] });
    // Empty and malformed markers are not "present".
    for (const contentTrust of ["", null, "trusted", 1]) {
      expect(
        validateCodingWorkbenchRuntimeSseEvent(
          frame({ eventKind: "research-performed", auxiliaryOutcome: "accepted", contentTrust }),
        ),
      ).toMatchObject({ ok: false, errors: [required] });
    }
    // A denied research frame took nothing in.
    expect(
      validateCodingWorkbenchRuntimeSseEvent(
        frame({
          eventKind: "research-performed",
          auxiliaryOutcome: "denied",
          contentTrust: "untrusted",
        }),
      ),
    ).toMatchObject({ ok: false, errors: [forbidden] });
    // A skill invocation is not a research read.
    expect(
      validateCodingWorkbenchRuntimeSseEvent(
        frame({
          eventKind: "skill-invoked",
          auxiliaryOutcome: "accepted",
          contentTrust: "untrusted",
        }),
      ),
    ).toMatchObject({ ok: false, errors: [forbidden] });
    // Nor is a status frame.
    expect(
      validateCodingWorkbenchRuntimeSseEvent(frame({ kind: "status", contentTrust: "untrusted" })),
    ).toMatchObject({ ok: false });
  });

  it("carries a bounded #2387 auxiliaryOutcome on a runtime-event frame", () => {
    const event = {
      schemaVersion: "1",
      cursor: "cursor-2",
      sequence: 4,
      occurredAt: AT,
      kind: "runtime-event",
      runId: "run-1",
      state: "running",
      revision: 5,
      eventKind: "child-run-completed",
      auxiliaryOutcome: "limit-reached",
    };
    expect(validateCodingWorkbenchRuntimeSseEvent(event)).toEqual({ ok: true, value: event });
    expect(
      validateCodingWorkbenchRuntimeSseEvent({ ...event, auxiliaryOutcome: "granted" }),
    ).toMatchObject({ ok: false, errors: ["auxiliaryOutcome is invalid"] });
    // auxiliaryOutcome is not part of the status-frame key set.
    expect(
      validateCodingWorkbenchRuntimeSseEvent({
        schemaVersion: "1",
        cursor: "cursor-3",
        sequence: 6,
        occurredAt: AT,
        kind: "status",
        runId: "run-1",
        state: "running",
        revision: 7,
        auxiliaryOutcome: "accepted",
      }),
    ).toMatchObject({ ok: false });
  });

  it("projects a live research grant on the snapshot and revokes it fail-closed", () => {
    const withGrant = {
      schemaVersion: "1",
      state: "running",
      revision: 2,
      updatedAt: AT,
      runId: "run-1",
      researchGrant: {
        grantId: "grant-1",
        domains: ["developer.mozilla.org", "nodejs.org"],
        expiresAt: AT,
      },
    };
    expect(validateCodingWorkbenchRuntimeSnapshot(withGrant)).toEqual({
      ok: true,
      value: withGrant,
    });
    // Empty domains, an IP literal, and a smuggled sub-key all fail closed.
    expect(
      validateCodingWorkbenchRuntimeSnapshot({
        ...withGrant,
        researchGrant: { ...withGrant.researchGrant, domains: [] },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({
        ...withGrant,
        researchGrant: { ...withGrant.researchGrant, domains: ["127.0.0.1"] },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({
        ...withGrant,
        researchGrant: { ...withGrant.researchGrant, queryTextDigest: "x" },
      }),
    ).toMatchObject({ ok: false });

    expect(
      parseCodingWorkbenchRuntimeResearchRevokeRequest({
        requestId: "req-1",
        expectedRevision: 2,
        grantId: "grant-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseCodingWorkbenchRuntimeResearchRevokeRequest({
        requestId: "req-1",
        expectedRevision: -1,
        grantId: "grant-1",
      }),
    ).toMatchObject({
      ok: false,
      errors: ["expectedRevision must be a non-negative safe integer"],
    });
    expect(
      parseCodingWorkbenchRuntimeResearchRevokeRequest({ requestId: "req-1", grantId: "grant-1" }),
    ).toMatchObject({ ok: false });
  });
});
