import { describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_READINESS_REASONS,
  ACTIVITY_LOG_READINESS_STATES,
  ACTIVITY_LOG_WRITER_KINDS,
  CLIENT_BINDING_CANDIDATES_MAX,
  CLIENT_BINDING_FAILURE_OUTCOMES,
  CLIENT_BINDING_OUTCOMES,
  CLIENT_BINDING_REFERENCE_SHAPES,
  CLIENT_BINDING_RELATED_CORRELATIONS_MAX,
  CLIENT_BINDING_DECIDING_LOADS_MAX,
  CLIENT_GIT_CLIENT_OPERATION_FAILURE_OUTCOMES,
  CLIENT_GIT_CLIENT_OPERATION_KINDS,
  CLIENT_GIT_CLIENT_OPERATION_OUTCOMES,
  CLIENT_SESSION_REPAIR_OUTCOMES,
  CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES,
  CLIENT_SESSION_REPAIR_STREAMS,
  CLIENT_SELECT_DISMISSAL_FOCUS_LOCATIONS,
  CLIENT_SELECT_DISMISSAL_REASONS,
  CLIENT_DIAGNOSTIC_KINDS,
  CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS,
  CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX,
  CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  CLIENT_DIAGNOSTIC_READY_STATES,
  CLIENT_STAGE_DURATION_MS_MAX,
  CLIENT_STAGE_IDS,
  CLIENT_STAGE_ORDINAL_MAX,
  CLIENT_VOICE_DIALOGUE_STAGES,
  CLIENT_VOICE_CAPTURE_REASONS,
  CLIENT_VOICE_CAPTURE_ERRORS,
  LINUX_GATEWAY_DIAGNOSTIC_KINDS,
  isActivityLogReadinessSnapshot,
  isClientBindingIngestRequest,
  isClientDiagnosticIngestRequest,
  isClientGitRetryAttemptIngestRequest,
  isClientSessionRepairIngestRequest,
  isClientDiagnosticKind,
  isClientDiagnosticLossCount,
  isClientStageIngestRequest,
  isLinuxGatewayDiagnosticKind,
  CLIENT_ERROR_CLASSES,
  clientErrorClass,
} from "./diagnostics.js";

function validRequest(): Record<string, unknown> {
  return {
    message: "boundary caught TypeError",
    clientTs: "2026-08-21T10:00:00.000Z",
  };
}

describe("Linux gateway diagnostic contract", () => {
  it("accepts every closed kind and rejects extensions or non-strings", () => {
    for (const kind of LINUX_GATEWAY_DIAGNOSTIC_KINDS) {
      expect(isLinuxGatewayDiagnosticKind(kind)).toBe(true);
    }
    expect(isLinuxGatewayDiagnosticKind("")).toBe(false);
    expect(isLinuxGatewayDiagnosticKind("host-relay-failed:private-detail")).toBe(false);
    expect(isLinuxGatewayDiagnosticKind({ kind: "host-relay-failed" })).toBe(false);
  });
});

