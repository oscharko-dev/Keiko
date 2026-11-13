import { describe, expect, it } from "vitest";
import { jiraReportDeclaration } from "./jiraReportDescriptor.js";

describe("the jira.report description (#4356)", () => {
  it("says that a call naming a reportId takes no scope, since models repeat it there", () => {
    const { description } = jiraReportDeclaration().descriptor;
    expect(description).toContain("names a reportId takes only reportId, section, startAt");
    expect(description).toContain("never repeat projectKey, jql or epicKey");
  });
});
