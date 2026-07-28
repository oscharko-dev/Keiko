import { describe, expect, it } from "vitest";

import { translateLocalKnowledge } from "./local-knowledge-i18n";

describe("local knowledge translations", () => {
  it("interpolates every named value in selected-document summaries", () => {
    expect(
      translateLocalKnowledge("en", "localKnowledge.detail.connect.selectedDocuments", {
        count: 3,
        root: "/repo/docs",
      }),
    ).toBe("Selected documents: 3 from /repo/docs");
    expect(
      translateLocalKnowledge("de", "localKnowledge.detail.diagnostics.groupAria", {
        severity: "Warnung",
        code: "PARSER_LIMIT",
        count: 2,
      }),
    ).toBe("Warnung: PARSER_LIMIT (2x)");
  });
});