describe("isClientDiagnosticIngestRequest", () => {
  it("accepts the minimal required shape", () => {
    expect(isClientDiagnosticIngestRequest(validRequest())).toBe(true);
  });

  it("accepts every optional field populated with an in-range value", () => {
    for (const readyState of CLIENT_DIAGNOSTIC_READY_STATES) {
      for (const kind of CLIENT_DIAGNOSTIC_KINDS) {
        expect(
          isClientDiagnosticIngestRequest({
            ...validRequest(),
            readyState,
            correlationId: "abcdefgh",
            kind,
            ...(kind === "voice-dialogue" ? { voiceDialogueStage: "started" } : {}),
          }),
        ).toBe(true);
      }
    }
  });

  it("requires a closed stage for voice dialogue and rejects unrelated stage injection", () => {
    for (const voiceDialogueStage of CLIENT_VOICE_DIALOGUE_STAGES) {
      expect(
        isClientDiagnosticIngestRequest({
          ...validRequest(),
          kind: "voice-dialogue",
          voiceDialogueStage,
        }),
      ).toBe(true);
    }
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), kind: "voice-dialogue" })).toBe(
      false,
    );
    expect(
      isClientDiagnosticIngestRequest({
        ...validRequest(),
        kind: "voice-dialogue",
        voiceDialogueStage: "private user text",
      }),
    ).toBe(false);
    expect(
      isClientDiagnosticIngestRequest({
        ...validRequest(),
        kind: "other",
        voiceDialogueStage: "turn-submitted",
      }),
    ).toBe(false);
  });

  it("rejects a non-object value", () => {
    expect(isClientDiagnosticIngestRequest(null)).toBe(false);
    expect(isClientDiagnosticIngestRequest(undefined)).toBe(false);
    expect(isClientDiagnosticIngestRequest("a string")).toBe(false);
    expect(isClientDiagnosticIngestRequest(["array"])).toBe(false);
  });

  it("rejects a missing or non-string message", () => {
    expect(isClientDiagnosticIngestRequest({ clientTs: validRequest().clientTs })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: 42 })).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: "" })).toBe(false);
  });

  it(`rejects a message over ${String(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)} characters`, () => {
    const tooLong = "a".repeat(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH + 1);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: tooLong })).toBe(false);
  });

  it(`accepts a message at exactly ${String(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH)} characters`, () => {
    const atLimit = "a".repeat(CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), message: atLimit })).toBe(true);
  });

  it("rejects a missing or malformed clientTs", () => {
    expect(isClientDiagnosticIngestRequest({ message: validRequest().message })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "not-a-date" })).toBe(
      false,
    );
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-08-21" })).toBe(
      false,
    );
  });

  // `Date.parse` silently normalizes a calendar-invalid instant instead of rejecting it (e.g.
  // `2026-02-30T10:00:00.000Z` becomes `2026-03-02T10:00:00.000Z`), so a shape-only regex plus
  // `!Number.isNaN(Date.parse(...))` accepts a date that never happened on the calendar.
  it("rejects a calendar-invalid clientTs that Date.parse would silently normalize", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-02-30T10:00:00.000Z" }),
    ).toBe(false);
    // April has 30 days; the 31st does not exist.
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-04-31T00:00:00Z" }),
    ).toBe(false);
    // Hour 24 does not exist as a clock value.
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2026-08-21T24:00:00Z" }),
    ).toBe(false);
    // The last valid day of February in a non-leap year.
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), clientTs: "2027-02-28T00:00:00Z" }),
    ).toBe(true);
  });

  it("rejects a readyState outside the closed 0|1|2 vocabulary", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), readyState: 3 })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), readyState: "1" })).toBe(false);
  });

  it("rejects a kind outside the closed vocabulary", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), kind: "crash" })).toBe(false);
  });

  // #3557 review: a failure the page classified keeps its closed class, e.g. a refused connection.
  it("accepts a classified error kind from the closed vocabulary and refuses any other", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), errorKind: "unavailable" })).toBe(
      true,
    );
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), errorKind: "exploded" })).toBe(
      false,
    );
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), errorKind: 503 })).toBe(false);
  });

  it("rejects a correlationId that is empty or over the bounded length", () => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "" })).toBe(false);
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "a".repeat(129) }),
    ).toBe(false);
  });

  it("accepts only a complete body-free git-change description response identity", () => {
    const gitChangeDescription = {
      action: "apply",
      disposition: "discarded",
      relationshipId: "rel-1",
      snapshotDigest: "a".repeat(64),
      proposalId: "prop-1",
      outcome: "observed",
    };
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), gitChangeDescription })).toBe(true);
    for (const invalid of [
      { ...gitChangeDescription, action: "write" },
      { ...gitChangeDescription, disposition: "ignored" },
      { ...gitChangeDescription, relationshipId: "/customer/repository" },
      { ...gitChangeDescription, snapshotDigest: "a".repeat(63) },
      { ...gitChangeDescription, proposalId: "contains spaces" },
      { ...gitChangeDescription, outcome: "body" },
    ]) {
      expect(
        isClientDiagnosticIngestRequest({ ...validRequest(), gitChangeDescription: invalid }),
      ).toBe(false);
    }
  });

  it("accepts only a complete body-free workspace trust binding", () => {
    const workspaceTrustBinding = {
      repositoryId: "repository-a",
      workspaceId: "workspace-a",
    };
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), workspaceTrustBinding })).toBe(
      true,
    );
    for (const invalid of [
      { ...workspaceTrustBinding, repositoryId: "/customer/repository" },
      { ...workspaceTrustBinding, workspaceId: "contains spaces" },
      { repositoryId: workspaceTrustBinding.repositoryId },
    ]) {
      expect(
        isClientDiagnosticIngestRequest({ ...validRequest(), workspaceTrustBinding: invalid }),
      ).toBe(false);
    }
  });

  // PR #3625 review: a Git-client operation settling after its own surface (an add-repository
  // dialog, a manual retry panel) is already gone. The two families — a discarded add-repository
  // result, a retried read — never mix: an operation from one family can never carry the other
  // family's outcome.
  it("accepts only a git-client operation whose outcome matches its operation's family", () => {
    const discardedClone = { operation: "repository-clone", outcome: "discarded-succeeded" };
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), gitClientOperation: discardedClone }),
    ).toBe(true);
    const recoveredRetry = { operation: "status-read", outcome: "retry-recovered" };
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), gitClientOperation: recoveredRetry }),
    ).toBe(true);
    for (const invalid of [
      { operation: "write-file", outcome: "discarded-succeeded" },
      { operation: "repository-clone", outcome: "exploded" },
      { operation: "repository-register", outcome: "retry-failed" },
      { operation: "status-read", outcome: "discarded-failed" },
      { operation: "branches-read", outcome: "discarded-succeeded" },
      { operation: "repository-clone" },
      { outcome: "discarded-succeeded" },
    ]) {
      expect(
        isClientDiagnosticIngestRequest({ ...validRequest(), gitClientOperation: invalid }),
      ).toBe(false);
    }
  });

  // This guard only asserts wire SHAPE (AGENTS.md: "reuse first" — the leaf must not duplicate
  // `correlation.ts`'s alphabet policy). A shape-conforming but semantically invalid id is the
  // server route's job to reject via `isValidCorrelationId`, never this guard's.
  it("accepts a correlationId shape that a stricter server-side policy would still reject", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "not valid!!" }),
    ).toBe(true);
  });

  // PR #3625 review (GitClientWindow.tsx finding): the closed unavailable reason is evidence for a
  // resolved-unavailable retry failure only — never a discard, and never a recovered or superseded
  // retry — so a reason on any other outcome must refuse the whole report, fail-closed.
  it("accepts the closed unavailable reason only alongside retry-failed", () => {
    const retryFailedWithReason = {
      operation: "status-read",
      outcome: "retry-failed",
      reason: "git-error",
    };
    expect(
      isClientDiagnosticIngestRequest({
        ...validRequest(),
        gitClientOperation: retryFailedWithReason,
      }),
    ).toBe(true);
    for (const invalid of [
      { operation: "status-read", outcome: "retry-recovered", reason: "git-error" },
      { operation: "status-read", outcome: "retry-superseded", reason: "git-error" },
      { operation: "repository-clone", outcome: "discarded-failed", reason: "git-error" },
      { operation: "status-read", outcome: "retry-failed", reason: "not-a-real-reason" },
      { operation: "status-read", outcome: "retry-failed", reason: 7 },
    ]) {
      expect(
        isClientDiagnosticIngestRequest({ ...validRequest(), gitClientOperation: invalid }),
      ).toBe(false);
    }
  });

  // PR #3625 review (KeikoSelect.tsx finding): an open menu consumes Escape wherever focus sits, and
  // this closed pair is the only evidence of which surface actually closed — never a label or an
  // option's text.
  it("accepts only a closed select dismissal: a known reason paired with a known focus location", () => {
    for (const reason of CLIENT_SELECT_DISMISSAL_REASONS) {
      for (const focus of CLIENT_SELECT_DISMISSAL_FOCUS_LOCATIONS) {
        expect(
          isClientDiagnosticIngestRequest({
            ...validRequest(),
            selectDismissal: { reason, focus },
          }),
        ).toBe(true);
      }
    }
    for (const invalid of [
      { reason: "outside-click", focus: "trigger" },
      { reason: "escape", focus: "menu" },
      { reason: "escape" },
      { focus: "trigger" },
      { reason: "escape", focus: "trigger", label: "Model only" },
    ]) {
      expect(isClientDiagnosticIngestRequest({ ...validRequest(), selectDismissal: invalid })).toBe(
        false,
      );
    }
  });
});

