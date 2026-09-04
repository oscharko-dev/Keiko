import { describe, expect, it } from "vitest";
import { GITHUB_ISSUE_REFERENCE_MAX_CHARS } from "./github-issue-reference.js";
import {
  CODING_WORKBENCH_ISSUE_NUMBER_MAX,
  CODING_WORKBENCH_RUNTIME_APPROVAL_DECISIONS,
  CODING_WORKBENCH_RUNTIME_PREFERENCES,
  CODING_WORKBENCH_RUNTIME_SSE_EVENT_KINDS,
  CODING_WORKBENCH_RUNTIME_UNAVAILABLE_REASONS,
  parseCodingWorkbenchRuntimeApprovalDecisionRequest,
  parseCodingWorkbenchRuntimeReadinessRequest,
  parseCodingWorkbenchRuntimeRecoveryAcknowledgementRequest,
  parseCodingWorkbenchRuntimeResumeRequest,
  parseCodingWorkbenchRuntimeResearchRevokeRequest,
  parseCodingWorkbenchRuntimeRetryRequest,
  parseCodingWorkbenchRuntimeStartRequest,
  parseCodingWorkbenchRuntimeStopRequest,
  parseCodingWorkbenchRuntimeTakeoverRequest,
  validateCodingWorkbenchRuntimeSnapshot,
  validateCodingWorkbenchRuntimeReadiness,
  validateCodingWorkbenchRuntimeSseEvent,
  validateCodingWorkbenchRuntimeStatus,
} from "./coding-workbench-runtime-api.js";

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
        decision: "approved",
        grantScope: "task",
        commandTemplateId: "verify.typecheck",
        safeArgumentClasses: ["frozen-argv"],
      }),
    ).toEqual({
      ok: true,
      value: {
        requestId: "permission-1",
        expectedRevision: 3,
        decision: "approved",
        grantScope: "task",
        commandTemplateId: "verify.typecheck",
        safeArgumentClasses: ["frozen-argv"],
      },
    });
    expect(
      parseCodingWorkbenchRuntimeApprovalDecisionRequest({
        requestId: "permission-1",
        expectedRevision: 3,
        decision: "denied",
        grantScope: "task",
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
    expect(
      parseCodingWorkbenchRuntimeResumeRequest({
        requestId: "request-3",
        requestedMode: "governed-assist",
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseCodingWorkbenchRuntimeResumeRequest({
        requestId: "request-3",
        requestedMode: "unbounded",
      }),
    ).toMatchObject({ ok: false });
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
      runtimeEvidenceClass: "platform-qualified",
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
        runtimeEvidenceClass: "platform-qualified",
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
      runtimeEvidenceClass: "platform-qualified",
    };
    const availableWithoutEvidence = {
      schemaVersion: available.schemaVersion,
      requestedMode: available.requestedMode,
      deploymentCeiling: available.deploymentCeiling,
      effectiveMode: available.effectiveMode,
      runtimeAvailable: available.runtimeAvailable,
    };
    const unavailable = {
      ...availableWithoutEvidence,
      runtimeAvailable: false,
      runtimeUnavailableReason: "payload-missing",
    };
    expect(validateCodingWorkbenchRuntimeReadiness(unavailable)).toEqual({
      ok: true,
      value: unavailable,
    });
    expect(
      validateCodingWorkbenchRuntimeReadiness({
        ...availableWithoutEvidence,
        runtimeAvailable: false,
      }),
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
      requestedMode: "autonomous-delivery",
      effectiveMode: "supervised-coding",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
    };
    expect(validateCodingWorkbenchRuntimeSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(validateCodingWorkbenchRuntimeStatus(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({
        ...snapshot,
        requestedMode: "supervised-coding",
        effectiveMode: "autonomous-delivery",
      }),
    ).toMatchObject({ ok: false });
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

  it("accepts only bounded body-free terminal process summaries", () => {
    const result = {
      status: "failed",
      exitCode: 9,
      output: { byteCount: 12, lineCount: 1, sha256: "a".repeat(64), truncated: false },
      error: { byteCount: 8, lineCount: 1, sha256: "b".repeat(64), truncated: false },
    };
    const snapshot = {
      schemaVersion: "1",
      state: "failed",
      revision: 3,
      updatedAt: AT,
      runId: "run-1",
      requestedMode: "supervised-coding",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      result,
    };

    expect(validateCodingWorkbenchRuntimeSnapshot(snapshot)).toMatchObject({ ok: true });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({
        ...snapshot,
        result: { ...result, output: { ...result.output, body: "hostile-stdout" } },
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCodingWorkbenchRuntimeSnapshot({ ...snapshot, result: { ...result, exitCode: 256 } }),
    ).toMatchObject({ ok: false });
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

describe("Coding Workbench issue binding contract (#3385)", () => {
  const START = {
    requestId: "request-1",
    taskIntent: "Implement the accepted issue",
    requestedMode: "supervised-coding",
  };
  const BINDING = {
    schemaVersion: "1",
    repositoryId: "repository-0123456789abcdef",
    remoteDigest: "a".repeat(64),
    issueNumber: 3385,
    issueIdDigest: "b".repeat(64),
    defaultBaseRef: "dev",
    contentRevisionDigest: "c".repeat(64),
    bindingDigest: "d".repeat(64),
  };
  const SNAPSHOT = {
    schemaVersion: "1",
    state: "running",
    revision: 2,
    updatedAt: AT,
    runId: "run-1",
    requestedMode: "supervised-coding",
    effectiveMode: "supervised-coding",
  };

  // #3385: the start request carries the pasted reference as ONE bounded string. Its meaning —
  // which repository, which issue, whether it exists — is resolved on the server; the contract only
  // admits the transport shape. Whether a request carrying it may START is decided by the runtime
  // orchestrator, which refuses the field outright while no issue resolver is composed
  // (codingRuntimeOrchestrator.test.ts pins that fail-closed admission).
  it("admits a bounded issue reference string on the start and retry requests", () => {
    expect(parseCodingWorkbenchRuntimeStartRequest(START)).toMatchObject({ ok: true });
    for (const issueRef of [
      "https://github.com/oscharko-dev/Keiko/issues/3385",
      "oscharko-dev/Keiko#3385",
      "#3385",
      "3385",
      "a".repeat(GITHUB_ISSUE_REFERENCE_MAX_CHARS),
    ]) {
      const request = { ...START, issueRef };
      expect(parseCodingWorkbenchRuntimeStartRequest(request), issueRef).toEqual({
        ok: true,
        value: request,
      });
      expect(parseCodingWorkbenchRuntimeRetryRequest(request), issueRef).toEqual({
        ok: true,
        value: request,
      });
    }
  });

  // A structured reference is still refused: the browser never authors repository identity or an
  // issue number as separate trusted fields, only the raw text the server parses (the pre-resolver
  // pin, kept). The remaining cases are the transport bounds every other start field already has.
  it("refuses a structured, empty, oversized, or control-character issue reference", () => {
    for (const issueRef of [
      { ownerAndRepo: "oscharko-dev/Keiko", issueNumber: 3385 },
      3385,
      null,
      "",
      "   ",
      "a".repeat(GITHUB_ISSUE_REFERENCE_MAX_CHARS + 1),
      "#3385\u0000",
      "#3385\n",
      "#3385\u007f",
    ]) {
      expect(
        parseCodingWorkbenchRuntimeStartRequest({ ...START, issueRef }),
        JSON.stringify(issueRef),
      ).toMatchObject({ ok: false });
    }
  });

  it("projects a content-free issue binding on the snapshot", () => {
    const snapshot = { ...SNAPSHOT, issueBinding: BINDING };
    expect(validateCodingWorkbenchRuntimeSnapshot(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(validateCodingWorkbenchRuntimeSnapshot(SNAPSHOT)).toMatchObject({ ok: true });
  });

  // Both ends of the accepted issue-number range, so an off-by-one in either bound is caught rather
  // than only the far-side rejection.
  it("accepts both boundaries of the issue-number range", () => {
    for (const issueNumber of [1, CODING_WORKBENCH_ISSUE_NUMBER_MAX]) {
      expect(
        validateCodingWorkbenchRuntimeSnapshot({
          ...SNAPSHOT,
          issueBinding: { ...BINDING, issueNumber },
        }),
        String(issueNumber),
      ).toMatchObject({ ok: true });
    }
  });

  it("refuses to carry issue content on the snapshot projection", () => {
    for (const field of ["title", "body", "comments", "url", "remoteUrl", "issueText"]) {
      expect(
        validateCodingWorkbenchRuntimeSnapshot({
          ...SNAPSHOT,
          issueBinding: { ...BINDING, [field]: "Add a rate limiter to the ingest path" },
        }),
        field,
      ).toMatchObject({ ok: false });
    }
  });

  it("rejects a malformed issue binding field by field", () => {
    const rejected: readonly Record<string, unknown>[] = [
      { schemaVersion: "2" },
      { repositoryId: "" },
      { repositoryId: "../escape" },
      { remoteDigest: "not-a-digest" },
      { remoteDigest: "A".repeat(64) },
      { issueIdDigest: "b".repeat(63) },
      { contentRevisionDigest: 42 },
      { bindingDigest: undefined },
      { issueNumber: 0 },
      { issueNumber: 2.5 },
      // The far side of the range. Without this, deleting the upper bound from `isBoundedIssueNumber`
      // left every case green: `0` pins the lower bound and accepting MAX pins that MAX is allowed,
      // but neither notices that anything above it is allowed too.
      { issueNumber: CODING_WORKBENCH_ISSUE_NUMBER_MAX + 1 },
      { defaultBaseRef: "" },
      { defaultBaseRef: "/dev" },
      { defaultBaseRef: "feature//x" },
      { defaultBaseRef: "feature/../x" },
      { defaultBaseRef: "dev.lock" },
      { defaultBaseRef: "dev branch" },
      // Refs git itself refuses that a weaker second formula used to accept.
      { defaultBaseRef: "dev/" },
      { defaultBaseRef: "dev." },
      { defaultBaseRef: ".hidden" },
      { defaultBaseRef: "feature/.hidden" },
      { defaultBaseRef: "-dev" },
      { defaultBaseRef: "dev@{0}" },
      { defaultBaseRef: "dev~1" },
      { defaultBaseRef: "dev^" },
      { defaultBaseRef: "dev:x" },
      { defaultBaseRef: "dev?" },
      { defaultBaseRef: "dev*" },
      { defaultBaseRef: "a".repeat(256) },
    ];
    for (const override of rejected) {
      expect(
        validateCodingWorkbenchRuntimeSnapshot({
          ...SNAPSHOT,
          issueBinding: { ...BINDING, ...override },
        }),
        JSON.stringify(override),
      ).toMatchObject({ ok: false });
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
        runtimeEvidenceClass: "platform-qualified",
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

  it("keeps live research grants structurally off the content-free runtime snapshot", () => {
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
    expect(validateCodingWorkbenchRuntimeSnapshot(withGrant)).toMatchObject({ ok: false });

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
