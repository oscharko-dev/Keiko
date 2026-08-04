import { describe, expect, it } from "vitest";

import {
  isCodingWorkbenchEvidenceSafeText,
  redactCodingWorkbenchEvidenceText,
  validateCodingWorkbenchEvidenceRecord,
} from "./coding-workbench-evidence.js";

function evidenceRecord(occurredAt: string): Record<string, unknown> {
  return {
    schemaVersion: "1",
    recordId: "event-runtime-1",
    runId: "run-runtime-1",
    occurredAt,
    kind: "run",
    effectiveMode: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
  };
}

describe("coding workbench evidence redaction", () => {
  it("keeps auxiliary evidence content-free", () => {
    expect(isCodingWorkbenchEvidenceSafeText("event-skill-1")).toBe(true);
    expect(
      redactCodingWorkbenchEvidenceText("https://docs.example.org/private?q=secret"),
    ).not.toContain("secret");
  });

  it.each(["2026-07-31T12:00:00Z", "2026-07-31T12:00:00.123Z"])(
    "accepts a canonical UTC evidence instant: %s",
    (occurredAt) => {
      expect(validateCodingWorkbenchEvidenceRecord(evidenceRecord(occurredAt)).ok).toBe(true);
    },
  );

  it.each([
    "",
    "2026-04-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-07-31 12:00:00 GMT+0000 Z",
    "2026-07-31T12:00:00+00:00",
    "2026-07-31T12:00:00.1Z",
    "2026-07-31T12:00:00.000z",
    "2026-07-31T12:00:00Z\u0000suffix",
  ])("rejects a normalized or non-canonical evidence instant: %s", (occurredAt) => {
    expect(validateCodingWorkbenchEvidenceRecord(evidenceRecord(occurredAt)).ok).toBe(false);
  });
});
