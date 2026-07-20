import { describe, expect, it } from "vitest";

import {
  isCodingWorkbenchEvidenceSafeText,
  redactCodingWorkbenchEvidenceText,
} from "./coding-workbench-evidence.js";

describe("coding workbench evidence redaction", () => {
  it("keeps auxiliary evidence content-free", () => {
    expect(isCodingWorkbenchEvidenceSafeText("event-skill-1")).toBe(true);
    expect(
      redactCodingWorkbenchEvidenceText("https://docs.example.org/private?q=secret"),
    ).not.toContain("secret");
  });
});
