// A template refusal names "PROJECT/Type #n" when several templates govern one type; the lab's repair grader
// must still recognise it as the template the case wrote (#4369, German user against an English template).
import { describe, expect, it } from "vitest";
import { canonicalToolId } from "../testing/jira-chat-lab/requirements/tool-exchanges.mjs";
import { gradeTemplateRepair } from "../testing/jira-chat-lab/requirements/templates.mjs";

const refusal = (template) => ({
  call: { name: "jira_create" },
  result: {
    toolRef: { canonicalId: canonicalToolId("jira.create") },
    status: "failed",
    data: {
      outcome: "rejected",
      reason: "field-validation",
      violations: [{ ruleId: "section-missing", subject: "Testhinweise", template }],
    },
  },
});

describe("gradeTemplateRepair names the template with or without its numbering", () => {
  it.each(["REQ/Task", "REQ/Task #1", "req/task #12"])("detects a refusal naming %s", (name) => {
    const graded = gradeTemplateRepair({
      exchanges: [refusal(name)],
      issues: [],
      template: "REQ/Task",
      conforms: () => true,
    });
    expect(graded.detected).toBe(true);
    expect(graded.ruleIds).toEqual(["section-missing"]);
  });

  it("does not detect a refusal of another template or another type", () => {
    for (const name of ["REQ/Epic #1", "REQ/Task force", "OTHER/Task"])
      expect(
        gradeTemplateRepair({
          exchanges: [refusal(name)],
          issues: [],
          template: "REQ/Task",
          conforms: () => true,
        }).detected,
      ).toBe(false);
  });
});
