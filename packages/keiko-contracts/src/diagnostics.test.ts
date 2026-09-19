import { describe, expect, it } from "vitest";

import {
  ACTIVITY_LOG_READINESS_REASONS,
  ACTIVITY_LOG_READINESS_STATES,
  ACTIVITY_LOG_WRITER_KINDS,
  CLIENT_BINDING_OUTCOMES,
  CLIENT_BINDING_REFERENCE_SHAPES,
  CLIENT_BINDING_RELATED_CORRELATIONS_MAX,
  CLIENT_BINDING_DECIDING_LOADS_MAX,
  CLIENT_SESSION_REPAIR_OUTCOMES,
  CLIENT_SESSION_REPAIR_STREAMS,
  CLIENT_DIAGNOSTIC_KINDS,
  CLIENT_DIAGNOSTIC_LOSS_COUNT_KEYS,
  CLIENT_DIAGNOSTIC_LOSS_COUNT_MAX,
  CLIENT_DIAGNOSTIC_MESSAGE_MAX_LENGTH,
  CLIENT_DIAGNOSTIC_READY_STATES,
  CLIENT_STAGE_DURATION_MS_MAX,
  CLIENT_STAGE_IDS,
  CLIENT_STAGE_ORDINAL_MAX,
  LINUX_GATEWAY_DIAGNOSTIC_KINDS,
  isActivityLogReadinessSnapshot,
  isClientBindingIngestRequest,
  isClientDiagnosticIngestRequest,
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
          }),
        ).toBe(true);
      }
    }
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

  // This guard only asserts wire SHAPE (AGENTS.md: "reuse first" — the leaf must not duplicate
  // `correlation.ts`'s alphabet policy). A shape-conforming but semantically invalid id is the
  // server route's job to reject via `isValidCorrelationId`, never this guard's.
  it("accepts a correlationId shape that a stricter server-side policy would still reject", () => {
    expect(
      isClientDiagnosticIngestRequest({ ...validRequest(), correlationId: "not valid!!" }),
    ).toBe(true);
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

  it("accepts every possible outcome and reference shape, with and without correlation ids", () => {
    for (const outcome of CLIENT_BINDING_OUTCOMES) {
      for (const referenceShape of CLIENT_BINDING_REFERENCE_SHAPES) {
        if (outcome === "resolved" && referenceShape === "redacted") continue;
        expect(isClientBindingIngestRequest({ ...bindingRequest(), outcome, referenceShape })).toBe(
          true,
        );
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

  it("accepts every closed outcome, with and without the repair's correlation id", () => {
    for (const outcome of CLIENT_SESSION_REPAIR_OUTCOMES) {
      const stream = outcome === "stream-repaired" ? { stream: "run-events" } : {};
      expect(isClientSessionRepairIngestRequest({ ...repairRequest(), outcome, ...stream })).toBe(
        true,
      );
    }
    expect(
      isClientSessionRepairIngestRequest({ ...repairRequest(), repairCorrelationId: undefined }),
    ).toBe(true);
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
    ["a stream on a replayed request", { stream: "run-events" }],
    ["a stream on a failed replay", { outcome: "replay-failed", stream: "run-events" }],
  ])("refuses %s", (_label, patch) => {
    const value = typeof patch === "string" ? patch : { ...repairRequest(), ...patch };
    expect(isClientSessionRepairIngestRequest(value)).toBe(false);
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
