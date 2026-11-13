import { describe, expect, it } from "vitest";
import { jiraReportDeclaration } from "./jiraReportDescriptor.js";

describe("the jira.report description (#4356)", () => {
  it("says that a repeated scope is harmless and a different one is refused", () => {
    const { description } = jiraReportDeclaration().descriptor;
    expect(description).toContain("names a reportId takes reportId, section, startAt");
    expect(description).toContain(
      "repeating the report's own projectKey, jql or epicKey is harmless",
    );
    expect(description).toContain("a different one is refused");
  });
});
