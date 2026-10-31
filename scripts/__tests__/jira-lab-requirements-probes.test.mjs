// The fields-writable probe (#4174) must not count a field as covered unless Keiko's production
// contracts declare the dedicated tool that writes it (#4176: attachment via jira.attach).
import { describe, expect, it } from "vitest";
import { isNotFieldWrite } from "../testing/jira-chat-lab/requirements/probes.mjs";

describe("fields-writable probe exemptions", () => {
  it("treats the create-fixed fields and the production dedicated tools as no field write", () => {
    for (const fieldId of ["project", "issuetype", "comment", "attachment"])
      expect(isNotFieldWrite(fieldId), fieldId).toBe(true);
  });

  it("counts attachment and comment as field writes again when their tool is not declared", () => {
    const withoutDedicatedTools = {
      "jira.create": "create-issue",
      "jira.edit": "update-issue-fields",
    };
    expect(isNotFieldWrite("attachment", withoutDedicatedTools)).toBe(false);
    expect(isNotFieldWrite("comment", withoutDedicatedTools)).toBe(false);
    expect(isNotFieldWrite("issuetype", withoutDedicatedTools)).toBe(true);
  });

  it("never exempts an ordinary field", () => {
    for (const fieldId of ["summary", "issuelinks", "labels", "customfield_10100"])
      expect(isNotFieldWrite(fieldId), fieldId).toBe(false);
  });
});
