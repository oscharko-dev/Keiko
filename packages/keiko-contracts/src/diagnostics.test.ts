import { describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_READINESS_REASONS,
  ACTIVITY_LOG_READINESS_STATES,
  ACTIVITY_LOG_WRITER_KINDS,
  CLIENT_DIAGNOSTIC_KINDS,
  CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS,
  CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX,
  CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  CLIENT_DIAGNOSTIC_READY_STATES,
  CLIENT_VOICE_DIALOGUE_STAGES,
  LINUX_GATEWAY_DIAGNOSTIC_KINDS,
  isActivityLogReadinessSnapshot,
  isClientDiagnosticIngestRequest,
  isClientDiagnosticKind,
  isClientDiagnosticLossCount,
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

  // This guard only asserts wire SHAPE (AGENTS.md: "reuse first" — the leaf must not duplicate
  // `correlation.ts`'s alphabet policy). A shape-conforming but semantically invalid id is the
  // server route's job to reject via `isValidCorrelationId`, never this guard's.
  it("accepts a correlationId shape that a stricter server-side policy would still reject", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "not valid!!" }),
    ).toBe(true);
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

describe("capture diagnostic vocabulary", () => {
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
