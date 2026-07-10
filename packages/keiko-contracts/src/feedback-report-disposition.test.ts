import { describe, expect, it } from "vitest";

import {
  FEEDBACK_DISPOSITION_ACTIONS_V1,
  FEEDBACK_DISPOSITION_REASONS_V1,
  FEEDBACK_DISPOSITION_UNIT_KINDS_V1,
  FEEDBACK_DRAFT_FIELD_IDS_V1,
} from "./feedback-report.js";

describe("feedback report disposition contract", () => {
  it("publishes closed content-free recovery vocabularies and source draft targets", () => {
    expect(FEEDBACK_DISPOSITION_ACTIONS_V1).toEqual(["redacted", "quarantined", "omitted"]);
    expect(FEEDBACK_DISPOSITION_REASONS_V1).toEqual([
      "complete-sensitive-span",
      "ambiguous-credential-structure",
      "no-safe-optional-content",
    ]);
    expect(FEEDBACK_DISPOSITION_UNIT_KINDS_V1).toEqual([
      "quoted-segment",
      "structured-value",
      "line-remainder",
      "optional-field",
      "attachment",
    ]);
    expect(FEEDBACK_DRAFT_FIELD_IDS_V1).toEqual([
      "title",
      "description",
      "reproductionSteps",
      "expectedBehavior",
      "actualBehavior",
      "productVersion",
      "browserDescription",
      "handwrittenEvidence",
    ]);
  });
});