// KEIKO-3557: routine desktop-window stage evidence (`useWindowStageEvidence`) rides this closed,
// free-text-free shape instead of the failure-shaped message report above.
describe("isClientStageIngestRequest", () => {
  function startedRequest(): Record<string, unknown> {
    return { kind: "stage", stage: "chat bind", phase: "started", ordinal: 1 };
  }

  function settledRequest(): Record<string, unknown> {
    return { kind: "stage", stage: "chat bind", phase: "settled", ordinal: 1, durationMs: 5 };
  }

  it("accepts a well-formed started report for every closed stage id", () => {
    for (const stage of CLIENT_STAGE_IDS) {
      expect(isClientStageIngestRequest({ ...startedRequest(), stage })).toBe(true);
    }
  });

  it("accepts a well-formed settled report, including a genuinely instant 0ms settle", () => {
    expect(isClientStageIngestRequest(settledRequest())).toBe(true);
    expect(isClientStageIngestRequest({ ...settledRequest(), durationMs: 0 })).toBe(true);
  });

  it("rejects a non-object value and a value whose kind is not the stage literal", () => {
    expect(isClientStageIngestRequest(null)).toBe(false);
    expect(isClientStageIngestRequest(undefined)).toBe(false);
    expect(isClientStageIngestRequest("a string")).toBe(false);
    expect(isClientStageIngestRequest(["array"])).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), kind: "boundary" })).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), kind: undefined })).toBe(false);
  });

  it("rejects a stage outside the closed vocabulary", () => {
    expect(isClientStageIngestRequest({ ...startedRequest(), stage: "unknown stage" })).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), stage: "" })).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), stage: 1 })).toBe(false);
  });

  it("rejects a phase outside the closed started|settled vocabulary", () => {
    expect(isClientStageIngestRequest({ ...startedRequest(), phase: "pending" })).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), phase: "STARTED" })).toBe(false);
  });

  it("rejects an out-of-range or non-integer ordinal", () => {
    expect(isClientStageIngestRequest({ ...startedRequest(), ordinal: 0 })).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), ordinal: -1 })).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), ordinal: 1.5 })).toBe(false);
    expect(
      isClientStageIngestRequest({ ...startedRequest(), ordinal: CLIENT_STAGE_ORDINAL_MAX + 1 }),
    ).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), ordinal: "1" })).toBe(false);
    expect(
      isClientStageIngestRequest({ ...startedRequest(), ordinal: CLIENT_STAGE_ORDINAL_MAX }),
    ).toBe(true);
  });

  it("rejects an out-of-range or non-integer durationMs on a settled report", () => {
    expect(isClientStageIngestRequest({ ...settledRequest(), durationMs: -1 })).toBe(false);
    expect(isClientStageIngestRequest({ ...settledRequest(), durationMs: 1.5 })).toBe(false);
    expect(
      isClientStageIngestRequest({
        ...settledRequest(),
        durationMs: CLIENT_STAGE_DURATION_MS_MAX + 1,
      }),
    ).toBe(false);
    expect(
      isClientStageIngestRequest({ ...settledRequest(), durationMs: CLIENT_STAGE_DURATION_MS_MAX }),
    ).toBe(true);
  });

  it("rejects a settled report with a missing durationMs, and a started report carrying one", () => {
    const { durationMs: _durationMs, ...settledWithoutDuration } = settledRequest();
    expect(isClientStageIngestRequest(settledWithoutDuration)).toBe(false);
    expect(isClientStageIngestRequest({ ...startedRequest(), durationMs: 5 })).toBe(false);
  });

  it("refuses the whole report for an unknown extra field", () => {
    expect(isClientStageIngestRequest({ ...startedRequest(), extra: "value" })).toBe(false);
    expect(isClientStageIngestRequest({ ...settledRequest(), message: "not allowed" })).toBe(false);
  });
});

// #3532: the browser reports its own delivery loss as bounded counts, never content. The block is
// closed on both axes, so the server never decides which part of a malformed block to believe.
describe("client diagnostic loss counts", () => {
  it("accepts every closed key at both ends of its range, and an explicit undefined", () => {
    for (const key of CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS) {
      for (const count of [0, CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX, undefined]) {
        expect(isClientDiagnosticIngestRequest({ ...validRequest(), loss: { [key]: count } })).toBe(
          true,
        );
      }
    }
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), loss: {} })).toBe(true);
  });

  it.each([
    ["an unknown key", { droppedSecrets: 1 }],
    ["a count above the ceiling", { bufferEvicted: CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX + 1 }],
    ["a negative count", { postsFailed: -1 }],
    ["a fractional count", { postsThrottled: 1.5 }],
    ["a numeric string", { errorsSuppressed: "3" }],
    ["a non-object block", 3],
    ["a null block", null],
  ])("refuses the whole report for %s", (_label, loss) => {
    expect(isClientDiagnosticIngestRequest({ ...validRequest(), loss })).toBe(false);
  });

  it("bounds a single count by the same ceiling", () => {
    expect(isClientDiagnosticLossCount(0)).toBe(true);
    expect(isClientDiagnosticLossCount(CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX)).toBe(true);
    expect(isClientDiagnosticLossCount(CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX + 1)).toBe(false);
    expect(isClientDiagnosticLossCount(Number.NaN)).toBe(false);
  });
});

