import { describe, expect, it } from "vitest";

import {
  isCodingWorkbenchEvidenceSafeText,
  redactCodingWorkbenchEvidenceText,
  validateCodingWorkbenchEvidenceRecord,
} from "./coding-workbench-evidence.js";

describe("coding workbench evidence redaction", () => {
  it("keeps auxiliary evidence content-free", () => {
    expect(isCodingWorkbenchEvidenceSafeText("event-skill-1")).toBe(true);
    expect(
      redactCodingWorkbenchEvidenceText("https://docs.example.org/private?q=secret"),
    ).not.toContain("secret");
  });

  it.each(["2026-04-31T00:00:00Z", "2026-07-31 12:00:00 GMT+0000 Z"])(
    "rejects a normalized or non-canonical evidence instant: %s",
    (occurredAt) => {
      expect(
        validateCodingWorkbenchEvidenceRecord({
          schemaVersion: "1",
          recordId: "event-runtime-1",
          runId: "run-runtime-1",
          occurredAt,
          kind: "run",
          effectiveMode: "supervised-coding",
          runtimeSource: "keiko-sidecar",
          modelSource: "keiko-model-gateway",
        }).ok,
      ).toBe(false);
    },
  );
});
