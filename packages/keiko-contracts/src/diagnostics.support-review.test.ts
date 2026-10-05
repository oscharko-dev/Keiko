import { describe, expect, it } from "vitest";
import { isClientDiagnosticIngestRequest, isClientStageIngestRequest } from "./diagnostics.js";

const base = {
  message: "Closed browser event",
  clientTs: "2026-10-05T00:00:00.000Z",
  correlationId: "source-review-event",
};
const prepared = {
  reportBytes: 42,
  evidenceScope: "server",
  completeness: "complete",
  loss: "none",
};
const closed = [
  { supportReportPreparation: prepared },
  { filesScopeDecision: { decision: "restored" } },
  { supportReportDelivery: "manual" },
  { selectDismissal: { reason: "escape", focus: "trigger" } },
  {
    knowledgeCatalog: {
      podCount: 1,
      readyPodCount: 1,
      setCount: 0,
      boundCount: 0,
      missingCount: 0,
      notReadyCount: 0,
    },
  },
  { answerCopy: { outcome: "copied", grounded: true, strippedGroupCount: 0, keptGroupCount: 1 } },
  { answerSpeech: { grounded: true, strippedGroupCount: 0, keptGroupCount: 1 } },
  { citationActivation: { reason: "matched", outcome: "opened", rootCount: 1, matchCount: 1 } },
];

describe("closed support diagnostics review regressions", () => {
  it.each(closed)("refuses every other closed report beside %j", (report) => {
    expect(isClientDiagnosticIngestRequest({ ...base, ...report })).toBe(true);
    for (const companion of closed) {
      if (companion === report) continue;
      expect(isClientDiagnosticIngestRequest({ ...base, ...report, ...companion })).toBe(false);
    }
  });
  it.each(closed)(
    "rejects every defined companion outside the common envelope for %j",
    (report) => {
      expect(isClientDiagnosticIngestRequest({ ...base, ...report })).toBe(true);
      for (const key of [
        "kind",
        "errorKind",
        "errorEvidence",
        "renderFailure",
        "composerCodeStage",
        "composerFocusIndicator",
        "codingIssueOutcome",
        "codingHistoryScope",
        "markdownLayout",
        "readyState",
        "privateExtension",
      ]) {
        expect(isClientDiagnosticIngestRequest({ ...base, ...report, [key]: "runtime" }), key).toBe(
          false,
        );
      }
      expect(
        isClientDiagnosticIngestRequest({
          ...base,
          ...report,
          errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
        }),
      ).toBe(false);
      expect(
        isClientDiagnosticIngestRequest({ ...base, ...report, loss: { errorsSuppressed: 1 } }),
      ).toBe(true);
    },
  );
  it("preserves the legacy neutral select envelope without accepting failure fields", () => {
    const selected = {
      ...base,
      kind: "other",
      selectDismissal: { reason: "escape", focus: "trigger" },
    };
    expect(isClientDiagnosticIngestRequest(selected)).toBe(true);
    expect(isClientDiagnosticIngestRequest({ ...selected, kind: "window-error" })).toBe(false);
    expect(isClientDiagnosticIngestRequest({ ...selected, errorKind: "unavailable" })).toBe(false);
    expect(
      isClientDiagnosticIngestRequest({
        ...selected,
        errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
      }),
    ).toBe(false);
  });
  it("retains the registered copy-failure evidence without accepting it on a copied result", () => {
    const failure = {
      ...base,
      answerCopy: { outcome: "failed", grounded: true, strippedGroupCount: 0, keptGroupCount: 1 },
      errorKind: "unavailable",
      errorEvidence: { errorClass: "TypeError", frames: [], causeChain: [] },
    };
    expect(isClientDiagnosticIngestRequest(failure)).toBe(true);
    expect(
      isClientDiagnosticIngestRequest({
        ...failure,
        answerCopy: { ...failure.answerCopy, outcome: "copied" },
      }),
    ).toBe(false);
  });
  it("accepts a safe parent edge on both lifecycle phases and refuses invalid shapes", () => {
    for (const phase of ["started", "settled"]) {
      const request = {
        kind: "stage",
        stage: "files directory load",
        phase,
        ordinal: 1,
        correlationId: "child-stage",
        ...(phase === "settled" ? { durationMs: 12 } : {}),
      };
      expect(isClientStageIngestRequest({ ...request, parentCorrelationId: "parent-task" })).toBe(
        true,
      );
      for (const parentCorrelationId of [42, "", "parent with spaces", "x".repeat(129)])
        expect(isClientStageIngestRequest({ ...request, parentCorrelationId })).toBe(false);
    }
  });
  it("accepts structured download provenance and rejects extra or malformed evidence", () => {
    const delivery = {
      mode: "manual",
      source: "browser",
      evidenceScope: "client-only",
      reportDigest: "a".repeat(64),
    };
    expect(isClientDiagnosticIngestRequest({ ...base, supportReportDelivery: delivery })).toBe(
      true,
    );
    for (const patch of [
      { mode: "automatic" },
      { source: "remote" },
      { evidenceScope: "private" },
      { reportDigest: "customer-id" },
      { reportBody: "private" },
    ])
      expect(
        isClientDiagnosticIngestRequest({
          ...base,
          supportReportDelivery: { ...delivery, ...patch },
        }),
      ).toBe(false);
  });
});

describe("Files-scope evidence field coherence", () => {
  it.each([
    { decision: "restored", sourceCount: Number.MAX_SAFE_INTEGER },
    { decision: "restored", candidateCount: 2 ** 32 },
    { decision: "restored", sourceCount: 1, candidateCount: 2 },
    { decision: "timeout-rejected", sourceCount: 1 },
    { decision: "conflict-retried", candidateCount: 1 },
    { decision: "automatic-suppressed", bindingFingerprint: "a".repeat(64) },
    { decision: "acknowledged", mutationSurface: "files" },
  ])("rejects fields without a producer meaning: %j", (filesScopeDecision) => {
    expect(isClientDiagnosticIngestRequest({ ...base, filesScopeDecision })).toBe(false);
  });
  it("accepts the technical array length boundary without allocating that array", () => {
    const scope = { decision: "restored", sourceCount: 2 ** 32 - 1, candidateCount: 2 ** 32 - 1 };
    expect(isClientDiagnosticIngestRequest({ ...base, filesScopeDecision: scope })).toBe(true);
    expect(
      isClientDiagnosticIngestRequest({
        ...base,
        filesScopeDecision: { ...scope, sourceCount: 2 ** 32 },
      }),
    ).toBe(false);
  });
});
