import { describe, expect, it } from "vitest";
import { JIRA_REPORT_DATA_TEXT_CHARS_MAX, jiraReportDataText } from "./jira-report-data-text.js";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

describe("document text carried as data (#4356)", () => {
  it("cuts by code point and never leaves half of a surrogate pair", () => {
    for (const unit of ["😀", "a😀", "𝒜b"]) {
      const cut = jiraReportDataText(unit.repeat(200));
      expect(Array.from(cut)).toHaveLength(JIRA_REPORT_DATA_TEXT_CHARS_MAX);
      expect(cut.endsWith("…")).toBe(true);
      expect(LONE_SURROGATE.test(cut)).toBe(false);
    }
  });

  it("keeps a text of exactly the bound whole", () => {
    const exact = "😀".repeat(JIRA_REPORT_DATA_TEXT_CHARS_MAX);
    expect(jiraReportDataText(exact)).toBe(exact);
  });
});