// #3532: the readiness `/api/health` reports and `keiko status` prints.
describe("isActivityLogReadinessSnapshot", () => {
  const ready = { readiness: "ready", reasons: [], writer: "production-file", lostEvents: 0 };

  it("accepts every closed state, reason and writer in a coherent combination", () => {
    for (const writer of ACTIVITY_LOG_WRITER_KINDS) {
      expect(isActivityLogReadinessSnapshot({ ...ready, writer })).toBe(true);
    }
    for (const readiness of ACTIVITY_LOG_READINESS_STATES.filter((state) => state !== "ready")) {
      for (const reason of ACTIVITY_LOG_READINESS_REASONS) {
        expect(isActivityLogReadinessSnapshot({ ...ready, readiness, reasons: [reason] })).toBe(
          true,
        );
      }
    }
    expect(
      isActivityLogReadinessSnapshot({
        ...ready,
        readiness: "unavailable",
        reasons: [...ACTIVITY_LOG_READINESS_REASONS],
        lostEvents: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);
  });

  it.each([
    ["a non-object", "ready"],
    ["an unknown state", { ...ready, readiness: "fine" }],
    ["an unknown reason", { ...ready, readiness: "degraded", reasons: ["disk-on-fire"] }],
    [
      "a repeated reason",
      { ...ready, readiness: "degraded", reasons: ["level-silent", "level-silent"] },
    ],
    ["a failed state without a reason", { ...ready, readiness: "unavailable" }],
    ["a ready state that names a reason", { ...ready, reasons: ["level-silent"] }],
    ["an unknown writer", { ...ready, writer: "stdout" }],
    ["a negative lost-event count", { ...ready, lostEvents: -1 }],
    ["a fractional lost-event count", { ...ready, lostEvents: 0.5 }],
  ])("refuses %s", (_label, value) => {
    expect(isActivityLogReadinessSnapshot(value)).toBe(false);
  });
});

describe("isClientDiagnosticKind", () => {
  it("accepts every declared kind", () => {
    for (const kind of CLIENT_DIAGNOSTIC_KINDS) {
      expect(isClientDiagnosticKind(kind)).toBe(true);
    }
  });

  it("rejects a value outside the closed vocabulary", () => {
    expect(isClientDiagnosticKind("crash")).toBe(false);
    expect(isClientDiagnosticKind(1)).toBe(false);
  });
});

// Review on PR #3452: the closed error-class vocabulary a client note may carry.
describe("clientErrorClass", () => {
  it("keeps a known error class and the type of a thrown non-Error", () => {
    const api = new Error("x");
    api.name = "ApiError";
    expect(clientErrorClass(new TypeError("/Users/alice/.env could not be read"))).toBe(
      "TypeError",
    );
    expect(clientErrorClass(api)).toBe("ApiError");
    expect(clientErrorClass("token=sk-secret")).toBe("string");
    expect(clientErrorClass(null)).toBe("object");
    expect(clientErrorClass(undefined)).toBe("undefined");
  });

  it("reports any other error name as Error, so a name never carries content", () => {
    const hostile = new Error("x");
    hostile.name = "AliceSmithPassword";
    const blank = new Error("x");
    blank.name = "  ";
    expect(clientErrorClass(hostile)).toBe("Error");
    expect(clientErrorClass(blank)).toBe("Error");
  });

  // The activity log captures a class as `\w{1,64}` before it looks the name up.
  it("holds only bounded word-shaped names", () => {
    for (const name of CLIENT_ERROR_CLASSES) expect(name).toMatch(/^\w{1,64}$/u);
  });
});

// #3557 review: a restored window's binding outcome rides a closed report of its own, so a
// reference lost at persistence and a target that is really gone stay distinguishable.
describe("isClientBindingIngestRequest", () => {
  function bindingRequest(): Record<string, unknown> {
    return {
      kind: "binding",
      surface: "chat-window",
      outcome: "target-missing",
      referenceShape: "redacted",
      heuristicFlagged: false,
      windowRef: "chat-mfr3k2x1-2",
    };
  }

  // A redaction marker never resolved to a live chat, only a redaction marker offers chats, and a
  // person decides only about a chat the window found again after redaction.
  function possibleBinding(outcome: string, referenceShape: string): boolean {
    if (outcome === "resolved") return referenceShape !== "redacted";
    if (outcome === "candidates-offered") return referenceShape === "redacted";
    if (outcome === "target-missing") return true;
    return referenceShape === "fingerprint" || referenceShape === "user-selected";
  }

  // The fields an outcome always carries.
  function outcomeFields(outcome: string): Record<string, unknown> {
    if (outcome === "candidates-offered") return { candidateCount: 1, disambiguatedCount: 0 };
    if (outcome.startsWith("choice-")) return { targetFingerprint: "c".repeat(64) };
    return {};
  }

  it("accepts every possible outcome and reference shape, with and without correlation ids", () => {
    for (const outcome of CLIENT_BINDING_OUTCOMES) {
      for (const referenceShape of CLIENT_BINDING_REFERENCE_SHAPES) {
        if (!possibleBinding(outcome, referenceShape)) continue;
        expect(
          isClientBindingIngestRequest({
            ...bindingRequest(),
            outcome,
            referenceShape,
            ...outcomeFields(outcome),
          }),
        ).toBe(true);
      }
    }
    expect(
      isClientBindingIngestRequest({
        ...bindingRequest(),
        correlationId: "ui_list-load-0001",
        relatedCorrelationIds: ["ui_list-load-0002", "ui_list-load-0003"],
      }),
    ).toBe(true);
  });

  // #3557 review: a redaction marker can never have resolved to a live chat.
  it("refuses a resolved outcome for a redacted reference", () => {
    expect(
      isClientBindingIngestRequest({
        ...bindingRequest(),
        outcome: "resolved",
        referenceShape: "redacted",
      }),
    ).toBe(false);
  });

  // #3557 review: a chat restored through its id's fingerprint resolved, and its id was flagged.
  it("accepts a resolved, flagged binding restored through a fingerprint", () => {
    expect(
      isClientBindingIngestRequest({
        ...bindingRequest(),
        outcome: "resolved",
        referenceShape: "fingerprint",
        heuristicFlagged: true,
      }),
    ).toBe(true);
  });

  // #3557 review: a window whose redacted id carries no fingerprint binds only to the chat the
  // person chose; that chat's id was flagged.
  it("accepts a resolved, flagged binding the person chose", () => {
    expect(
      isClientBindingIngestRequest({
        ...bindingRequest(),
        outcome: "resolved",
        referenceShape: "user-selected",
        heuristicFlagged: true,
      }),
    ).toBe(true);
  });

  // #3557 review: a window whose redacted id carries no fingerprint says how many chats it offered,
  // zero included. Nothing else carries a count, and only a redaction marker offers.
  it("accepts an offer only with its candidate count, zero included, from a redaction marker", () => {
    const offer = { ...bindingRequest(), outcome: "candidates-offered", disambiguatedCount: 0 };
    for (const candidateCount of [0, 2, CLIENT_BINDING_CANDIDATES_MAX]) {
      expect(isClientBindingIngestRequest({ ...offer, candidateCount })).toBe(true);
    }
    for (const candidateCount of [undefined, -1, 1.5, "2", CLIENT_BINDING_CANDIDATES_MAX + 1]) {
      expect(isClientBindingIngestRequest({ ...offer, candidateCount })).toBe(false);
    }
    for (const referenceShape of CLIENT_BINDING_REFERENCE_SHAPES) {
      if (referenceShape === "redacted") continue;
      expect(isClientBindingIngestRequest({ ...offer, referenceShape, candidateCount: 1 })).toBe(
        false,
      );
    }
    for (const outcome of ["resolved", "target-missing"]) {
      for (const counts of [{ candidateCount: 1 }, { disambiguatedCount: 0 }]) {
        expect(
          isClientBindingIngestRequest({
            ...bindingRequest(),
            outcome,
            referenceShape: "uuid",
            ...counts,
          }),
        ).toBe(false);
      }
    }
  });

  // #3557 review: an offer also says how many of its offers read alike and show a fingerprint
  // reference, zero included, and never more than it offered.
  it("accepts an offer's disambiguation count only up to its candidate count", () => {
    const offer = { ...bindingRequest(), outcome: "candidates-offered", candidateCount: 3 };
    for (const disambiguatedCount of [0, 2, 3]) {
      expect(isClientBindingIngestRequest({ ...offer, disambiguatedCount })).toBe(true);
    }
    for (const disambiguatedCount of [undefined, -1, 1.5, "2", 4]) {
      expect(isClientBindingIngestRequest({ ...offer, disambiguatedCount })).toBe(false);
    }
  });

  // #3557 review: a chat the person chose stays a choice until they keep it or withdraw it; each
  // decision names that chat by its fingerprint, and only a binding found again after redaction
  // can be decided about.
  it("accepts a choice decision only with the chosen chat's fingerprint, for a restored binding", () => {
    const targetFingerprint = "c".repeat(64);
    for (const outcome of ["choice-kept", "choice-withdrawn"]) {
      const decision = { ...bindingRequest(), outcome, heuristicFlagged: true };
      for (const referenceShape of ["fingerprint", "user-selected"]) {
        expect(
          isClientBindingIngestRequest({ ...decision, referenceShape, targetFingerprint }),
        ).toBe(true);
        expect(isClientBindingIngestRequest({ ...decision, referenceShape })).toBe(false);
      }
      for (const referenceShape of ["uuid", "opaque", "redacted"]) {
        expect(
          isClientBindingIngestRequest({
            ...decision,
            referenceShape,
            heuristicFlagged: false,
            targetFingerprint,
          }),
        ).toBe(false);
      }
    }
  });

  // #3557 review: a binding found again after redaction names the chat it bound to, only by the
  // fingerprint the window persists and never by its id, so two choices from one list stay apart.
  it("accepts a target fingerprint only on a binding found again after redaction", () => {
    const targetFingerprint = "c".repeat(64);
    const restored = { ...bindingRequest(), outcome: "resolved", heuristicFlagged: true };
    for (const referenceShape of ["fingerprint", "user-selected"]) {
      for (const outcome of ["resolved", "target-missing"]) {
        expect(
          isClientBindingIngestRequest({ ...restored, outcome, referenceShape, targetFingerprint }),
        ).toBe(true);
      }
    }
    for (const patch of [
      { outcome: "resolved", referenceShape: "uuid" },
      { outcome: "resolved", referenceShape: "opaque", heuristicFlagged: false },
      { outcome: "target-missing", referenceShape: "redacted", heuristicFlagged: false },
      {
        outcome: "candidates-offered",
        referenceShape: "redacted",
        candidateCount: 1,
        disambiguatedCount: 0,
      },
    ]) {
      expect(isClientBindingIngestRequest({ ...restored, ...patch, targetFingerprint })).toBe(
        false,
      );
    }
    for (const malformed of [
      "1404206d-9ab6-4bca-8853-813867352087",
      "c".repeat(63),
      "C".repeat(64),
      7,
    ]) {
      expect(
        isClientBindingIngestRequest({
          ...restored,
          referenceShape: "fingerprint",
          targetFingerprint: malformed,
        }),
      ).toBe(false);
    }
  });

  it("accepts a heuristic flag only for a server-issued UUID", () => {
    expect(
      isClientBindingIngestRequest({
        ...bindingRequest(),
        outcome: "resolved",
        referenceShape: "uuid",
        heuristicFlagged: true,
      }),
    ).toBe(true);
    for (const referenceShape of ["opaque", "redacted"]) {
      expect(
        isClientBindingIngestRequest({
          ...bindingRequest(),
          referenceShape,
          heuristicFlagged: true,
        }),
      ).toBe(false);
    }
  });

  // #3557 review: the window's own id reaches the server whole (it logs only its digest), so two
  // windows can never share one; it is held to the shape persistence restores.
  it("accepts a window reference up to its bound in the safe alphabet", () => {
    for (const windowRef of ["files", "chat-mfr3k2x1-2", "w".repeat(128), "a.b_c-1"]) {
      expect(isClientBindingIngestRequest({ ...bindingRequest(), windowRef })).toBe(true);
    }
  });

  it("bounds the related correlation ids and the deciding load count", () => {
    for (const decidingLoadCount of [1, CLIENT_BINDING_DECIDING_LOADS_MAX]) {
      expect(isClientBindingIngestRequest({ ...bindingRequest(), decidingLoadCount })).toBe(true);
    }
    for (const decidingLoadCount of [0, CLIENT_BINDING_DECIDING_LOADS_MAX + 1, 1.5, "17"]) {
      expect(isClientBindingIngestRequest({ ...bindingRequest(), decidingLoadCount })).toBe(false);
    }
    const related = Array.from(
      { length: CLIENT_BINDING_RELATED_CORRELATIONS_MAX },
      (_value, index) => `ui_list-load-${String(index).padStart(4, "0")}`,
    );
    expect(
      isClientBindingIngestRequest({ ...bindingRequest(), relatedCorrelationIds: related }),
    ).toBe(true);
    expect(
      isClientBindingIngestRequest({
        ...bindingRequest(),
        relatedCorrelationIds: [...related, "ui_list-load-9999"],
      }),
    ).toBe(false);
  });

  it.each([
    ["a non-object", "binding"],
    ["another kind", { kind: "stage" }],
    ["an unknown surface", { surface: "files-window" }],
    ["an unknown outcome", { outcome: "restored" }],
    ["an unknown reference shape", { referenceShape: "chat-123" }],
    ["a non-boolean heuristic flag", { heuristicFlagged: "false" }],
    ["a missing heuristic flag", { heuristicFlagged: undefined }],
    ["a missing window reference", { windowRef: undefined }],
    ["an empty window reference", { windowRef: "" }],
    ["an oversized window reference", { windowRef: "w".repeat(129) }],
    ["a window reference outside the safe alphabet", { windowRef: "chat 1" }],
    ["a window reference joining two window ids", { windowRef: "files-1~chat-1" }],
    ["a non-string window reference", { windowRef: 7 }],
    ["a browser digest instead of the reference", { windowDigest: "a".repeat(64) }],
    ["an oversized correlation id", { correlationId: "c".repeat(129) }],
    ["a related id that is not a string", { relatedCorrelationIds: [7] }],
    ["related ids that are not a list", { relatedCorrelationIds: "ui_list-load-0001" }],
    ["an undeclared field", { chatId: "chat-123" }],
  ])("refuses %s", (_label, patch) => {
    const value = typeof patch === "string" ? patch : { ...bindingRequest(), ...patch };
    expect(isClientBindingIngestRequest(value)).toBe(false);
  });
});

// #3557 review: the browser and the server budget their reports by one rule. Only a missing target
// is a binding failure (an offer and a person's decisions are routine), and only a recovery is a
// routine session repair.
describe("client report budgets", () => {
  it("classifies exactly the missing target as a binding failure", () => {
    expect(
      CLIENT_BINDING_OUTCOMES.filter((outcome) => CLIENT_BINDING_FAILURE_OUTCOMES.has(outcome)),
    ).toEqual(["target-missing"]);
  });

  it("classifies exactly the recoveries as routine session repairs", () => {
    expect(
      CLIENT_SESSION_REPAIR_OUTCOMES.filter((outcome) =>
        CLIENT_SESSION_REPAIR_ROUTINE_OUTCOMES.has(outcome),
      ),
    ).toEqual(["replayed", "stream-repaired", "repair-acknowledged"]);
  });

  it("classifies exactly the discarded-failed and retry-failed outcomes as git-client failures", () => {
    expect(
      CLIENT_GIT_CLIENT_OPERATION_OUTCOMES.filter((outcome) =>
        CLIENT_GIT_CLIENT_OPERATION_FAILURE_OUTCOMES.has(outcome),
      ),
    ).toEqual(["discarded-failed", "retry-failed"]);
  });

  // PR #3625 review: a retry superseded by a newer automatic read is discarded evidence, never a
  // failure of the read itself — it must spend the routine budget alongside a recovery, exactly
  // like a discarded-succeeded add-repository result.
  it("classifies retry-superseded as routine, not a git-client failure", () => {
    expect(CLIENT_GIT_CLIENT_OPERATION_FAILURE_OUTCOMES.has("retry-superseded")).toBe(false);
    expect(CLIENT_GIT_CLIENT_OPERATION_OUTCOMES).toContain("retry-superseded");
  });
});

describe("git-client operation settlement vocabulary", () => {
  it("accepts every operation paired with every outcome from its own family", () => {
    const discardOperations = CLIENT_GIT_CLIENT_OPERATION_KINDS.filter((operation) =>
      operation.startsWith("repository-"),
    );
    const retryOperations = CLIENT_GIT_CLIENT_OPERATION_KINDS.filter(
      (operation) => !operation.startsWith("repository-"),
    );
    const discardOutcomes = CLIENT_GIT_CLIENT_OPERATION_OUTCOMES.filter((outcome) =>
      outcome.startsWith("discarded-"),
    );
    const retryOutcomes = CLIENT_GIT_CLIENT_OPERATION_OUTCOMES.filter((outcome) =>
      outcome.startsWith("retry-"),
    );
    for (const operation of discardOperations) {
      for (const outcome of discardOutcomes) {
        expect(
          isClientDiagnosticIngestRequest({
            ...validRequest(),
            gitClientOperation: { operation, outcome },
          }),
        ).toBe(true);
      }
    }
    for (const operation of retryOperations) {
      for (const outcome of retryOutcomes) {
        expect(
          isClientDiagnosticIngestRequest({
            ...validRequest(),
            gitClientOperation: { operation, outcome },
          }),
        ).toBe(true);
      }
    }
  });
});

// PR #3625 review: a manual retry's attempt line mints its own correlation id up front so a later
// supersession is still joinable to it, mirroring the stage lifecycle's own correlation contract.
describe("isClientGitRetryAttemptIngestRequest", () => {
  function attemptRequest(): Record<string, unknown> {
    return { kind: "git-retry-attempt", operation: "status-read", correlationId: "ui_retry-0001" };
  }

  it("accepts a well-formed retry attempt", () => {
    expect(isClientGitRetryAttemptIngestRequest(attemptRequest())).toBe(true);
  });

  it("accepts every retriable read operation and refuses a discard operation", () => {
    for (const operation of ["status-read", "branches-read", "summary-read"]) {
      expect(isClientGitRetryAttemptIngestRequest({ ...attemptRequest(), operation })).toBe(true);
    }
    for (const operation of ["repository-clone", "repository-register"]) {
      expect(isClientGitRetryAttemptIngestRequest({ ...attemptRequest(), operation })).toBe(false);
    }
  });

  it.each([
    ["a missing correlation id", { correlationId: undefined }],
    ["an oversized correlation id", { correlationId: "c".repeat(129) }],
    ["a non-string correlation id", { correlationId: 7 }],
    ["an unknown operation", { operation: "write-file" }],
    ["a mismatched kind", { kind: "stage" }],
    ["an undeclared field", { extra: "x" }],
  ])("refuses %s", (_label, patch) => {
    expect(isClientGitRetryAttemptIngestRequest({ ...attemptRequest(), ...patch })).toBe(false);
  });
});

// #3557 review: the stage lifecycle carries one client-minted id across both phases.
describe("isClientStageIngestRequest correlation", () => {
  it("accepts a well-formed correlation id on either phase and refuses a malformed one", () => {
    const started = { kind: "stage", stage: "chat bind", phase: "started", ordinal: 1 };
    const settled = { ...started, phase: "settled", durationMs: 5 };
    expect(isClientStageIngestRequest({ ...started, correlationId: "ui_stage-0001" })).toBe(true);
    expect(isClientStageIngestRequest({ ...settled, correlationId: "ui_stage-0001" })).toBe(true);
    expect(isClientStageIngestRequest({ ...started, correlationId: "c".repeat(129) })).toBe(false);
    expect(isClientStageIngestRequest({ ...settled, correlationId: 42 })).toBe(false);
  });
});

// #3557 review: the stale-session repair links the denied request, the repair and the replay.
describe("isClientSessionRepairIngestRequest", () => {
  function repairRequest(): Record<string, unknown> {
    return {
      kind: "session-repair",
      outcome: "replayed",
      correlationId: "ui_denied-0001",
      repairCorrelationId: "ui_repair-0001",
    };
  }

  it("accepts every closed outcome with the repair's correlation id", () => {
    for (const outcome of CLIENT_SESSION_REPAIR_OUTCOMES) {
      const streamOnly = outcome === "stream-repaired" || outcome === "repair-acknowledged";
      const stream = streamOnly ? { stream: "run-events" } : {};
      expect(isClientSessionRepairIngestRequest({ ...repairRequest(), outcome, ...stream })).toBe(
        true,
      );
    }
    expect(
      isClientSessionRepairIngestRequest({
        ...repairRequest(),
        outcome: "replay-failed",
        errorKind: "unavailable",
      }),
    ).toBe(true);
  });

  it.each([
    ["a non-object", "session-repair"],
    ["another kind", { kind: "binding" }],
    ["an unknown outcome", { outcome: "healed" }],
    ["a missing denied-request id", { correlationId: undefined }],
    ["a malformed repair id", { repairCorrelationId: "" }],
    ["an error kind outside the closed vocabulary", { errorKind: "gateway-exploded" }],
    ["an undeclared field", { path: "/api/files" }],
    ["an unknown stream", { stream: "chat-tokens" }],
    ["a stream repair that names no stream", { outcome: "stream-repaired" }],
    ["an acknowledged repair that names no stream", { outcome: "repair-acknowledged" }],
    ["a stream on a replayed request", { stream: "run-events" }],
    ["a stream on a failed replay", { outcome: "replay-failed", stream: "run-events" }],
  ])("refuses %s", (_label, patch) => {
    const value = typeof patch === "string" ? patch : { ...repairRequest(), ...patch };
    expect(isClientSessionRepairIngestRequest(value)).toBe(false);
  });

  // #3557 review: every outcome follows a repair attempt whose id the page minted before sending it,
  // so a report that cannot name that attempt is refused instead of recorded as complete.
  it("refuses every outcome without the repair request's id", () => {
    for (const outcome of CLIENT_SESSION_REPAIR_OUTCOMES) {
      const streamOnly = outcome === "stream-repaired" || outcome === "repair-acknowledged";
      const stream = streamOnly ? { stream: "run-events" } : {};
      const report: Record<string, unknown> = { ...repairRequest(), outcome, ...stream };
      expect(
        isClientSessionRepairIngestRequest({ ...report, repairCorrelationId: undefined }),
      ).toBe(false);
      const { repairCorrelationId: _omitted, ...withoutRepairId } = report;
      expect(isClientSessionRepairIngestRequest(withoutRepairId)).toBe(false);
    }
  });

  // #3557 review: a stream repair reports under its failure streak, naming its stream.
  it("accepts every stream on a stream repair and on a failed repair", () => {
    for (const stream of CLIENT_SESSION_REPAIR_STREAMS) {
      for (const outcome of ["stream-repaired", "repair-failed"]) {
        expect(isClientSessionRepairIngestRequest({ ...repairRequest(), outcome, stream })).toBe(
          true,
        );
      }
    }
  });
});

describe("capture diagnostic vocabulary", () => {
  it.each([
    ["voiceCaptureReason", CLIENT_VOICE_CAPTURE_REASONS],
    ["voiceCaptureError", CLIENT_VOICE_CAPTURE_ERRORS],
  ] as const)("accepts exactly the closed %s vocabulary", (field, vocabulary) => {
    const request = {
      ...validRequest(),
      kind: "voice-dialogue",
      voiceDialogueStage: "capture-renewal-failed",
    };
    for (const value of vocabulary) {
      expect(isClientDiagnosticIngestRequest({ ...request, [field]: value })).toBe(true);
      expect(isClientDiagnosticIngestRequest({ ...request, [field]: `${value}-extra` })).toBe(
        false,
      );
      expect(isClientDiagnosticIngestRequest({ ...request, [field]: ` ${value}` })).toBe(false);
    }
    for (const value of ["", null, 0, {}, []]) {
      expect(isClientDiagnosticIngestRequest({ ...request, [field]: value })).toBe(false);
    }
  });

  it.each(["voiceCaptureReason", "voiceCaptureError"])("rejects hostile %s", (field) => {
    expect(
      isClientDiagnosticIngestRequest({
        message: "capture",
        clientTs: "2026-09-19T00:00:00.000Z",
        kind: "voice-dialogue",
        voiceDialogueStage: "capture-renewal-failed",
        [field]: "private arbitrary error text",
      }),
    ).toBe(false);
  });
});

describe("client module and markdown identity boundaries", () => {
  const base = { message: "diagnostic", clientTs: "2026-09-19T00:00:00.000Z" };
  it("accepts the known module and a short provider message identity", () => {
    expect(isClientDiagnosticIngestRequest({ ...base, moduleLoadFailure: "git-sync" })).toBe(true);
    expect(
      isClientDiagnosticIngestRequest({
        ...base,
        markdownLayout: { messageId: "msg_1", listStart: 1, listIndex: 0, depth: 0 },
      }),
    ).toBe(true);
  });
  it.each(["", "private text", "https://private.invalid", "x".repeat(129)])(
    "rejects hostile message identity %s",
    (messageId) => {
      expect(
        isClientDiagnosticIngestRequest({
          ...base,
          markdownLayout: { messageId, listStart: 1, listIndex: 0, depth: 0 },
        }),
      ).toBe(false);
    },
  );
  it("rejects an unregistered module name", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...base, moduleLoadFailure: "private module URL" }),
    ).toBe(false);
  });
});

describe("client error evidence trust boundary", () => {
  const base = { message: "failure", clientTs: "2026-09-19T00:00:00.000Z" };
  const frame = "dist/ui/static/_next/static/chunks/1wntg-7ptuw73.js:12:345";
  const evidence = { errorClass: "TypeError", frames: [frame], causeChain: ["Error"] };
  it("accepts the bounded closed evidence shape", () => {
    expect(isClientDiagnosticIngestRequest({ ...base, errorEvidence: evidence })).toBe(true);
  });
  it.each([
    { ...evidence, errorClass: "PrivateCustomer" },
    { ...evidence, frames: ["https://private.invalid/file.js:1:2"] },
    { ...evidence, frames: ["dist/ui/static/_next/static/chunks/../private.js:1:2"] },
    { ...evidence, frames: Array.from({ length: 9 }, () => frame) },
    { ...evidence, causeChain: ["private cause"] },
    { ...evidence, causeChain: Array.from({ length: 6 }, () => "Error") },
  ])("rejects hostile or unbounded evidence", (errorEvidence) => {
    expect(isClientDiagnosticIngestRequest({ ...base, errorEvidence })).toBe(false);
  });
});

it("preserves the closed native DOMException class for browser error events", () => {
  expect(clientErrorClass(new DOMException("private device detail", "NotReadableError"))).toBe(
    "NotReadableError",
  );
});

describe("coding history scope diagnostic contract", () => {
  const scope = {
    reason: "repository-mismatch",
    taskId: "chat-one",
    requestedScopeId: "scope-one",
    currentScopeId: "scope-two",
  };
  const request = (codingHistoryScope: unknown): unknown => ({
    message: "history scope outcome",
    clientTs: "2026-09-20T00:00:00.000Z",
    correlationId: "ui_history-load-0001",
    codingHistoryScope,
  });
  it("accepts opaque identities and optional workspace references", () => {
    expect(isClientDiagnosticIngestRequest(request(scope))).toBe(true);
    expect(
      isClientDiagnosticIngestRequest(
        request({
          ...scope,
          requestedWorkspaceId: "ws-one",
          currentWorkspaceId: "ws-two",
          targetWorkspaceId: "ws-target",
        }),
      ),
    ).toBe(true);
  });
  it.each([
    null,
    { ...scope, reason: "unknown" },
    { ...scope, taskId: undefined },
    { ...scope, requestedScopeId: "/private/repo" },
    { ...scope, currentWorkspaceId: "secret key" },
    { ...scope, content: "private" },
  ])("rejects invalid scope data: %s", (invalid) => {
    expect(isClientDiagnosticIngestRequest(request(invalid))).toBe(false);
  });
});

describe("coding issue diagnostic outcome", () => {
  it.each([
    [undefined, true],
    ["multiple-issues", true],
    ["unknown", false],
    ["https://github.com/private/repo/issues/1", false],
    [null, false],
  ])("validates the closed outcome %s", (codingIssueOutcome, expected) => {
    expect(
      isClientDiagnosticIngestRequest({
        message: "issue outcome",
        clientTs: "2026-09-20T00:00:00.000Z",
        codingIssueOutcome,
      }),
    ).toBe(expected);
  });
});
